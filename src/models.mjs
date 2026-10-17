// Separation models offered as tiles. `kind` decides which panel the workspace shows.
export const MODELS = [
  { id: 'mrx', short: 'MRX', name: 'MERL MRX · adapted loudness', detail: 'Dialogue, music and effects. MIT weights. Default.', kind: 'stems' },
  { id: 'bandit', short: 'BandIt', name: 'BandIt v2 · multilingual', detail: 'Dialogue, music and effects. CC BY-SA 4.0 weights.', kind: 'stems' },
  { id: 'sfc', short: 'SFC', name: 'SFC-Locoformer', detail: 'Dialogue, music and effects. CC BY-NC-SA 4.0, non-commercial.', kind: 'stems' },
  { id: 'sam', short: 'SAM', name: 'SAM Audio', detail: 'Describe or box any sound and pull it from the whole source. Experimental.', kind: 'prompt' },
  { id: 'guidesep', short: 'Guide', name: 'GuideSep · user-guided music separation', detail: 'Pull one instrument by humming or playing it as a reference. Experimental.', kind: 'reference' },
];
export const MODEL_IDS = MODELS.map(model => model.id);
export const modelName = id => MODELS.find(model => model.id === id)?.name;
