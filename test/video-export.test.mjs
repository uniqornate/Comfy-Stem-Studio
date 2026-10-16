import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { videoWorkflow, validateVideoExport, VideoExporter, nativeVideoStatus } from '../electron/video-export.mjs';
const stems = [{ id: 'a', label: 'Dialogue', path: 'a.flac', level: 0.75, mute: false, solo: true }, { id: 'b', label: 'Music', path: 'b.flac', level: 1, mute: false, solo: false }];
const options = { mode: 'mix', format: 'mkv' };
const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
async function sandbox(t) { const root = await mkdtemp(join(tmpdir(), 'stemstudio-native-export-')); t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('stemstudio-native-export-')); await rm(root, { recursive: true, force: true }); }); return root; }
function clientFixture(outputs) {
  const bindings = [];
  const job = { status: 'succeeded', progress: null, outputs, refresh: async () => {}, cancel: async () => { job.status = 'canceled'; } };
  let graph;
  return { job, bindings, get graph() { return graph; }, client: { assets: { fromFile: path => ({ assetPath: path }) }, workflows: { fromJson: value => { graph = value; return { setInput: (...args) => bindings.push(args) }; } }, submit: async () => job } };
}
test('native graph ends in real SaveVideo and preserves mix and separate-track selection', () => {
  for (const mode of ['mix', 'tracks']) {
    const graph = videoWorkflow(stems, { ...options, mode });
    assert.equal(graph['1'].class_type, 'LoadVideo'); assert.equal(graph['3'].class_type, 'SaveVideo'); assert.equal(graph['3'].inputs.format, 'mkv'); assert.equal(graph['3'].inputs['format.codec'], 'auto');
    assert.deepEqual(graph['3'].inputs.video, ['2', 0]); assert.equal(graph['2'].inputs.mode, mode);
    assert.equal(graph['10'].inputs.level, 0.75); assert.equal(graph['10'].inputs.solo, true); assert.deepEqual(graph['11'].inputs.previous, ['10', 0]);
    assert.deepEqual(graph['2'].inputs.tracks, ['11', 0]); assert.equal(Object.values(graph).some(node => /ffmpeg/i.test(node.class_type)), false);
  }
});
test('native capability discovery is targeted and missing nodes fail before submission', async () => {
  const calls = []; await nativeVideoStatus(profile, async url => { calls.push(url); return new Response(JSON.stringify({ [url.split('/').at(-1)]: {} })); });
  assert.equal(calls.length, 4); assert.ok(calls.every(url => new URL(url).pathname.startsWith('/object_info/')));
  await assert.rejects(nativeVideoStatus(profile, async () => new Response('{}')), /updated Stem Studio setup/);
});
test('invalid gain, duplicate channels and non-native containers fail', () => {
  assert.throws(() => validateVideoExport([{ ...stems[0], level: NaN }], options));
  assert.throws(() => validateVideoExport([stems[0], stems[0]], options));
  assert.throws(() => validateVideoExport(stems, { ...options, format: 'mov' }));
});
test('SDK submits uploaded source and stem references and downloads native SaveVideo output atomically', async t => {
  const root = await sandbox(t), target = join(root, 'result.mkv');
  const fixture = clientFixture([{ nodeId: '3', type: 'video', name: 'native.mkv', toFile: path => writeFile(path, 'native-fixture') }]);
  const exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client });
  assert.equal(await exporter.run(profile, join(root, 'source.mp4'), stems, options, target), target);
  assert.equal(await readFile(target, 'utf8'), 'native-fixture'); assert.equal(fixture.bindings.length, 3); assert.equal(fixture.bindings[0][0], '1'); assert.equal(fixture.bindings[1][2].assetPath, 'a.flac'); assert.equal(fixture.graph['3'].class_type, 'SaveVideo'); assert.equal(exporter.snapshot().phase, 'complete'); assert.equal((await readdir(root)).length, 1);
});
test('legacy proxy native PreviewVideo images classification remains downloadable', async t => {
  const root = await sandbox(t); const fixture = clientFixture([{ nodeId: '3', type: 'image', name: 'native.mkv', toFile: path => writeFile(path, 'native-video') }]);
  const exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client }); await exporter.run(profile, join(root, 'source.mp4'), stems, options, join(root, 'result.mkv')); assert.equal(exporter.snapshot().phase, 'complete');
});
test('missing/ambiguous video outputs and SDK failures preserve existing targets', async t => {
  const root = await sandbox(t), target = join(root, 'result.mkv'); await writeFile(target, 'existing');
  for (const outputs of [[], [{ nodeId: '1', type: 'video', name: 'preview.mkv' }], [{ nodeId: '3', type: 'image', name: 'wrong.png' }], [{ nodeId: '3', type: 'video', name: 'first.mkv' }, { nodeId: '3', type: 'video', name: 'second.mkv' }]]) {
    const fixture = clientFixture(outputs); const exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client }); await assert.rejects(exporter.run(profile, join(root, 'source.mp4'), stems, options, target), /exactly one/);
    assert.equal(await readFile(target, 'utf8'), 'existing'); assert.equal(exporter.active, false);
  }
  const fixture = clientFixture([]); fixture.job.status = 'failed'; fixture.job.error = { message: 'server encoder error' };
  const exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client }); await assert.rejects(exporter.run(profile, join(root, 'source.mp4'), stems, options, target), /server encoder error/); assert.deepEqual(await readdir(root), ['result.mkv']);
});
test('cancel affects only the owned SDK job and cannot publish a successful file', async t => {
  const root = await sandbox(t); const fixture = clientFixture([]); fixture.job.status = 'running'; let exporter;
  exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client, sleep: async () => { await exporter.cancel(); } });
  await assert.rejects(exporter.run(profile, join(root, 'source.mp4'), stems, options, join(root, 'result.mkv')), /cancelled/); assert.equal(fixture.job.status, 'canceled'); assert.equal(exporter.snapshot().phase, 'cancelled'); assert.deepEqual(await readdir(root), []);
});
test('partial download failure removes staged bytes and leaves previous destination intact', async t => {
  const root = await sandbox(t), target = join(root, 'result.mkv'); await writeFile(target, 'previous');
  const fixture = clientFixture([{ nodeId: '3', type: 'video', name: 'native.mkv', toFile: async path => { await writeFile(path, 'partial'); throw new Error('network interrupted'); } }]);
  const exporter = new VideoExporter({ check: async () => {}, makeClient: () => fixture.client }); await assert.rejects(exporter.run(profile, join(root, 'source.mp4'), stems, options, target), /network interrupted/); assert.equal(await readFile(target, 'utf8'), 'previous'); assert.deepEqual(await readdir(root), ['result.mkv']);
});
