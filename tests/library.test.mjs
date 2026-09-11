import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, filterLibrary, filterCounts, boxCount, navigation, planComboAssignment, describeComboAssignment } from '../src/library.js';
const zone={x:0,y:0,width:9,height:9,note:''};
const file=(over={})=>({name:'scan.dcm',path:'batch-a/scan.dcm',combo:'16',width:640,height:480,frameCount:2,frames:{},file:{},...over});
const blank=file({name:'blank.dcm',frames:{0:[]}});
const drawn=file({name:'drawn.dcm',frames:{0:[zone],1:[zone,zone]}});
const noCombo=file({name:'nocombo.dcm',combo:'',frames:{0:[zone]}});
const detached=file({name:'gone.dcm',path:'batch-b/gone.dcm',frames:{0:[zone]},file:null});

test('box counts span every frame, and each filter names one triage state',()=>{
 assert.equal(boxCount(drawn),3);assert.equal(boxCount(blank),0);
 assert.deepEqual(['unannotated','annotated','needs-combo','source-needed'].map(f=>matchesFilter(blank,f)),[true,false,false,false]);
 assert.deepEqual(['unannotated','annotated','needs-combo','source-needed'].map(f=>matchesFilter(noCombo,f)),[false,true,true,false]);
 assert.deepEqual(['unannotated','annotated','needs-combo','source-needed'].map(f=>matchesFilter(detached,f)),[false,true,false,true]);
 // An unannotated file never blocks export, so it never appears under Needs combo ID.
 assert.equal(matchesFilter(file({combo:'',frames:{0:[]}}),'needs-combo'),false);
 // The filter mirrors the export gate exactly: only digits count as assigned.
 assert.equal(matchesFilter(file({combo:'abc',frames:{0:[zone]}}),'needs-combo'),true);
 assert.equal(matchesFilter(file({combo:'016',frames:{0:[zone]}}),'needs-combo'),false);
 assert.equal(matchesFilter(blank,'all'),true);
});

test('filtering keeps the original indices and searches name, path, and combo',()=>{
 const images=[blank,drawn,noCombo,detached];
 assert.deepEqual(filterLibrary(images,'','needs-combo').map(e=>e.index),[2]);
 assert.deepEqual(filterLibrary(images,'','source-needed').map(e=>e.index),[3]);
 assert.deepEqual(filterLibrary(images,'batch-b').map(e=>e.index),[3]);
 assert.deepEqual(filterLibrary(images,'DRAWN').map(e=>e.index),[1]);
 assert.deepEqual(filterLibrary(images,'16').map(e=>e.index),[0,1,3]);
 // Filter and query compose rather than replacing one another.
 assert.deepEqual(filterLibrary(images,'batch-a','annotated').map(e=>e.index),[1,2]);
 assert.deepEqual(filterLibrary(images,'nothing-here').length,0);
 assert.deepEqual(filterLibrary(images).map(e=>e.index),[0,1,2,3]);
});

test('counts report progress across the whole batch in one pass',()=>{
 assert.deepEqual(filterCounts([blank,drawn,noCombo,detached]),
  {all:4,unannotated:1,annotated:3,'needs-combo':1,'source-needed':1});
 assert.deepEqual(filterCounts([]),{all:0,unannotated:0,annotated:0,'needs-combo':0,'source-needed':0});
});

test('navigation steps through the view, skipping hidden files',()=>{
 const shown=[2,5,6].map(index=>({index}));
 assert.deepEqual(navigation(shown,2),{previous:null,next:5,position:1,total:3});
 assert.deepEqual(navigation(shown,5),{previous:2,next:6,position:2,total:3}); // 3 and 4 are skipped
 assert.deepEqual(navigation(shown,6),{previous:5,next:null,position:3,total:3});
 // An open file outside the view has no position, but still has neighbours either side.
 assert.deepEqual(navigation(shown,4),{previous:2,next:5,position:null,total:3});
 assert.deepEqual(navigation(shown,0),{previous:null,next:2,position:null,total:3});
 assert.deepEqual(navigation(shown,9),{previous:6,next:null,position:null,total:3});
 assert.deepEqual(navigation([],3),{previous:null,next:null,position:null,total:0});
 // Unfiltered, positions match indices so the counter reads exactly as it always did.
 assert.deepEqual(navigation([0,1,2].map(index=>({index})),1),{previous:0,next:2,position:2,total:3});
 assert.equal(navigation([{index:-1}],-1).position,1);
});
test('a batch assignment separates new IDs from overwrites and is described before it runs',()=>{
 const plan=planComboAssignment([blank,drawn,noCombo,file({combo:'22'})],'16');
 assert.deepEqual([plan.unchanged.length,plan.assigned.length,plan.overwritten.length,plan.changed],[2,1,1,2]);
 const text=describeComboAssignment(plan,'16');
 assert.match(text,/Set 2 files to combo 16\?/);
 assert.match(text,/1 file already carry a different ID \(22\) and will be overwritten\./);
 assert.match(text,/2 files already match/);
 assert.match(text,/not covered by undo/);
 // Clearing is spelled out as clearing, and a long list of replaced IDs is capped.
 assert.match(describeComboAssignment(planComboAssignment([drawn],''),''),/Clear the combo ID on 1 file\?/);
 const many=describeComboAssignment(planComboAssignment(['1','2','3','4','5'].map(c=>file({combo:c})),'9'),'9');
 assert.match(many,/\(1, 2, 3, 4, …\)/);
 assert.equal(planComboAssignment([file({combo:'16'})],'16').changed,0);
});
