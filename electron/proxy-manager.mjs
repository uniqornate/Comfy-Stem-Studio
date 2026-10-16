import { quietCommand } from './quiet-process.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { normalizeEndpoint } from './connection.mjs';

const UV = { version: '0.13.1', url: 'https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-pc-windows-msvc.zip', size: 15308685, sha256: '3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672' };
const PROXY_VERSION = '0.1.6';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

export function localProxyConfig(profile) {
  const comfyUrl = normalizeEndpoint(profile.comfyUrl);
  const proxyUrl = normalizeEndpoint(profile.proxyUrl);
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/') {
    throw new Error('Automatic setup supports http://127.0.0.1:PORT or http://localhost:PORT. Use Check connection for an externally managed proxy.');
  }
  const port = Number(url.port || 80);
  if (port < 1024 || port > 65535) throw new Error('Choose a local proxy port between 1024 and 65535.');
  if (proxyUrl === comfyUrl) throw new Error('ComfyUI and API Proxy need separate ports.');
  return { comfyUrl, proxyUrl, port };
}

async function health(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${url}/api/v2/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.status === 'healthy' && typeof value.upstream === 'string' ? value : null;
  } catch { return null; }
}
async function availablePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use. Choose another proxy port; the existing process was left running.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function runCommand(file, args, { cwd, env, signal, update, timeout = 600000 }) {
  return new Promise((resolve, reject) => {
    const command = quietCommand(file, args, env);
    const child = spawn(command.file, command.args, { cwd, env, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = chunk => { tail = (tail + chunk.toString()).slice(-2500); update({ detail: tail }); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Proxy preparation timed out. Retry when the internet connection is available.')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Proxy preparation failed (exit ${code}). ${tail.trim()}`)); });
  });
}

export async function prepareRuntime(root, update, signal) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Automatic proxy installation is currently available for Windows x64.');
  await mkdir(root, { recursive: true });
  const runtime = join(root, `proxy-${PROXY_VERSION}`);
  const python = join(runtime, 'Scripts', 'python.exe');
  const marker = join(runtime, 'stem-ready.json');
  if (await exists(python) && await exists(marker)) return python;
  const tools = join(root, `uv-${UV.version}`);
  const uv = join(tools, 'uv.exe');
  if (!(await exists(uv))) {
    update({ phase: 'downloading', message: 'Downloading the runtime manager…', detail: 'First use downloads uv, a private Python runtime and the official API Proxy.' });
    const response = await fetch(UV.url, { signal });
    if (!response.ok) throw new Error(`Runtime manager download failed (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== UV.size || createHash('sha256').update(bytes).digest('hex') !== UV.sha256) throw new Error('Runtime manager integrity check failed. Retry setup.');
    const archive = join(root, 'uv.zip');
    await writeFile(archive, bytes);
    // Values travel through environment variables, not interpolated PowerShell source.
    const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STEM_UV_ARCHIVE,$env:STEM_UV_DEST)";
    const extracted = join(root, `uv-stage-${Date.now()}`);
    await runCommand(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root, env: { ...process.env, STEM_UV_ARCHIVE: archive, STEM_UV_DEST: extracted }, signal, update,
    });
    // The pinned upstream ZIP contains its binaries at the archive root.
    const uvSource = await exists(join(extracted, 'uv.exe')) ? join(extracted, 'uv.exe') : join(extracted, 'uv-x86_64-pc-windows-msvc', 'uv.exe');
    if (!(await exists(uvSource))) throw new Error('The runtime manager archive has an unexpected layout.');
    await mkdir(tools, { recursive: true });
    await rename(uvSource, uv);
    await rm(archive, { force: true });
  }
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'), UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'automatic' };
  for (const name of Object.keys(env)) if (/^(PIP_|UV_INDEX|UV_DEFAULT_INDEX|UV_EXTRA_INDEX)/.test(name)) delete env[name];
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
  update({ phase: 'installing', message: 'Preparing private Python…', detail: 'Your system Python and ComfyUI environment are not modified.' });
  await runCommand(uv, ['--no-config', 'venv', '--python', '3.12', '--managed-python', '--allow-existing', runtime], { cwd: root, env, signal, update });
  update({ phase: 'installing', message: 'Installing the official API Proxy…', detail: 'Installing into Stem Studio’s private environment.' });
  await runCommand(uv, ['--no-config', 'pip', 'install', '--python', python, '--default-index', 'https://pypi.org/simple', '--only-binary', ':all:', `comfy-api-proxy==${PROXY_VERSION}`], { cwd: root, env, signal, update });
  await writeFile(marker, JSON.stringify({ version: PROXY_VERSION }));
  return python;
}

export class ProxyManager {
  constructor(root, options = {}) {
    this.root = root;
    this.prepare = options.prepare || prepareRuntime;
    this.probe = options.probe || health;
    this.portCheck = options.portCheck || availablePort;
    this.spawn = options.spawn || spawn;
    this.pause = options.pause || delay;
    this.child = null; this.pending = null; this.abort = null; this.stopped = new WeakSet(); this.startedUrl = '';
    this.state = { phase: 'idle', message: 'Local proxy can be prepared automatically.', detail: '', owned: false };
  }
  snapshot() { return { ...this.state }; }
  update(patch) { Object.assign(this.state, patch); }
  async start(profile) {
    if (this.pending) throw new Error('Proxy preparation is already in progress.');
    const config = localProxyConfig(profile);
    if (this.child && this.startedUrl !== config.proxyUrl) throw new Error('Stop the managed proxy before selecting a different proxy address.');
    this.abort = new AbortController();
    this.pending = this.startInternal(config);
    try { await this.pending; } catch (error) {
      if (this.state.phase === 'starting') this.stopOwned();
      this.update({ phase: 'error', message: error.message, owned: !!this.child }); throw error;
    }
    finally { this.pending = null; this.abort = null; }
    return this.snapshot();
  }
  async startInternal(config) {
    this.update({ phase: 'checking', message: 'Checking the local proxy…', detail: '' });
    const current = await this.probe(config.proxyUrl);
    if (current) {
      if (normalizeEndpoint(current.upstream) !== config.comfyUrl) throw new Error('This proxy points to another ComfyUI. Stop it through its owner or choose a different proxy port.');
      this.update({ phase: 'running', message: this.child ? 'Stem Studio proxy is running.' : 'Using your existing proxy. Its lifecycle remains externally managed.', owned: !!this.child });
      return;
    }
    if (this.child) throw new Error('The managed proxy is already running or starting. Stop it before changing the connection.');
    await this.portCheck(config.port);
    const python = await this.prepare(this.root, patch => this.update(patch), this.abort.signal);
    if (this.abort.signal.aborted) throw new Error('Proxy setup cancelled.');
    await this.portCheck(config.port);
    this.update({ phase: 'starting', message: 'Starting the local API Proxy…', detail: '' });
    const command = quietCommand(python, ['-I', '-u', '-c', 'from comfy_api_proxy.cli import main; raise SystemExit(main())', '--comfyui', config.comfyUrl, '--host', '127.0.0.1', '--port', String(config.port)]);
    const child = this.spawn(command.file, command.args, { cwd: this.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; this.startedUrl = config.proxyUrl; this.update({ owned: true });
    let spawnError = null;
    const onData = chunk => this.update({ detail: (this.state.detail + chunk.toString()).slice(-2500) });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', error => { spawnError = error; if (this.child === child) this.child = null; });
    child.once('exit', code => {
      if (this.child === child) this.child = null;
      if (!this.stopped.has(child)) this.update({ phase: 'error', message: `The managed proxy exited (${code ?? 'unknown'}). See details and retry.`, owned: false });
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (this.child !== child) throw new Error(this.state.message);
      if (this.abort.signal.aborted) throw new Error('Proxy setup cancelled.');
      const ready = await this.probe(config.proxyUrl);
      if (ready && normalizeEndpoint(ready.upstream) === config.comfyUrl) {
        this.update({ phase: 'running', message: 'Local API Proxy is ready. No terminal window is needed.', owned: true });
        return;
      }
      await this.pause(250);
    }
    this.stopOwned();
    throw new Error('The proxy did not become ready. Check details, the port and your security software.');
  }
  stopOwned() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    this.stopped.add(child);
    child.kill();
  }
  stop() {
    this.abort?.abort(); this.stopOwned();
    this.update({ phase: 'idle', message: 'Stem Studio proxy stopped. External services were left running.', detail: '', owned: false });
    return this.snapshot();
  }
}
