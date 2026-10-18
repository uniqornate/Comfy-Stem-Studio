import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { downloadVerified } from '../setup/download-verified.mjs';
import { normalizeEndpoint } from './connection.mjs';
import { BRUSH_FILES, BRUSH_FOLDER } from './brush.mjs';

export function brushFolder(profile) {
  const endpoint = new URL(normalizeEndpoint(profile.comfyUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !profile.installation) throw Error('The sound model needs the selected local ComfyUI folder.');
  return join(profile.installation, 'models', 'audio_separation', BRUSH_FOLDER);
}
export class BrushModelManager {
  constructor(options = {}) { this.files = options.files || BRUSH_FILES; this.fetchImpl = options.fetchImpl || fetch; this.state = { phase: 'idle', message: '', percent: -1 }; this.active = false; }
  async status(profile) {
    let ready = true;
    try { const folder = brushFolder(profile); for (const file of this.files) if ((await stat(join(folder, file.path)).catch(() => null))?.size !== file.size) ready = false; } catch { ready = false; }
    return { ...this.state, ready };
  }
  cancel() { this.abort?.abort(); }
  async start(profile) {
    if (this.active) throw Error('The sound model is already downloading.');
    const folder = brushFolder(profile);
    this.active = true; this.abort = new AbortController();
    this.state = { phase: 'downloading', message: 'Starting the download…', percent: 0 };
    this.pending = this.run(folder).catch(error => { this.state = { phase: this.abort.signal.aborted ? 'cancelled' : 'failed', message: this.abort.signal.aborted ? 'Download cancelled. The partial file is kept and resumes next time.' : error.message, percent: -1 }; }).finally(() => { this.active = false; });
    return { ...this.state, ready: false };
  }
  async run(folder) {
    const total = this.files.reduce((sum, file) => sum + file.size, 0);
    let before = 0;
    for (const file of this.files) {
      let reported = 0;
      await downloadVerified({ url: file.url, size: file.size, sha256: file.sha256 }, join(folder, file.path), { fetchImpl: this.fetchImpl, signal: this.abort.signal, onProgress: (done, size) => {
        const now = Date.now(); if (now - reported < 250 && done < size) return; reported = now;
        this.state = { phase: 'downloading', message: `Downloading ${file.name}`, percent: Math.round((before + done) / total * 100), detail: `${((before + done) / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MiB` };
      } });
      before += file.size;
    }
    this.state = { phase: 'complete', message: 'Sound model ready. Restart ComfyUI once so it lists the new files.', percent: 100 };
  }
}
