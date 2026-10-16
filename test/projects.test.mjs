import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Projects } from '../electron/projects.mjs';
import { nativeOutput, nativePath } from '../electron/native-media.mjs';
import { stemWorkflow } from '../electron/separation.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stemstudio-project-test-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('stemstudio-project-test-')); await rm(root, { recursive: true, force: true }); });
  const make = () => {
    const separation = { outputs: new Map(), state: { phase: 'idle', stems: [], canCancel: false }, reset() { this.outputs.clear(); this.state = { phase: 'idle', stems: [], canCancel: false }; }, snapshot() { return structuredClone(this.state); } };
    const sources = new Map(); let i = 0;
    const expose = path => { const id = `token-${++i}`; sources.set(id, path); return `app-media://source/${id}`; };
    return { projects: new Projects(join(root, 'data'), separation, sources, expose), separation, sources, expose };
  };
  const made = make(), opened = await made.projects.boot();
  const source = join(root, 'clip.mp4'); await writeFile(source, 'synthetic video reference, never decoded');
  const session = await made.projects.attach({ url: made.expose(source) });
  const audio = join(root, 'cache.flac'); await writeFile(audio, 'synthetic audio bytes, never decoded');
  const stem = { id: 'channel-a', label: 'Effects', size: 43, url: made.expose(audio) };
  made.separation.outputs.set(stem.id, { path: audio, name: 'effects.flac' });
  const run = { runId: 'take-a', model: 'sfc', phase: 'complete', stems: [stem] };
  return { root, make, ...made, opened, session, source, audio, stem, run, payload: { projectId: session.info.id, runs: [run], view: {} } };
}

test('autosave survives restart/cache deletion and restores mix, groups, transport and last project', async t => {
  const f = await fixture(t);
  f.payload.view = { model: 'bandit', selectedRun: 'take-a', transport: { position: 3.2, duration: 10, selection: { start: 2, end: 4 }, loopLocked: true }, timelines: { 'take-a': { mix: { 'channel-a': { mute: true, solo: false, level: .3 } }, collapsed: ['channel-a'], zoom: 4, edits: { 'channel-a': { clips: [{id:'left',start:0,end:2},{id:'right',start:4,end:8}], gains:[{start:1,end:5,db:-6}] } }, waveHeight: .8, scrollLeft: 23, scrollTop: 9 } } };
  await f.projects.save(f.payload); await unlink(f.audio);
  const fresh = f.make(), session = await fresh.projects.boot();
  assert.equal(session.info.id, f.session.info.id); assert.equal(session.source.missing, false);
  assert.equal(session.runs[0].stems[0].missing, false);
  assert.equal(await readFile(fresh.separation.outputs.get(f.stem.id).path, 'utf8'), 'synthetic audio bytes, never decoded');
  assert.deepEqual(session.view, f.payload.view);
  const file = await readFile(session.info.path, 'utf8'); assert.ok(!file.includes('app-media:'));
  assert.deepEqual(f.opened.warnings, []);
});
test('completed job is captured even before renderer polling, child results merge into the root', async t => {
  const f = await fixture(t);
  f.separation.state = f.run; await f.projects.save({ ...f.payload, runs: [] });
  assert.equal(f.projects.current.runs[0].stems.length, 1);
  const child = { ...f.stem, id: 'child-a', parentId: f.stem.id, label: 'Footsteps' };
  f.separation.outputs.set(child.id, { path: f.audio, name: 'footsteps.flac' });
  f.separation.state = { phase: 'complete', runId: 'detail-a', rootRunId: 'take-a', stems: [child] };
  await f.projects.save(f.payload); assert.equal(f.projects.current.runs[0].stems.length, 2);
  const session = await f.projects.load(f.projects.path);
  assert.equal(session.runs[0].stems[1].parentId, f.stem.id); assert.ok(f.separation.outputs.has(child.id));
});
test('missing media references remain saved and a source can be relinked without losing stems', async t => {
  const f = await fixture(t); await f.projects.save(f.payload);
  await unlink(f.source); await unlink(join(dirname(f.projects.path), 'assets', `${f.stem.id}.flac`));
  const session = await f.projects.load(f.projects.path);
  assert.equal(session.source.missing, true); assert.equal(session.runs[0].stems[0].missing, true);
  await f.projects.save({ ...f.payload, runs: session.runs }); assert.equal(f.projects.current.runs[0].stems.length, 1);
  const replacement = join(f.root, 'replacement.mov'); await writeFile(replacement, 'new reference');
  const relinked = await f.projects.relink(replacement); assert.equal(relinked.source.missing, false); assert.equal(relinked.runs.length, 1);
});
test('project copies have separate assets and identity; creating a project retains previous files', async t => {
  const f = await fixture(t); await f.projects.save(f.payload);
  const original = f.projects.path; const folder = join(f.root, 'copies'); await mkdir(folder);
  const copied = await f.projects.saveAs(folder); assert.notEqual(copied.info.id, f.session.info.id);
  await unlink(join(dirname(original), 'assets', `${f.stem.id}.flac`));
  assert.equal(copied.runs[0].stems[0].missing, false);
  await f.projects.rename('Scene 01'); assert.equal(f.projects.info().name, 'Scene 01');
  await f.projects.create('Scene 02'); assert.ok(await readFile(copied.info.path));
  await assert.rejects(f.projects.save(f.payload), /active project changed/);
});
test('atomic backup recovers malformed primary and interrupted processing is never resubmitted', async t => {
  const f = await fixture(t); await f.projects.save(f.payload);
  f.separation.state = { phase: 'running', stems: [], canCancel: true };
  await f.projects.save(f.payload); await f.projects.rename('Previous valid save');
  await writeFile(f.projects.path, '{broken');
  const recovered = await f.projects.load(f.projects.path);
  assert.ok(recovered.warnings.some(message => message.includes('Recovered')));
  assert.equal(recovered.job.phase, 'cancelled'); assert.match(recovered.job.message, /not submitted again/);
});
test('unsafe media references and invalid view data are rejected without switching project', async t => {
  const f = await fixture(t); await f.projects.save(f.payload);
  const valid = JSON.parse(await readFile(f.projects.path, 'utf8'));
  const bad = join(f.root, 'bad.stemstudio.json');
  const malicious = structuredClone(valid); malicious.runs[0].stems[0].file = '../cache.flac';
  await writeFile(bad, JSON.stringify(malicious)); await assert.rejects(f.projects.load(bad), /Invalid project channel/);
  assert.equal(f.projects.path, f.session.info.path);
  await assert.rejects(f.projects.save({ ...f.payload, view: { timelines: { bad: { collapsed: 'bad' } } } }), /Invalid project timeline/);
  await f.projects.save({ ...f.payload, view: { token: 'do-not-save', profile: { password: 'do-not-save' }, model: 'sfc' } });
  assert.ok(!(await readFile(f.projects.path, 'utf8')).includes('do-not-save'));
});
test('serialized saves preserve ordering and reject a late save from the previous project', async t => {
  const f = await fixture(t);
  await Promise.all([f.projects.serial(() => f.projects.save(f.payload)), f.projects.serial(() => f.projects.rename('Final name'))]);
  assert.equal(f.projects.info().name, 'Final name');
  await f.projects.serial(() => f.projects.create('Next'));
  await assert.rejects(f.projects.serial(() => f.projects.save(f.payload)), /active project changed/);
});
test('local projects retain native input/output references without duplicating output audio', async t => {
  const f = await fixture(t);
  const comfy = join(f.root, 'ComfyUI'); await mkdir(comfy); await writeFile(join(comfy, 'main.py'), '# synthetic installation');
  const project = await f.projects.attach({ url: f.expose(f.source) }, comfy);
  assert.equal(f.projects.current.storage.comfyRoot, comfy);
  assert.ok(f.projects.current.source.path.startsWith(join(comfy, 'input', 'StemStudio')));
  await unlink(f.source);
  const name = `StemStudio/${project.info.id}/job-a/effects_00001_.flac`;
  const output = join(comfy, 'output', name); await mkdir(dirname(output), { recursive: true }); await writeFile(output, 'native SaveAudio fixture');
  f.separation.outputs.set(f.stem.id, { path: output, name: 'effects.flac', native: { type: 'output', relative: name, assetId: 'asset-a', jobId: 'job-a' } });
  await f.projects.save({ ...f.payload, projectId: project.info.id });
  assert.equal(f.projects.current.runs[0].stems[0].file, undefined);
  const fresh = f.make(), restored = await fresh.projects.boot();
  assert.equal(restored.source.missing, false); assert.equal(fresh.separation.outputs.get(f.stem.id).path, await nativePath(comfy, 'output', name));
  assert.equal(restored.runs[0].stems[0].missing, false);
  assert.equal(await nativeOutput(comfy, `StemStudio/${project.info.id}/job-a/effects`, 'effects_00001_.flac'), await nativePath(comfy, 'output', name));
  await assert.rejects(nativePath(comfy, 'output', '../main.py'), /Invalid native media reference/);
  const copy = await fresh.projects.saveAs(join(f.root, 'copies'));
  assert.equal(copy.runs[0].stems[0].missing, false); assert.equal(fresh.projects.current.runs[0].stems[0].native.relative, name);
});
test('native graph scopes every model output, including USS All, to the project and run', () => {
  const outputPrefix = 'StemStudio/project-a/job-b';
  for (const options of [{ model: 'sfc' }, { model: 'bandit' }, { model: 'mrx' }, { mode: 'uss', target: 'Door' }, { mode: 'sam', target: 'Door' }]) {
    const graph = stemWorkflow({ ...options, outputPrefix });
    for (const node of Object.values(graph).filter(node => node.class_type === 'SaveAudio')) assert.ok(node.inputs.filename_prefix.startsWith(outputPrefix + '/'));
  }
  assert.equal(stemWorkflow({ mode: 'uss', target: 'All', outputPrefix })['2'].inputs.filename_prefix, outputPrefix);
  assert.throws(() => stemWorkflow({ outputPrefix: '../elsewhere' }), /Invalid project output prefix/);
});
