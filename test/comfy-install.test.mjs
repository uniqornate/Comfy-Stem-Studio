import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified, extractArchive, findComfyRoot, gpuKind, installComfyPortable, pickAsset } from '../setup/comfy-install.mjs';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const release = (bytes, name = 'ComfyUI_windows_portable_nvidia.7z') => ({ tag_name: 'v9.9.9', assets: [
  { name, size: bytes.length, digest: `sha256:${sha(bytes)}`, browser_download_url: `https://github.com/Comfy-Org/ComfyUI/releases/download/v9.9.9/${name}` },
  { name: 'ComfyUI_windows_portable_amd.7z', size: 5, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://github.com/Comfy-Org/ComfyUI/releases/download/v9.9.9/ComfyUI_windows_portable_amd.7z' },
] });
async function folder(t) { const root = await mkdtemp(join(tmpdir(), 'stemstudio-comfy-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function server(bytes, { cutFirstAt, ignoreRange = false, calls = [] } = {}) {
  return async (url, options = {}) => {
    calls.push([String(url), options.headers?.Range]);
    if (String(url).includes('api.github.com')) return new Response(JSON.stringify(release(bytes)), { status: 200 });
    const range = /bytes=(\d+)-/.exec(options.headers?.Range || ''), start = range && !ignoreRange ? Number(range[1]) : 0;
    const end = calls.filter(call => !call[0].includes('api.github.com')).length === 1 && cutFirstAt ? cutFirstAt : bytes.length;
    return new Response(bytes.subarray(start, end), { status: range && !ignoreRange ? 206 : 200 });
  };
}

test('GPU kind picks the matching portable build and defaults to NVIDIA', () => {
  assert.equal(gpuKind(['NVIDIA GeForce RTX 4090']), 'nvidia'); assert.equal(gpuKind(['AMD Radeon RX 7900']), 'amd');
  assert.equal(gpuKind(['Intel(R) Arc A770']), 'intel'); assert.equal(gpuKind([]), 'nvidia'); assert.equal(gpuKind(['Intel UHD', 'NVIDIA RTX 3060']), 'nvidia');
  const bytes = Buffer.from('archive');
  assert.equal(pickAsset(release(bytes), 'nvidia').sha256, sha(bytes)); assert.equal(pickAsset(release(bytes), 'amd').name, 'ComfyUI_windows_portable_amd.7z');
});
test('an asset without a SHA-256 digest or from another host is refused', () => {
  const bytes = Buffer.from('x'), good = release(bytes);
  assert.throws(() => pickAsset({ ...good, assets: [{ ...good.assets[0], digest: undefined }] }), /verifiable/);
  assert.throws(() => pickAsset({ ...good, assets: [{ ...good.assets[0], browser_download_url: 'https://evil.example/a.7z' }] }), /verifiable/);
  assert.throws(() => pickAsset({ tag_name: 'v1', assets: [] }), /verifiable/);
});
test('download resumes with a Range request after the connection ends early and verifies the hash', async t => {
  const root = await folder(t), bytes = Buffer.alloc(200000, 7), calls = [], asset = pickAsset(release(bytes));
  const destination = await downloadVerified(asset, join(root, 'a.7z'), { fetchImpl: server(bytes, { cutFirstAt: 80000, calls }) });
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(calls.map(call => call[1]), [undefined, 'bytes=80000-']);
  assert.deepEqual(await readdir(root), ['a.7z']);
  const again = await downloadVerified(asset, destination, { fetchImpl: async () => { throw Error('must not download again'); } });
  assert.equal(again, destination);
});
test('a server that ignores Range restarts cleanly and a wrong hash deletes the partial file', async t => {
  const root = await folder(t), bytes = Buffer.alloc(50000, 3), asset = pickAsset(release(bytes));
  await writeFile(join(root, 'b.7z.part'), bytes.subarray(0, 1000));
  await downloadVerified(asset, join(root, 'b.7z'), { fetchImpl: server(bytes, { ignoreRange: true }) });
  assert.deepEqual(await readFile(join(root, 'b.7z')), bytes);
  const tampered = { ...asset, sha256: '0'.repeat(64) };
  await assert.rejects(downloadVerified(tampered, join(root, 'c.7z'), { fetchImpl: server(bytes) }), /SHA-256/);
  assert.deepEqual((await readdir(root)).sort(), ['b.7z']);
});
test('a stalled connection gives up instead of looping forever, and cancel keeps the partial file', async t => {
  const root = await folder(t), bytes = Buffer.alloc(1000, 1), asset = pickAsset(release(bytes));
  await assert.rejects(downloadVerified(asset, join(root, 'd.7z'), { fetchImpl: async () => new Response(new Uint8Array(0), { status: 200 }) }), /stopped making progress/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadVerified(asset, join(root, 'e.7z'), { fetchImpl: server(bytes), signal: controller.signal }), /cancelled/);
});
function fakeSpawn(plan) {
  return (file, args) => { const child = new EventEmitter(); queueMicrotask(async () => { const code = await plan(file, args); child.emit('close', code); }); return child; };
}
test('extraction prefers Windows tar and falls back to 7-Zip, or explains what to install', async t => {
  const root = await folder(t), used = [];
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.equal(await extractArchive('a.7z', join(root, 'x'), { env, exists: () => true, spawnImpl: fakeSpawn(async file => { used.push(file); return 0; }) }), 'tar');
  used.length = 0;
  assert.equal(await extractArchive('a.7z', join(root, 'y'), { env, exists: () => true, spawnImpl: fakeSpawn(async file => { used.push(file); return /tar/i.test(file) ? 1 : 0; }) }), '7z');
  assert.ok(used.some(file => /7z\.exe$/.test(file)));
  await assert.rejects(extractArchive('a.7z', join(root, 'z'), { env, exists: () => false, spawnImpl: fakeSpawn(async () => 1) }), /Install 7-Zip/);
});
test('install downloads, unpacks into the chosen parent, removes the archive and reports its progress', async t => {
  const root = await folder(t); if (!/^[A-Za-z]:\\/.test(root)) return; // the installer only runs on Windows drive paths
  const bytes = Buffer.alloc(30000, 5), updates = [], parent = join(root, 'AI');
  const spawnImpl = fakeSpawn(async (file, args) => { const target = args[args.indexOf('-C') + 1]; await mkdir(join(target, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true }); await writeFile(join(target, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '# comfy'); return 0; });
  const result = await installComfyPortable({ parent, kind: 'nvidia', update: patch => updates.push(patch), fetchImpl: server(bytes), spawnImpl, freeBytes: 50 * 1024 ** 3 });
  assert.equal(result.root, join(parent, 'ComfyUI_windows_portable', 'ComfyUI')); assert.equal(result.reused, false);
  assert.ok(updates.some(update => update.percent === 100)); assert.ok(updates.some(update => /Downloading/.test(update.message)));
  assert.ok(!(await readdir(parent)).some(name => name.endsWith('.7z')));
  const again = await installComfyPortable({ parent, fetchImpl: async () => { throw Error('must not download'); }, spawnImpl, freeBytes: 50 * 1024 ** 3 });
  assert.equal(again.reused, true);
});
test('install refuses a drive without enough space or a foreign non-empty folder, and finds an existing install', async t => {
  const root = await folder(t); if (!/^[A-Za-z]:\\/.test(root)) return;
  await assert.rejects(installComfyPortable({ parent: root, fetchImpl: server(Buffer.from('x')), freeBytes: 1024 }), /12 GB/);
  await mkdir(join(root, 'ComfyUI_windows_portable'), { recursive: true }); await writeFile(join(root, 'ComfyUI_windows_portable', 'unrelated.txt'), 'x');
  await assert.rejects(installComfyPortable({ parent: root, fetchImpl: server(Buffer.from('x')), freeBytes: 50 * 1024 ** 3 }), /not a working ComfyUI/);
  await assert.rejects(installComfyPortable({ parent: 'relative/path' }), /local folder/);
  assert.equal(await findComfyRoot(root), null);
  await mkdir(join(root, 'ComfyUI'), { recursive: true }); await writeFile(join(root, 'ComfyUI', 'main.py'), '');
  assert.equal(await findComfyRoot(root), join(root, 'ComfyUI'));
  assert.ok((await stat(root)).isDirectory());
});
