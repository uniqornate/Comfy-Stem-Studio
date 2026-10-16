import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { byteRange, mediaResponse } from '../electron/media-response.mjs';
test('ranges support interior, open-ended and suffix bytes and reject invalid requests', () => {
  assert.deepEqual(byteRange('bytes=25-49', 100), { start: 25, end: 49 });
  assert.deepEqual(byteRange('bytes=25-', 100), { start: 25, end: 99 });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=25-900', 100), { start: 25, end: 99 });
  for (const value of ['bytes=100-', 'bytes=25-10', 'bytes=1-5,10-20', 'bytes=-0', 'bytes=-', 'items=1-2']) assert.throws(() => byteRange(value, 100));
});
test('media endpoint returns actual interior bytes with seekable headers, HEAD and 416', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stemstudio-range-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('stemstudio-range-')); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'fixture.mp4'); await writeFile(path, Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
  const response = await mediaResponse(new Request('https://fixture', { headers: { Range: 'bytes=25-49' } }), path);
  assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 25-49/100'); assert.equal(response.headers.get('Content-Length'), '25'); assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), (await readFile(path)).subarray(25, 50));
  const head = await mediaResponse(new Request('https://fixture', { method: 'HEAD' }), path); assert.equal(head.headers.get('Content-Length'), '100'); assert.equal(head.body, null);
  const invalid = await mediaResponse(new Request('https://fixture', { headers: { Range: 'bytes=100-' } }), path); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('Content-Range'), 'bytes */100');
  const empty = join(directory, 'empty.flac'); await writeFile(empty, ''); const zero = await mediaResponse(new Request('https://fixture'), empty); assert.equal((await zero.arrayBuffer()).byteLength, 0);
});
