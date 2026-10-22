import { join, dirname } from 'node:path';
import { stat, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { prepareRuntime } from './proxy-manager.mjs';
import { quietCommand } from './quiet-process.mjs';
import { normalizeEndpoint } from './connection.mjs';

const SAM = 'bb4c6999d2677c7402360e426afc01ddfad6dce0';
const MISSING = (what, why) => [
  'class _Unavailable:',
  '    def __init__(self, *args, **kwargs):',
  `        raise RuntimeError('${what} is not available: ${why}')`,
  ''
].join('\n');
export const PYTHON_STUBS = {
  'xformers/__init__.py': '',
  'xformers/ops/__init__.py': 'class AttentionBias:\n    pass\n\n\nclass _Fmha:\n    def __getattr__(self, name):\n        raise RuntimeError("xformers is not available: Stem Studio uses PyTorch SDPA attention")\n\n\nfmha = _Fmha()\n',
  'torchcodec/__init__.py': '',
  'torchcodec/decoders.py': MISSING('torchcodec decoders', 'Stem Studio passes decoded tensors') + '\n\nAudioDecoder = VideoDecoder = _Unavailable\n',
  'torchcodec/encoders.py': MISSING('torchcodec encoders', 'SAM rankers are disabled') + '\n\nAudioEncoder = _Unavailable\n'
};
export function samConfig(profile, variant = 'small-tv') {
  if (!['small-tv','large-tv'].includes(variant)) throw Error('Choose SAM Small or Large.');
  const endpoint = new URL(normalizeEndpoint(profile.comfyUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !profile.installation) throw Error('SAM preparation needs the selected local ComfyUI folder.');
  return join(profile.installation, 'models', 'audio_separation', 'sam-audio-' + variant);
}
export class SAMManager {
  constructor(root, script, options = {}) { this.root = root; this.script = script; this.spawn = options.spawn || spawn; this.prepareRuntime = options.prepareRuntime || prepareRuntime; this.state = { phase: 'idle', message: '', detail: '' }; this.active = false; }
  async status(profile, variant = 'small-tv') {
    // Without a local ComfyUI folder the model simply is not ready; the status poll must not raise an error every few seconds.
    let model; try { model = samConfig(profile, variant); } catch { return { ...this.snapshot(), ready: false }; }
    let config; try { config = JSON.parse(await readFile(join(model, 'stem-runtime.json'), 'utf8')); } catch {}
    const ready = typeof config?.python === 'string' && (await stat(config.python).catch(() => null))?.isFile() && (await stat(join(model, 'checkpoint.pt')).catch(() => null))?.size > 0;
    return { ...this.snapshot(), ready: !!ready };
  }
  snapshot() { return { ...this.state }; }
  cancel() { this.abort?.abort(); }
  async start(profile, token, variant = 'small-tv') {
    if (this.active) throw Error('SAM preparation is already running.');
    const model = samConfig(profile, variant);
    if (typeof token !== 'string' || !/^hf_[a-zA-Z0-9]{10,250}$/.test(token)) throw Error('Enter a Hugging Face read token with access to SAM Audio and its encoder models.');
    if (!(await stat(join(profile.installation, 'main.py')).catch(() => null))?.isFile()) throw Error('Select an existing ComfyUI installation first.');
    if (this.active) throw Error('SAM preparation is already running.');
    this.active = true; this.abort = new AbortController();
    this.state = { phase: 'preparing', message: 'Preparing isolated SAM runtime…', detail: '' };
    this.pending = this.run(model, token, variant).catch(error => { this.state = { phase: this.abort.signal.aborted ? 'cancelled' : 'failed', message: this.abort.signal.aborted ? 'SAM preparation cancelled. Cached files are retained.' : error.message.replaceAll(token, '[redacted]'), detail: '' }; }).finally(() => { this.active = false; });
    return this.snapshot();
  }
  async run(model, token, variant = 'small-tv') {
    const update = patch => Object.assign(this.state, patch);
    await mkdir(model, { recursive: true });
    await rm(join(model, 'stem-runtime.json'), { force: true });
    const proxyRoot = join(this.root, '..', 'managed-proxy');
    await this.prepareRuntime(proxyRoot, update, this.abort.signal);
    const uv = join(proxyRoot, 'uv-0.13.1', 'uv.exe');
    const runtime = join(this.root, 'runtime');
    const python = join(runtime, 'Scripts', 'python.exe');
    const previousCache=join(dirname(model),'sam-audio-small-tv','cache');
    const cacheRoot=(await stat(previousCache).catch(()=>null))?.isDirectory()?previousCache:join(dirname(model),'sam-shared-cache');
    const env = { ...process.env, HF_TOKEN: token, HF_HOME: cacheRoot, TORCH_HOME: join(cacheRoot, 'torch'), XDG_CACHE_HOME: join(cacheRoot, 'xdg'), UV_PYTHON_INSTALL_DIR: join(proxyRoot, 'python'), UV_CACHE_DIR: join(this.root, 'cache'), UV_NO_PROGRESS: '1', PYTHONUNBUFFERED: '1' };
    for (const key of Object.keys(env)) if (/^(PIP_|UV_INDEX|UV_DEFAULT_INDEX|UV_EXTRA_INDEX)/.test(key)) delete env[key];
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']) delete env[key];
    await mkdir(model, { recursive: true });
    const command = async (file, args) => new Promise((resolve, reject) => {
      const quiet = quietCommand(file, args, env);
      const child = this.spawn(quiet.file, quiet.args, { env, signal: this.abort.signal, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = ''; const log = chunk => { tail = (tail + chunk.toString().replaceAll(token, '[redacted]')).slice(-2500); update({ detail: tail }); };
      child.stdout.on('data', log); child.stderr.on('data', log);
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`SAM preparation failed (${code}). ${tail}`)));
    });
    await command(uv, ['--no-config', 'venv', '--python', '3.12', '--managed-python', '--allow-existing', runtime]);
    const constraints = join(this.root, 'sam-constraints.txt');
    await writeFile(constraints, 'torch==2.11.0\ntorchaudio==2.11.0\ntorchvision==0.26.0\ntorchcodec==0.15.0\ntransformers>=4.54,<5\nnumpy<2\n');
    update({ phase: 'installing', message: 'Installing private CUDA libraries…' });
    await command(uv, ['--no-config', 'pip', 'install', '--python', python, '--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.11.0', 'torchaudio==2.11.0', 'torchvision==0.26.0']);
    update({ message: 'Installing SAM Audio and its private dependencies…' });
    // Pin the upstream code and avoid auxiliary Git dependency resolution.
    // Explicit runtime dependencies preserve the matched CUDA stack below.
    await command(uv, ['--no-config', 'pip', 'install', '--python', python, '--no-deps', '--default-index', 'https://pypi.org/simple',
      `sam_audio @ https://github.com/facebookresearch/sam-audio/archive/${SAM}.zip`,
      'dacvae @ https://github.com/facebookresearch/dacvae/archive/414c20785fc3a28373073ea8ef7a1316eeeaca6e.zip',
      'imagebind @ https://github.com/facebookresearch/ImageBind/archive/53680b02d7e37b19b124fa37bae4b6c98c38f5be.zip',
      'perception-models @ https://github.com/facebookresearch/perception_models/archive/e72b6810b1133e1c879f2cc965d276eb73803f1f.zip',
      'laion-clap @ https://github.com/lematt1991/CLAP/archive/b85cb7ecac0af7d064cbf03ebd990e709e959fe7.zip',
      'pytorchvideo @ https://github.com/facebookresearch/pytorchvideo/archive/6cdc929315aab1b5674b6dcf73b16ec99147735f.zip']);
    await command(uv, ['--no-config', 'pip', 'install', '--python', python, '--constraint', constraints, '--default-index', 'https://pypi.org/simple', 'transformers>=4.54,<5', 'huggingface-hub>=0.34,<1', 'numpy<2', 'soundfile', 'scipy', 'einops', 'torchdiffeq', 'audiobox-aesthetics', 'pydub', 'sentencepiece', 'tiktoken', 'safetensors', 'timm', 'ftfy', 'regex', 'iopath', 'fvcore', 'librosa', 'torchlibrosa', 'webdataset', 'braceexpand', 'wget', 'tqdm', 'omegaconf', 'hydra-core', 'scikit-learn', 'pandas', 'tensorboard', 'matplotlib', 'pyyaml', 'descript-audiotools', 'encodec', 'beartype', 'easydict', 'argbind', 'setuptools<81', 'av', 'parameterized', 'yacs', 'msgspec', 'rouge-score', 'sacrebleu', 'blobfile', 'wandb', 'viztracer', 'pynvml', 'orjson', 'pyahocorasick', 'torchdata', 'opencv-python', 'h5py', 'progressbar']);
    // perception-models imports xformers at module load but only calls it for the unused "fmha" mode (default is SDPA).
    // sam_audio imports torchcodec, which needs system FFmpeg DLLs on Windows; Stem Studio only passes tensors, never file paths.
    const site = join(runtime, 'Lib', 'site-packages');
    await rm(join(site, 'torchcodec'), { recursive: true, force: true });
    for (const [file, text] of Object.entries(PYTHON_STUBS)) {
      await mkdir(dirname(join(site, file)), { recursive: true });
      await writeFile(join(site, file), text);
    }
    update({ phase: 'downloading', message: 'Downloading approved SAM weights and encoder files. Existing cache is reused…' });
    await command(python, [this.script, model, 'facebook/sam-audio-' + variant]);
    // Marker is written only after imports, processor and model load succeed.
    await writeFile(join(model, 'stem-runtime.json'), JSON.stringify({ python, revision: SAM, repo: 'facebook/sam-audio-' + variant, cacheRoot }, null, 2));
    this.state = { phase: 'complete', message: 'SAM Audio prepared. Select a target and extract a short range.', detail: '' };
  }
}
