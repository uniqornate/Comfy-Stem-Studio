import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Separation, stemWorkflow, jobProgress } from '../electron/separation.mjs';
import { MUSIC_CHANNELS, MUSIC_FILES, MUSIC_MODEL, musicCapability, musicFolder } from '../electron/music.mjs';
import { BrushModelManager } from '../electron/brush-manager.mjs';
import { MODELS } from '../src/models.mjs';
import { preferences } from '../src/workspace-preferences.mjs';

const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
test('music graph saves six named channels from the music node', () => {
  const graph = stemWorkflow({ mode: 'music' });
  assert.equal(graph['2'].class_type, 'StemStudioMusicSeparate'); assert.equal(graph['2'].inputs.model, MUSIC_MODEL);
  assert.deepEqual(MUSIC_CHANNELS.map(channel => channel.label), ['Vocals', 'Drums', 'Bass', 'Guitar', 'Piano', 'Other']);
  MUSIC_CHANNELS.forEach((channel, index) => { assert.deepEqual(graph[channel.node].inputs.audio, ['2', index]); assert.equal(graph[channel.node].class_type, 'SaveAudio'); });
  assert.match(stemWorkflow({ mode: 'music', outputPrefix: 'StemStudio/p/r' })['10'].inputs.filename_prefix, /^StemStudio\/p\/r\/vocals$/);
});
test('music model is pinned and its folder needs a local ComfyUI', () => {
  assert.equal(MUSIC_FILES.length, 1); assert.match(MUSIC_FILES[0].sha256, /^[0-9a-f]{64}$/); assert.ok(MUSIC_FILES[0].url.startsWith('https://')); assert.ok(MUSIC_FILES[0].sha256.startsWith('34c22ccb'));
  assert.ok(musicFolder({ ...profile, installation: 'C:/Comfy' }).replace(/\\/g, '/').endsWith('models/audio_separation/htdemucs-6s'));
  assert.throws(() => musicFolder({ comfyUrl: 'http://example.com:8188', installation: 'C:/Comfy' }), /local ComfyUI/);
  assert.throws(() => musicFolder(profile), /local ComfyUI/);
});
test('engine reports the music node and whether the model file is listed', () => {
  const node = list => ({ StemStudioMusicSeparate: { input: { required: { model: [list] } } } });
  assert.deepEqual(musicCapability(node([MUSIC_MODEL])), { music: true, musicModel: true });
  assert.deepEqual(musicCapability(node(['Model not installed'])), { music: true, musicModel: false });
  assert.deepEqual(musicCapability({}), { music: false, musicModel: false });
});
test('music model downloads through the shared verified manager', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-music-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(2048, 7);
  const files = [{ path: 'htdemucs_6s.th', name: 'x', url: 'https://example.invalid/x.th', size: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }];
  const manager = new BrushModelManager({ files, folderFor: musicFolder, label: 'The music model', fetchImpl: async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }) });
  const installed = { ...profile, installation: root };
  assert.equal((await manager.status(installed)).ready, false);
  await manager.start(installed); await manager.pending;
  assert.equal((await manager.status(installed)).ready, true);
  assert.deepEqual(await readFile(join(musicFolder(installed), 'htdemucs_6s.th')), bytes);
  await assert.rejects(manager.start({ comfyUrl: 'http://example.com:8188', installation: root }), /local ComfyUI/);
});
test('music job returns six channels, and is refused without the node or model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-music-job-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, 'song.flac'); await writeFile(audio, 'song');
  const outputs = MUSIC_CHANNELS.map(channel => ({ nodeId: channel.node, type: 'audio', name: `${channel.key}_00001_.flac`, toFile: path => writeFile(path, channel.key) }));
  const client = { assets: { fromFile: path => path }, workflows: { fromJson: graph => ({ graph, setInput() {} }) }, submit: async () => ({ status: 'succeeded', refresh: async () => {}, outputs }) };
  const runner = new Separation(join(root, 'cache'), path => `opaque:${path}`, { check: async () => ({ ready: true, music: true, musicModel: true }), prepareAudio: async (_profile, source) => ({ path: source, size: 1, duration: 10, cleanup: async () => {} }), makeClient: () => client });
  await runner.start(profile, audio, { mode: 'music' }); await runner.pending;
  const state = runner.snapshot();
  assert.equal(state.phase, 'complete'); assert.deepEqual(state.stems.map(stem => stem.label), ['Vocals', 'Drums', 'Bass', 'Guitar', 'Piano', 'Other']); assert.equal(state.model, 'Music · 6 stems');
  for (const status of [{ ready: true, music: false, musicModel: false }, { ready: true, music: true, musicModel: false }]) {
    const blocked = new Separation(join(root, `cache-${status.music}`), path => path, { check: async () => status, prepareAudio: async (_profile, source) => ({ path: source, size: 1, duration: 10, cleanup: async () => {} }), makeClient: () => client });
    await blocked.start(profile, audio, { mode: 'music' }); await blocked.pending;
    assert.equal(blocked.snapshot().phase, 'failed'); assert.match(blocked.snapshot().message, /music|Music/);
  }
});
test('job progress uses only what ComfyUI reports', () => {
  assert.equal(jobProgress({ progress: null }), null);
  assert.equal(jobProgress({ progress: { value: 0.4 } }), 0.4);
  assert.equal(jobProgress({ progress: { value: 40 } }), 0.4);
  assert.equal(jobProgress({ progress: { value: 0, nodesDone: 1, nodesTotal: 4 } }), 0.25);
  assert.equal(jobProgress({ progress: { value: 0, nodesDone: null, nodesTotal: null } }), null);
});
test('tiles: USS and six-stem music are main models and GuideSep is no longer a whole-source tile', () => {
  const ids = MODELS.map(model => model.id);
  assert.ok(ids.includes('uss') && ids.includes('music6')); assert.ok(!ids.includes('guidesep'));
  assert.equal(MODELS.find(model => model.id === 'uss').kind, 'uss'); assert.equal(MODELS.find(model => model.id === 'music6').kind, 'music');
  assert.equal(preferences(JSON.stringify({ model: 'guidesep' })).model, 'mrx'); assert.equal(preferences(JSON.stringify({ model: 'music6' })).model, 'music6');
});
test('overall progress spans sending, ComfyUI work and fetching, using steps of the running node', async () => {
  const { jobProgress, overallProgress } = await import('../electron/separation.mjs');
  assert.equal(jobProgress({ nodesDone: 1, nodesTotal: 4, step: 5, steps: 10 }), 0.375);
  assert.equal(jobProgress({ nodesDone: 0, nodesTotal: 2, step: 0, steps: 0, value: 0.5 }), 0.25);
  assert.equal(jobProgress(null), null);
  assert.equal(overallProgress('uploading'), 0.03); assert.equal(overallProgress('downloading'), 0.97);
  assert.equal(overallProgress('running', null), null); assert.ok(Math.abs(overallProgress('running', 0.5) - 0.5) < 1e-9);
});
