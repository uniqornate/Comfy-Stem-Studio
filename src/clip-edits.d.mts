export type ChannelEdit = { clips: { id: string; start: number; end: number }[]; gains: { start: number; end: number; db: number }[] };
export function channelEdit(value: ChannelEdit | undefined, duration: number): ChannelEdit;
export function fitEdit(value: ChannelEdit | undefined, duration: number): ChannelEdit;
export function splitEdit(value: ChannelEdit | undefined, at: number, duration: number): ChannelEdit;
export function trimEdit(value: ChannelEdit | undefined, id: string, edge: string, at: number, duration: number): ChannelEdit;
export function gainEdit(value: ChannelEdit | undefined, start: number, end: number, db: number, duration: number): ChannelEdit;
export function gainAt(value: ChannelEdit | undefined, at: number): number;
export function audibleSegments(value: ChannelEdit | undefined, duration: number, offset?: number, until?: number): { start: number; end: number; gain: number }[];
