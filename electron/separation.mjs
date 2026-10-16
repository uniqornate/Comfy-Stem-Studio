import { Comfy } from '@comfyorg/sdk';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdir, readFile, writeFile, stat, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { normalizeEndpoint } from './connection.mjs';
import { normalizeGuidance } from '../src/sam-guidance.mjs';
import { channelEdit } from '../src/clip-edits.mjs';
import { audioNodes } from './node-capabilities.mjs';
import { nativeOutput, nativeRelative } from './native-media.mjs';

const CHANNELS = [{ key: 'dialogue', label: 'Dialogue', node: '10' }, { key: 'music', label: 'Music', node: '11' }, { key: 'effects', label: 'Effects', node: '12' }];
function baseWorkflow(options = {}) {
  if (options.mode === 'uss' && options.target === 'All') return {
    '1': { class_type: 'LoadAudio', inputs: { audio: '' } },
    '2': { class_type: 'StemStudioExtractAll', inputs: { audio: ['1', 0], threshold: options.threshold ?? 0.1, ...(options.autoThreshold ? { auto_threshold: true } : {}) } },
  };
  if (options.mode === 'uss') return {
    '1': { class_type: 'LoadAudio', inputs: { audio: '' } },
    '2': { class_type: 'StemStudioExtract', inputs: { audio: ['1', 0], target: options.target, threshold: options.threshold ?? 0.1, ...(options.autoThreshold ? { auto_threshold: true } : {}) } },
    '10': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: 'StemStudio/target' } },
    '11': { class_type: 'SaveAudio', inputs: { audio: ['2', 1], filename_prefix: 'StemStudio/remainder' } },
  };
  if (options.mode === 'sam') {
    const prompts = options.sam ? normalizeGuidance(options.sam, options.range) : null;
    const visual = !!prompts?.keyframes.length;
    return {
    '1': { class_type: 'LoadAudio', inputs: { audio: '' } },
    '2': { class_type: 'StemStudioSAM', inputs: { audio: ['1', 0], description: prompts?.visualOnly ? '' : prompts?.description || options.target, ...(options.samModel ? { model_variant: options.samModel } : {}), ...(prompts ? { guidance_json: JSON.stringify(prompts) } : {}), ...(visual ? { video: ['6', 0], video_start: options.range.start } : {}) } },
    '10': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: 'StemStudio/sam-target' } },
    '11': { class_type: 'SaveAudio', inputs: { audio: ['2', 1], filename_prefix: 'StemStudio/sam-remainder' } },
    ...(visual ? { '6': { class_type: 'LoadVideo', inputs: { file: '' } } } : {}),
  };
  }
  const graph = { '1': { class_type: 'LoadAudio', inputs: { audio: '' } }, '2': { class_type: 'StemStudioSeparate', inputs: { audio: ['1', 0], segment_seconds: 12, model: options.model || 'mrx' } } };
  CHANNELS.forEach((channel, i) => { graph[channel.node] = { class_type: 'SaveAudio', inputs: { audio: ['2', i], filename_prefix: `StemStudio/${channel.key}` } }; });
  return graph;
}
export function stemWorkflow(options = {}) {
  const graph = baseWorkflow(options);
  if (options.outputPrefix) {
    if (!/^StemStudio\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(options.outputPrefix)) throw Error('Invalid project output prefix.');
    for (const node of Object.values(graph)) if (node.class_type === 'SaveAudio') node.inputs.filename_prefix = `${options.outputPrefix}/${node.inputs.filename_prefix.split('/').at(-1)}`;
    if (options.mode === 'uss' && options.target === 'All') graph['2'].inputs.filename_prefix = options.outputPrefix;
  }
  if (options.edits) {
    channelEdit(options.edits,864000);
    graph['7'] = { class_type:'StemStudioEditAudio',inputs:{ audio:['1',0],edits_json:JSON.stringify(options.edits) } };
    graph['2'].inputs.audio=['7',0];
  }
  if (!options.range) return graph;
  const { start, end } = options.range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 864000) throw Error('Select a valid channel range.');
  graph['3'] = { class_type: 'StemStudioAudioRange', inputs: { audio: [options.edits ? '7' : '1', 0], start_seconds: start, end_seconds: end } };
  graph['2'].inputs.audio = ['3', 0];
  if (options.mode === 'uss' && options.target === 'All') Object.assign(graph['2'].inputs, { range_reference: [options.edits ? '7' : '1', 0], range_start: start, suppress_duplicates: true });
  else for (const [save, restore, index] of [['10', '4', 0], ['11', '5', 1]]) {
    graph[restore] = { class_type: 'StemStudioRestoreRange', inputs: { audio: ['2', index], reference: [options.edits ? '7' : '1', 0], start_seconds: start } };
    graph[save].inputs.audio = [restore, 0];
  }
  return graph;
}
export async function engineStatus(profile, fetchImpl = fetch) {
  try {
    const nodes = await audioNodes(normalizeEndpoint(profile.comfyUrl), fetchImpl);
    const missing = ['LoadAudio', 'StemStudioSeparate', 'SaveAudio'].filter(name => !nodes[name]);
    const models = nodes.StemStudioSeparate?.input?.required?.model?.[0] || ['sfc'];
    const targets = nodes.StemStudioExtract?.input?.required?.target?.[0] || [];
    return { samModels: !!nodes.StemStudioSAM?.input?.optional?.model_variant, editAudio: !!nodes.StemStudioEditAudio, projectOutputs: !!nodes.StemStudioExtractAll?.input?.optional?.filename_prefix, detailRange: !!nodes.StemStudioAudioRange && !!nodes.StemStudioRestoreRange, sam: !!nodes.StemStudioSAM, samPrompts: !!nodes.StemStudioSAM?.input?.optional?.guidance_json, samVisual: !!nodes.StemStudioSAM?.input?.optional?.video && !!nodes.LoadVideo, ready: missing.length === 0, models, autoThreshold: !!nodes.StemStudioExtract?.input?.optional?.auto_threshold && !!nodes.StemStudioExtractAll?.input?.optional?.auto_threshold, targets: targets.filter(name => name !== 'USS models not installed' && (name !== 'All' || nodes.StemStudioExtractAll)), message: missing.length ? `Missing audio nodes: ${missing.join(', ')}. Install the integration, restart ComfyUI, then check again.` : 'Audio nodes available. Choose an installed separation model or USS target extraction.' };
  } catch (error) { return { ready: false, message: `Audio engine could not be checked: ${error.message}` }; }
}
export async function resolveCheckpoint(modelRoot) {
  for (const path of [join(modelRoot, 'sfc-locoformer-dnr', 'model.pth'), join(modelRoot, 'model.pth')]) {
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  throw new Error('SFC model.pth was not found. Choose the models folder or its sfc-locoformer-dnr subfolder.');
}
export async function copyIntegration(source, destination, update = () => {}) {
  const files = [];
  async function collect(relative = '') {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await collect();
  if (!files.includes('__init__.py')) throw new Error('Bundled integration files are missing. Reinstall Stem Studio.');
  let changed = false;
  for (let index = 0; index < files.length; index++) {
    const path = files[index];
    await mkdir(join(destination, path, '..'), { recursive: true });
    const input = await readFile(join(source, path));
    const current = await readFile(join(destination, path)).catch(() => null);
    if (!current || !input.equals(current)) { await writeFile(join(destination, path), input); changed = true; }
    update({ phase: 'copying', message: `Copying integration files (${index + 1}/${files.length})`, detail: path, current: index + 1, total: files.length });
  }
  return { count: files.length, changed };
}
export async function installEngine(profile, nodeSource, modelRoot, update = () => {}) {
  const url = new URL(normalizeEndpoint(profile.comfyUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Automatic node installation is for a local ComfyUI. Remote engines need the integration installed on that server.');
  if (!profile.installation || !(await stat(join(profile.installation, 'main.py')).catch(() => null))?.isFile()) throw new Error('Select the existing ComfyUI folder in Connection settings first.');
  const checkpoint = await resolveCheckpoint(modelRoot);
  const size = (await stat(checkpoint)).size;
  update({ phase: 'verifying', message: 'Verifying the SFC model…', detail: checkpoint, current: 0, total: size });
  const hash = createHash('sha256');
  let read = 0;
  try { for await (const chunk of createReadStream(checkpoint)) { hash.update(chunk); read += chunk.length; update({ current: read }); } }
  catch { throw new Error('SFC DnR model not found. Choose the model folder used during installation.'); }
  if (hash.digest('hex') !== 'b878ea0ffe29c67401727d51cdaab8db0394178d8e0eafa9d2ca5e241fd472e2') throw new Error('The SFC checkpoint failed verification. Recheck model preparation.');
  const destination = join(profile.installation, 'custom_nodes', 'StemStudio');
  const marker = join(destination, '.stemstudio.json');
  const existing = await stat(destination).catch(() => null);
  if (existing && !(await stat(marker).catch(() => null))) throw new Error('A StemStudio custom node folder already exists without an ownership marker. Move it aside before installing this integration.');
  await mkdir(destination, { recursive: true });
  await writeFile(marker, JSON.stringify({ owner: 'Stem Studio', integration: 1 }));
  const { count, changed } = await copyIntegration(nodeSource, destination, update);
  const runtime = JSON.stringify({ checkpoint, model_root: dirname(dirname(checkpoint)) }, null, 2);
  const oldRuntime = await readFile(join(destination, 'runtime.json'), 'utf8').catch(() => '');
  await writeFile(join(destination, 'runtime.json'), runtime);
  return { ready: false, changed: changed || runtime !== oldRuntime, message: `Installed ${count} integration files in ${destination}. Restart ComfyUI, then press Check audio engine. No downloads or Python package changes were needed.` };
}

export class Separation {
  constructor(cache, expose, options = {}) {
    this.cache = cache; this.expose = expose; this.makeClient = options.makeClient || (() => new Comfy()); this.check = options.check || engineStatus;
    this.state = { phase: 'idle', message: 'Choose a video, then separate its soundtrack.', stems: [], canCancel: false };
    this.outputs = new Map(); this.active = false; this.job = null;
  }
  snapshot() { return structuredClone(this.state); }
  reset() { if (this.active) throw new Error('A separation job is active.'); this.outputs.clear(); this.state = { phase: 'idle', message: '', stems: [], canCancel: false }; }
  async start(profile, sourcePath, options = {}) {
    if (this.active) throw new Error('A separation job is already active.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid separation options.');
    this.active = true; this.state = { phase: 'checking', message: 'Checking audio workflow…', stems: [], canCancel: false };
    if (!['sfc', 'bandit', 'mrx'].includes(options.model || 'mrx')) { this.active = false; throw new Error('Unknown model.'); }
    if (options.mode && !['stems', 'uss', 'sam'].includes(options.mode)) { this.active = false; throw new Error('Unknown operation.'); }
    try { stemWorkflow(options); } catch (error) { this.active = false; throw error; }
    this.pending = this.run(profile, sourcePath, options).catch(error => { this.state.phase = 'failed'; this.state.message = error.message; }).finally(() => { this.active = false; this.job = null; this.state.canCancel = false; });
    return this.snapshot();
  }
  async run(profile, sourcePath, options) {
    const status = await this.check(profile);
    if (!status.ready) throw new Error(status.message);
    if (options.mode === 'uss' && (!status.targets?.includes(options.target) || !Number.isFinite(options.threshold ?? 0.1) || (options.threshold ?? 0.1) < 0 || (options.threshold ?? 0.1) > 1)) throw new Error('Choose an installed USS target and valid threshold. Run setup with USS selected if it is missing.');
    if (options.mode === 'uss' && options.autoThreshold && !status.autoThreshold) throw new Error('Auto threshold needs the updated Stem Studio integration. Retry setup and restart ComfyUI, or select Manual.');
    if (options.outputPrefix && options.mode === 'uss' && options.target === 'All' && !status.projectOutputs) throw Error('Update the integration and restart idle ComfyUI to enable project-organized USS outputs.');
    if (options.mode === 'uss' && options.target === 'All' && (options.threshold ?? 0.1) <= 0) throw new Error('All needs a detection threshold above zero.');
    if (options.mode === 'sam' && (!status.sam || typeof options.target !== 'string' || !options.target.trim() || options.target.length > 200)) throw new Error('SAM integration or target is unavailable. Update integration and prepare SAM Audio.');
    if (options.range && !status.detailRange) throw new Error('Range extraction needs the updated integration. Retry setup and restart idle ComfyUI.');
    if (!['uss', 'sam'].includes(options.mode) && status.models && !status.models.includes(options.model || 'mrx')) throw new Error('This model is not installed. Select it in setup and restart ComfyUI.');
    if (options.samModel && !['small-tv','large-tv'].includes(options.samModel)) throw Error('Unsupported SAM model.');
    if (options.samModel === 'large-tv' && !status.samModels) throw Error('Update integration and restart idle ComfyUI to choose SAM Large.');
    if (options.edits && !status.editAudio) throw Error('Update integration and restart idle ComfyUI for edited-channel extraction.');
    if (options.sam && !status.samPrompts) throw Error('Update integration and restart idle ComfyUI to enable SAM guidance.');
    if (options.sam?.visual && (!status.samVisual || !options.samVideoPath)) throw Error('Visual guidance needs native LoadVideo and the original source video.');
    process.env.COMFY_BASE_URL = normalizeEndpoint(profile.proxyUrl);
    const client = this.makeClient();
    const workflow = client.workflows.fromJson(stemWorkflow(options));
    workflow.setInput('1', 'audio', client.assets.fromFile(sourcePath));
    if (options.sam?.visual) workflow.setInput('6', 'file', client.assets.fromFile(options.samVideoPath));
    this.state.phase = 'uploading'; this.state.message = 'Sending the source to your selected ComfyUI through the official SDK…';
    const job = await client.submit(workflow);
    this.job = job; this.state.canCancel = true;
    do {
      await job.refresh(); this.state.phase = job.status; this.state.message = `ComfyUI job: ${job.status}.`;
      if (!['queued', 'running', 'canceling'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (true);
    this.state.canCancel = false;
    if (job.status === 'canceled') { this.state.phase = 'cancelled'; this.state.message = 'Separation cancelled by ComfyUI.'; return; }
    if (job.status !== 'succeeded') throw new Error(`Separation ${job.status}: ${job.error?.message || JSON.stringify(job.error) || 'See the ComfyUI log.'}`);
    const targetName = (options.target || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'target';
    const channels = ['uss', 'sam'].includes(options.mode) ? [{ key: targetName, label: options.target, node: '10' }, { key: 'remainder', label: 'Remainder', node: '11' }] : CHANNELS;
    let selected = channels.map(channel => ({ ...channel, output: job.outputs.find(output => output.nodeId === channel.node && output.type === 'audio') }));
    if (options.mode === 'uss' && options.target === 'All') {
      const names = status.targets.filter(name => name !== 'All');
      const seen = new Set();
      selected = job.outputs.filter(output => output.nodeId === '2' && output.type === 'audio').map(output => {
        const match = /(?:^|\/)class-(\d{3})-/.exec((output.name || '').replaceAll('\\', '/'));
        const index = match ? Number(match[1]) : -1;
        if (!names[index] || seen.has(index)) throw new Error('USS All returned an unrecognized or duplicate sound channel.');
        seen.add(index);
        const key = `${String(index).padStart(3, '0')}-${names[index].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70)}`;
        return { key, label: names[index], node: '2', output };
      });
      if (!selected.length) throw new Error('USS All returned no detected channels. Lower the threshold or choose a specific target.');
    }
    if (selected.some(channel => !channel.output)) throw new Error('ComfyUI finished without the complete audio output set. No incomplete set was presented as successful.');
    this.state.phase = 'downloading'; this.state.message = options.nativeRoot ? `Reading ${selected.length} native ComfyUI outputs…` : `Receiving and caching ${selected.length} stem files…`;
    const directory = join(this.cache, randomUUID()); if (!options.nativeRoot) await mkdir(directory, { recursive: true });
    const stems = [];
    for (const channel of selected) {
      const prefix = options.outputPrefix ? `${options.outputPrefix}/${channel.key}` : '';
      let path = await nativeOutput(options.nativeRoot, prefix, channel.output.name);
      if (options.nativeRoot && !path) throw Error(`Native ComfyUI output could not be found: ${channel.output.name}. Check the selected installation and its output directory.`);
      const native = path ? { type: 'output', relative: nativeRelative(options.nativeRoot, 'output', path), assetId: channel.output.id, jobId: channel.output.jobId } : null;
      if (!path) { path = join(directory, `${channel.key}.flac`); await channel.output.toFile(path); }
      const info = await stat(path); if (info.size === 0) throw new Error(`${channel.label} output was empty.`);
      const id = randomUUID(); this.outputs.set(id, { path, native, name: options.parentId ? `${options.parentId.slice(0, 8)}-${channel.key}-${id.slice(0, 6)}.flac` : `${channel.key}.flac` });
      stems.push({ id, label: channel.label, size: info.size, url: this.expose(path), ...(options.parentId ? { parentId: options.parentId } : {}) });
    }
    this.state = { phase: 'complete', message: `${selected.length} channels ready. Preview or save each channel, or download all.`, stems, canCancel: false, runId: randomUUID(), parentId: options.parentId, rootRunId: options.rootRunId, model: ['uss', 'sam'].includes(options.mode) ? `${options.mode.toUpperCase()} · ${options.target}` : options.model || 'mrx' };
  }
  async cancel() { if (this.job && this.state.canCancel) { await this.job.cancel(); this.state.message = 'Cancellation requested. Waiting for ComfyUI to confirm.'; } return this.snapshot(); }
  output(id) { const value = this.outputs.get(id); if (!value) throw new Error('This stem is not available. Run separation first.'); return value; }
  async saveOne(id, path) { await copyFile(this.output(id).path, path); }
  async saveAll(parent, ids = this.state.stems.map(stem => stem.id)) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 8192) throw new Error('Run separation before exporting stems.');
    const items = ids.map(id => this.output(id));
    const folder = join(parent, `StemStudio-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
    await mkdir(folder);
    let saved = 0;
    try { for (const item of items) { await copyFile(item.path, join(folder, item.name), constants.COPYFILE_EXCL); saved++; } }
    catch (error) { throw new Error(`Saved ${saved} of ${items.length} files in ${folder}. ${error.message}`); }
    return folder;
  }
}
