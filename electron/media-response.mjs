import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { mimeTypes } from './media-types.mjs';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) throw new Error('Invalid byte range.');
  let start, end;
  if (!match[1]) { const length = Number(match[2]); if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid suffix.'); start = Math.max(0, size - length); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Unsatisfiable byte range.');
  return { start, end };
}
export async function mediaResponse(request, path) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' } });
  let info; try { info = await stat(path); } catch { return new Response(null, { status: 404, headers: cors }); }
  if (!info.isFile()) return new Response(null, { status: 404, headers: cors });
  const size = info.size;
  const headers = { ...cors, 'Content-Type': mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let range;
  try { range = byteRange(request.headers.get('Range'), size); }
  catch { return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } }); }
  const start = range?.start ?? 0, end = range?.end ?? size - 1;
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(createReadStream(path, { start, end, signal: request.signal }));
  return new Response(body, { status: range ? 206 : 200, headers });
}
