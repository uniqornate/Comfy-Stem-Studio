import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Separation, stemWorkflow, engineStatus, installEngine, resolveCheckpoint, copyIntegration } from '../electron/separation.mjs';

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-separation-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('stemstudio-separation-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
test('model selection accepts both the native category root and its model subfolder', async t => {
  const root = await sandbox(t); const folder = join(root, 'sfc-locoformer-dnr');
  await mkdir(folder); await writeFile(join(folder, 'model.pth'), 'fixture');
  assert.equal(await resolveCheckpoint(root), join(folder, 'model.pth'));
  assert.equal(await resolveCheckpoint(folder), join(folder, 'model.pth'));
});
test('integration reinstall reuses identical files and reports actual source changes', async t => {
  const root = await sandbox(t); const source = join(root, 'source'); const target = join(root, 'target');
  await mkdir(source); await writeFile(join(source, '__init__.py'), '# fixture');
  const updates = [];
  assert.deepEqual(await copyIntegration(source, target, patch => updates.push(patch)), { count: 1, changed: true });
  assert.equal(updates[0].current, 1);
  assert.equal((await copyIntegration(source, target)).changed, false);
  await writeFile(join(source, '__init__.py'), '# updated fixture');
  assert.equal((await copyIntegration(source, target)).changed, true);
});
function fakeClient(outputs, status = 'succeeded') {
  const job = { status, outputs, error: { message: 'Simulated failure' }, refresh: async () => {}, cancel: async () => { job.status = 'canceled'; } };
  return { job, client: {
    workflows: { fromJson: graph => ({ graph, setInput: (node, key, value) => { assert.equal(node, '1'); assert.equal(key, 'audio'); assert.deepEqual(value, { source: '/chosen/video.mp4' }); } }) },
    assets: { fromFile: source => ({ source }) }, submit: async () => job,
  } };
}

test('local separation reuses native SaveAudio files without downloading them again', async t => {
  const root = await sandbox(t), outputPrefix = 'StemStudio/project-a/job-b';
  const directory = join(root, 'output', outputPrefix); await mkdir(directory, { recursive: true });
  const outputs = await Promise.all(['dialogue', 'music', 'effects'].map(async (key, index) => {
    const name = `${key}_00001_.flac`; await writeFile(join(directory, name), `native:${key}`);
    return { name, id: `asset-${key}`, jobId: 'job-b', nodeId: String(10 + index), type: 'audio', toFile() { throw Error('Native output must not be downloaded again.'); } };
  }));
  const { client } = fakeClient(outputs);
  const runner = new Separation(join(root, 'cache'), path => path, { check: async () => ({ ready: true, models: ['sfc'] }), makeClient: () => client });
  await runner.start(profile, '/chosen/video.mp4', { nativeRoot: root, outputPrefix }); await runner.pending;
  assert.equal(runner.snapshot().phase, 'complete');
  for (const stem of runner.snapshot().stems) {
    assert.ok(runner.output(stem.id).path.startsWith(directory));
    assert.equal(runner.output(stem.id).native.type, 'output'); assert.equal(runner.output(stem.id).native.jobId, 'job-b');
  }
});

test('completed SAM and USS range jobs retain root take and parent metadata for grouped append', async t => {
  const root = await sandbox(t);
  for (const mode of ['sam', 'uss']) {
    const outputs = ['10', '11'].map(nodeId => ({ nodeId, type: 'audio', toFile: path => writeFile(path, 'synthetic-test-bytes') }));
    const { client } = fakeClient(outputs);
    const runner = new Separation(join(root, mode), path => path, { check: async () => ({ ready: true, sam: true, detailRange: true, targets: ['Door'] }), makeClient: () => client });
    await runner.start(profile, '/chosen/video.mp4', { mode, target: 'Door', parentId: 'parent-channel', rootRunId: 'root-take', range: { start: 1, end: 2 } });
    await runner.pending;
    const result = runner.snapshot();
    assert.equal(result.phase, 'complete'); assert.equal(result.parentId, 'parent-channel'); assert.equal(result.rootRunId, 'root-take');
    assert.equal(result.model, mode.toUpperCase() + ' · Door'); assert.equal(result.stems.length, 2);
    assert.ok(result.stems.every(stem => stem.parentId === 'parent-channel'));
    assert.notEqual(runner.output(result.stems[0].id).name, 'door.flac');
  }
});
test('workflow keeps all sources with fixed output-index routing', () => {
  const graph = stemWorkflow();
  assert.equal(graph['1'].class_type, 'LoadAudio');
  assert.equal(graph['2'].class_type, 'StemStudioSeparate');
  assert.deepEqual(['10', '11', '12'].map(id => graph[id].inputs.audio), [['2', 0], ['2', 1], ['2', 2]]);
  assert.equal(Object.values(graph).filter(node => node.class_type === 'SaveAudio').length, 3);
});

test('comparison model selection and USS target/remainder use distinct node contracts', () => {
  assert.equal(stemWorkflow({ model: 'bandit' })['2'].inputs.model, 'bandit');
  assert.equal(stemWorkflow({ model: 'mrx' })['2'].inputs.model, 'mrx');
  const graph = stemWorkflow({ mode: 'uss', target: 'Walk, footsteps', threshold: 0.05 });
  assert.equal(graph['2'].class_type, 'StemStudioExtract');
  assert.equal(graph['2'].inputs.target, 'Walk, footsteps');
  assert.equal(graph['2'].inputs.threshold, 0.05);
  assert.deepEqual(graph['10'].inputs.audio, ['2', 0]);
  assert.deepEqual(graph['11'].inputs.audio, ['2', 1]);
  assert.equal(graph['12'], undefined);
  const all = stemWorkflow({ mode: 'uss', target: 'All', threshold: 0.15 });
  assert.equal(all['2'].class_type, 'StemStudioExtractAll');
  assert.equal(all['2'].inputs.threshold, 0.15);
  assert.equal(all['10'], undefined);
});

test('All receives every dynamic named audio output and exports more than twenty detected classes', async t => {
  const root = await sandbox(t); const names = Array.from({ length: 23 }, (_, i) => `Sound class ${i}`);
  const outputs = names.map((name, i) => ({ nodeId: '2', type: 'audio', name: `class-${String(i).padStart(3, '0')}-sound-${i}_00001_.flac`, toFile: path => writeFile(path, `fixture:${i}`) }));
  const { client } = fakeClient(outputs);
  const runner = new Separation(join(root, 'cache'), path => `opaque:${basename(path)}`, { check: async () => ({ ready: true, targets: ['All', ...names] }), makeClient: () => client });
  await runner.start(profile, '/chosen/video.mp4', { mode: 'uss', target: 'All', threshold: 0.1 }); await runner.pending;
  const result = runner.snapshot();
  assert.equal(result.phase, 'complete'); assert.equal(result.stems.length, 23);
  assert.deepEqual(result.stems.map(stem => stem.label), names);
  const folder = await runner.saveAll(root);
  assert.equal((await readdir(folder)).length, 23);
  assert.equal(await readFile(join(folder, '022-sound-class-22.flac'), 'utf8'), 'fixture:22');
});

test('All with no outputs, duplicate labels or invalid output names cannot report success', async t => {
  const root = await sandbox(t);
  for (const outputs of [[], [{ nodeId: '2', type: 'audio', name: 'unrecognized.flac' }], [{ nodeId: '2', type: 'audio', name: 'class-000-a.flac' }, { nodeId: '2', type: 'audio', name: 'class-000-b.flac' }]]) {
    const { client } = fakeClient(outputs);
    const runner = new Separation(root, () => 'unused', { check: async () => ({ ready: true, targets: ['All', 'Speech'] }), makeClient: () => client });
    await runner.start(profile, '/chosen/video.mp4', { mode: 'uss', target: 'All', threshold: 0.1 }); await runner.pending;
    assert.equal(runner.snapshot().phase, 'failed'); assert.deepEqual(runner.snapshot().stems, []);
  }
});

test('All rejects zero threshold before any submission', async t => {
  const root = await sandbox(t);
  const runner = new Separation(root, () => 'unused', { check: async () => ({ ready: true, targets: ['All', 'Speech'] }), makeClient: () => assert.fail('must not submit') });
  await runner.start(profile, '/chosen/video.mp4', { mode: 'uss', target: 'All', threshold: 0 }); await runner.pending;
  assert.match(runner.snapshot().message, /above zero/);
});

test('capability response lists installed models and only available USS classes', async () => {
  const nodes = { LoadAudio: {}, SaveAudio: {}, StemStudioSeparate: { input: { required: { model: [['sfc', 'bandit', 'mrx']] } } }, StemStudioExtract: { input: { required: { target: [['Walk, footsteps', 'Door']] } } } };
  const check = () => new Response(JSON.stringify(nodes));
  const value = await engineStatus(profile, check);
  assert.deepEqual(value.models, ['sfc', 'bandit', 'mrx']);
  assert.deepEqual(value.targets, ['Walk, footsteps', 'Door']);
  nodes.StemStudioExtract.input.required.target = [['USS models not installed']];
  assert.deepEqual((await engineStatus(profile, check)).targets, []);
});

test('USS exports two channels and a later failed job cannot erase an earlier downloadable take', async t => {
  const root = await sandbox(t); const bytes = Buffer.from('target-fixture');
  const outputs = ['10', '11'].map(nodeId => ({ nodeId, type: 'audio', toFile: path => writeFile(path, bytes) }));
  const { client, job } = fakeClient(outputs);
  const runner = new Separation(join(root, 'cache'), path => `opaque:${basename(path)}`, { check: async () => ({ ready: true, targets: ['Walk, footsteps'], models: ['sfc'] }), makeClient: () => client });
  await runner.start(profile, '/chosen/video.mp4', { mode: 'uss', target: 'Walk, footsteps', threshold: 0.1 }); await runner.pending;
  const result = runner.snapshot();
  assert.equal(result.phase, 'complete'); assert.equal(result.stems.length, 2);
  assert.deepEqual(result.stems.map(stem => stem.label), ['Walk, footsteps', 'Remainder']);
  const ids = result.stems.map(stem => stem.id);
  job.status = 'failed';
  await runner.start(profile, '/chosen/video.mp4'); await runner.pending;
  assert.equal(runner.snapshot().phase, 'failed');
  const folder = await runner.saveAll(root, ids);
  assert.deepEqual((await readdir(folder)).sort(), ['remainder.flac', 'walk-footsteps.flac']);
  await runner.saveOne(ids[0], join(root, 'prior-take.flac'));
  assert.deepEqual(await readFile(join(root, 'prior-take.flac')), bytes);
  runner.reset(); assert.throws(() => runner.output(ids[0]), /not available/);
});

test('uninstalled comparison model and invalid USS target fail before any job submission', async t => {
  const root = await sandbox(t);
  const runner = new Separation(root, () => 'unused', { check: async () => ({ ready: true, models: ['sfc'], targets: ['Door'] }), makeClient: () => assert.fail('must not submit') });
  await runner.start(profile, '/chosen/video.mp4', { model: 'bandit' }); await runner.pending;
  assert.match(runner.snapshot().message, /not installed/);
  await runner.start(profile, '/chosen/video.mp4', { mode: 'uss', target: 'Unsupported' }); await runner.pending;
  assert.match(runner.snapshot().message, /installed USS target/);
  await assert.rejects(runner.start(profile, '/chosen/video.mp4', null), /Invalid separation/);
});
test('capability check detects reachable engine without the required custom node', async () => {
  const result = await engineStatus(profile, async () => new Response(JSON.stringify({ LoadAudio: {}, SaveAudio: {} })));
  assert.equal(result.ready, false); assert.match(result.message, /StemStudioSeparate/);
});
test('local installer refuses a remote deployment before writing anything', async () => {
  await assert.rejects(installEngine({ ...profile, comfyUrl: 'https://remote.example' }, '/unused', '/unused'), /local ComfyUI/);
});
test('missing capability cannot create a fake successful result or submit a job', async t => {
  const root = await sandbox(t);
  const runner = new Separation(root, () => 'unused', { check: async () => ({ ready: false, message: 'Missing integration' }), makeClient: () => assert.fail('must not submit') });
  await runner.start(profile, '/chosen/video.mp4'); await runner.pending;
  assert.equal(runner.snapshot().phase, 'failed'); assert.deepEqual(runner.snapshot().stems, []);
});
test('three SDK outputs become individually exportable and batch export preserves every byte', async t => {
  const root = await sandbox(t);
  // Tiny fixture bytes, not real or simulated model inference. No UI/network/process.
  const bytes = Buffer.from('offline-output-fixture');
  const outputs = ['10', '11', '12'].map(nodeId => ({ nodeId, type: 'audio', toFile: path => writeFile(path, bytes) }));
  const { client } = fakeClient(outputs);
  const runner = new Separation(join(root, 'cache'), path => `opaque:${basename(path)}`, { check: async () => ({ ready: true }), makeClient: () => client });
  await runner.start(profile, '/chosen/video.mp4'); await runner.pending;
  const result = runner.snapshot(); assert.equal(result.phase, 'complete'); assert.equal(result.stems.length, 3);
  assert.deepEqual(result.stems.map(stem => stem.label), ['Dialogue', 'Music', 'Effects']);
  await runner.saveOne(result.stems[1].id, join(root, 'selected.flac'));
  assert.deepEqual(await readFile(join(root, 'selected.flac')), bytes);
  const folder = await runner.saveAll(root);
  assert.deepEqual((await readdir(folder)).sort(), ['dialogue.flac', 'effects.flac', 'music.flac']);
  for (const file of await readdir(folder)) assert.deepEqual(await readFile(join(folder, file)), bytes);
  assert.throws(() => runner.output('unrecognized-token'), /not available/);
});
test('missing or failed server output never presents partial stems as a complete set', async t => {
  const root = await sandbox(t);
  for (const status of ['succeeded', 'failed']) {
    const { client } = fakeClient([{ nodeId: '10', type: 'audio', toFile: () => assert.fail('must not download incomplete set') }], status);
    const runner = new Separation(root, () => 'unused', { check: async () => ({ ready: true }), makeClient: () => client });
    await runner.start(profile, '/chosen/video.mp4'); await runner.pending;
    assert.equal(runner.snapshot().phase, 'failed'); assert.equal(runner.snapshot().stems.length, 0);
  }
});

test('Auto threshold is explicit in USS graphs and absent in legacy manual graphs', () => {
  for (const target of ['All', 'Walk, footsteps']) {
    assert.equal(stemWorkflow({ mode: 'uss', target, autoThreshold: true })['2'].inputs.auto_threshold, true);
    assert.equal('auto_threshold' in stemWorkflow({ mode: 'uss', target })['2'].inputs, false);
  }
});
