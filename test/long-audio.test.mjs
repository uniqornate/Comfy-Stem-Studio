import test from 'node:test';
import assert from 'node:assert/strict';
import { audioWindows, SAFE_UPLOAD } from '../electron/audio-source.mjs';
import { stemWorkflow } from '../electron/separation.mjs';
import { Separation } from '../electron/separation.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('audio below the upload ceiling stays whole even when the video is much larger', () => {
  assert.deepEqual(audioWindows(1595.5, 25_600_000), [{ start: 0, end: 1595.5 }]);
});

test('oversize audio is divided into bounded contiguous sections', () => {
  const duration = 1500;
  const windows = audioWindows(duration, SAFE_UPLOAD * 3);
  assert.ok(windows.length > 1);
  assert.equal(windows[0].start, 0);
  assert.equal(windows.at(-1).end, duration);
  for (let i = 0; i < windows.length; i++) {
    assert.ok(windows[i].end - windows[i].start <= 180);
    if (i) assert.equal(windows[i].start, windows[i - 1].end);
  }
});

test('chunk workflow loads only the requested audio interval through ComfyUI', () => {
  const graph = stemWorkflow({ mode: 'stems', model: 'mrx', chunkRange: { start: 180, end: 360 } });
  assert.equal(graph['1'].class_type, 'StemStudioLoadAudioRange');
  assert.deepEqual(graph['1'].inputs, { file: '', start_seconds: 180, end_seconds: 360 });
  assert.equal(graph['2'].inputs.audio[0], '1');
  assert.throws(() => stemWorkflow({ mode: 'stems', chunkRange: { start: 360, end: 180 } }), /Invalid audio chunk/);
});

test('large audio sends bounded input and makes each processed section available', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-long-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graphs = [], uploads = [];
  const client = {
    assets: { fromFile: path => ({ path }) },
    workflows: { fromJson: graph => ({ graph, setInput(node, key, value) { graph[node].inputs[key] = value; } }) },
    async submit(workflow) {
      graphs.push(workflow.graph);
      return { status: 'succeeded', refresh: async () => {}, outputs: ['10', '11', '12'].map(nodeId => ({ nodeId, type: 'audio', name: `${nodeId}.flac`, toFile: path => writeFile(path, 'fixture') })) };
    },
  };
  const runner = new Separation(join(root, 'cache'), path => path, {
    check: async () => ({ ready: true, models: ['mrx'], chunkAudio: true }), makeClient: () => client,
    prepareAudio: async () => ({ path: 'prepared.mka', size: 250 * 1024 * 1024, duration: 400, cleanup: async () => {} }),
    uploadAudio: async (_profile, path, size) => { uploads.push([path, size]); return 'StemStudio/inbox/prepared.mka'; },
  });
  await runner.start({ comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' }, 'source.mp4', { mode: 'stems', model: 'mrx' });
  await runner.pending;
  const job = runner.snapshot();
  assert.equal(job.phase, 'complete', job.message);
  assert.deepEqual(uploads, [['prepared.mka', 250 * 1024 * 1024]]);
  assert.equal(graphs.length, 4);
  assert.deepEqual(graphs.map(graph => [graph['1'].inputs.start_seconds, graph['1'].inputs.end_seconds]), [[0, 100], [100, 200], [200, 300], [300, 400]]);
  assert.deepEqual(job.stems.filter(stem => stem.channelKey === 'dialogue').map(stem => [stem.start, stem.end]), [[0, 100], [100, 200], [200, 300], [300, 400]]);
  assert.equal(job.stems.length, 12);
});
