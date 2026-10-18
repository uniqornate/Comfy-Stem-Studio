// Brush: paint a sound into a region of a new channel from a text prompt, using Stable Audio 3 Small-SFX through
// ComfyUI's own nodes. No private runtime is needed; the two model files sit in <ComfyUI>/models/audio_separation/stable-audio-3
// and the StemStudio node registers that folder with ComfyUI's checkpoint and text encoder lists.
export const BRUSH_FOLDER = 'stable-audio-3';
export const BRUSH_CHECKPOINT = 'stable_audio_3_small_sfx.safetensors';
export const BRUSH_ENCODER = 't5gemma_b_b_ul2.safetensors';
const REVISION = '75aad8836271cb5a5123fb58304fae5d3bb4b0f9';
const BASE = `https://huggingface.co/Comfy-Org/stable-audio-3/resolve/${REVISION}`;
export const BRUSH_FILES = [
  { path: BRUSH_CHECKPOINT, name: 'Stable Audio 3 Small-SFX', url: `${BASE}/checkpoints/${BRUSH_CHECKPOINT}`, size: 2270384940, sha256: 'ed9cf1b6172f1a8c2921a9560c21109ff3239524563ced9dce6dcdef41e2f515' },
  { path: BRUSH_ENCODER, name: 'T5Gemma text encoder', url: `${BASE}/text_encoders/${BRUSH_ENCODER}`, size: 1187264003, sha256: '1e1eba25be8872edb0d3c6335c6658fd6388e7b14b60da6e454e404cfcd8150e' },
];
export const BRUSH_MIN_SECONDS = 0.5;
export const BRUSH_MAX_SECONDS = 60;
export function normalizeBrush(value) {
  if (!value || typeof value !== 'object') throw Error('Describe the sound to paint.');
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!prompt || prompt.length > 300) throw Error('Describe the sound in 1 to 300 characters.');
  const { seconds, start } = value, seed = value.seed ?? 0, steps = value.steps ?? 8;
  if (![seconds, start, seed, steps].every(Number.isFinite) || start < 0 || start > 864000) throw Error('Select a valid region on the timeline.');
  if (seconds < BRUSH_MIN_SECONDS || seconds > BRUSH_MAX_SECONDS) throw Error(`Paint between ${BRUSH_MIN_SECONDS} and ${BRUSH_MAX_SECONDS} seconds at a time.`);
  if (!Number.isInteger(steps) || steps < 4 || steps > 50 || !Number.isInteger(seed) || seed < 0 || seed > 2 ** 32) throw Error('Invalid brush settings.');
  return { prompt, seconds: Math.round(seconds * 1000) / 1000, start: Math.round(start * 1000) / 1000, seed, steps };
}
// LoadAudio '1' is the project source and only supplies the length the painted clip is padded to.
export function brushGraph(options) {
  const brush = normalizeBrush(options.brush);
  return {
    '1': { class_type: 'LoadAudio', inputs: { audio: '' } },
    '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: BRUSH_CHECKPOINT } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: BRUSH_ENCODER, type: 'stable_audio', device: 'default' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: brush.prompt } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: '' } },
    '6': { class_type: 'EmptyLatentAudio', inputs: { seconds: brush.seconds, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: brush.seed, steps: brush.steps, cfg: 1, sampler_name: 'lcm', scheduler: 'simple', denoise: 1 } },
    '8': { class_type: 'VAEDecodeAudio', inputs: { samples: ['7', 0], vae: ['2', 2] } },
    '9': { class_type: 'StemStudioRestoreRange', inputs: { audio: ['8', 0], reference: ['1', 0], start_seconds: brush.start } },
    '10': { class_type: 'SaveAudio', inputs: { audio: ['9', 0], filename_prefix: 'StemStudio/brush' } },
  };
}
export const BRUSH_NODES = ['CheckpointLoaderSimple', 'CLIPLoader', 'CLIPTextEncode', 'KSampler', 'EmptyLatentAudio', 'VAEDecodeAudio', 'StemStudioRestoreRange'];
// What the engine reports: nodes present and the two files visible to ComfyUI's loaders.
export function brushCapability(nodes) {
  const nodesReady = BRUSH_NODES.every(name => nodes[name]) && !!nodes.CLIPLoader?.input?.required?.type?.[0]?.includes?.('stable_audio');
  const modelReady = !!nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.includes?.(BRUSH_CHECKPOINT) && !!nodes.CLIPLoader?.input?.required?.clip_name?.[0]?.includes?.(BRUSH_ENCODER);
  return { brush: nodesReady, brushModel: nodesReady && modelReady };
}
