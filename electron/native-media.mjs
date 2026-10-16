import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename, join } from 'node:path';

export function nativeRelative(root, type, file) {
  if (!['input', 'output'].includes(type)) throw Error('Invalid ComfyUI media type.');
  const rel = relative(resolve(root, type), resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Media must stay inside the selected ComfyUI folder.');
  return rel.replaceAll('\\', '/');
}
export async function nativePath(root, type, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('Invalid native media reference.');
  const directory = resolve(root, type), file = resolve(directory, name);
  nativeRelative(root, type, file);
  const canonical = await realpath(file).catch(() => null);
  if (!canonical) return null;
  nativeRelative(await realpath(root), type, canonical);
  return (await stat(canonical)).isFile() ? canonical : null;
}
export async function nativeOutput(root, prefix, name) {
  if (!root || !prefix || typeof name !== 'string' || !/\.flac$/i.test(name)) return null;
  const folder = prefix.split('/').slice(0, -1).join('/');
  for (const candidate of [name, `${folder}/${basename(name.replaceAll('\\', '/'))}`]) {
    const path = await nativePath(root, 'output', candidate);
    if (path && nativeRelative(root, 'output', path).startsWith(`${folder}/`)) return path;
  }
  return null;
}
