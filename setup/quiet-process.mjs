import { existsSync } from 'node:fs';
// Dedicated hidden-console host prevents console grandchildren from flashing.
export function quietCommand(file, args, env = process.env, platform = process.platform, exists = existsSync) {
  const host = env.STEM_QUIET_PROCESS;
  return platform === 'win32' && typeof host === 'string' && host && exists(host) ? { file: host, args: [file, ...args] } : { file, args };
}
