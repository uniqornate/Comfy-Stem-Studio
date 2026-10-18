export function normalizeMarkers(list: unknown, duration?: number): number[];
export function toggleMarker(markers: number[], at: number, duration?: number): number[];
export function removeMarker(markers: number[], at: number): number[];
export function regionAt(markers: number[], at: number, duration: number): { start: number; end: number } | null;
export function stepMarker(markers: number[], at: number, direction: number): number | null;
