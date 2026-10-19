import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { downloadVerified } from '../setup/download-verified.mjs';
import { extractArchive } from '../setup/comfy-install.mjs';
import { quietCommand } from './quiet-process.mjs';
import { MMAUDIO_ARCHIVE, MMAUDIO_COMMIT, MMAUDIO_FILES, MMAUDIO_IMPORTS, mmaudioFolders } from './mmaudio.mjs';

const MAX_ARCHIVE = 20 * 1024 * 1024;
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
// ComfyUI's own interpreter: the portable build keeps it next to the ComfyUI folder, other installs usually use a venv.
export async function comfyPython(installation, exists = path => stat(path).then(info => info.isFile(), () => false)) {
  for (const candidate of [join(installation, '..', 'python_embeded', 'python.exe'), join(installation, 'python_embeded', 'python.exe'), join(installation, 'venv', 'Scripts', 'python.exe'), join(installation, '.venv', 'Scripts', 'python.exe'), join(installation, 'venv', 'bin', 'python'), join(installation, '.venv', 'bin', 'python')]) if (await exists(candidate)) return candidate;
  return null;
}
// Every file of the unpacked archive must be one the manifest lists with the same git blob hash.
export async function verifyPack(folder, manifest) {
  const seen = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) seen.push(path);
      else throw Error('The node pack contains an unexpected entry. Nothing was installed.');
    }
  }
  await walk(folder);
  for (const path of seen) {
    const name = relative(folder, path).replaceAll('\\', '/');
    if (manifest.files[name] !== gitBlob(await readFile(path))) throw Error(`The downloaded node pack differs from the pinned version (${name}). Nothing was installed.`);
  }
  for (const required of ['__init__.py', 'nodes.py', 'requirements.txt']) if (!seen.some(path => relative(folder, path).replaceAll('\\', '/') === required)) throw Error(`The downloaded node pack is incomplete (${required}). Nothing was installed.`);
  return seen.length;
}
export class MMAudioManager {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch; this.spawn = options.spawn || spawn; this.extract = options.extract || extractArchive; this.files = options.files || MMAUDIO_FILES;
    this.manifest = options.manifest; this.state = { phase: 'idle', message: '', percent: -1 }; this.active = false; this.deps = null;
  }
  async loadManifest() { return this.manifest || JSON.parse(await readFile(new URL('./mmaudio-manifest.json', import.meta.url), 'utf8')); }
  async parts(profile) {
    let folders; try { folders = mmaudioFolders(profile); } catch { return { node: false, weights: false }; }
    const node = !!(await stat(join(folders.node, '.stemstudio.json')).catch(() => null));
    let weights = true; for (const file of this.files) if ((await stat(join(folders.models, file.path)).catch(() => null))?.size !== file.size) weights = false;
    return { node, weights };
  }
  async status(profile) {
    const { node, weights } = await this.parts(profile);
    if (this.deps === null && !this.active && profile.installation) this.deps = await this.checkDeps(profile).catch(() => false);
    const python = profile.installation ? !!(await comfyPython(profile.installation)) : false;
    return { ...this.state, node, weights, deps: !!this.deps, python, ready: node && weights && !!this.deps };
  }
  command(file, args, signal, onText) {
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    return new Promise((resolve, reject) => {
      const quiet = quietCommand(file, args, env);
      const child = this.spawn(quiet.file, quiet.args, { env, signal, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = ''; const log = chunk => { tail = (tail + chunk.toString()).slice(-2500); onText?.(tail); };
      child.stdout?.on('data', log); child.stderr?.on('data', log);
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(tail) : reject(Error(`Command failed (${code}). ${tail.split('\n').slice(-6).join(' ').trim()}`)));
    });
  }
  async checkDeps(profile) {
    const python = await comfyPython(profile.installation); if (!python) return false;
    try { await this.command(python, ['-c', `import ${MMAUDIO_IMPORTS.join(', ')}`]); return true; } catch { return false; }
  }
  cancel() { this.abort?.abort(); }
  async start(profile) {
    if (this.active) throw Error('MMAudio is already being prepared.');
    const folders = mmaudioFolders(profile);
    if (!(await stat(join(profile.installation, 'main.py')).catch(() => null))?.isFile()) throw Error('Select an existing ComfyUI installation first.');
    const existing = await stat(folders.node).catch(() => null);
    if (existing && !(await stat(join(folders.node, '.stemstudio.json')).catch(() => null))) throw Error('A custom node folder named ComfyUI-MMAudio already exists and was not installed by Stem Studio. Move it aside first, or install the weights yourself.');
    this.active = true; this.abort = new AbortController();
    this.state = { phase: 'installing', message: 'Starting…', percent: -1 };
    this.pending = this.run(profile, folders).catch(error => { this.state = { phase: this.abort.signal.aborted ? 'cancelled' : 'failed', message: this.abort.signal.aborted ? 'Cancelled. Downloaded files are kept and checked again next time.' : error.message, percent: -1 }; }).finally(() => { this.active = false; });
    return { ...this.state, ready: false };
  }
  async run(profile, folders) {
    const signal = this.abort.signal, parts = await this.parts(profile);
    if (!parts.node) await this.installNode(folders, signal);
    const python = await comfyPython(profile.installation);
    if (!(await this.checkDeps(profile).catch(() => false))) {
      if (!python) throw Error('ComfyUI\'s Python was not found next to the selected folder (python_embeded, venv or .venv). Install the packages from ComfyUI-MMAudio/requirements.txt into your ComfyUI Python, then retry.');
      this.state = { phase: 'installing', message: 'Installing the Python packages the node pack needs into ComfyUI…', percent: -1, detail: '' };
      await this.command(python, ['-m', 'pip', 'install', '--no-input', '-r', join(folders.node, 'requirements.txt')], signal, detail => { this.state.detail = detail; });
      this.deps = await this.checkDeps(profile);
      if (!this.deps) throw Error('The packages installed but ComfyUI\'s Python still cannot import them. See the ComfyUI log.');
    } else this.deps = true;
    const total = this.files.reduce((sum, file) => sum + file.size, 0); let before = 0;
    for (const file of this.files) {
      let reported = 0;
      await downloadVerified({ url: file.url, size: file.size, sha256: file.sha256 }, join(folders.models, file.path), { fetchImpl: this.fetchImpl, signal, onProgress: (done, size) => {
        const now = Date.now(); if (now - reported < 250 && done < size) return; reported = now;
        this.state = { phase: 'downloading', message: `Downloading ${file.name}`, percent: Math.round((before + done) / total * 100), detail: `${((before + done) / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MiB` };
      } });
      before += file.size;
    }
    this.state = { phase: 'complete', message: 'MMAudio is ready. Restart ComfyUI once so it loads the new nodes, then check the engine again.', percent: 100 };
  }
  async installNode(folders, signal) {
    this.state = { phase: 'installing', message: 'Downloading the MMAudio node pack from GitHub…', percent: -1 };
    const manifest = await this.loadManifest();
    const work = await mkdtemp(join(tmpdir(), 'stemstudio-mmaudio-'));
    try {
      const response = await this.fetchImpl(MMAUDIO_ARCHIVE, { signal, headers: { 'User-Agent': 'stem-studio-setup' } });
      if (!response.ok) throw Error(`The node pack download failed with HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_ARCHIVE) throw Error('The node pack archive has an unexpected size. Nothing was installed.');
      const archive = join(work, 'pack.zip'); await writeFile(archive, bytes);
      const unpacked = join(work, 'unpacked'); await this.extract(archive, unpacked);
      const roots = await readdir(unpacked); if (roots.length !== 1) throw Error('The node pack archive has an unexpected layout. Nothing was installed.');
      const root = join(unpacked, roots[0]);
      await verifyPack(root, manifest);
      await mkdir(join(folders.node, '..'), { recursive: true });
      await cp(root, folders.node, { recursive: true });
      await writeFile(join(folders.node, '.stemstudio.json'), JSON.stringify({ owner: 'Stem Studio', repo: manifest.repo, commit: manifest.commit || MMAUDIO_COMMIT }));
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}
