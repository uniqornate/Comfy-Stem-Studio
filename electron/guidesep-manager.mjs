import { join } from 'node:path';
import { stat, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { prepareRuntime } from './proxy-manager.mjs';
import { quietCommand } from './quiet-process.mjs';
import { normalizeEndpoint } from './connection.mjs';

const REVISION = 'c7f97a2f938e355a6aefa53bf5e81ceaf3604275';
export function guidesepConfig(profile) {
  const endpoint = new URL(normalizeEndpoint(profile.comfyUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !profile.installation) throw Error('GuideSep preparation needs the selected local ComfyUI folder.');
  return join(profile.installation, 'models', 'audio_separation', 'guidesep-v1');
}
export class GuideSepManager {
  constructor(root, script, options = {}) { this.root = root; this.script = script; this.spawn = options.spawn || spawn; this.prepareRuntime = options.prepareRuntime || prepareRuntime; this.state = { phase: 'idle', message: '', detail: '' }; this.active = false; }
  async status(profile) {
    let model; try { model = guidesepConfig(profile); } catch { return { ...this.snapshot(), ready: false }; }
    let config; try { config = JSON.parse(await readFile(join(model, 'stem-runtime.json'), 'utf8')); } catch {}
    const ready = typeof config?.python === 'string' && (await stat(config.python).catch(() => null))?.isFile() && (await stat(join(model, 'guidesep.pt')).catch(() => null))?.size > 0;
    return { ...this.snapshot(), ready: !!ready };
  }
  snapshot() { return { ...this.state }; }
  cancel() { this.abort?.abort(); }
  async start(profile) {
    if (this.active) throw Error('GuideSep preparation is already running.');
    const model = guidesepConfig(profile);
    if (!(await stat(join(profile.installation, 'main.py')).catch(() => null))?.isFile()) throw Error('Select an existing ComfyUI installation first.');
    this.active = true; this.abort = new AbortController();
    this.state = { phase: 'preparing', message: 'Preparing isolated GuideSep runtime…', detail: '' };
    this.pending = this.run(model).catch(error => { this.state = { phase: this.abort.signal.aborted ? 'cancelled' : 'failed', message: this.abort.signal.aborted ? 'GuideSep preparation cancelled. Downloaded files are retained.' : error.message, detail: '' }; }).finally(() => { this.active = false; });
    return this.snapshot();
  }
  async run(model) {
    const update = patch => Object.assign(this.state, patch);
    await mkdir(model, { recursive: true });
    await rm(join(model, 'stem-runtime.json'), { force: true });
    const proxyRoot = join(this.root, '..', 'managed-proxy');
    await this.prepareRuntime(proxyRoot, update, this.abort.signal);
    const uv = join(proxyRoot, 'uv-0.13.1', 'uv.exe');
    const runtime = join(this.root, 'runtime');
    const python = join(runtime, 'Scripts', 'python.exe');
    const env = { ...process.env, HF_HOME: join(model, 'cache'), UV_PYTHON_INSTALL_DIR: join(proxyRoot, 'python'), UV_CACHE_DIR: join(this.root, '..', 'sam-audio', 'cache'), UV_NO_PROGRESS: '1', PYTHONUNBUFFERED: '1' };
    for (const key of Object.keys(env)) if (/^(PIP_|UV_INDEX|UV_DEFAULT_INDEX|UV_EXTRA_INDEX)/.test(key)) delete env[key];
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE', 'HF_HUB_OFFLINE']) delete env[key];
    const command = async (file, args) => new Promise((resolve, reject) => {
      const quiet = quietCommand(file, args, env);
      const child = this.spawn(quiet.file, quiet.args, { env, signal: this.abort.signal, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = ''; const log = chunk => { tail = (tail + chunk.toString()).slice(-2500); update({ detail: tail }); };
      child.stdout.on('data', log); child.stderr.on('data', log);
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`GuideSep preparation failed (${code}). ${tail}`)));
    });
    await command(uv, ['--no-config', 'venv', '--python', '3.12', '--managed-python', '--allow-existing', runtime]);
    update({ phase: 'installing', message: 'Installing private CUDA libraries…' });
    await command(uv, ['--no-config', 'pip', 'install', '--python', python, '--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.11.0', 'torchaudio==2.11.0']);
    update({ message: 'Installing GuideSep dependencies…' });
    await command(uv, ['--no-config', 'pip', 'install', '--python', python, '--default-index', 'https://pypi.org/simple', '--constraint', await this.constraints(), 'numpy', 'scipy', 'soundfile', 'einops', 'einops-exts', 'torchsde', 'typing_extensions', 'huggingface-hub>=0.34,<1', 'omegaconf', 'tqdm']);
    update({ phase: 'downloading', message: 'Downloading the GuideSep checkpoint (about 1 GB) and extracting weights…' });
    await command(python, [this.script, model]);
    await writeFile(join(model, 'stem-runtime.json'), JSON.stringify({ python, revision: REVISION, repo: 'YutongCooper/GuideSep-v1' }, null, 2));
    this.state = { phase: 'complete', message: 'GuideSep prepared. Choose a reference sound and extract a short range first.', detail: '' };
  }
  async constraints() {
    const file = join(this.root, 'guidesep-constraints.txt');
    await mkdir(this.root, { recursive: true });
    await writeFile(file, 'torch==2.11.0\ntorchaudio==2.11.0\n');
    return file;
  }
}
