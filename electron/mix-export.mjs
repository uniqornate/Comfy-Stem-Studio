import { Comfy } from '@comfyorg/sdk';
import { rename, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEndpoint } from './connection.mjs';

export function flacWorkflow(prefix) {
  return { '1': { class_type: 'LoadAudio', inputs: { audio: '' } }, '3': { class_type: 'SaveAudio', inputs: { audio: ['1', 0], filename_prefix: prefix } } };
}
// Turns a rendered WAV mixdown into lossless FLAC with the same native SaveAudio node the stems use.
export class MixExporter {
  constructor(options = {}) { this.makeClient = options.makeClient || (() => new Comfy()); this.sleep = options.sleep || (() => new Promise(resolve => setTimeout(resolve, 400))); this.active = false; }
  async cancel() { this.cancelled = true; if (this.job) await this.job.cancel(); }
  async toFlac(profile, wavPath, destination) {
    if (this.active) throw Error('A mix export is already running.');
    this.active = true; this.cancelled = false;
    const partial = `${destination}.${randomUUID().slice(0, 8)}.part`;
    try {
      process.env.COMFY_BASE_URL = normalizeEndpoint(profile.proxyUrl);
      const client = this.makeClient(), workflow = client.workflows.fromJson(flacWorkflow(`StemStudio/Mixes/${randomUUID()}/mix`));
      workflow.setInput('1', 'audio', client.assets.fromFile(wavPath));
      this.job = await client.submit(workflow);
      while (true) {
        if (this.cancelled) { await this.job.cancel(); throw Error('Mix export cancelled.'); }
        await this.job.refresh();
        if (!['queued', 'running', 'canceling'].includes(this.job.status)) break;
        await this.sleep();
      }
      if (this.job.status !== 'succeeded') throw Error(`Mix export ${this.job.status}.`);
      const outputs = this.job.outputs.filter(output => output.nodeId === '3' && output.type === 'audio');
      if (outputs.length !== 1) throw Error('ComfyUI did not return the mixed audio.');
      await mkdir(dirname(destination), { recursive: true });
      await outputs[0].toFile(partial); await rename(partial, destination);
      return destination;
    } finally { await rm(partial, { force: true }); this.active = false; this.job = null; }
  }
}
export async function writeWav(bytes, destination) {
  const { writeFile } = await import('node:fs/promises');
  const partial = `${destination}.${randomUUID().slice(0, 8)}.part`;
  try { await writeFile(partial, bytes); await rename(partial, destination); } finally { await rm(partial, { force: true }); }
  return destination;
}
