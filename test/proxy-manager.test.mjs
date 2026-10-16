import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProxyManager, localProxyConfig } from '../electron/proxy-manager.mjs';

const profile = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killed = false; }
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 0)); return true; }
}
test('automatic mode rejects remote binds, reserved ports, service collisions and URL injection', () => {
  for (const proxyUrl of ['http://0.0.0.0:8189', 'https://127.0.0.1:8189', 'http://127.0.0.1:80', profile.comfyUrl, 'http://127.0.0.1:8189/path', 'http://u:p@127.0.0.1:8189']) {
    assert.throws(() => localProxyConfig({ ...profile, proxyUrl }));
  }
});
test('existing aligned external proxy is reused without downloading, spawning or stopping it', async () => {
  const manager = new ProxyManager('/unused', { probe: async () => ({ status: 'healthy', upstream: profile.comfyUrl }), prepare: () => assert.fail('must not prepare'), spawn: () => assert.fail('must not spawn') });
  const state = await manager.start(profile);
  assert.equal(state.phase, 'running'); assert.equal(state.owned, false);
  assert.equal(manager.stop().owned, false);
});
test('external proxy pointing elsewhere is left untouched', async () => {
  const manager = new ProxyManager('/unused', { probe: async () => ({ status: 'healthy', upstream: 'http://127.0.0.1:9000' }), prepare: () => assert.fail('must not install') });
  await assert.rejects(manager.start(profile), /another ComfyUI/);
});
test('one-click path passes isolated interpreter and loopback-only arguments without a shell', async () => {
  const child = new FakeChild(); let probes = 0; let prepared = 0;
  const manager = new ProxyManager('/private-runtime', {
    probe: async () => ++probes === 1 ? null : { status: 'healthy', upstream: profile.comfyUrl },
    portCheck: async () => {}, pause: async () => {},
    prepare: async () => { prepared++; return 'C:\\Private Space\\python.exe'; },
    spawn: (file, args, options) => {
      assert.equal(file, 'C:\\Private Space\\python.exe');
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.ok(args.includes('127.0.0.1')); assert.ok(args.includes('8189'));
      assert.equal(args[args.indexOf('--comfyui') + 1], profile.comfyUrl);
      return child;
    },
  });
  assert.equal((await manager.start(profile)).owned, true);
  assert.equal(prepared, 1);
  manager.stop(); await Promise.resolve();
  assert.equal(child.killed, true); assert.equal(manager.snapshot().phase, 'idle');
});
test('occupied port fails before installing and does not touch its owner', async () => {
  const manager = new ProxyManager('/unused', { probe: async () => null, portCheck: async () => { throw new Error('Port in use'); }, prepare: () => assert.fail('must not prepare') });
  await assert.rejects(manager.start(profile), /Port in use/);
});
test('failed readiness stops only the child started by this manager', async () => {
  const child = new FakeChild();
  const manager = new ProxyManager('/unused', { probe: async () => null, portCheck: async () => {}, prepare: async () => '/fake/python.exe', spawn: () => child, pause: async () => {} });
  await assert.rejects(manager.start(profile), /did not become ready/);
  assert.equal(child.killed, true); assert.equal(manager.snapshot().owned, false);
});
test('parallel setup attempts are refused; cancellation signals runtime preparation', async () => {
  let finish; let signal;
  const manager = new ProxyManager('/unused', { probe: async () => null, portCheck: async () => {}, prepare: async (_root, _update, cancellation) => { signal = cancellation; return new Promise(resolve => { finish = resolve; }); } });
  const first = manager.start(profile);
  while (!finish) await Promise.resolve();
  await assert.rejects(manager.start(profile), /already in progress/);
  manager.stop(); assert.equal(signal.aborted, true); finish('/fake/python.exe');
  await assert.rejects(first, /cancelled/);
});
