// Installs the official ComfyUI portable build for users who do not have ComfyUI yet.
// Runs in the setup helper process (Electron as plain Node). Everything is verified against the SHA-256 digest
// that GitHub publishes for the release asset, downloads resume after an interruption and nothing outside the chosen
// parent folder is touched.
import { existsSync } from 'node:fs';
import { downloadVerified, fileSha256 } from './download-verified.mjs';
export { downloadVerified, fileSha256 };
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { quietCommand } from './quiet-process.mjs';
import { createStatusWriter } from './status-writer.mjs';

export const RELEASE_API = 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest';
const ASSETS = { nvidia: 'ComfyUI_windows_portable_nvidia.7z', amd: 'ComfyUI_windows_portable_amd.7z', intel: 'ComfyUI_windows_portable_intel.7z' };
export const MIN_FREE_BYTES = 12 * 1024 ** 3;

export function gpuKind(names) {
  const text = (Array.isArray(names) ? names : [names]).filter(Boolean).join(' ').toLowerCase();
  if (/nvidia|geforce|rtx|quadro/.test(text)) return 'nvidia';
  if (/radeon|amd/.test(text)) return 'amd';
  if (/intel/.test(text)) return 'intel';
  return 'nvidia';
}
export function pickAsset(release, kind = 'nvidia') {
  const name = ASSETS[kind] || ASSETS.nvidia;
  const asset = release?.assets?.find(item => item.name === name);
  const match = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !match || !/^https:\/\/github\.com\//.test(asset.browser_download_url || '')) throw Error(`The latest ComfyUI release has no verifiable ${name}. Install ComfyUI yourself and choose it in setup.`);
  return { tag: String(release.tag_name || ''), name, size: asset.size, sha256: match[1].toLowerCase(), url: asset.browser_download_url };
}
export async function latestRelease(fetchImpl = fetch, signal) {
  const response = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'stem-studio-setup' }, signal });
  if (!response.ok) throw Error(`GitHub answered HTTP ${response.status} while looking for the latest ComfyUI release.`);
  return response.json();
}
const run = (file, args, spawnImpl) => new Promise(resolvePromise => {
  const command = quietCommand(file, args);
  let child; try { child = spawnImpl(command.file, command.args, { windowsHide: true, shell: false, stdio: 'ignore' }); } catch { resolvePromise(false); return; }
  child.once('error', () => resolvePromise(false)); child.once('close', code => resolvePromise(code === 0));
});
// Windows 10 and 11 ship bsdtar, which reads 7z; a locally installed 7-Zip is the fallback.
export async function extractArchive(archive, destination, { spawnImpl = spawn, env = process.env, exists = existsSync } = {}) {
  await mkdir(destination, { recursive: true });
  const system = join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (await run(exists(system) ? system : 'tar', ['-xf', archive, '-C', destination], spawnImpl)) return 'tar';
  for (const candidate of [join(env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe'), join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip', '7z.exe')]) {
    if (exists(candidate) && await run(candidate, ['x', archive, `-o${destination}`, '-y'], spawnImpl)) return '7z';
  }
  throw Error('Windows could not unpack the .7z archive. Install 7-Zip from 7-zip.org, then retry setup.');
}
export async function findComfyRoot(folder) {
  for (const candidate of [join(folder, 'ComfyUI_windows_portable', 'ComfyUI'), join(folder, 'ComfyUI')]) {
    try { if ((await stat(join(candidate, 'main.py'))).isFile()) return resolve(candidate); } catch { /* try the next layout */ }
  }
  return null;
}
export async function installComfyPortable({ parent, kind = 'nvidia', update = () => {}, signal, fetchImpl = fetch, spawnImpl = spawn, freeBytes }) {
  if (typeof parent !== 'string' || !/^[A-Za-z]:\\/.test(parent)) throw Error('Choose a local folder for ComfyUI.');
  await mkdir(parent, { recursive: true });
  const existing = await findComfyRoot(parent);
  if (existing) { update({ message: 'ComfyUI is already installed there.', detail: existing, percent: 100 }); return { root: existing, reused: true }; }
  if ((await readdir(join(parent, 'ComfyUI_windows_portable')).catch(() => [])).length) throw Error('The folder ComfyUI_windows_portable already exists and is not a working ComfyUI. Choose another location.');
  if (freeBytes !== undefined && freeBytes < MIN_FREE_BYTES) throw Error('ComfyUI needs about 12 GB of free disk space at that location.');
  update({ message: 'Looking up the latest official ComfyUI release…', detail: RELEASE_API, percent: 0 });
  const asset = pickAsset(await latestRelease(fetchImpl, signal), kind);
  const archive = join(parent, asset.name);
  update({ message: `Downloading ComfyUI ${asset.tag} (${(asset.size / 1024 ** 3).toFixed(1)} GB)`, detail: asset.url });
  let reported = 0;
  await downloadVerified(asset, archive, { fetchImpl, signal, onProgress: (done, total) => {
    const now = Date.now(); if (now - reported < 250 && done < total) return; reported = now;
    update({ message: `Downloading ComfyUI ${asset.tag}`, detail: `${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MiB`, percent: Math.round(done / total * 80) });
  } });
  if (signal?.aborted) throw Error('Setup cancelled.');
  update({ message: 'Unpacking ComfyUI. This can take several minutes.', detail: parent, percent: 82 });
  await extractArchive(archive, parent, { spawnImpl });
  const root = await findComfyRoot(parent);
  if (!root) throw Error('The archive unpacked but no ComfyUI main.py was found.');
  await rm(archive, { force: true });
  await writeFile(join(parent, 'ComfyUI_windows_portable', '.stemstudio-installed.json'), JSON.stringify({ tag: asset.tag, asset: asset.name, sha256: asset.sha256 }, null, 2)).catch(() => {});
  update({ message: 'ComfyUI is installed.', detail: root, percent: 100 });
  return { root, tag: asset.tag, reused: false };
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const controller = new AbortController();
  const reporter = createStatusWriter(config.statusFile);
  const timer = setInterval(() => { stat(config.cancelFile).then(() => controller.abort()).catch(() => {}); }, 250);
  try {
    const drive = await statfs(config.parent.slice(0, 3)).catch(() => null);
    const result = await installComfyPortable({ parent: config.parent, kind: config.gpu, update: patch => reporter.update(patch), signal: controller.signal, freeBytes: drive ? drive.bavail * drive.bsize : undefined });
    await writeFile(config.resultFile, JSON.stringify({ success: true, root: result.root, message: 'ComfyUI is ready.', detail: result.root }));
  } catch (error) { await writeFile(config.resultFile, JSON.stringify({ success: false, message: 'ComfyUI could not be installed.', detail: controller.signal.aborted ? 'Setup cancelled. A partial download is kept for retry.' : error.message })); process.exitCode = 2; }
  finally { clearInterval(timer); await reporter.flush(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
