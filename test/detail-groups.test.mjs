import test from 'node:test';
import assert from 'node:assert/strict';
import { groupedTracks, initialMix, descendants } from '../src/detail-groups.mjs';
import { stemWorkflow, Separation } from '../electron/separation.mjs';
import { SAMManager, samConfig } from '../electron/sam-manager.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const stems = [{ id: 'a' }, { id: 'b' }, { id: 'c', parentId: 'a' }, { id: 'd', parentId: 'c' }, { id: 'e', parentId: 'b' }];
test('child channels retain parent color, nesting and collapse without deleting outputs', () => {
  const rows = groupedTracks(stems);
  assert.deepEqual(rows.map(row => [row.stem.id, row.depth, row.color]), [['a',0,0],['c',1,0],['d',2,0],['b',0,1],['e',1,1]]);
  assert.deepEqual(groupedTracks(stems, new Set(['a'])).map(row => row.stem.id), ['a','b','e']);
  assert.deepEqual([...descendants(stems, 'a')], ['c','d']); assert.equal(stems.length, 5);
});
test('new detail channels start muted and preserve existing mixer choices', () => {
  const previous = { a: { mute: false, solo: true, level: 0.3 } };
  const mix = initialMix(stems, previous);
  assert.deepEqual(mix.a, previous.a); assert.equal(mix.c.mute, true); assert.equal(mix.b.mute, false);
});
test('USS All receives cropped input and restores full timeline positions before saving', () => {
  const graph = stemWorkflow({ mode: 'uss', target: 'All', range: { start: 1.25, end: 4.75 }, autoThreshold: true });
  assert.deepEqual(graph['2'].inputs.audio, ['3', 0]); assert.deepEqual(graph['2'].inputs.range_reference, ['1', 0]);
  assert.equal(graph['2'].inputs.range_start, 1.25); assert.equal(graph['2'].inputs.suppress_duplicates, true);
  assert.equal(graph['3'].inputs.end_seconds, 4.75);
});
test('SAM and individual USS target graphs crop once and independently pad target/remainder', () => {
  for (const mode of ['sam', 'uss']) {
    const graph = stemWorkflow({ mode, target: 'Door', range: { start: 2, end: 3 } });
    assert.equal(graph['2'].class_type, mode === 'sam' ? 'StemStudioSAM' : 'StemStudioExtract');
    assert.deepEqual(graph['10'].inputs.audio, ['4', 0]); assert.deepEqual(graph['11'].inputs.audio, ['5', 0]);
    assert.deepEqual(graph['4'].inputs.reference, ['1', 0]); assert.deepEqual(graph['5'].inputs.audio, ['2', 1]);
  }
});
test('invalid ranges are rejected before submitting or activating a model job', async () => {
  const runner = new Separation('unused', value => value, { prepareAudio: async (_profile, source) => ({ path: source, size: 1, duration: 10, cleanup: async () => {} }), makeClient: () => { throw Error('must not submit'); } });
  for (const range of [{ start: -1, end: 2 }, { start: 2, end: 2 }, { start: 1, end: Infinity }]) {
    await assert.rejects(runner.start({}, 'unused', { mode: 'sam', target: 'door', range }), /valid channel range/);
    assert.equal(runner.active, false);
  }
});
test('SAM preparation rejects remote endpoints and invalid access without a command or download', async () => {
  assert.throws(() => samConfig({ comfyUrl: 'http://example.test', installation: 'C:/Comfy' }), /local ComfyUI/);
  const manager = new SAMManager('unused', 'unused', { spawn: () => { throw Error('must not spawn'); }, prepareRuntime: () => { throw Error('must not download'); } });
  await assert.rejects(manager.start({ comfyUrl: 'http://127.0.0.1:8188', installation: 'C:/Comfy' }, ''), /read token/);
  assert.equal(manager.active, false);
});
test('SAM preparation failures redact access tokens and remain retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-sam-test-'));
  try {
    await writeFile(join(root, 'main.py'), 'fixture only');
    const manager = new SAMManager(root, 'unused');
    const token = 'hf_12345678901234567890'; manager.run = async () => { throw Error('access rejected ' + token); };
    await manager.start({ comfyUrl: 'http://127.0.0.1:8188', installation: root }, token); await manager.pending;
    assert.equal(manager.active, false); assert.equal(manager.snapshot().phase, 'failed'); assert.ok(!JSON.stringify(manager.snapshot()).includes(token));
  } finally { await rm(root, { recursive: true, force: true }); }
});
