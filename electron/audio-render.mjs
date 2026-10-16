import { Comfy } from '@comfyorg/sdk';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { channelEdit } from '../src/clip-edits.mjs';
import { normalizeEndpoint } from './connection.mjs';
import { nativeOutput } from './native-media.mjs';
export function editWorkflow(edits, prefix) {
  channelEdit(edits, 864000);
  return { '1': { class_type: 'LoadAudio', inputs: { audio: '' } }, '2': { class_type: 'StemStudioEditAudio', inputs: { audio: ['1',0], edits_json: JSON.stringify(edits) } }, '3': { class_type: 'SaveAudio', inputs: { audio: ['2',0], filename_prefix: prefix } } };
}
export class AudioRenderer {
  constructor(root, options = {}) { this.root = root; this.makeClient = options.makeClient || (() => new Comfy()); this.fetch = options.fetch || fetch; this.sleep = options.sleep || (() => new Promise(resolve => setTimeout(resolve,500))); this.active = false; }
  async cancel() { this.cancelled = true; if(this.job) await this.job.cancel(); }
  async render(profile, source, edits, nativeRoot) {
    if (!edits) return source;
    if(this.active) throw Error('An audio edit export is already running.');
    this.active = true; this.cancelled = false;
    try {
      const response = await this.fetch(`${normalizeEndpoint(profile.comfyUrl)}/object_info/StemStudioEditAudio`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.json()).StemStudioEditAudio) throw Error('Update the integration and restart idle ComfyUI to export edited audio.');
      process.env.COMFY_BASE_URL = normalizeEndpoint(profile.proxyUrl);
      const id = randomUUID(), prefix = `StemStudio/Edits/${id}/audio`, client = this.makeClient();
      const workflow = client.workflows.fromJson(editWorkflow(edits,prefix)); workflow.setInput('1','audio',client.assets.fromFile(source));
      if(this.cancelled) throw Error('Audio export cancelled.');
      this.job = await client.submit(workflow);
      while(true) { if(this.cancelled) { await this.job.cancel(); throw Error('Audio export cancelled.'); } await this.job.refresh(); if(!['queued','running','canceling'].includes(this.job.status)) break; await this.sleep(); }
      if(this.cancelled || this.job.status!=='succeeded') throw Error(`Audio edit export ${this.job.status}.`);
      const outputs=this.job.outputs.filter(output=>output.nodeId==='3' && output.type==='audio');
      if(outputs.length!==1) throw Error('Edited audio output was not returned.');
      let path = await nativeOutput(nativeRoot,prefix,outputs[0].name);
      if(nativeRoot && !path) throw Error('Edited native ComfyUI output could not be found.');
      if(!path) { await mkdir(this.root,{recursive:true}); path=join(this.root,`${id}.flac`); await outputs[0].toFile(path); }
      if(!(await stat(path)).size) throw Error('Edited audio output is empty.');
      return path;
    } finally { this.active=false;this.job=null; }
  }
}
