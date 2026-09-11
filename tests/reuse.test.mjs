import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceZones, reuseTargets, planReuse, applyPlan, describePlan, sameRaster } from '../src/reuse.js';
const strip={x:0,y:0,width:420,height:40,note:'patient strip'};
const dob={x:5,y:45,width:180,height:30,note:'DOB'};
const image=(over={})=>({id:(over.id||'a').repeat(64).slice(0,64),name:'scan.dcm',combo:'16',width:640,height:480,frameCount:3,frameIndex:0,frames:{0:[{...strip}]},...over});

test('the source frame is explicit, normalized, and free of unusable boxes',()=>{
  const im=image({frames:{0:[{...strip}],1:[{...dob,note:undefined},{x:0,y:0,width:0,height:9,note:''},{x:900,y:9,width:40,height:9,note:''}]}});
  assert.deepEqual(sourceZones(im,0),[strip]);
  // Zero-area and fully out-of-bounds boxes cannot be copied; the note is always a string.
  assert.deepEqual(sourceZones(im,1),[{...dob,note:''}]);
  assert.deepEqual(sourceZones(im,2),[]);
  assert.deepEqual(sourceZones(null),[]);
});

test('frame scope covers every frame except the open one',()=>{
  const im=image({frameIndex:1});
  assert.deepEqual(reuseTargets({image:im,scope:'frames'}).map(t=>t.frameIndex),[0,2]);
  assert.deepEqual(reuseTargets({image:image({frameCount:1}),scope:'frames'}),[]);
});

test('file scope only accepts rasters of exactly the same size, never rescaling a box',()=>{
  const source=image({id:'a'});
  const match=image({id:'b',frameIndex:2,frameCount:3,frames:{}});
  const other=image({id:'c',width:1024,height:768});
  const images=[source,match,other];
  assert.equal(sameRaster(source,other),false);
  assert.deepEqual(reuseTargets({image:source,images,scope:'files'}),[{image:match,frameIndex:2}]);
  assert.deepEqual(reuseTargets({image:source,images,scope:'files-all-frames'}).map(t=>t.frameIndex),[0,1,2]);
});

test('combo filter restricts a batch copy to one device combination',()=>{
  const source=image({id:'a'}),same=image({id:'b'}),different=image({id:'c',combo:'22'}),unassigned=image({id:'d',combo:''});
  const images=[source,same,different,unassigned];
  assert.equal(reuseTargets({image:source,images,scope:'files'}).length,3);
  assert.deepEqual(reuseTargets({image:source,images,scope:'files',sameCombo:true}),[{image:same,frameIndex:0}]);
});

test('merge adds only what is missing and reports duplicates without touching unchanged frames',()=>{
  const im=image({frames:{0:[{...strip}],1:[{...strip}],2:[{...dob}]}});
  const plan=planReuse([strip],reuseTargets({image:im,scope:'frames'}));
  assert.deepEqual(plan.frames.map(f=>f.frameIndex),[2]); // frame 1 already holds it
  assert.deepEqual(plan.frames[0].zones,[dob,strip]);
  assert.deepEqual([plan.added,plan.duplicates,plan.replaced,plan.files],[1,1,0,1]);
  // A matching rectangle with a different note is a distinct zone, as in the pipeline export.
  const renote=planReuse([{...strip,note:'name'}],[{image:im,frameIndex:1}]);
  assert.equal(renote.added,1);assert.equal(renote.duplicates,0);
});

test('replace discards destination boxes and prices the loss before anything is written',()=>{
  const im=image({frames:{0:[{...strip}],1:[{...dob},{...strip}]}});
  const plan=planReuse([strip],[{image:im,frameIndex:1},{image:im,frameIndex:2}],'replace');
  assert.deepEqual(plan.frames.map(f=>f.frameIndex),[1,2]);
  assert.equal(plan.replaced,2);
  assert.deepEqual(im.frames[1],[dob,strip]); // planning is pure
  const writes=[];applyPlan(plan,(target,frame)=>writes.push(frame));
  assert.deepEqual(writes,[1,2]);
  assert.deepEqual(im.frames[1],[strip]);assert.deepEqual(im.frames[2],[strip]);
  assert.deepEqual(im.frames[0],[strip]); // untargeted frames are untouched
});

test('an empty or fully redundant plan is described rather than silently applied',()=>{
  const im=image({frames:{0:[{...strip}],1:[{...strip}],2:[{...strip}]}});
  const redundant=planReuse([strip],reuseTargets({image:im,scope:'frames'}));
  assert.deepEqual(redundant.frames,[]);
  assert.match(describePlan(redundant,1),/already has these boxes/);
  assert.match(describePlan(planReuse([],[]),0),/no boxes to copy/);
  assert.match(describePlan(planReuse([strip],[]),1),/No eligible destination/);
  assert.equal(describePlan(planReuse([strip,dob],[{image:image({frames:{}}),frameIndex:1}]),2),'2 boxes into 1 frame across 1 file');
});
