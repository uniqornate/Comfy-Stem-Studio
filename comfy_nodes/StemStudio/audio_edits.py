"""Non-destructive, full-length clip/gain rendering. No media or model imports."""
import json
import math

def parse_edits(raw, duration):
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not value:
        return None
    if not isinstance(value, dict) or not isinstance(value.get('clips'), list) or not isinstance(value.get('gains'), list) or len(value['clips']) > 256 or len(value['gains']) > 512:
        raise ValueError('Invalid clip edits')
    for key in ['clips', 'gains']:
        previous = -1
        for item in value[key]:
            start, end = item['start'], item['end']
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [start, end]) or start < 0 or end <= start or end > 864000 or start < previous - .000001:
                raise ValueError('Invalid clip range')
            previous = end
            if key == 'gains' and (not isinstance(item['db'], (int, float)) or not math.isfinite(item['db']) or not -60 <= item['db'] <= 24):
                raise ValueError('Invalid clip gain')
    return value

def edit_array(wave, rate, raw):
    import numpy as np
    edit = parse_edits(raw, wave.shape[-1] / rate)
    if edit is None:
        return wave
    envelope = np.zeros(wave.shape[-1], dtype=np.float32)
    for clip in edit['clips']:
        envelope[round(clip['start'] * rate):round(clip['end'] * rate)] = 1
    for region in edit['gains']:
        envelope[round(region['start'] * rate):round(region['end'] * rate)] *= 10 ** (region['db'] / 20)
    return wave * envelope

class StemStudioEditAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'audio': ('AUDIO',), 'edits_json': ('STRING', {'default': '{}'})}}
    RETURN_TYPES = ('AUDIO',)
    FUNCTION = 'render'
    CATEGORY = 'Stem Studio'
    def render(self, audio, edits_json='{}'):
        import torch
        wave = audio['waveform']
        result = edit_array(wave.detach().float().cpu().numpy(), audio['sample_rate'], edits_json)
        return ({'waveform': torch.from_numpy(result).to(device=wave.device, dtype=wave.dtype), 'sample_rate': audio['sample_rate']},)
