import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideSepManager, guidesepConfig } from '../electron/guidesep-manager.mjs';
import { stemWorkflow } from '../electron/separation.mjs';
import { isAudioPath, isSourcePath } from '../electron/media-types.mjs';

test('GuideSep workflow uploads source and reference, and keeps range restoration aligned', () => {
  const whole = stemWorkflow({ mode: 'guidesep', target: 'hum', range: { start: 0, end: 12 } });
  assert.equal(whole['2'].class_type, 'StemStudioGuideSep');
  assert.deepEqual(whole['2'].inputs.reference, ['8', 0]);
  assert.equal(whole['8'].class_type, 'LoadAudio');
  assert.deepEqual(whole['2'].inputs.audio, ['3', 0]);
  assert.equal(whole['10'].inputs.audio[0], '4');
  assert.equal(whole['11'].inputs.audio[0], '5');
  assert.equal(whole['4'].class_type, 'StemStudioRestoreRange');
});

test('GuideSep preparation is limited to a local ComfyUI folder', () => {
  assert.ok(guidesepConfig({ comfyUrl: 'http://127.0.0.1:8188', installation: 'C:/Comfy' }).endsWith('guidesep-v1'));
  assert.throws(() => guidesepConfig({ comfyUrl: 'http://example.com:8188', installation: 'C:/Comfy' }), /local ComfyUI/);
  assert.throws(() => guidesepConfig({ comfyUrl: 'http://127.0.0.1:8188', installation: '' }), /local ComfyUI/);
});

test('GuideSep preparation installs a private runtime, runs the weight extractor and marks ready only afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guidesep-'));
  const comfy = join(root, 'ComfyUI'); await mkdir(comfy, { recursive: true }); await writeFile(join(comfy, 'main.py'), '');
  const calls = [];
  const spawn = (file, args) => {
    calls.push([file, ...args].join(' '));
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      if (args.some(arg => String(arg).endsWith('prepare-guidesep.py'))) await writeFile(join(comfy, 'models', 'audio_separation', 'guidesep-v1', 'guidesep.pt'), 'weights');
      child.emit('close', 0);
    });
    return child;
  };
  const manager = new GuideSepManager(join(root, 'userData', 'guidesep'), join(root, 'prepare-guidesep.py'), { spawn, prepareRuntime: async () => {} });
  const profile = { comfyUrl: 'http://127.0.0.1:8188', installation: comfy };
  assert.equal((await manager.status(profile)).ready, false);
  await manager.start(profile); await manager.pending;
  assert.equal(manager.snapshot().phase, 'complete');
  assert.ok(calls.some(call => call.includes('torch==2.11.0')));
  assert.ok(calls.some(call => call.includes('einops-exts') && call.includes('torchsde')));
  assert.ok(calls.at(-1).includes('prepare-guidesep.py'));
  const marker = JSON.parse(await readFile(join(comfy, 'models', 'audio_separation', 'guidesep-v1', 'stem-runtime.json'), 'utf8'));
  assert.equal(marker.repo, 'YutongCooper/GuideSep-v1');
  await mkdir(join(root, 'userData', 'guidesep', 'runtime', 'Scripts'), { recursive: true });
  await writeFile(join(root, 'userData', 'guidesep', 'runtime', 'Scripts', 'python.exe'), '');
  assert.equal((await manager.status(profile)).ready, true);
});

test('audio files are accepted as sources, reference choices stay audio only', () => {
  for (const name of ['clip.mp3', 'clip.WAV', 'clip.flac', 'clip.m4a', 'film.mkv']) assert.ok(isSourcePath(name), name);
  assert.ok(isAudioPath('hum.opus')); assert.ok(!isAudioPath('film.mp4')); assert.ok(!isSourcePath('notes.txt'));
});
