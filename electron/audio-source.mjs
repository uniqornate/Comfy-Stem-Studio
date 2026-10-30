import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { comfyPython } from './mmaudio-manager.mjs';
import { quietCommand } from './quiet-process.mjs';
import { normalizeEndpoint } from './connection.mjs';

export const UPLOAD_LIMIT = 100 * 1024 * 1024;
export const SAFE_UPLOAD = 96 * 1024 * 1024;

export function audioWindows(duration, bytes, maxBytes = SAFE_UPLOAD) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(bytes) || bytes <= 0) throw Error('Could not measure the source audio.');
  if (bytes <= maxBytes) return [{ start: 0, end: duration }];
  const count = Math.ceil(bytes / (maxBytes * 0.8));
  const seconds = Math.max(1, Math.min(180, Math.ceil(duration / count)));
  const windows = [];
  for (let start = 0; start < duration; start += seconds) windows.push({ start, end: Math.min(duration, start + seconds) });
  return windows;
}

function runPython(python, script, source, destination, signal) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const quiet = quietCommand(python, [script, source, destination], env);
    const child = spawn(quiet.file, quiet.args, { env, windowsHide: true, shell: false, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-4000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1500); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(Error(`Audio preparation failed: ${stderr || `Python exit ${code}`}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(Error('Audio preparation did not return media information.')); }
    });
  });
}

export async function prepareAudioSource(profile, source, script, signal) {
  const python = await comfyPython(profile.installation || '');
  const sourceSize = (await stat(source)).size;
  if (!python) {
    if (sourceSize < SAFE_UPLOAD && /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(source)) return { path: source, size: sourceSize, duration: null, cleanup: async () => {} };
    throw Error('Audio-only preparation needs the Python bundled with your selected ComfyUI installation. Choose its folder in Connection settings.');
  }
  const folder = await mkdtemp(join(tmpdir(), 'stemstudio-audio-'));
  const destination = join(folder, `${randomUUID()}.mka`);
  try {
    const info = await runPython(python, script, source, destination, signal);
    if (!Number.isFinite(info.size) || info.size <= 0 || !Number.isFinite(info.duration) || info.duration <= 0) throw Error('Prepared audio has no measurable duration.');
    return { path: destination, size: info.size, duration: info.duration, cleanup: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(typeof body.error === 'string' ? body.error : body.error?.message || `ComfyUI HTTP ${response.status}`);
  return body;
}

// Files above the proxy/ComfyUI per-request ceiling are sent to the selected ComfyUI
// in bounded requests. The resulting ordinary input file is used by LoadAudio.
export async function uploadLargeAudio(profile, path, size, onProgress = () => {}, signal) {
  const base = normalizeEndpoint(profile.comfyUrl);
  const init = await responseJson(await fetch(`${base}/stemstudio/media/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: path, size }), signal }));
  try {
    let index = 0, sent = 0;
    for await (const part of createReadStream(path, { highWaterMark: Math.min(init.chunkBytes || 8 * 1024 * 1024, 8 * 1024 * 1024) })) {
      await responseJson(await fetch(`${base}/stemstudio/media/${init.token}/${index++}`, { method: 'PUT', body: part, signal }));
      sent += part.length; onProgress(sent / size);
    }
    const complete = await responseJson(await fetch(`${base}/stemstudio/media/${init.token}/complete`, { method: 'POST', signal }));
    return `${complete.subfolder}/${complete.name}`;
  } catch (error) {
    await fetch(`${base}/stemstudio/media/${init.token}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}
