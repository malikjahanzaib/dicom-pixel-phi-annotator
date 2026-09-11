import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { rectangleBetween, buildPipelineExport, pipelineLayout, nudgeZone, cycleIndex, hydrate, imageRecord, parseFilename } from '../src/coordinates.js';
import { validateBackup } from '../src/project.js';
import { openDatabase, saveFile, saveSession, loadFile, loadSession, clearSession } from '../src/storage.js';
const zone={x:0,y:0,width:420,height:40,note:'DOB'};
const record={id:'a'.repeat(64),name:'scan.dcm',path:'scan.dcm',kind:'DICOM',combo:'016',width:640,height:480,frameIndex:0,frameCount:2,frames:{0:[zone],1:[{x:5,y:45,width:180,height:30,note:''}]},display:{},metadata:{}};
test('source edges round and clamp; display and physical spacing do not enter the model',()=>{
 assert.deepEqual(rectangleBetween({x:800,y:600},{x:-4,y:-5},record),{x:0,y:0,width:640,height:480});
 assert.deepEqual(rectangleBetween({x:419.7,y:39.8},{x:0,y:0},record),{x:0,y:0,width:420,height:40});
 assert.equal(parseFilename('combo016_640x480_s1.dcm').combo,'016');
});
test('a nudge slides a box without resizing it or leaving the raster',()=>{
 const box={x:10,y:10,width:420,height:40,note:'DOB'};
 assert.deepEqual(nudgeZone(box,1,-1,record),{...box,x:11,y:9});
 assert.deepEqual(nudgeZone(box,-10,10,record),{...box,x:0,y:20});
 // Clamping stops at the edge instead of shrinking the box or letting it hang off.
 assert.deepEqual(nudgeZone(box,-99,-99,record),{...box,x:0,y:0});
 assert.deepEqual(nudgeZone(box,999,999,record),{...box,x:220,y:440});
 const full={x:0,y:0,width:640,height:480,note:''};
 assert.deepEqual(nudgeZone(full,5,5,record),full); // a box filling the raster cannot move
});
test('cycling wraps in both directions and starts from either end',()=>{
 assert.equal(cycleIndex(-1,3,1),0);assert.equal(cycleIndex(-1,3,-1),2);
 assert.equal(cycleIndex(0,3,1),1);assert.equal(cycleIndex(2,3,1),0);
 assert.equal(cycleIndex(0,3,-1),2);assert.equal(cycleIndex(1,1,1),1%1);
 assert.equal(cycleIndex(0,1,1),0);assert.equal(cycleIndex(0,1,-1),0);
 assert.equal(cycleIndex(-1,0,1),-1);assert.equal(cycleIndex(0,0,-1),-1);
});
test('frame ownership, layout union, duplicate handling, and exact pipeline schema',()=>{
 const im=hydrate(structuredClone(record),null);im.frameIndex=1;assert.equal(im.zones[0].x,5);im.zones.push({...zone});im.frameIndex=0;assert.equal(im.zones.length,1);
 const payload=buildPipelineExport([im]);assert.deepEqual(Object.keys(payload),['generated_at','annotations']);
 assert.deepEqual(payload.annotations,{'016':{'640x480':{ref_width:640,ref_height:480,zones:[zone,{x:5,y:45,width:180,height:30,note:''}]}}});
 assert.throws(()=>buildPipelineExport([{...record,combo:''}]),/Assign/);
});
test('the previewed layout is the pipeline union for one combo and size, not one frame',()=>{
 const other={...record,id:'b'.repeat(64),frames:{0:[{x:600,y:470,width:40,height:10,note:'corner'}]}};
 const bigger={...record,id:'c'.repeat(64),width:1024,height:768,frames:{0:[{x:0,y:0,width:9,height:9,note:'wide'}]}};
 const elsewhere={...record,id:'d'.repeat(64),combo:'22',frames:{0:[{x:1,y:1,width:9,height:9,note:'other combo'}]}};
 const zones=pipelineLayout([record,other,bigger,elsewhere],'016',640,480);
 // Every frame of every same-combo, same-size file contributes; nothing else does.
 assert.deepEqual(zones.map(z=>z.note),['DOB','','corner']);
 // Exact duplicates collapse, but a rectangle differing only by note is its own zone.
 const twin={...record,id:'e'.repeat(64),frames:{0:[{...zone},{...zone,note:'name'}]}};
 assert.deepEqual(pipelineLayout([record,twin],'016',640,480).map(z=>z.note),['DOB','','name']);
 // Zero-area boxes cannot be redacted and never reach the preview.
 assert.deepEqual(pipelineLayout([{...record,frames:{0:[{x:5,y:5,width:0,height:9,note:'flat'}]}}],'016',640,480),[]);
 // Without a combo ID no pipeline group exists yet, so there is no union to show.
 assert.equal(pipelineLayout([{...record,combo:''}],'',640,480),null);
 assert.deepEqual(pipelineLayout([record],'016',1024,768),[]);
});
test('backup validation rejects malformed or off-image coordinates without silently clipping',()=>{
 const backup={format:'occlude-project',version:1,images:[record]};assert.equal(validateBackup(backup)[0].frames[0][0].width,420);
 const bad=structuredClone(backup);bad.images[0].frames[0][0].width=1000;assert.throws(()=>validateBackup(bad),/outside/);
 const badFrame=structuredClone(backup);badFrame.images[0].frames[99]=[];assert.throws(()=>validateBackup(badFrame),/frame/);
});
test('IndexedDB keeps original files and frame annotations independently and can clear both',async()=>{
 const db=await openDatabase(),blob=new Blob(['synthetic source']);await saveFile(db,record.id,blob);await saveSession(db,{version:1,images:[imageRecord(record)]});
 assert.equal(await (await loadFile(db,record.id)).text(),'synthetic source');assert.deepEqual((await loadSession(db)).images[0].frames,record.frames);
 await clearSession(db);assert.equal(await loadSession(db),undefined);assert.equal(await loadFile(db,record.id),undefined);db.close();
});
