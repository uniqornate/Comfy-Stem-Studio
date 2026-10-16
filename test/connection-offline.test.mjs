import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../electron/connection.mjs';

const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
function fakeServices(t, health) {
  t.mock.method(globalThis, 'fetch', async url => {
    const body = url.endsWith('/system_stats') ? { devices: [{ name: 'Mock GPU' }] }
      : url.endsWith('/object_info') ? {} : health;
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}
test('official healthy proxy and aligned upstream pass independent probes without real networking', async t => {
  fakeServices(t, { status: 'healthy', upstream: profile.comfyUrl });
  const result = await checkConnection(profile);
  assert.equal(result.comfy, true);
  assert.equal(result.proxy, true);
  assert.match(result.proxyDetail, /does not verify an audio workflow/);
});
test('a healthy proxy configured for another ComfyUI is reported as misconfigured', async t => {
  fakeServices(t, { status: 'healthy', upstream: 'http://127.0.0.1:9000' });
  const result = await checkConnection(profile);
  assert.equal(result.comfy, true);
  assert.equal(result.proxy, false);
  assert.match(result.proxyDetail, /points to http:\/\/127.0.0.1:9000/);
});
test('connection refusal and authentication have actionable distinct explanations', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/system_stats')) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return new Response('{}', { status: 401 });
  });
  const result = await checkConnection(profile);
  assert.equal(result.comfy, false);
  assert.equal(result.proxy, false);
  assert.match(result.comfyDetail, /Connection refused/);
  assert.match(result.proxyDetail, /Authentication is required/);
});
