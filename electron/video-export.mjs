import { Comfy } from '@comfyorg/sdk';
import { stat, rename, rm, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEndpoint } from './connection.mjs';

export function validateVideoExport(stems, options) {
  if (options.format !== 'mkv' || !['mix', 'tracks'].includes(options.mode)) throw new Error('Native lossless export requires MKV and a valid audio mode.');
  if (!Array.isArray(stems) || !stems.length || stems.length > 527 || new Set(stems.map(item => item.id)).size !== stems.length) throw new Error('Choose available stem channels.');
  for (const stem of stems) if (!Number.isFinite(stem.level) || stem.level < 0 || stem.level > 1 || typeof stem.mute !== 'boolean' || typeof stem.solo !== 'boolean') throw new Error('Invalid channel mix.');
}
export function videoWorkflow(stems, options) {
  validateVideoExport(stems, options);
  const graph = { '1': { class_type: 'LoadVideo', inputs: { file: '' } } };
  let previous;
  stems.forEach((stem, index) => {
    const id = String(10 + index);
    graph[id] = { class_type: 'StemStudioVideoTrack', inputs: { file: '', label: String(stem.label).replace(/[\r\n]/g, ' ').slice(0, 120), mute: stem.mute, solo: stem.solo, level: stem.level, ...(previous ? { previous: [previous, 0] } : {}) } };
    previous = id;
  });
  graph['2'] = { class_type: 'StemStudioVideo', inputs: { video: ['1', 0], tracks: [previous, 0], mode: options.mode } };
  graph['3'] = { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: `StemStudio/Exports/${randomUUID()}`, format: 'mkv', 'format.codec': 'auto' } };
  return graph;
}
export async function nativeVideoStatus(profile, fetchImpl = fetch) {
  const endpoint = normalizeEndpoint(profile.comfyUrl);
  const names = ['LoadVideo', 'SaveVideo', 'StemStudioVideoTrack', 'StemStudioVideo'];
  const found = await Promise.all(names.map(async name => {
    const response = await fetchImpl(`${endpoint}/object_info/${name}`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return false;
    return !!(await response.json())[name];
  }));
  const missing = names.filter((_, index) => !found[index]);
  if (missing.length) throw new Error(`Native video export nodes missing: ${missing.join(', ')}. Run the updated Stem Studio setup and restart ComfyUI.`);
}
export class VideoExporter {
  constructor(options = {}) { this.makeClient = options.makeClient || (() => new Comfy()); this.check = options.check || nativeVideoStatus; this.sleep = options.sleep || (() => new Promise(resolve => setTimeout(resolve, 500))); this.active = false; this.job = null; this.cancelled = false; this.controller = null; this.state = { phase: 'idle', progress: 0, message: '' }; }
  snapshot() { return { ...this.state }; }
  async cancel() { this.cancelled = true; this.controller?.abort(); if (this.job) await this.job.cancel(); }
  async run(profile, source, stems, options, target) {
    if (this.active) throw new Error('A video export is already running.');
    validateVideoExport(stems, options);
    const temporary = join(dirname(target), `.stemstudio-${randomUUID()}.partial.mkv`);
    this.active = true; this.cancelled = false; this.controller = new AbortController(); this.state = { phase: 'running', progress: 0, message: 'Checking native ComfyUI video export…' };
    try {
      const canonicalTarget = (await realpath(target).catch(() => resolve(target))).toLowerCase();
      for (const input of [source, ...stems.map(stem => stem.path)]) if ((await realpath(input).catch(() => resolve(input))).toLowerCase() === canonicalTarget) throw new Error('Choose a new export filename.');
      await this.check(profile);
      if (this.cancelled) throw new Error('Video export cancelled.');
      process.env.COMFY_BASE_URL = normalizeEndpoint(profile.proxyUrl);
      const client = this.makeClient(); const workflow = client.workflows.fromJson(videoWorkflow(stems, options));
      workflow.setInput('1', 'file', client.assets.fromFile(source));
      stems.forEach((stem, index) => workflow.setInput(String(10 + index), 'file', client.assets.fromFile(stem.path)));
      this.state.message = 'Uploading video and stem assets through the official ComfyUI SDK…';
      this.job = await client.submit(workflow, { signal: this.controller.signal });
      if (this.cancelled) { await this.job.cancel(); throw new Error('Video export cancelled.'); }
      while (true) {
        await this.job.refresh();
        this.state.message = `ComfyUI SaveVideo: ${this.job.status}.`;
        if (Number.isFinite(this.job.progress?.value)) this.state.progress = Math.max(0, Math.min(0.95, this.job.progress.value));
        if (this.cancelled) throw new Error('Video export cancelled.');
        if (!['queued', 'running', 'canceling'].includes(this.job.status)) break;
        await this.sleep();
      }
      if (this.job.status === 'canceled') { this.cancelled = true; throw new Error('Video export cancelled by ComfyUI.'); }
      if (this.job.status !== 'succeeded') throw new Error(`ComfyUI SaveVideo failed: ${this.job.error?.message || this.job.status}`);
      const outputs = this.job.outputs.filter(output => output.nodeId === '3' && ['video', 'image'].includes(output.type) && /\.mkv$/i.test(output.name || ''));
      if (outputs.length !== 1) throw new Error('SaveVideo did not return exactly one MKV video. No export was published.');
      this.state.message = 'Receiving the saved video from ComfyUI…'; this.state.progress = 0.98;
      await outputs[0].toFile(temporary, { signal: this.controller.signal });
      if (this.cancelled) throw new Error('Video export cancelled.');
      if (!(await stat(temporary)).size) throw new Error('SaveVideo returned an empty file.');
      await rename(temporary, target);
      this.state = { phase: 'complete', progress: 1, message: 'Video exported through native ComfyUI SaveVideo.' }; return target;
    } catch (error) { this.state = { phase: this.cancelled ? 'cancelled' : 'failed', progress: 0, message: error.message }; throw error; }
    finally { this.job = null; this.controller = null; this.active = false; await rm(temporary, { force: true }).catch(() => {}); }
  }
}
