import { copyFile as copy, mkdir as makeDirectory } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const safe = (value, fallback = 'item') => String(value || fallback).replace(/\.[^./\\]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || fallback;
// Runs one separation job per file, one after another, and copies every resulting channel into
// <output folder>/<file name> (<model>)/<channel>.flac. A failed file never stops the rest.
export class BatchRunner {
  constructor(separation) { this.separation = separation; this.active = false; this.cancelled = false; this.state = { phase: 'idle', items: [], current: -1, folder: '' }; }
  snapshot() { return structuredClone(this.state); }
  cancel() { this.cancelled = true; void this.separation.cancel?.().catch(() => {}); }
  async start(profile, files, folder, jobFor, tag) {
    if (this.active) throw Error('A batch is already running.');
    if (!Array.isArray(files) || !files.length || files.length > 200) throw Error('Choose between 1 and 200 files.');
    if (!folder) throw Error('Choose an output folder first.');
    this.active = true; this.cancelled = false;
    this.state = { phase: 'running', items: files.map(file => ({ name: file.name, status: 'queued', message: '', folder: '' })), current: 0, folder };
    this.pending = this.run(profile, files, folder, jobFor, tag).catch(error => { this.state.phase = 'failed'; this.state.message = error.message; }).finally(() => { this.active = false; });
    return this.snapshot();
  }
  async run(profile, files, folder, jobFor, tag) {
    for (let index = 0; index < files.length; index++) {
      const item = this.state.items[index];
      if (this.cancelled) { item.status = 'skipped'; continue; }
      this.state.current = index; item.status = 'running';
      try {
        await this.separation.start(profile, files[index].path, jobFor(files[index]));
        await this.separation.pending;
        const result = this.separation.snapshot();
        if (this.cancelled || result.phase === 'cancelled') { item.status = 'skipped'; continue; }
        if (result.phase !== 'complete') throw Error(result.message || 'Separation failed.');
        item.folder = await this.save(folder, `${safe(files[index].name)} (${safe(tag, 'model')})`, result.stems);
        item.status = 'done';
      } catch (error) { item.status = 'failed'; item.message = error.message; }
      finally { try { this.separation.reset(); } catch {} }
    }
    this.state.phase = this.cancelled ? 'cancelled' : this.state.items.some(item => item.status === 'failed') ? 'finished-with-errors' : 'complete';
    this.state.current = -1;
  }
  async save(parent, name, stems) {
    let target = join(parent, name), suffix = 1;
    for (;;) { try { await makeDirectory(target); break; } catch (error) { if (error.code !== 'EEXIST') throw error; target = join(parent, `${name} ${++suffix}`); } }
    const used = new Set();
    for (const stem of stems) {
      let label = safe(stem.label, 'channel'), count = 1; while (used.has(label.toLowerCase())) label = `${safe(stem.label, 'channel')} ${++count}`;
      used.add(label.toLowerCase());
      await copy(this.separation.output(stem.id).path, join(target, `${label}.flac`), fsConstants.COPYFILE_EXCL);
    }
    return target;
  }
}
export { safe as safeName };
