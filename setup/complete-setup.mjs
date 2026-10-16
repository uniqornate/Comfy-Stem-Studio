import { quietCommand } from './quiet-process.mjs';
import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { createStatusWriter } from './status-writer.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const equalPath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error(`Engine returned HTTP ${response.status}`);
  return response.json();
}
async function fileExists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

export function nativeModelRoot(comfyRoot) { return join(comfyRoot, 'models', 'audio_separation'); }
export function setupProfile(comfyRoot, proxyUrl) {
  return { comfyUrl: 'http://127.0.0.1:8188', proxyUrl, installation: comfyRoot, managedProxy: true, setupComplete: true };
}
export function assertIdle(queue) {
  if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) throw new Error('Cannot verify the ComfyUI queue. The engine was not restarted.');
  return queue.queue_running.length === 0 && queue.queue_pending.length === 0;
}
export function runningEngineDirectory(root, argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('Cannot identify the selected running ComfyUI safely. It was not stopped.');
  const base = [root, dirname(root)].find(directory => equalPath(resolve(directory, argv[0]), join(root, 'main.py')));
  if (!base) throw new Error('The running ComfyUI does not match the selected folder. It was not stopped.');
  return base;
}

async function portFree(port) {
  return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
async function proxyAddress(comfyUrl) {
  for (let port = 8189; port < 8200; port++) {
    const url = `http://127.0.0.1:${port}`;
    try { const value = await json(`${url}/api/v2/health`); if (value.status === 'healthy' && value.upstream?.replace(/\/+$/, '') === comfyUrl) return url; } catch { }
    if (await portFree(port)) return url;
  }
  throw new Error('No free local proxy port between 8189 and 8199. Existing processes were left untouched.');
}
async function processOwner(port) {
  const command = "$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -State Listen -LocalPort $env:STEM_COMFY_PORT | Select-Object -ExpandProperty OwningProcess -Unique); if($ids.Count -ne 1){throw 'Ambiguous listener'}; Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]) | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress";
  const executable = quietCommand(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command]);
  const { stdout } = await promisify(execFile)(executable.file, executable.args, { windowsHide: true, env: { ...process.env, STEM_COMFY_PORT: String(port) }, timeout: 15000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
async function readyEngine(config, update, signal, changed, probeNodes) {
  const root = config.comfyRoot;
  const pythonCandidates = [join(root, '..', 'python_embeded', 'python.exe'), join(root, '.venv', 'Scripts', 'python.exe'), join(root, 'venv', 'Scripts', 'python.exe')];
  let stats; try { stats = await json(`${config.comfyUrl}/system_stats`); } catch { }
  if (stats && !changed) { try { const nodes = await probeNodes(config.comfyUrl); if (nodes.StemStudioSeparate && nodes.LoadAudio && nodes.SaveAudio) return; } catch { } }
  if (!config.allowEngineRestart) throw new Error('Integration is installed. Start or restart your ComfyUI once to load it; automatic engine control was not approved.');
  let executable; let args; let launchDirectory = root;
  const port = Number(new URL(config.comfyUrl).port || 80);
  if (stats) {
    const argv = stats.system?.argv;
    launchDirectory = runningEngineDirectory(root, argv);
    update({ message: 'Waiting for ComfyUI to become idle…', detail: 'Active or queued jobs are never interrupted by setup.' });
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!assertIdle(await json(`${config.comfyUrl}/queue`))) {
      if (signal.aborted) throw new Error('Setup cancelled before restarting ComfyUI.');
      if (Date.now() > deadline) throw new Error('ComfyUI still has queued work. Models and proxy are prepared; retry setup after that work finishes.');
      await pause(2000);
    }
    const owner = await processOwner(port);
    if (!owner.ExecutablePath || !pythonCandidates.some(path => equalPath(path, owner.ExecutablePath))) throw new Error('The running engine uses an unrecognized Python environment. It was left running; restart it manually once.');
    const confirmed = await processOwner(port);
    if (owner.ProcessId !== confirmed.ProcessId || owner.CreationDate !== confirmed.CreationDate || !equalPath(owner.ExecutablePath, confirmed.ExecutablePath)) throw new Error('The engine process changed during setup. No process was stopped. Retry setup.');
    if (!assertIdle(await json(`${config.comfyUrl}/queue`))) throw new Error('New ComfyUI work appeared. No process was stopped. Retry after the queue is idle.');
    if (signal.aborted) throw new Error('Setup cancelled before restarting ComfyUI.');
    executable = owner.ExecutablePath; args = ['-s', join(root, 'main.py'), ...argv.slice(1)];
    update({ message: 'Restarting the selected idle ComfyUI…', detail: 'Reusing its existing command-line arguments.' });
    process.kill(owner.ProcessId);
    for (let attempt = 0; attempt < 50 && !(await portFree(port)); attempt++) await pause(200);
    if (!(await portFree(port))) throw new Error('The old engine has not released its port. Retry setup; no other listener was stopped.');
  } else {
    if (!(await portFree(port))) throw new Error('The configured ComfyUI port is occupied by an unrecognized service. It was left untouched.');
    for (const candidate of pythonCandidates) if (await fileExists(candidate)) { executable = candidate; break; }
    if (!executable) throw new Error('No portable or virtual-environment Python found for this ComfyUI. Start your engine once and retry setup.');
    args = ['-s', join(root, 'main.py'), '--port', String(port)];
    if (executable.includes('python_embeded')) args.push('--windows-standalone-build');
  }
  if (signal.aborted) throw new Error('Setup cancelled. Start ComfyUI again when ready.');
  const log = await open(join(config.userData, 'comfy-startup.log'), 'a');
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const command = quietCommand(executable, args, env);
    const child = spawn(command.file, command.args, { cwd: launchDirectory, env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  update({ message: 'Waiting for ComfyUI and its audio nodes…', detail: 'The first engine startup may take a few minutes. Logs: comfy-startup.log in app data.' });
  const readyDeadline = Date.now() + 240000;
  let lastDetail = 'Waiting for the engine HTTP server.';
  while (Date.now() < readyDeadline) {
    if (signal.aborted) throw new Error('Setup cancelled. The selected ComfyUI was left running.');
    try {
      const nodes = await probeNodes(config.comfyUrl);
      const missing = ['StemStudioSeparate', 'LoadAudio', 'SaveAudio'].filter(name => !nodes[name]);
      if (!missing.length) return;
      lastDetail = `Waiting for audio nodes: ${missing.join(', ')}`;
    } catch (error) { lastDetail = error.message; }
    update({ message: 'Checking the required audio nodes…', detail: lastDetail });
    await pause(2000);
  }
  throw new Error(`ComfyUI audio readiness timed out: ${lastDetail}. Models and proxy remain prepared. Check comfy-startup.log.`);
}

export async function completeSetup(config, dependencies) {
  const { prepareRuntime, installEngine, ProxyManager, update, signal } = dependencies;
  await mkdir(config.userData, { recursive: true });
  const profile = { ...setupProfile(config.comfyRoot, ''), comfyUrl: config.comfyUrl };
  update({ message: 'Preparing the private API Proxy runtime…', detail: 'No system Python or ComfyUI package changes.' });
  await prepareRuntime(join(config.userData, 'managed-proxy'), update, signal);
  if (signal.aborted) throw new Error('Setup cancelled.');
  update({ message: 'Installing the ComfyUI audio integration…', detail: config.comfyRoot });
  const result = await installEngine(profile, join(config.resources, 'comfy_nodes', 'StemStudio'), nativeModelRoot(config.comfyRoot), update);
  // Save choices even if a supported automatic engine restart cannot be completed.
  profile.proxyUrl = await (dependencies.proxyAddress || proxyAddress)(profile.comfyUrl);
  profile.setupComplete = false;
  await writeFile(join(config.userData, 'connection.json'), JSON.stringify(profile, null, 2));
  await (dependencies.readyEngine || readyEngine)(config, update, signal, result.changed !== false, dependencies.probeNodes);
  if (signal.aborted) throw new Error('Setup cancelled.');
  update({ message: 'Checking the API Proxy connection…', detail: profile.proxyUrl });
  const manager = new ProxyManager(join(config.userData, 'managed-proxy'));
  const onAbort = () => manager.stop(); signal.addEventListener('abort', onAbort, { once: true });
  try { await manager.start(profile); } finally { signal.removeEventListener('abort', onAbort); manager.stop(); }
  if (signal.aborted) throw new Error('Setup cancelled.');
  profile.setupComplete = true;
  await writeFile(join(config.userData, 'connection.json'), JSON.stringify(profile, null, 2));
  return { message: 'ComfyUI, models, integration and proxy are ready.', detail: 'ComfyUI is already running in the background. Open Stem Studio; it will connect automatically. No second ComfyUI launch is needed.' };
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const controller = new AbortController();
  const reporter = createStatusWriter(config.statusFile);
  const update = patch => reporter.update(patch);
  const timer = setInterval(() => { stat(config.cancelFile).then(() => controller.abort()).catch(() => {}); }, 250);
  try {
    const base = join(config.resources, 'app.asar', 'electron');
    const { prepareRuntime, ProxyManager } = await import(pathToFileURL(join(base, 'proxy-manager.mjs')).href);
    const { installEngine } = await import(pathToFileURL(join(base, 'separation.mjs')).href);
    const { audioNodes: probeNodes } = await import(pathToFileURL(join(base, 'node-capabilities.mjs')).href);
    const result = await completeSetup(config, { prepareRuntime, installEngine, ProxyManager, probeNodes, update, signal: controller.signal });
    await writeFile(config.resultFile, JSON.stringify({ success: true, ...result }));
  } catch (error) { await writeFile(config.resultFile, JSON.stringify({ success: false, message: 'Setup needs attention.', detail: error.message })); process.exitCode = 2; }
  finally { clearInterval(timer); await reporter.flush(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
