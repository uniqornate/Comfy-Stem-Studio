const MAX = 256;
const TOLERANCE = 0.15;
const round = value => Math.round(value * 1000) / 1000;
export function normalizeMarkers(list, duration = Infinity) {
  if (!Array.isArray(list)) return [];
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return [...new Set(list.filter(value => Number.isFinite(value) && value >= 0 && value <= limit).map(round))].sort((a, b) => a - b).slice(0, MAX);
}
export function toggleMarker(markers, at, duration = Infinity) {
  const near = markers.find(value => Math.abs(value - at) <= TOLERANCE);
  if (near !== undefined) return markers.filter(value => value !== near);
  return normalizeMarkers([...markers, at], duration);
}
export function removeMarker(markers, at) { return markers.filter(value => value !== at); }
// The loop region between the markers around `at`; the start and end of the media act as implicit markers.
export function regionAt(markers, at, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const sorted = normalizeMarkers(markers, duration);
  const start = [...sorted].reverse().find(value => value <= at) ?? 0;
  const end = sorted.find(value => value > at) ?? duration;
  return end - start >= 0.05 ? { start, end } : null;
}
export function stepMarker(markers, at, direction) {
  const sorted = normalizeMarkers(markers);
  return direction < 0 ? [...sorted].reverse().find(value => value < at - 0.05) ?? null : sorted.find(value => value > at + 0.05) ?? null;
}
