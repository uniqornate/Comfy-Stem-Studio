import { writeFile, rename } from 'node:fs/promises';

// Windows readers can briefly lock a status file against replacement. Progress
// reporting is best-effort and must never abort the actual preparation task.
export function createStatusWriter(path, io = { writeFile, rename }, now = Date.now) {
  let pending = Promise.resolve();
  let status = { phase: 'preparing', message: 'Preparing services…', detail: '' };
  let lastAt = -Infinity; let lastMessage = ''; let lastPhase = '';
  return {
    update(patch) {
      status = { ...status, ...patch };
      const time = now();
      if (time - lastAt < 200 && status.message === lastMessage && status.phase === lastPhase) return;
      lastAt = time; lastMessage = status.message; lastPhase = status.phase;
      const snapshot = JSON.stringify(status);
      pending = pending.then(async () => {
        await io.writeFile(`${path}.tmp`, snapshot);
        await io.rename(`${path}.tmp`, path);
      }).catch(() => {});
    },
    flush() { return pending; },
  };
}
