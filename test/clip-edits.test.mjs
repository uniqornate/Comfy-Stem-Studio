import test from 'node:test';
import assert from 'node:assert/strict';
import { channelEdit, fitEdit, splitEdit, trimEdit, gainEdit, audibleSegments } from '../src/clip-edits.mjs';
import { stemWorkflow } from '../electron/separation.mjs';
import { AudioRenderer, editWorkflow } from '../electron/audio-render.mjs';
import { samConfig } from '../electron/sam-manager.mjs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

test('split preserves complete timeline coverage and is idempotent at boundaries', () => {
  const split = splitEdit(undefined, 3.25, 10);
  assert.deepEqual(split.clips.map(clip => [clip.start,clip.end]),[[0,3.25],[3.25,10]]);
  assert.deepEqual(splitEdit(split,3.25,10),split);
  assert.deepEqual(splitEdit(split,10,10),split);
});
test('clip edges trim and restore without crossing neighboring clips or changing source offset', () => {
  const split = splitEdit(undefined,4,10), id=split.clips[1].id;
  const trimmed=trimEdit(split,id,'start',6,10);
  assert.deepEqual(trimmed.clips.map(clip=>[clip.start,clip.end]),[[0,4],[6,10]]);
  assert.equal(trimEdit(trimmed,id,'start',1,10).clips[1].start,4);
  assert.equal(trimEdit(trimmed,id,'end',100,10).clips[1].end,10);
});
test('new range gain replaces overlapping automation and retains both outside pieces', () => {
  const base=gainEdit(undefined,1,9,-6,10), next=gainEdit(base,3,5,6,10);
  assert.deepEqual(next.gains,[{start:1,end:3,db:-6},{start:3,end:5,db:6},{start:5,end:9,db:-6}]);
  assert.equal(gainEdit(next,3,5,50,10).gains[1].db,24);
});
test('audible schedule intersects trims, gain boundaries, transport offset and loop end', () => {
  const edit={clips:[{id:'a',start:0,end:2},{id:'b',start:4,end:8}],gains:[{start:1,end:5,db:20}]};
  assert.deepEqual(audibleSegments(edit,10,.5,6),[{start:.5,end:1,gain:1},{start:1,end:2,gain:10},{start:4,end:5,gain:10},{start:5,end:6,gain:1}]);
});
test('invalid overlapping ranges, non-finite gains and unbounded clip counts are rejected', () => {
  assert.throws(()=>channelEdit({clips:[{start:0,end:4},{start:2,end:5}],gains:[]},10),/overlapping/);
  assert.throws(()=>channelEdit({clips:[],gains:[{start:0,end:1,db:NaN}]},10),/Gain/);
  assert.throws(()=>channelEdit({clips:new Array(257).fill({start:0,end:1}),gains:[]},10),/Too many/);
});
test('pending metadata and a shorter relinked video cannot crash stored clip rendering', () => {
  const edit={clips:[{id:'a',start:0,end:4},{id:'b',start:6,end:10}],gains:[{start:2,end:9,db:-6}]};
  assert.deepEqual(fitEdit(edit,0),{clips:[],gains:[]});
  assert.deepEqual(fitEdit(edit,7).clips,[{id:'a',start:0,end:4},{id:'b',start:6,end:7}]);
  assert.equal(edit.clips[1].end,10); assert.equal(splitEdit(edit,2,7).clips.at(-1).end,7);
});
test('native edit node precedes processing crop and full-timeline padding reference', () => {
  const edits=gainEdit(undefined,2,3,-6,10);
  const graph=stemWorkflow({mode:'uss',target:'Door',range:{start:1,end:4},edits});
  assert.equal(graph['7'].class_type,'StemStudioEditAudio');
  assert.deepEqual(graph['3'].inputs.audio,['7',0]); assert.deepEqual(graph['4'].inputs.reference,['7',0]);
  assert.deepEqual(editWorkflow(edits,'StemStudio/Edits/test/audio')['3'].inputs.audio,['2',0]);
});
test('SAM model choices map to separate native model folders and explicit workflow input', () => {
  const profile={comfyUrl:'http://127.0.0.1:8188',installation:resolve('fixture-comfy')};
  assert.ok(samConfig(profile,'large-tv').endsWith('sam-audio-large-tv'));
  assert.ok(samConfig(profile,'small-tv').endsWith('sam-audio-small-tv'));
  assert.throws(()=>samConfig(profile,'arbitrary'),/Choose SAM/);
  assert.equal(stemWorkflow({mode:'sam',target:'Door',samModel:'large-tv'})['2'].inputs.model_variant,'large-tv');
});
test('edited export submits native LoadAudio/EditAudio/SaveAudio through SDK and retrieves only completed audio', async t => {
  const root=await mkdtemp(join(tmpdir(),'stemstudio-edit-test-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('stemstudio-edit-test-'));await rm(root,{recursive:true,force:true});});
  let submitted;
  const client={assets:{fromFile:source=>source},workflows:{fromJson:graph=>({graph,setInput(){}})},submit:async workflow=>{submitted=workflow.graph;return {status:'succeeded',refresh:async()=>{},outputs:[{nodeId:'3',type:'audio',toFile:path=>writeFile(path,'edited-native-fixture')}]};}};
  const renderer=new AudioRenderer(root,{makeClient:()=>client,fetch:async()=>new Response(JSON.stringify({StemStudioEditAudio:{}}))});
  const path=await renderer.render({comfyUrl:'http://127.0.0.1:8188',proxyUrl:'http://127.0.0.1:8189'},'/approved/file.flac',gainEdit(undefined,1,2,-6,10));
  assert.equal(await readFile(path,'utf8'),'edited-native-fixture'); assert.equal(submitted['2'].class_type,'StemStudioEditAudio'); assert.equal(renderer.active,false);
});
