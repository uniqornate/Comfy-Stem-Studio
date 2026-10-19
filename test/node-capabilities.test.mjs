import test from 'node:test';
import assert from 'node:assert/strict';
import { audioNodes } from '../electron/node-capabilities.mjs';

test('audio readiness never requests the global inventory and tolerates absent optional USS', async () => {
  const calls = [];
  const nodes = await audioNodes('http://fixture.invalid', async url => {
    calls.push(url);
    assert.notEqual(new URL(url).pathname, '/object_info');
    const name = url.split('/').at(-1);
    return ['StemStudioExtract', 'StemStudioExtractAll', 'StemStudioAudioRange', 'StemStudioRestoreRange', 'StemStudioSAM', 'StemStudioGuideSep', 'StemStudioEditAudio', 'StemStudioMusicSeparate', 'StemStudioVideoClip', 'MMAudioModelLoader', 'MMAudioFeatureUtilsLoader', 'MMAudioSampler', 'LoadVideo', 'CheckpointLoaderSimple', 'CLIPLoader', 'CLIPTextEncode', 'KSampler', 'EmptyLatentAudio', 'VAEDecodeAudio'].includes(name) ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ [name]: { input: {} } }));
  });
  assert.equal(calls.length, 22);
  assert.deepEqual(Object.keys(nodes).sort(), ['LoadAudio', 'SaveAudio', 'StemStudioSeparate']);
});

test('missing required node stays missing and required HTTP errors cannot imply readiness', async () => {
  const missing = await audioNodes('http://fixture.invalid', async url => url.endsWith('/LoadAudio') ? new Response('{}') : new Response(JSON.stringify({ [url.split('/').at(-1)]: {} })));
  assert.equal(missing.LoadAudio, undefined);
  await assert.rejects(audioNodes('http://fixture.invalid', async () => new Response('{}', { status: 503 })), /HTTP 503/);
});
