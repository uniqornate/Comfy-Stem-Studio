import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { completeSetup, nativeModelRoot, assertIdle, runningEngineDirectory } from '../setup/complete-setup.mjs';

test('engine restart policy accepts an empty queue and fails closed on unknown state', () => {
  assert.equal(assertIdle({ queue_running: [], queue_pending: [] }), true);
  assert.equal(assertIdle({ queue_running: [[1]], queue_pending: [] }), false);
  assert.equal(assertIdle({ queue_running: [], queue_pending: [[2]] }), false);
  assert.throws(() => assertIdle({}), /Cannot verify/);
  const root = resolve('fixture/ComfyUI');
  assert.equal(runningEngineDirectory(root, ['main.py', '--port', '8188']), root);
  assert.equal(runningEngineDirectory(root, ['ComfyUI/main.py']), dirname(root));
  assert.throws(() => runningEngineDirectory(root, ['other/main.py']), /does not match/);
  assert.throws(() => runningEngineDirectory(root, [null]), /Cannot identify/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-setup-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('stemstudio-setup-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const config = { userData: join(root, 'data'), comfyRoot: join(root, 'ComfyUI'), resources: join(root, 'resources'), comfyUrl: 'http://127.0.0.1:8288' };
  const calls = [];
  const dependencies = {
    update: () => {}, signal: new AbortController().signal,
    prepareRuntime: async () => calls.push('runtime'),
    installEngine: async (profile, source, modelRoot) => {
      calls.push('node'); assert.equal(modelRoot, nativeModelRoot(config.comfyRoot));
      assert.equal(profile.installation, config.comfyRoot);
      return { changed: false };
    },
    proxyAddress: async address => { assert.equal(address, config.comfyUrl); return 'http://127.0.0.1:8190'; },
    readyEngine: async (value, update, signal, changed) => { calls.push('engine'); assert.equal(changed, false); },
    ProxyManager: class {
      async start(profile) { calls.push('proxy'); assert.equal(profile.setupComplete, false); }
      stop() { calls.push('stop'); }
    },
  };
  return { config, dependencies, calls, profile: async () => JSON.parse(await readFile(join(config.userData, 'connection.json'), 'utf8')) };
}

test('one-pass setup saves a ready profile only after node, engine and proxy preparation', async t => {
  const f = await fixture(t);
  await completeSetup(f.config, f.dependencies);
  assert.deepEqual(f.calls, ['runtime', 'node', 'engine', 'proxy', 'stop']);
  const saved = await f.profile();
  assert.equal(saved.setupComplete, true); assert.equal(saved.managedProxy, true);
  assert.equal(saved.comfyUrl, f.config.comfyUrl); assert.equal(saved.proxyUrl, 'http://127.0.0.1:8190');
});

test('engine readiness failure preserves choices without falsely marking setup complete', async t => {
  const f = await fixture(t);
  f.dependencies.readyEngine = async () => { throw new Error('Fixture engine unavailable'); };
  await assert.rejects(completeSetup(f.config, f.dependencies), /Fixture engine unavailable/);
  assert.equal((await f.profile()).setupComplete, false);
  assert.deepEqual(f.calls, ['runtime', 'node']);
});

test('proxy failure stops its owned manager and leaves setup retryable', async t => {
  const f = await fixture(t);
  f.dependencies.ProxyManager = class {
    async start() { throw new Error('Fixture proxy unavailable'); }
    stop() { f.calls.push('stop'); }
  };
  await assert.rejects(completeSetup(f.config, f.dependencies), /Fixture proxy unavailable/);
  assert.equal((await f.profile()).setupComplete, false);
  assert.equal(f.calls.at(-1), 'stop');
});

test('cancellation before integration cannot be reported as success', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  f.dependencies.signal = controller.signal;
  await assert.rejects(completeSetup(f.config, f.dependencies), /cancelled/);
  assert.deepEqual(f.calls, ['runtime']);
});
