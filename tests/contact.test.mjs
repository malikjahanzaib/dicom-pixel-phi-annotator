import test from 'node:test';
import assert from 'node:assert/strict';
import { contactFiles, thumbFlags, scaleZones, gridWindow } from '../src/contact.js';
const file=(over={})=>({name:'a.dcm',combo:'16',width:640,height:480,frames:{0:[{x:0,y:0,width:9,height:9,note:''}]},file:{},...over});

test('scope narrows to the combo, the combo and size, or nothing at all',()=>{
  const open=file();
  const images=[open,file({width:1024,height:768}),file({combo:'22'}),file({combo:''})];
  assert.deepEqual(contactFiles(images,open,'combo').map(e=>e.index),[0,1]);
  assert.deepEqual(contactFiles(images,open,'size').map(e=>e.index),[0]);
  assert.deepEqual(contactFiles(images,open,'all').map(e=>e.index),[0,1,2,3]);
  // An unassigned file groups with other unassigned files, never with a real combo.
  assert.deepEqual(contactFiles(images,file({combo:''}),'combo').map(e=>e.index),[3]);
  assert.deepEqual(contactFiles(images,null,'combo').map(e=>e.index),[0,1,2,3]);
});

test('flags name why a thumbnail deserves a look, and never imply the others are done',()=>{
  assert.deepEqual(thumbFlags(file()),[]);
  assert.deepEqual(thumbFlags(file({frames:{0:[]}})),['no zones']);
  // A missing source is reported instead of "no zones": the zones may be fine, unseen.
  assert.deepEqual(thumbFlags(file({file:null,frames:{0:[]}})),['no source']);
  assert.deepEqual(thumbFlags(file({combo:''})),['no combo']);
  assert.deepEqual(thumbFlags(file(),3),['3 uncovered']);
  assert.deepEqual(thumbFlags(file({combo:'',frames:{0:[]}}),2),['no zones','no combo','2 uncovered']);
});

test('thumbnail scaling is presentation only and never rounds a zone away',()=>{
  const image={width:640,height:480};
  const [zone]=scaleZones([{x:320,y:240,width:160,height:120}],image,160,120);
  assert.deepEqual(zone,{x:80,y:60,width:40,height:30});
  // A hairline zone stays visible at thumbnail scale rather than collapsing to nothing.
  const [thin]=scaleZones([{x:0,y:0,width:2,height:1}],image,160,120);
  assert.ok(thin.width>=1&&thin.height>=1);
  assert.deepEqual(scaleZones([],image,160,120),[]);
});

test('the grid renders a window of rows, not a cell per file',()=>{
  const base={count:1000,width:640,cellWidth:160,cellHeight:130,viewportHeight:520};
  const top=gridWindow({...base,scrollTop:0});
  assert.equal(top.columns,4);
  assert.equal(top.rows,250);
  assert.equal(top.height,32500);
  assert.equal(top.offset,0);
  assert.ok(top.to-top.from<40,`windowed to ${top.to-top.from} cells`);
  const deep=gridWindow({...base,scrollTop:13000});
  assert.equal(deep.from,4*(100-1));
  assert.equal(deep.offset,99*130);
  assert.ok(deep.to<=1000);
  // The last window stops at the final file rather than overrunning it.
  assert.equal(gridWindow({...base,scrollTop:32500}).to,1000);
  // A container too narrow for one cell still lays out a single column.
  assert.equal(gridWindow({...base,width:40}).columns,1);
});
