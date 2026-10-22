import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// The ComfyUI node pack repository (a clone in custom_nodes) provides the same nodes as the integration the desktop app
// copies into custom_nodes/StemStudio. Both at once would load every node twice and the copy would overwrite the pack's
// own files, so the desktop app leaves its copy alone when it finds the pack.
export async function findNodePack(installation) {
  if (!installation) return null;
  const folder = join(installation, 'custom_nodes');
  let entries; try { entries = await readdir(folder); } catch { return null; }
  for (const name of entries) {
    if (name === 'StemStudio' || name.endsWith('.disabled') || name.startsWith('.')) continue;
    if ((await stat(join(folder, name, 'comfy_nodes', 'StemStudio', 'web_routes.py')).catch(() => null))?.isFile()) return join(folder, name);
  }
  return null;
}
