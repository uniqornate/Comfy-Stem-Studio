import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchRunner, safeName } from '../electron/batch.mjs';
import { MixExporter, flacWorkflow, writeWav } from '../electron/mix-export.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fakeSeparation(root, failOn = '') {
  const outputs = new Map(); let counter = 0;
  const separation = {
    active: false, state: { phase: 'idle', stems: [] }, started: [], resets: 0,
    snapshot() { return structuredClone(this.state); },
    async start(profile, path, options) {
      this.started.push([path, options]); this.active = true;
      this.pending = (async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (path.includes(failOn) && failOn) { this.state = { phase: 'failed', message: 'model exploded', stems: [] }; return; }
        const stems = [];
        for (const label of ['Dialogue', 'Music', 'Dialogue']) { const id = `id${++counter}`; const file = join(root, `${id}.flac`); await writeFile(file, `audio-${path}-${label}`); outputs.set(id, { path: file }); stems.push({ id, label }); }
        this.state = { phase: 'complete', stems };
      })().finally(() => { this.active = false; });
    },
    output(id) { return outputs.get(id); },
    reset() { this.resets++; this.state = { phase: 'idle', stems: [] }; },
    async cancel() { this.cancelled = true; },
  };
  return separation;
}

test('batch runs files one after another into per-file folders without overwriting anything', async t => {
  const root = await fixture(t), out = join(root, 'out'); await mkdir(out);
  await mkdir(join(out, 'Scene.one (mrx)'));
  const separation = fakeSeparation(root), batch = new BatchRunner(separation);
  await batch.start({}, [{ name: 'Scene.one.mp4', path: '/a/scene1.mp4' }, { name: 'Scene two.wav', path: '/a/scene2.wav' }], out, file => ({ mode: 'stems', model: 'mrx', source: file.name }), 'mrx');
  await batch.pending;
  const state = batch.snapshot();
  assert.equal(state.phase, 'complete'); assert.deepEqual(state.items.map(item => item.status), ['done', 'done']);
  assert.deepEqual(separation.started.map(([path]) => path), ['/a/scene1.mp4', '/a/scene2.wav']);
  assert.equal(separation.resets, 2);
  assert.deepEqual((await readdir(out)).sort(), ['Scene two (mrx)', 'Scene.one (mrx)', 'Scene.one (mrx) 2']);
  assert.deepEqual((await readdir(join(out, 'Scene two (mrx)'))).sort(), ['Dialogue 2.flac', 'Dialogue.flac', 'Music.flac']);
  assert.equal(await readFile(join(out, 'Scene two (mrx)', 'Music.flac'), 'utf8'), 'audio-/a/scene2.wav-Music');
});
test('a failing file is reported while the remaining files still run; cancel skips the rest', async t => {
  const root = await fixture(t), out = join(root, 'out'); await mkdir(out);
  const separation = fakeSeparation(root, 'bad'), batch = new BatchRunner(separation);
  await batch.start({}, [{ name: 'bad.mp4', path: '/a/bad.mp4' }, { name: 'ok.mp4', path: '/a/ok.mp4' }], out, () => ({ mode: 'stems' }), 'mrx');
  await batch.pending;
  assert.deepEqual(batch.snapshot().items.map(item => item.status), ['failed', 'done']); assert.match(batch.snapshot().items[0].message, /exploded/); assert.equal(batch.snapshot().phase, 'finished-with-errors');
  const second = new BatchRunner(fakeSeparation(root));
  await second.start({}, [{ name: 'a.mp4', path: '/a' }, { name: 'b.mp4', path: '/b' }], out, () => ({}), 'mrx'); second.cancel(); await second.pending;
  assert.equal(second.snapshot().phase, 'cancelled'); assert.ok(second.snapshot().items.some(item => item.status === 'skipped'));
});
test('batch validates its input and refuses to run twice at once', async t => {
  const root = await fixture(t), batch = new BatchRunner(fakeSeparation(root));
  await assert.rejects(batch.start({}, [], root, () => ({}), 'x'), /1 and 200/);
  await assert.rejects(batch.start({}, [{ name: 'a', path: '/a' }], '', () => ({}), 'x'), /output folder/);
  await batch.start({}, [{ name: 'a.mp4', path: '/a' }], root, () => ({}), 'x');
  await assert.rejects(batch.start({}, [{ name: 'b', path: '/b' }], root, () => ({}), 'x'), /already running/);
  await batch.pending;
  assert.equal(safeName('a/b:c*.mp4'), 'a-b-c-'); assert.equal(safeName(''), 'item');
});
test('mix export converts a WAV mixdown through native LoadAudio and SaveAudio and publishes atomically', async t => {
  const root = await fixture(t); let graph, input;
  const client = { assets: { fromFile: path => path }, workflows: { fromJson: value => { graph = value; return { setInput: (node, name, value) => { input = [node, name, value]; } }; } }, submit: async () => ({ status: 'succeeded', refresh: async () => {}, outputs: [{ nodeId: '3', type: 'audio', toFile: path => writeFile(path, 'flac-bytes') }] }) };
  const exporter = new MixExporter({ makeClient: () => client, sleep: async () => {} });
  const wav = join(root, 'mix.wav'); await writeFile(wav, 'wav'); const destination = join(root, 'nested', 'result.flac');
  assert.equal(await exporter.toFlac({ comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' }, wav, destination), destination);
  assert.equal(await readFile(destination, 'utf8'), 'flac-bytes'); assert.deepEqual(input, ['1', 'audio', wav]); assert.equal(graph['3'].class_type, 'SaveAudio'); assert.equal(exporter.active, false);
  assert.deepEqual((await readdir(join(root, 'nested'))), ['result.flac']);
  assert.match(flacWorkflow('P/x')['3'].inputs.filename_prefix, /^P\/x$/);
});
test('mix export fails without publishing when ComfyUI fails or returns nothing', async t => {
  const root = await fixture(t), wav = join(root, 'mix.wav'); await writeFile(wav, 'wav');
  for (const job of [{ status: 'failed', outputs: [] }, { status: 'succeeded', outputs: [] }]) {
    const client = { assets: { fromFile: path => path }, workflows: { fromJson: () => ({ setInput() {} }) }, submit: async () => ({ ...job, refresh: async () => {} }) };
    const exporter = new MixExporter({ makeClient: () => client, sleep: async () => {} }), destination = join(root, 'never.flac');
    await assert.rejects(exporter.toFlac({ proxyUrl: 'http://127.0.0.1:8189' }, wav, destination));
    assert.equal(exporter.active, false); assert.ok(!(await readdir(root)).some(name => name.startsWith('never')));
  }
  await writeWav(new Uint8Array([1, 2, 3]), join(root, 'plain.wav')); assert.equal((await readFile(join(root, 'plain.wav'))).length, 3);
});
