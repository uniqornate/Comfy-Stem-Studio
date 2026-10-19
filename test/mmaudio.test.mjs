import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Separation, stemWorkflow } from '../electron/separation.mjs';
import { normalizeBrush, brushFiles, BRUSH_MEDIUM_CHECKPOINT, BRUSH_ENCODER } from '../electron/brush.mjs';
import { MMAUDIO_CLIP, MMAUDIO_FILES, MMAUDIO_MODEL, MMAUDIO_SYNC, MMAUDIO_VAE, mmaudioCapability, mmaudioFolders } from '../electron/mmaudio.mjs';
import { MMAudioManager, comfyPython, verifyPack } from '../electron/mmaudio-manager.mjs';
import manifest from '../electron/mmaudio-manifest.json' with { type: 'json' };

const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
const brush = { prompt: 'door slam', seconds: 3, start: 5, seed: 1 };
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

test('Medium uses its own checkpoint, the same encoder and the same sampler', () => {
  const graph = stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, model: 'medium' } });
  assert.equal(graph['2'].inputs.ckpt_name, BRUSH_MEDIUM_CHECKPOINT); assert.equal(graph['3'].inputs.clip_name, BRUSH_ENCODER);
  assert.deepEqual(brushFiles('medium').map(file => file.path), [BRUSH_MEDIUM_CHECKPOINT, BRUSH_ENCODER]);
  assert.match(brushFiles('medium')[0].sha256, /^[0-9a-f]{64}$/); assert.equal(brushFiles('medium')[0].size, 9222116660);
  assert.throws(() => normalizeBrush({ ...brush, model: 'nope' }), /Unknown sound model/);
  assert.throws(() => normalizeBrush({ ...brush, video: true }), /Unknown sound model/);
});
test('MMAudio graph uses the pinned files, the sampler, and optionally the cut video', () => {
  const text = stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio' } });
  assert.equal(text['20'].inputs.mmaudio_model, MMAUDIO_MODEL); assert.equal(text['21'].inputs.clip_model, MMAUDIO_CLIP);
  assert.equal(text['7'].class_type, 'MMAudioSampler'); assert.equal(text['7'].inputs.duration, 3); assert.equal(text['7'].inputs.images, undefined); assert.equal(text['6'], undefined);
  assert.deepEqual(text['9'].inputs.reference, ['1', 0]); assert.equal(text['9'].inputs.start_seconds, 5); assert.equal(text['10'].class_type, 'SaveAudio');
  const video = stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio', video: true } });
  assert.equal(video['6'].class_type, 'LoadVideo'); assert.deepEqual(video['22'].inputs, { video: ['6', 0], start_seconds: 5, seconds: 3 }); assert.deepEqual(video['7'].inputs.images, ['22', 0]);
  assert.match(stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio' }, outputPrefix: 'StemStudio/p/r' })['10'].inputs.filename_prefix, /^StemStudio\/p\/r\/brush$/);
  assert.throws(() => stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, seconds: 13, model: 'mmaudio' } }), /at a time/);
  assert.doesNotThrow(() => stemWorkflow({ mode: 'brush', target: 'x', brush: { ...brush, seconds: 13, model: 'small' } }));
});
test('MMAudio weights are pinned and the capability needs the nodes and every listed file', () => {
  for (const file of MMAUDIO_FILES) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.url.startsWith('https://huggingface.co/')); assert.match(file.url, /resolve\/[0-9a-f]{40}\//); }
  const nodes = { MMAudioModelLoader: { input: { required: { mmaudio_model: [[MMAUDIO_MODEL]] } } }, MMAudioFeatureUtilsLoader: { input: { required: { vae_model: [[MMAUDIO_VAE]], synchformer_model: [[MMAUDIO_SYNC]], clip_model: [[MMAUDIO_CLIP]] } } }, MMAudioSampler: {}, StemStudioVideoClip: {} };
  assert.deepEqual(mmaudioCapability(nodes), { mmaudio: true, mmaudioModel: true });
  assert.deepEqual(mmaudioCapability({ ...nodes, MMAudioModelLoader: { input: { required: { mmaudio_model: [['other']] } } } }), { mmaudio: true, mmaudioModel: false });
  assert.deepEqual(mmaudioCapability({ ...nodes, StemStudioVideoClip: undefined }), { mmaudio: false, mmaudioModel: false });
  assert.throws(() => mmaudioFolders({ comfyUrl: 'http://example.com:8188', installation: 'C:/Comfy' }), /local ComfyUI/);
  assert.ok(mmaudioFolders({ ...profile, installation: 'C:/Comfy' }).node.replace(/\\/g, '/').endsWith('custom_nodes/ComfyUI-MMAudio'));
});
test('node pack verification accepts the pinned files only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-pack-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = { '__init__.py': 'a', 'nodes.py': 'b', 'requirements.txt': 'c', 'sub/x.json': 'd' };
  await mkdir(join(root, 'sub'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const good = { files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, blob(Buffer.from(text))])) };
  assert.equal(await verifyPack(root, good), 4);
  await writeFile(join(root, 'nodes.py'), 'tampered');
  await assert.rejects(verifyPack(root, good), /differs from the pinned version \(nodes\.py\)/);
  await writeFile(join(root, 'nodes.py'), 'b'); await writeFile(join(root, 'extra.py'), 'x');
  await assert.rejects(verifyPack(root, good), /extra\.py/);
  assert.equal(manifest.commit.length, 40); assert.ok(manifest.files['nodes.py'] && manifest.files['requirements.txt'] && manifest.files['__init__.py']);
});
test('manager installs the pack, packages and weights, and refuses a foreign node folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-mmaudio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const comfy = join(root, 'ComfyUI'); await mkdir(comfy, { recursive: true }); await writeFile(join(comfy, 'main.py'), '');
  await mkdir(join(root, 'python_embeded'), { recursive: true }); await writeFile(join(root, 'python_embeded', 'python.exe'), '');
  const installed = { ...profile, installation: comfy };
  assert.equal((await comfyPython(comfy)).replace(/\\/g, '/').endsWith('python_embeded/python.exe'), true);
  const packFiles = { '__init__.py': 'init', 'nodes.py': 'nodes', 'requirements.txt': 'einops' };
  const fakeManifest = { repo: 'x/y', commit: 'c'.repeat(40), files: Object.fromEntries(Object.entries(packFiles).map(([name, text]) => [name, blob(Buffer.from(text))])) };
  const bytes = Buffer.alloc(1500, 5);
  const files = [{ path: 'nvidia/v/a.bin', name: 'a', url: 'https://example.invalid/a', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  const commands = []; let importable = false;
  const spawn = (file, args) => {
    commands.push(args.join(' '));
    const listeners = {}; const child = { stdout: { on() {} }, stderr: { on() {} }, once: (name, fn) => { listeners[name] = fn; } };
    queueMicrotask(() => { if (args.includes('install')) importable = true; listeners.close?.(args[0] === '-c' && !importable ? 1 : 0); });
    return child;
  };
  const extract = async (archive, destination) => { const folder = join(destination, 'ComfyUI-MMAudio-x'); await mkdir(folder, { recursive: true }); for (const [name, text] of Object.entries(packFiles)) await writeFile(join(folder, name), text); };
  const fetchImpl = async url => url.includes('codeload') ? new Response(Buffer.from('zip')) : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const manager = new MMAudioManager({ fetchImpl, spawn, extract, files, manifest: fakeManifest });
  assert.equal((await manager.status(installed)).ready, false);
  await manager.start(installed); await manager.pending;
  assert.equal(manager.state.phase, 'complete', manager.state.message);
  const status = await manager.status(installed);
  assert.deepEqual([status.node, status.weights, status.deps, status.ready], [true, true, true, true]);
  assert.ok(commands.some(command => command.includes('pip install') && command.includes('requirements.txt')));
  assert.equal((await stat(join(comfy, 'custom_nodes', 'ComfyUI-MMAudio', '.stemstudio.json'))).isFile(), true);
  assert.equal(await readFile(join(comfy, 'custom_nodes', 'ComfyUI-MMAudio', 'nodes.py'), 'utf8'), 'nodes');
  const other = join(root, 'Other'); await mkdir(join(other, 'custom_nodes', 'ComfyUI-MMAudio'), { recursive: true }); await writeFile(join(other, 'main.py'), '');
  await assert.rejects(new MMAudioManager({ fetchImpl, spawn, extract, files, manifest: fakeManifest }).start({ ...profile, installation: other }), /not installed by Stem Studio/);
});
test('MMAudio and Medium jobs are refused until ComfyUI lists them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-mm-job-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, 'a.flac'); await writeFile(audio, 'a'); const video = join(root, 'v.mp4'); await writeFile(video, 'v');
  let submitted;
  const client = { assets: { fromFile: path => path }, workflows: { fromJson: graph => ({ graph, setInput(node, input, value) { (this.set ||= []).push([node, input, value]); } }) }, submit: async workflow => { submitted = workflow; return { status: 'succeeded', refresh: async () => {}, outputs: [{ nodeId: '10', type: 'audio', name: 'brush_1.flac', toFile: path => writeFile(path, 'x') }] }; } };
  const run = async (status, options) => { const runner = new Separation(join(root, `c${Math.random()}`), path => path, { check: async () => ({ ready: true, ...status }), makeClient: () => client }); await runner.start(profile, audio, options); await runner.pending; return runner.snapshot(); };
  const ok = await run({ mmaudio: true, mmaudioModel: true, detailRange: true, samVisual: true }, { mode: 'brush', target: 'door slam', brush: { ...brush, model: 'mmaudio', video: true }, samVideoPath: video });
  assert.equal(ok.phase, 'complete'); assert.deepEqual(submitted.set.find(item => item[0] === '6'), ['6', 'file', video]);
  assert.match((await run({ mmaudio: true, mmaudioModel: false, detailRange: true }, { mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio' } })).message, /does not list the MMAudio files/);
  assert.match((await run({ mmaudio: false, detailRange: true }, { mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio' } })).message, /node pack/);
  assert.match((await run({ mmaudio: true, mmaudioModel: true, detailRange: true, samVisual: false }, { mode: 'brush', target: 'x', brush: { ...brush, model: 'mmaudio', video: true }, samVideoPath: video })).message, /LoadVideo/);
  assert.match((await run({ brush: true, brushModels: { small: true, medium: false } }, { mode: 'brush', target: 'x', brush: { ...brush, model: 'medium' } })).message, /not listed/);
  assert.equal((await run({ brush: true, brushModels: { small: true, medium: true } }, { mode: 'brush', target: 'x', brush: { ...brush, model: 'medium' } })).phase, 'complete');
});
