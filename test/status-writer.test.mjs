import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusWriter } from '../setup/status-writer.mjs';

test('a Windows status-file replacement lock cannot abort setup and subsequent updates recover', async () => {
  let locked = true; let snapshot; const writes = [];
  const reporter = createStatusWriter('fixture-status', {
    writeFile: async (path, text) => { writes.push(text); },
    rename: async () => {
      if (locked) throw Object.assign(new Error('Fixture file is locked'), { code: 'EPERM' });
      snapshot = JSON.parse(writes.at(-1));
    },
  });
  reporter.update({ phase: 'verifying', message: 'Verifying model', detail: 'model.pth' });
  await reporter.flush();
  locked = false;
  reporter.update({ phase: 'copying', message: 'Installing integration' });
  await reporter.flush();
  assert.equal(snapshot.message, 'Installing integration');
  assert.equal(snapshot.detail, 'model.pth');
});

test('rapid checkpoint counters are throttled but stage changes publish immediately', async () => {
  let time = 0; const values = [];
  const reporter = createStatusWriter('fixture-status', {
    writeFile: async (path, text) => { values.push(JSON.parse(text)); }, rename: async () => {},
  }, () => time);
  reporter.update({ phase: 'verifying', message: 'Verifying model', current: 0 });
  for (let n = 1; n <= 128; n++) reporter.update({ current: n });
  await reporter.flush();
  assert.equal(values.length, 1);
  time = 201; reporter.update({ current: 129 });
  reporter.update({ phase: 'copying', message: 'Copying files' });
  await reporter.flush();
  assert.equal(values.length, 3); assert.equal(values[1].current, 129);
});

test('status write failures are handled immediately without an unhandled promise rejection', async () => {
  const reporter = createStatusWriter('fixture-status', {
    writeFile: async () => { throw new Error('Fixture write failure'); }, rename: async () => assert.fail('must not rename'),
  });
  reporter.update({ message: 'First stage' });
  await new Promise(resolve => setImmediate(resolve));
  reporter.update({ message: 'Second stage' });
  await reporter.flush();
});
