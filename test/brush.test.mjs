import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRUSH_CHECKPOINT, BRUSH_ENCODER, BRUSH_FILES, brushCapability, normalizeBrush } from '../electron/brush.mjs';
import { BrushModelManager, brushFolder } from '../electron/brush-manager.mjs';
import { Separation, stemWorkflow } from '../electron/separation.mjs';

const brush = { prompt: ' footsteps on gravel ', seconds: 2.5, start: 4.25, seed: 7 };

test('brush settings are validated and normalised', () => {
  assert.deepEqual(normalizeBrush(brush), { prompt: 'footsteps on gravel', seconds: 2.5, start: 4.25, seed: 7, steps: 8, model: 'small', video: false });
  for (const bad of [null, {}, { ...brush, prompt: '   ' }, { ...brush, prompt: 'x'.repeat(301) }, { ...brush, seconds: 0.1 }, { ...brush, seconds: 61 }, { ...brush, start: -1 }, { ...brush, steps: 2 }, { ...brush, seed: 1.5 }, { ...brush, seconds: NaN }]) assert.throws(() => normalizeBrush(bad));
});
test('brush graph uses native Stable Audio 3 nodes and pads the painted clip to the source timeline', () => {
  const graph = stemWorkflow({ mode: 'brush', target: 'footsteps', brush });
  assert.equal(graph['2'].inputs.ckpt_name, BRUSH_CHECKPOINT); assert.equal(graph['3'].inputs.clip_name, BRUSH_ENCODER); assert.equal(graph['3'].inputs.type, 'stable_audio');
  assert.equal(graph['4'].inputs.text, 'footsteps on gravel'); assert.equal(graph['6'].inputs.seconds, 2.5);
  assert.deepEqual([graph['7'].inputs.steps, graph['7'].inputs.cfg, graph['7'].inputs.sampler_name, graph['7'].inputs.scheduler], [8, 1, 'lcm', 'simple']);
  assert.deepEqual(graph['8'].inputs.vae, ['2', 2]); assert.equal(graph['9'].class_type, 'StemStudioRestoreRange'); assert.equal(graph['9'].inputs.start_seconds, 4.25); assert.deepEqual(graph['9'].inputs.reference, ['1', 0]);
  assert.equal(graph['10'].class_type, 'SaveAudio'); assert.equal(Object.values(graph).filter(node => node.class_type === 'SaveAudio').length, 1);
  assert.throws(() => stemWorkflow({ mode: 'brush', target: 'x' }));
  assert.match(stemWorkflow({ mode: 'brush', target: 'x', brush, outputPrefix: 'StemStudio/p/r' })['10'].inputs.filename_prefix, /^StemStudio\/p\/r\/brush$/);
});
const nodes = (over = {}) => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[BRUSH_CHECKPOINT]] } } }, CLIPLoader: { input: { required: { clip_name: [[BRUSH_ENCODER]], type: [['stable_diffusion', 'stable_audio']] } } }, CLIPTextEncode: {}, KSampler: {}, EmptyLatentAudio: {}, VAEDecodeAudio: {}, StemStudioRestoreRange: {}, ...over });
test('capability separates missing nodes from a missing model file', () => {
  const flags = value => ({ brush: value.brush, brushModel: value.brushModel, small: value.brushModels.small, medium: value.brushModels.medium });
  assert.deepEqual(flags(brushCapability(nodes())), { brush: true, brushModel: true, small: true, medium: false });
  assert.equal(brushCapability(nodes({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[BRUSH_CHECKPOINT, 'stable_audio_3_medium.safetensors']] } } } })).brushModels.medium, true);
  assert.deepEqual(flags(brushCapability(nodes({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['other.safetensors']] } } } }))), { brush: true, brushModel: false, small: false, medium: false });
  assert.deepEqual(flags(brushCapability(nodes({ CLIPLoader: { input: { required: { clip_name: [[BRUSH_ENCODER]], type: [['stable_diffusion']] } } } }))), { brush: false, brushModel: false, small: false, medium: false });
  assert.deepEqual(flags(brushCapability({})), { brush: false, brushModel: false, small: false, medium: false });
});
test('the model manifest pins revisions, sizes and hashes for both files', () => {
  assert.equal(BRUSH_FILES.length, 2);
  for (const file of BRUSH_FILES) { assert.match(file.url, /^https:\/\/huggingface\.co\/Comfy-Org\/stable-audio-3\/resolve\/[0-9a-f]{40}\//); assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.size > 1e9); }
});
test('model download is limited to a local ComfyUI, verifies each file and reports readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-brush-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = Buffer.alloc(3000, 1), b = Buffer.alloc(2000, 2), sha = buffer => createHash('sha256').update(buffer).digest('hex');
  const files = [{ path: 'a.safetensors', name: 'A', url: 'https://x/a', size: a.length, sha256: sha(a) }, { path: 'b.safetensors', name: 'B', url: 'https://x/b', size: b.length, sha256: sha(b) }];
  const fetchImpl = async url => new Response(String(url).endsWith('/a') ? a : b, { status: 200 });
  const profile = { comfyUrl: 'http://127.0.0.1:8188', installation: root };
  const manager = new BrushModelManager({ files, fetchImpl });
  assert.equal((await manager.status(profile)).ready, false);
  await manager.start(profile); await manager.pending;
  assert.equal(manager.state.phase, 'complete'); assert.equal((await manager.status(profile)).ready, true);
  assert.deepEqual(await readFile(join(brushFolder(profile), 'b.safetensors')), b);
  assert.throws(() => brushFolder({ comfyUrl: 'http://example.com:8188', installation: root }), /local ComfyUI/);
  const failing = new BrushModelManager({ files, fetchImpl: async () => new Response(Buffer.alloc(3000, 9), { status: 200 }) });
  await rm(brushFolder(profile), { recursive: true, force: true });
  await failing.start(profile); await failing.pending;
  assert.equal(failing.state.phase, 'failed'); assert.match(failing.state.message, /SHA-256/); assert.equal((await failing.status(profile)).ready, false);
});
test('brush job returns one new channel without a parent and is refused when the engine lacks the model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-brush-job-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, 'source.flac'); await writeFile(audio, 'source');
  let submitted;
  const client = { assets: { fromFile: path => path }, workflows: { fromJson: graph => ({ graph, setInput() {} }) }, submit: async workflow => { submitted = workflow.graph; return { status: 'succeeded', refresh: async () => {}, outputs: [{ nodeId: '10', type: 'audio', name: 'brush_00001_.flac', toFile: path => writeFile(path, 'painted') }] }; } };
  const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
  const runner = new Separation(join(root, 'cache'), path => `opaque:${path}`, { check: async () => ({ ready: true, brush: true, brushModel: true }), makeClient: () => client });
  await runner.start(profile, audio, { mode: 'brush', target: 'footsteps on gravel', rootRunId: 'take-1', brush }); await runner.pending;
  const state = runner.snapshot();
  assert.equal(state.phase, 'complete'); assert.equal(state.stems.length, 1); assert.equal(state.stems[0].label, 'footsteps on gravel'); assert.equal(state.stems[0].parentId, undefined);
  assert.equal(state.rootRunId, 'take-1'); assert.match(state.model, /^Brush · footsteps/); assert.equal(submitted['10'].class_type, 'SaveAudio');
  const blocked = new Separation(join(root, 'cache2'), path => path, { check: async () => ({ ready: true, brush: true, brushModel: false }), makeClient: () => client });
  await blocked.start(profile, audio, { mode: 'brush', target: 'x', brush }); await blocked.pending;
  assert.equal(blocked.snapshot().phase, 'failed'); assert.match(blocked.snapshot().message, /sound model/);
});

test('a finished job the interface never read is handed over once when the next job starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-missed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, 'source.flac'); await writeFile(audio, 'source');
  const client = { assets: { fromFile: path => path }, workflows: { fromJson: graph => ({ graph, setInput() {} }) }, submit: async () => ({ status: 'succeeded', refresh: async () => {}, outputs: [{ nodeId: '10', type: 'audio', name: 'brush_00001_.flac', toFile: path => writeFile(path, 'painted') }] }) };
  const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
  const runner = new Separation(join(root, 'cache'), path => `opaque:${path}`, { check: async () => ({ ready: true, brush: true, brushModel: true, brushModels: { small: true } }), makeClient: () => client });
  await runner.start(profile, audio, { mode: 'brush', target: 'one', rootRunId: 'take', brush }); await runner.pending;
  const first = runner.snapshot().runId;
  await runner.start(profile, audio, { mode: 'brush', target: 'two', rootRunId: 'take', brush }); await runner.pending;
  const polled = runner.poll();
  assert.equal(polled.earlier?.length, 1); assert.equal(polled.earlier[0].runId, first); assert.equal(polled.stems[0].label, 'two');
  assert.equal(runner.poll().earlier, undefined, 'handed over once');
  await runner.start(profile, audio, { mode: 'brush', target: 'three', rootRunId: 'take', brush }); await runner.pending;
  assert.equal(runner.poll().earlier, undefined, 'a result that was read is not handed over again');
});
