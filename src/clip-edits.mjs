const finite = value => typeof value === 'number' && Number.isFinite(value);
export function channelEdit(value, duration) {
  if (!finite(duration) || duration < 0) throw Error('Invalid channel duration.');
  if (!value) return { clips: duration ? [{ id: 'full', start: 0, end: duration }] : [], gains: [] };
  if (!Array.isArray(value.clips) || !Array.isArray(value.gains) || value.clips.length > 256 || value.gains.length > 512) throw Error('Too many clip edits.');
  function ranges(items, gains) {
    let end = -1;
    return items.map((item, index) => {
      if (!item || !finite(item.start) || !finite(item.end) || item.start < 0 || item.end <= item.start || item.end > duration + .001 || item.start < end - .000001) throw Error('Invalid or overlapping clip ranges.');
      end = item.end;
      if (gains && (!finite(item.db) || item.db < -60 || item.db > 24)) throw Error('Gain must be between -60 and +24 dB.');
      return gains ? { start: item.start, end: item.end, db: item.db } : { id: String(item.id || index).slice(0, 100), start: item.start, end: item.end };
    });
  }
  return { clips: ranges(value.clips, false), gains: ranges(value.gains, true) };
}
export function splitEdit(value, at, duration) {
  const edit = fitEdit(value, duration);
  if (edit.clips.length >= 256) return edit;
  return { ...edit, clips: edit.clips.flatMap(clip => at > clip.start + .02 && at < clip.end - .02 ? [{ ...clip, id: clip.id.slice(0,60) + '-L-' + at.toFixed(6), end: at }, { ...clip, id: clip.id.slice(0,60) + '-R-' + at.toFixed(6), start: at }] : [clip]) };
}
export function trimEdit(value, id, edge, at, duration) {
  const edit = fitEdit(value, duration), index = edit.clips.findIndex(clip => clip.id === id);
  if (index < 0) return edit;
  const clip = edit.clips[index];
  if (edge === 'start') clip.start = Math.max(edit.clips[index - 1]?.end || 0, Math.min(clip.end - .02, at));
  else clip.end = Math.min(edit.clips[index + 1]?.start ?? duration, Math.max(clip.start + .02, at));
  return channelEdit(edit, duration);
}
export function gainEdit(value, start, end, db, duration) {
  const edit = fitEdit(value, duration);
  const gains = edit.gains.flatMap(region => region.end <= start || region.start >= end ? [region] : [region.start < start ? { ...region, end: start } : null, region.end > end ? { ...region, start: end } : null].filter(Boolean));
  gains.push({ start, end, db: Math.round(Math.max(-60, Math.min(24, db)) * 10) / 10 });
  return channelEdit({ ...edit, gains: gains.sort((a, b) => a.start - b.start) }, duration);
}
export function gainAt(value, at) { return value?.gains?.find(region => at >= region.start && at < region.end)?.db || 0; }
export function fitEdit(value, duration) {
  if (!value) return channelEdit(undefined, duration);
  const edit = channelEdit(value, 864000);
  const fit = ranges => ranges.map(range => ({ ...range, end: Math.min(range.end, duration) })).filter(range => range.end > range.start);
  return channelEdit({ clips: fit(edit.clips), gains: fit(edit.gains) }, duration);
}
export function audibleSegments(value, duration, offset = 0, until = duration) {
  const edit = channelEdit(value, Math.max(duration, ...(value?.clips || []).map(clip => clip.end), ...(value?.gains || []).map(gain => gain.end))), result = [];
  for (const clip of edit.clips) {
    const start = Math.max(clip.start, offset), end = Math.min(clip.end, until);
    if (end <= start) continue;
    const points = [...new Set([start, end, ...edit.gains.flatMap(gain => [gain.start, gain.end]).filter(at => at > start && at < end)])].sort((a,b) => a-b);
    for (let i=0; i<points.length-1; i++) result.push({ start: points[i], end: points[i+1], gain: 10 ** (gainAt(edit, (points[i]+points[i+1])/2) / 20) });
  }
  return result;
}
