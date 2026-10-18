// Resumable downloads with size and SHA-256 verification, shared by setup and the desktop app.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// The final file only appears after it verifies; an interrupted download resumes from its partial file.
export async function downloadVerified(asset, destination, { fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  const partial = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  if (existsSync(destination) && (await stat(destination)).size === asset.size && await fileSha256(destination) === asset.sha256) { onProgress(asset.size, asset.size); return destination; }
  let have = existsSync(partial) ? (await stat(partial)).size : 0;
  if (have > asset.size) { await rm(partial, { force: true }); have = 0; }
  let idle = 0;
  while (have < asset.size) {
    const before = have;
    if (signal?.aborted) throw Error('Setup cancelled. The partial download is kept for retry.');
    const response = await fetchImpl(asset.url, { headers: have ? { Range: `bytes=${have}-`, 'User-Agent': 'stem-studio-setup' } : { 'User-Agent': 'stem-studio-setup' }, signal });
    if (have && response.status !== 206) { await rm(partial, { force: true }); have = 0; if (response.status === 200) { await response.body?.cancel(); continue; } }
    if (!response.ok || !response.body) throw Error(`Download failed with HTTP ${response.status}.`);
    const tap = new Transform({ transform(chunk, _encoding, done) { have += chunk.length; onProgress(have, asset.size); done(null, chunk); } });
    try { await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(partial, { flags: have ? 'a' : 'w' }), { signal }); }
    catch (error) { if (signal?.aborted) throw Error('Setup cancelled. The partial download is kept for retry.'); throw error; }
    // A connection that ends early is resumed from the new offset; repeated passes without progress give up.
    idle = have > before ? 0 : idle + 1;
    if (idle >= 3) throw Error('The download stopped making progress. Check your connection and retry setup; the partial file is kept.');
  }
  if ((await stat(partial)).size !== asset.size) { await rm(partial, { force: true }); throw Error('The downloaded size does not match the release. Retry setup.'); }
  if (await fileSha256(partial) !== asset.sha256) { await rm(partial, { force: true }); throw Error('The downloaded ComfyUI archive failed its SHA-256 check and was deleted. Retry setup.'); }
  await rename(partial, destination);
  return destination;
}
