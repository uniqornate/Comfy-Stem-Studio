import test from 'node:test';
import assert from 'node:assert/strict';
import { quietCommand } from '../setup/quiet-process.mjs';
test('hidden console command preserves argument boundaries, original executable and no shell source', () => {
  const args = ['-c', 'print("a b")', 'C:\\folder with spaces\\tail\\', ''];
  const command = quietCommand('C:\\Python\\python.exe', args, { STEM_QUIET_PROCESS: 'C:\\App\\QuietProcess.exe' }, 'win32', () => true);
  assert.equal(command.file, 'C:\\App\\QuietProcess.exe'); assert.deepEqual(command.args, ['C:\\Python\\python.exe', ...args]); assert.deepEqual(args, ['-c', 'print("a b")', 'C:\\folder with spaces\\tail\\', '']);
});
test('missing host and other platforms retain direct hidden spawn compatibility', () => {
  for(const [environment, platform, exists] of [[{}, 'win32', () => true], [{ STEM_QUIET_PROCESS: 'missing.exe' }, 'win32', () => false], [{ STEM_QUIET_PROCESS: 'host.exe' }, 'linux', () => true]]) assert.deepEqual(quietCommand('python', ['arg'], environment, platform, exists), { file: 'python', args: ['arg'] });
});
