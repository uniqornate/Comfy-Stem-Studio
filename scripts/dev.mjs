// Developer workflow: renderer HMR via Vite, Electron restarts on main-process edits,
// and ComfyUI integration files are mirrored into the selected ComfyUI on every save.
import { spawn } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyIntegration } from '../electron/separation.mjs';
import { findNodePack } from '../electron/node-pack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const log = text => console.log(`\x1b[35m[dev]\x1b[0m ${text}`);
const children = new Set();
const run = (file, args, extra = {}) => {
  const child = spawn(file, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...extra });
  children.add(child); child.once('exit', () => children.delete(child));
  return child;
};

async function nodeDestination() {
  const appData = process.env.APPDATA || join(process.env.HOME || '', '.config');
  const profile = JSON.parse(await readFile(join(appData, 'stem-studio', 'connection.json'), 'utf8'));
  const destination = join(profile.installation || '', 'custom_nodes', 'StemStudio');
  return profile.installation && existsSync(join(destination, '.stemstudio.json')) ? destination : null;
}
let syncTimer;
async function syncNodes(reason) {
  try {
    const profile = JSON.parse(await readFile(join(process.env.APPDATA || join(process.env.HOME || '', '.config'), 'stem-studio', 'connection.json'), 'utf8'));
    const pack = await findNodePack(profile.installation);
    if (pack) return log(`Node sync skipped: the Stem Studio node pack is installed in ${pack}.`);
    const destination = await nodeDestination();
    if (!destination) return log('Node sync skipped: no installed Stem Studio integration found. Run setup once first.');
    const { count, changed } = await copyIntegration(join(root, 'comfy_nodes', 'StemStudio'), destination);
    log(changed ? `Synced ${count} integration files (${reason}). Restart ComfyUI to load node changes.` : `Integration already current (${reason}).`);
  } catch (error) { log(`Node sync failed: ${error.message}`); }
}

await syncNodes('startup');
watch(join(root, 'comfy_nodes', 'StemStudio'), { recursive: true }, (_event, name) => {
  if (!name || /__pycache__|\.pyc$/.test(name)) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNodes(name), 300);
});

run(npx, ['vite', '--host', '127.0.0.1']);
await new Promise(resolve => { const poll = setInterval(async () => { try { const r = await fetch('http://127.0.0.1:5173'); if (r.ok) { clearInterval(poll); resolve(); } } catch {} }, 300); });

let electron; let restartTimer; let quitting = false;
function startElectron() {
  electron = run(npx, ['electron', '.', '--dev']);
  electron.once('exit', code => { if (!quitting && !electron.restarting) { log(`Electron closed (${code}). Stopping dev server.`); shutdown(); } });
}
function restartElectron(name) {
  log(`Main-process change (${name}); restarting Electron.`);
  electron.restarting = true;
  spawn('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }).once('exit', () => setTimeout(startElectron, 400));
}
watch(join(root, 'electron'), { recursive: true }, (_event, name) => {
  clearTimeout(restartTimer); restartTimer = setTimeout(() => restartElectron(name || 'electron/'), 400);
});
function shutdown() {
  quitting = true;
  for (const child of children) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
startElectron();
log('Renderer edits hot-reload. electron/ edits restart the window. comfy_nodes edits sync to ComfyUI (restart ComfyUI for Python changes).');
