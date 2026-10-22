import { readFile, writeFile, mkdir, rename, copyFile, stat, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { channelEdit } from '../src/clip-edits.mjs';
import { validGroups } from '../src/channel-groups.mjs';
import { nativePath, nativeRelative } from './native-media.mjs';
import { isSourcePath } from './media-types.mjs';

const idle = () => ({ phase: 'idle', message: '', stems: [], canCancel: false });
const nameOf = value => String(value || 'Untitled project').replace(/[\x00-\x1f]/g, '').trim().slice(0, 100) || 'Untitled project';
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
async function json(path) { const info = await stat(path); if (info.size > 8 * 1024 * 1024) throw Error('Project file is too large.'); return JSON.parse(await readFile(path, 'utf8')); }
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2));
  await copyFile(path, `${path}.bak`).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rename(temp, path);
}
function validate(doc) {
  if (!doc || doc.format !== 'stem-studio-project' || doc.version !== 1 || typeof doc.id !== 'string' || typeof doc.name !== 'string' || !Array.isArray(doc.runs) || doc.runs.length > 12) throw Error('Unsupported Stem Studio project.');
  const ids = new Set(); let count = 0;
  for (const run of doc.runs) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(run.runId) || typeof run.model !== 'string' || !Array.isArray(run.stems)) throw Error('Invalid project take.');
    for (const stem of run.stems) {
      const native = stem.native?.type === 'output' && typeof stem.native.relative === 'string' && !isAbsolute(stem.native.relative) && !stem.native.relative.split(/[\\/]/).includes('..') && /^StemStudio\/.+\.flac$/i.test(stem.native.relative);
      const asset = typeof stem.file === 'string' && /^assets[\/\\][a-zA-Z0-9_-]+\.flac$/.test(stem.file);
      if (++count > 8192 || typeof stem.label !== 'string' || !Number.isFinite(stem.size) || !/^[a-zA-Z0-9_-]{1,160}$/.test(stem.id) || ids.has(stem.id) || (!native && !asset) || (stem.native && !native) || (native && !doc.storage?.comfyRoot)) throw Error('Invalid project channel.');
      ids.add(stem.id);
    }
  }
  if (doc.source && (typeof doc.source.path !== 'string' || typeof doc.source.name !== 'string' || !Number.isFinite(doc.source.size) || !isAbsolute(doc.source.path) || !isSourcePath(doc.source.path))) throw Error('Invalid source reference.');
  if (doc.storage && (typeof doc.storage.comfyRoot !== 'string' || !isAbsolute(doc.storage.comfyRoot))) throw Error('Invalid ComfyUI storage root.');
  doc.view = view(doc.view);
  return doc;
}
// Only workspace data is persisted. Connection settings and HF tokens are excluded.
function view(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid project workspace.');
  const result = {};
  for (const key of ['selectedRun', 'model', 'activeOperation', 'target', 'detailMode', 'samVariant', 'lastGuidance', 'detailRequest', 'layoutZoom', 'workspaceShare', 'timelineExpanded', 'floatPosition', 'floatSize', 'exportMode', 'transport', 'timelines']) if (value[key] !== undefined) result[key] = value[key];
  if (JSON.stringify(result).length > 2 * 1024 * 1024) throw Error('Workspace settings are too large.');
  for (const key of ['selectedRun', 'model', 'activeOperation', 'target', 'detailMode', 'exportMode']) if (result[key] !== undefined && typeof result[key] !== 'string') throw Error('Invalid workspace selection.');
  for (const key of ['layoutZoom', 'workspaceShare']) if (result[key] !== undefined && !Number.isFinite(result[key])) throw Error('Invalid workspace scale.');
  if (result.transport) {
    const t = result.transport;
    if (!Number.isFinite(t.position) || !Number.isFinite(t.duration) || t.position < 0 || t.duration < 0 || (t.selection && (!Number.isFinite(t.selection.start) || !Number.isFinite(t.selection.end)))) throw Error('Invalid project transport.');
  }
  if (result.timelines) for (const timeline of Object.values(result.timelines)) {
    if (!timeline || !Array.isArray(timeline.collapsed) || !timeline.collapsed.every(id => typeof id === 'string') || !timeline.mix || typeof timeline.mix !== 'object' || !['zoom', 'waveHeight', 'scrollLeft', 'scrollTop'].every(key => Number.isFinite(timeline[key]))) throw Error('Invalid project timeline.');
    if (timeline.groups !== undefined && !validGroups(timeline.groups)) throw Error('Invalid channel groups.');
    if (timeline.channelColors !== undefined && (!timeline.channelColors || typeof timeline.channelColors !== 'object' || Array.isArray(timeline.channelColors) || !Object.values(timeline.channelColors).every(hex => typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)))) throw Error('Invalid channel colors.');
    if (timeline.edits) for (const edit of Object.values(timeline.edits)) channelEdit(edit, 864000);
    for (const px of [timeline.rowHeight, ...Object.values(timeline.rowHeights || {})]) if (px !== undefined && !(Number.isFinite(px) && px >= 24 && px <= 400)) throw Error('Invalid channel height.');
    for (const mix of Object.values(timeline.mix)) if (!mix || typeof mix.mute !== 'boolean' || typeof mix.solo !== 'boolean' || !Number.isFinite(mix.level) || mix.level < 0 || mix.level > 1) throw Error('Invalid channel mix.');
  }
  if (result.lastGuidance) {
    const g = result.lastGuidance;
    if (g.description !== undefined && typeof g.description !== 'string') throw Error('Invalid SAM description.');
    if (g.anchors && (!Array.isArray(g.anchors) || !g.anchors.every(anchor => anchor && ['+', '-'].includes(anchor.kind) && Number.isFinite(anchor.start) && Number.isFinite(anchor.end)))) throw Error('Invalid SAM examples.');
    if (g.visual && (!Array.isArray(g.visual.keyframes) || !g.visual.keyframes.every(frame => frame && Number.isFinite(frame.time) && frame.box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame.box[key]))))) throw Error('Invalid SAM picture guidance.');
  }
  if (result.detailRequest && (!result.detailRequest.stem || typeof result.detailRequest.stem.id !== 'string' || !Number.isFinite(result.detailRequest.start) || !Number.isFinite(result.detailRequest.end))) throw Error('Invalid selected detail region.');
  if (result.detailRequest) result.detailRequest = { stem: { id: result.detailRequest.stem.id }, start: result.detailRequest.start, end: result.detailRequest.end };
  return JSON.parse(JSON.stringify(result));
}

export class Projects {
  constructor(root, separation, sources, expose) {
    Object.assign(this, { root, separation, sources, expose }); this.current = null; this.path = ''; this.recent = []; this.queue = Promise.resolve(); this.lastInput = '';
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  info() { return { id: this.current.id, name: this.current.name, path: this.path, updatedAt: this.current.updatedAt }; }
  async remember() {
    const entry = this.info(); this.recent = [entry, ...this.recent.filter(item => item.path !== entry.path && item.id !== entry.id)].slice(0, 20);
    await atomic(join(this.root, 'projects.json'), { last: this.path, recent: this.recent });
  }
  async load(path) {
    let doc; let recovered = false;
    try { doc = validate(await json(path)); } catch (error) { try { doc = validate(await json(`${path}.bak`)); recovered = true; } catch { throw error; } }
    this.current = doc; this.path = path; this.lastInput = '';
    // Keep the valid backup until a subsequent successful save replaces the primary.
    if (recovered) await writeFile(path, JSON.stringify(doc, null, 2));
    await this.remember(); return this.hydrate(recovered ? ['Recovered the previous project save.'] : []);
  }
  async boot() {
    try { const index = await json(join(this.root, 'projects.json')); this.recent = Array.isArray(index.recent) ? index.recent.filter(item => item && typeof item.path === 'string' && typeof item.name === 'string').slice(0, 20) : []; if (index.last) return await this.load(index.last); } catch (error) { if (error.code !== 'ENOENT') this.bootWarning = `Last project could not be opened: ${error.message}`; }
    const result = await this.create('Untitled project'); if (this.bootWarning) result.warnings.push(this.bootWarning); return result;
  }
  async create(name, folder) {
    const id = randomUUID(), now = new Date().toISOString();
    this.path = join(folder || join(this.root, 'projects'), id, 'project.stemstudio.json');
    this.current = { format: 'stem-studio-project', version: 1, id, name: nameOf(name), createdAt: now, updatedAt: now, source: null, runs: [], view: {}, job: idle() };
    this.lastInput = ''; await atomic(this.path, this.current); await this.remember(); return this.hydrate();
  }
  resolveSource(url) { try { const parsed = new URL(url); return parsed.protocol === 'app-media:' && parsed.hostname === 'source' ? this.sources.get(parsed.pathname.slice(1)) : null; } catch { return null; } }
  async attach(source, installation) {
    const path = this.resolveSource(source.url); if (!path) throw Error('Choose a source video first.');
    const info = await stat(path);
    const comfyRoot = installation || this.current.storage?.comfyRoot;
    if (comfyRoot && !(await stat(join(comfyRoot, 'main.py')).catch(() => null))?.isFile()) throw Error('Select the existing ComfyUI folder in connection settings.');
    if (this.current.source) await this.create(basename(path).replace(/\.[^.]+$/, ''));
    let storedPath = path;
    if (comfyRoot) {
      this.current.storage = { comfyRoot };
      this.path = join(comfyRoot, 'output', 'StemStudio', this.current.id, 'project.stemstudio.json');
      const extension = /\.[^.]+$/.exec(path)?.[0] || '.mp4';
      storedPath = join(comfyRoot, 'input', 'StemStudio', this.current.id, `${randomUUID()}${extension}`);
      await mkdir(dirname(storedPath), { recursive: true });
      await copyFile(path, `${storedPath}.part`); await rename(`${storedPath}.part`, storedPath);
    }
    this.current.source = { path: storedPath, name: basename(path), size: info.size, ...(comfyRoot ? { native: { type: 'input', relative: nativeRelative(comfyRoot, 'input', storedPath) } } : {}) };
    if (this.current.name === 'Untitled project') this.current.name = nameOf(basename(path).replace(/\.[^.]+$/, ''));
    await atomic(this.path, this.current); await this.remember(); return this.hydrate();
  }
  async hydrate(warnings = [], restore = true) {
    if (restore) { this.separation.reset(); this.sources.clear(); }
    const doc = this.current; let source = null;
    if (doc.source) {
      const exists = (await stat(doc.source.path).catch(() => null))?.isFile();
      source = { name: doc.source.name, size: doc.source.size, url: exists ? this.expose(doc.source.path) : '', missing: !exists };
      if (!exists) warnings.push('Source video is missing. Relink it from Projects.');
    }
    const runs = [];
    for (const run of doc.runs) {
      const stems = [];
      for (const stem of run.stems) {
        const path = stem.native ? await nativePath(doc.storage.comfyRoot, 'output', stem.native.relative) : resolve(dirname(this.path), stem.file);
        const canonical = path ? await realpath(path).catch(() => null) : null;
        const exists = canonical && (stem.native || inside(await realpath(dirname(this.path)), canonical)) && (await stat(canonical)).isFile();
        if (exists) this.separation.outputs.set(stem.id, { path: canonical, native: stem.native, name: `${stem.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}-${stem.id.slice(0, 8)}.flac` });
        stems.push({ id: stem.id, label: stem.label, size: stem.size, ...(stem.parentId ? { parentId: stem.parentId } : {}), ...(stem.kind === 'brush' ? { kind: 'brush' } : {}), url: exists ? this.expose(canonical) : '', missing: !exists });
        if (!exists) warnings.push(`Missing channel: ${stem.label}`);
      }
      runs.push({ ...run, stems });
    }
    const interrupted = !['idle', 'complete', 'failed', 'cancelled'].includes(doc.job?.phase);
    const job = interrupted ? { ...idle(), phase: 'cancelled', message: 'Previous processing was interrupted. It was not submitted again; ComfyUI may still have the original job.' } : idle();
    if (restore) this.separation.state = job;
    return { info: this.info(), source, runs, view: doc.view || {}, job: restore ? job : this.separation.snapshot(), warnings };
  }
  async save(payload = {}) {
    if (!this.current || payload.projectId !== this.current.id) throw Error('The active project changed.');
    const activeJob = this.separation.snapshot();
    const supplied = Array.isArray(payload.runs) ? payload.runs : [];
    const runs = supplied.map(run => ({ ...run, stems: [...run.stems] }));
    if (activeJob.phase === 'complete' && activeJob.runId) {
      if (activeJob.rootRunId) { const root = runs.find(run => run.runId === activeJob.rootRunId); if (root) root.stems.push(...activeJob.stems.filter(stem => !root.stems.some(other => other.id === stem.id))); }
      else if (!runs.some(run => run.runId === activeJob.runId)) runs.push(activeJob);
    }
    const nextView = view(payload.view);
    const input = JSON.stringify({ runs, view: nextView, job: activeJob }); if (input === this.lastInput) return this.info();
    const durable = [];
    const known = new Map(this.current.runs.flatMap(item => item.stems).map(stem => [stem.id, stem]));
    for (const run of runs.slice(-12)) {
      const stems = [];
      for (const stem of run.stems) {
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(stem.id)) throw Error('Invalid channel id.');
        const existing = known.get(stem.id);
        const output = this.separation.outputs.get(stem.id);
        const file = `assets/${stem.id}.flac`, destination = join(dirname(this.path), file);
        if (!existing && !output?.native) {
          if (!output) throw Error(`Channel is unavailable: ${stem.label}`);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(output.path, `${destination}.part`); await rename(`${destination}.part`, destination);
        }
        // A renamed channel keeps its stored file; only the label follows the interface.
        const label = String(stem.label).slice(0, 160) || 'Channel';
        stems.push(existing ? { ...existing, label } : { id: stem.id, label, size: stem.size, ...(output?.native ? { native: output.native } : { file }), ...(stem.parentId ? { parentId: stem.parentId } : {}), ...(stem.kind === 'brush' ? { kind: 'brush' } : {}) });
      }
      durable.push({ runId: run.runId, model: String(run.model || ''), phase: 'complete', message: '', canCancel: false, stems });
    }
    const next = validate({ ...this.current, updatedAt: new Date().toISOString(), runs: durable, view: nextView, job: { phase: activeJob.phase } });
    await atomic(this.path, next); this.current = next; this.lastInput = input; await this.remember(); return this.info();
  }
  async rename(name) { this.current.name = nameOf(name); await atomic(this.path, this.current); await this.remember(); return this.info(); }
  async saveAs(folder, name) {
    const old = this.current, oldPath = this.path;
    const id = randomUUID(), target = join(folder, id, 'project.stemstudio.json');
    for (const stem of old.runs.flatMap(run => run.stems)) {
      if (stem.native) continue;
      const source = join(dirname(oldPath), stem.file); if (!(await stat(source).catch(() => null))?.isFile()) throw Error(`Cannot copy missing channel: ${stem.label}`);
      await mkdir(join(dirname(target), 'assets'), { recursive: true }); await copyFile(source, join(dirname(target), stem.file));
    }
    const now = new Date().toISOString(); const doc = { ...old, id, name: nameOf(name || `${old.name} copy`), createdAt: now, updatedAt: now };
    await atomic(target, doc); return this.load(target);
  }
  async relink(path) {
    if (!this.current.source) throw Error('This project has no source to relink.');
    let destination = path;
    if (this.current.storage?.comfyRoot) {
      destination = join(this.current.storage.comfyRoot, 'input', 'StemStudio', this.current.id, `${randomUUID()}${/\.[^.]+$/.exec(path)?.[0] || '.mp4'}`);
      await mkdir(dirname(destination), { recursive: true }); await copyFile(path, `${destination}.part`); await rename(`${destination}.part`, destination);
    }
    const next = validate({ ...this.current, source: { path: destination, name: basename(path), size: (await stat(path)).size } });
    await atomic(this.path, next); this.current = next; return this.hydrate();
  }
}
