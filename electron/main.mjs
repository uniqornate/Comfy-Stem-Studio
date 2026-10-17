import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { readFile, writeFile, mkdir, stat, copyFile, realpath } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Comfy } from '@comfyorg/sdk';
import { checkConnection, normalizeEndpoint } from './connection.mjs';
import { AudioRenderer } from './audio-render.mjs';
import { SAMManager } from './sam-manager.mjs';
import { GuideSepManager } from './guidesep-manager.mjs';
import { audioFilters, isAudioPath, isSourcePath, sourceFilters } from './media-types.mjs';
import { Projects } from './projects.mjs';
import { resources } from './resources.mjs';
import { VideoExporter } from './video-export.mjs';
import { mediaResponse } from './media-response.mjs';
import { ProxyManager } from './proxy-manager.mjs';
import { Separation, engineStatus, installEngine } from './separation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sources = new Map();
const defaults = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189', installation: '', managedProxy: false, setupComplete: false };
let window;
let proxyManager;
let separation;
let samManager, guidesepManager;
let audioRenderer;
const videoExporter = new VideoExporter();
let engineInstallState = { phase: 'idle', message: '', detail: '', current: 0, total: 0 };
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function profilePath() { return join(app.getPath('userData'), 'connection.json'); }
function sanitize(profile) {
  return { comfyUrl: normalizeEndpoint(profile.comfyUrl), proxyUrl: normalizeEndpoint(profile.proxyUrl), installation: typeof profile.installation === 'string' ? profile.installation.slice(0, 4096) : '', managedProxy: profile.managedProxy === true, setupComplete: profile.setupComplete === true };
}
function assertSender(event) {
  const current = event.senderFrame?.url || '';
  const expected = window?.webContents.getURL();
  if (!expected || current !== expected) throw new Error('Untrusted application frame.');
}
function handle(channel, fn) { ipcMain.handle(channel, async (event, ...args) => { assertSender(event); return fn(...args); }); }

app.whenReady().then(async () => {
  if (!singleInstance) return;
  const quietHost = app.isPackaged ? join(process.resourcesPath, 'setup', 'QuietProcess.exe') : join(here, '../setup/QuietProcess.exe');
  if ((await stat(quietHost).catch(() => null))?.isFile()) process.env.STEM_QUIET_PROCESS = quietHost;
  proxyManager = new ProxyManager(join(app.getPath('userData'), 'managed-proxy'));
  const expose = path => { const token = randomUUID(); sources.set(token, path); return `app-media://source/${token}`; };
  separation = new Separation(join(app.getPath('userData'), 'stem-cache'), expose);
  audioRenderer = new AudioRenderer(join(app.getPath('userData'), 'edited-audio'));
  const projects = new Projects(app.getPath('userData'), separation, sources, expose);
  const assertExportTarget = async target => {
    const canonical = (await realpath(target).catch(() => resolve(target))).toLowerCase();
    for (const path of new Set([...sources.values(), ...[...separation.outputs.values()].map(output => output.path)])) if ((await realpath(path).catch(() => resolve(path))).toLowerCase() === canonical) throw Error('Choose a new export filename. Original project media must stay unchanged.');
  };
  let projectReady;
  let allowClose = false;
  let rendererGone = false;
  const ensureProject = () => projectReady ||= projects.serial(() => projects.boot());
  const idleProject = () => { if (separation.active || videoExporter.active || audioRenderer.active) throw Error('Finish or cancel the active processing/export before switching projects.'); };
  handle('project:get', async () => { const boot = await ensureProject(); return projects.serial(() => projects.hydrate(boot.warnings, false)); });
  handle('project:recent', async () => { await ensureProject(); return projects.recent; });
  handle('project:save', async payload => { await ensureProject(); return projects.serial(() => projects.save(payload)); });
  handle('project:action', async (action, payload, argument) => {
    await ensureProject();
    return projects.serial(async () => {
      idleProject(); await projects.save(payload);
      if (action === 'rename') { await projects.rename(argument); return { info: projects.info() }; }
      if (action === 'new') return projects.create(argument);
      if (action === 'source') { let saved; try { saved = sanitize(JSON.parse(await readFile(profilePath(), 'utf8'))); } catch { saved = defaults; } return projects.attach(argument, saved.installation); }
      if (action === 'open') {
        const result = await dialog.showOpenDialog(window, { title: 'Open Stem Studio project', properties: ['openFile'], filters: [{ name: 'Stem Studio project', extensions: ['json'] }] });
        return result.canceled ? null : projects.load(result.filePaths[0]);
      }
      if (action === 'recent') { const entry = projects.recent.find(item => item.path === argument); if (!entry) throw Error('Choose a project from the recent list.'); return projects.load(entry.path); }
      if (action === 'copy') {
        const result = await dialog.showOpenDialog(window, { title: 'Save project copy in folder', properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : projects.saveAs(result.filePaths[0]);
      }
      if (action === 'relink') {
        const result = await dialog.showOpenDialog(window, { title: 'Relink original media (same timing and duration)', properties: ['openFile'], filters: sourceFilters });
        return result.canceled ? null : projects.relink(result.filePaths[0]);
      }
      if (action === 'folder') { await shell.openPath(dirname(projects.path)); return null; }
      throw Error('Unknown project action.');
    });
  });
  handle('project:close', async payload => {
    try { if (payload) { await ensureProject(); await projects.serial(() => projects.save(payload)); } else await projects.queue; allowClose = true; window.close(); }
    catch (error) { closeRequested = false; throw error; }
  });
  let closeRequested = false;
  samManager = new SAMManager(join(app.getPath('userData'), 'sam-audio'), app.isPackaged ? join(process.resourcesPath, 'setup', 'prepare-sam.py') : join(here, '../setup/prepare-sam.py'));
  handle('sam:status', (profile, variant) => samManager.status(sanitize(profile), variant));
  handle('sam:prepare', (profile, token, variant) => { if (separation.active) throw Error('Wait for separation to finish first.'); return samManager.start(sanitize(profile), token, variant); });
  handle('sam:cancel', () => samManager.cancel());
  guidesepManager = new GuideSepManager(join(app.getPath('userData'), 'guidesep'), app.isPackaged ? join(process.resourcesPath, 'setup', 'prepare-guidesep.py') : join(here, '../setup/prepare-guidesep.py'));
  handle('guidesep:status', profile => guidesepManager.status(sanitize(profile)));
  handle('guidesep:prepare', profile => { if (separation.active) throw Error('Wait for separation to finish first.'); if (samManager.active) throw Error('Wait for SAM preparation to finish first.'); return guidesepManager.start(sanitize(profile)); });
  handle('guidesep:cancel', () => guidesepManager.cancel());
  handle('reference:choose', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Choose a reference sound (hum, whistle or play the target)', properties: ['openFile'], filters: audioFilters });
    if (selection.canceled) return null;
    const path = selection.filePaths[0];
    if (!isAudioPath(path)) throw new Error('Choose a supported audio file.');
    const info = await stat(path);
    return { name: path.split(/[\/]/).pop(), size: info.size, url: expose(path) };
  });
  handle('resources:get', profile => resources(sanitize(profile)));
  handle('layout:zoom', factor => {
    if (!Number.isFinite(factor) || factor < 0.6 || factor > 1.5) throw new Error('Invalid layout scale.');
    window.webContents.setZoomFactor(factor); return factor;
  });
  handle('video:export-status', () => audioRenderer.active ? {phase:'running',progress:0,message:'Rendering timeline edits through ComfyUI…'} : videoExporter.snapshot());
  handle('video:export-cancel', async () => { await audioRenderer.cancel(); await videoExporter.cancel(); });
  handle('video:export', async (profile, options) => {
    if (videoExporter.active || audioRenderer.active) throw new Error('A video export is already running.');
    if (!options || !Array.isArray(options.stems)) throw new Error('Choose stem channels first.');
    const url = new URL(options.sourceUrl);
    const source = url.protocol === 'app-media:' && url.hostname === 'source' ? sources.get(url.pathname.slice(1)) : null;
    if (!source) throw new Error('Choose the original video first.');
    const stems = options.stems.map(stem => ({ ...stem, path: separation.output(stem.id).path }));
    const format = 'mkv';
    const choice = await dialog.showSaveDialog(window, { title: 'Export video with lossless audio', defaultPath: source.replace(/\.[^./\\]+$/, '') + '-stems.' + format, filters: [{ name: 'ComfyUI video + lossless FLAC audio', extensions: [format] }] });
    if (choice.canceled) return null;
    await assertExportTarget(choice.filePath);
    for (const stem of stems) if (stem.edits) stem.path = await audioRenderer.render(sanitize(profile),stem.path,stem.edits,projects.current.storage?.comfyRoot);
    return videoExporter.run(sanitize(profile), source, stems, options, choice.filePath);
  });
  handle('engine:check', profile => engineStatus(sanitize(profile)));
  handle('engine:install-status', () => ({ ...engineInstallState }));
  handle('engine:install', async profile => {
    if (separation.active) throw new Error('Wait for the active separation before installing the integration.');
    if (['choosing', 'verifying', 'copying'].includes(engineInstallState.phase)) throw new Error('Integration installation is already active.');
    engineInstallState = { phase: 'choosing', message: 'Choose the model folder', detail: 'Select models or sfc-locoformer-dnr. No new model download is needed.', current: 0, total: 0 };
    try {
      const clean = sanitize(profile);
      const selection = await dialog.showOpenDialog(window, { title: 'Select models or sfc-locoformer-dnr', defaultPath: join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Stem Studio', 'models'), properties: ['openDirectory'] });
      if (selection.canceled) { engineInstallState.phase = 'cancelled'; engineInstallState.message = 'Model folder selection cancelled. No installation was completed.'; return { ready: false, message: engineInstallState.message }; }
      const nodeSource = app.isPackaged ? join(process.resourcesPath, 'comfy_nodes', 'StemStudio') : join(here, '../comfy_nodes/StemStudio');
      const result = await installEngine(clean, nodeSource, selection.filePaths[0], patch => Object.assign(engineInstallState, patch));
      let saved; try { saved = sanitize(JSON.parse(await readFile(profilePath(), 'utf8'))); } catch { saved = { ...defaults }; }
      saved.installation = clean.installation;
      await mkdir(dirname(profilePath()), { recursive: true }); await writeFile(profilePath(), JSON.stringify(saved, null, 2));
      Object.assign(engineInstallState, { phase: 'complete', message: 'Integration installed. Restart ComfyUI to load it.', detail: result.message, current: 1, total: 1 });
      return result;
    } catch (error) { Object.assign(engineInstallState, { phase: 'error', message: 'Integration was not completed.', detail: error.message }); throw error; }
  });
  handle('stems:start', async (profile, sourceUrl, options) => {
    await ensureProject();
    let source;
    try { const url = new URL(sourceUrl); if (url.protocol === 'app-media:' && url.hostname === 'source') source = sources.get(url.pathname.slice(1)); } catch { }
    if (!source) throw new Error('Choose a local source video first.');
    if (samManager.active && options?.mode === 'sam') throw Error('Wait for SAM preparation to finish.');
    if (guidesepManager.active && options?.mode === 'guidesep') throw Error('Wait for GuideSep preparation to finish.');
    let referencePath;
    if (options?.mode === 'guidesep') {
      try { const url = new URL(options.referenceUrl); if (url.protocol === 'app-media:' && url.hostname === 'source') referencePath = sources.get(url.pathname.slice(1)); } catch {}
      if (!referencePath) throw Error('Choose a reference sound for GuideSep first.');
    }
    if (options?.parentId && separation.output(options.parentId).path !== source) throw Error('The selected parent channel does not match its audio.');
    let samVideoPath;
    if (options?.mode === 'sam' && options.sam?.visual) {
      try { const url = new URL(options.videoUrl); if (url.protocol === 'app-media:' && url.hostname === 'source') samVideoPath = sources.get(url.pathname.slice(1)); } catch {}
      if (!samVideoPath) throw Error('Choose the original video for visual guidance.');
    }
    const nativeRoot = projects.current.storage?.comfyRoot;
    return separation.start(sanitize(profile), source, { ...options, samVideoPath, referencePath, nativeRoot, outputPrefix: nativeRoot ? `StemStudio/${projects.current.id}/${randomUUID()}` : undefined });
  });
  handle('stems:status', () => separation.snapshot());
  handle('stems:cancel', () => separation.cancel());
  handle('stems:save', async (id, edits, profile) => {
    const output = separation.output(id);
    const selection = await dialog.showSaveDialog(window, { title: 'Save stem', defaultPath: output.name, filters: [{ name: 'Lossless audio', extensions: ['flac'] }] });
    if (selection.canceled) return null;
    await assertExportTarget(selection.filePath);
    const path = edits ? await audioRenderer.render(sanitize(profile),output.path,edits,projects.current.storage?.comfyRoot) : output.path;
    await copyFile(path, selection.filePath); return selection.filePath;
  });
  handle('stems:save-all', async (ids, edits = {}, profile) => {
    const selection = await dialog.showOpenDialog(window, { title: 'Choose where to save all three stems', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled) return null;
    if (!ids.some(id => edits[id])) return separation.saveAll(selection.filePaths[0], ids);
    const folder = join(selection.filePaths[0],`StemStudio-${randomUUID()}`); await mkdir(folder);
    for (const id of ids) { const output = separation.output(id); const path=edits[id] ? await audioRenderer.render(sanitize(profile),output.path,edits[id],projects.current.storage?.comfyRoot) : output.path; await copyFile(path,join(folder,output.name)); }
    return folder;
  });
  handle('proxy:status', () => proxyManager.snapshot());
  handle('proxy:start', profile => proxyManager.start(sanitize(profile)));
  handle('proxy:stop', () => proxyManager.stop());
  protocol.handle('app-media', async (request) => {
    const url = new URL(request.url);
    const path = url.hostname === 'source' ? sources.get(url.pathname.slice(1)) : null;
    if (!path) return new Response('Media not found', { status: 404 });
    return mediaResponse(request, path);
  });
  handle('profile:get', async () => { try { return sanitize(JSON.parse(await readFile(profilePath(), 'utf8'))); } catch { return defaults; } });
  handle('profile:save', async (profile) => {
    const clean = sanitize(profile);
    await mkdir(dirname(profilePath()), { recursive: true });
    await writeFile(profilePath(), JSON.stringify(clean, null, 2));
    return clean;
  });
  handle('connection:check', async (profile) => {
    const clean = sanitize(profile);
    const result = await checkConnection(clean);
    if (result.comfy && result.proxy) {
      process.env.COMFY_BASE_URL = clean.proxyUrl;
      // Construct the official client only against the explicitly selected local deployment.
      new Comfy();
    }
    return result;
  });
  handle('installation:choose', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Select your ComfyUI folder', properties: ['openDirectory'] });
    if (selection.canceled) return null;
    const selected = selection.filePaths[0];
    for (const candidate of [selected, join(selected, 'ComfyUI')]) {
      try { if ((await stat(join(candidate, 'main.py'))).isFile()) return candidate; } catch { /* Try portable root. */ }
    }
    throw new Error('No ComfyUI main.py found. Select the ComfyUI folder or its portable parent.');
  });
  handle('video:open', async () => {
    if (separation.active || videoExporter.active || audioRenderer.active) throw new Error('Wait for separation/export to finish or cancel it before changing the source.');
    const selection = await dialog.showOpenDialog(window, { title: 'Open a video or audio file', properties: ['openFile'], filters: sourceFilters });
    if (selection.canceled) return null;
    const path = selection.filePaths[0];
    if (!isSourcePath(path)) throw new Error('Choose a supported video or audio file.');
    const info = await stat(path);
    const token = randomUUID();
    sources.set(token, path);
    return { name: path.split(/[\\/]/).pop(), size: info.size, url: `app-media://source/${token}` };
  });
  window = new BrowserWindow({ width: 1360, height: 920, minWidth: 1000, minHeight: 720, backgroundColor: '#211927', title: 'Stem Studio', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.on('close', event => {
    if (allowClose || !projectReady || rendererGone || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (!closeRequested) { closeRequested = true; window.webContents.send('project:request-close'); }
  });
  window.webContents.on('render-process-gone', () => { rendererGone = true; });
  window.webContents.on('did-finish-load', () => { rendererGone = false; });
  window.webContents.setWindowOpenHandler(({ url }) => { if (['https://huggingface.co/facebook/sam-audio-small-tv', 'https://huggingface.co/facebook/sam-audio-large-tv', 'https://huggingface.co/settings/tokens', 'https://huggingface.co/YutongCooper/GuideSep-v1', 'https://huggingface.co/facebook/pe-av-large', 'https://github.com/facebookresearch/sam-audio/blob/main/LICENSE'].includes(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (!app.isPackaged && process.argv.includes('--dev')) window.loadURL('http://127.0.0.1:5173');
  else window.loadFile(join(here, '../dist/index.html'));
});
app.on('before-quit', () => { samManager?.cancel(); void audioRenderer?.cancel().catch(() => {}); void videoExporter.cancel().catch(() => {}); proxyManager?.stop(); });
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
