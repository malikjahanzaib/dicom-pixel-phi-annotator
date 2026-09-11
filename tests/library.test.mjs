import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, filterLibrary, filterCounts, boxCount, invalidateCount, groupLibrary, libraryRows, navigation, planComboAssignment, describeComboAssignment, UNASSIGNED } from '../src/library.js';
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
 // Grouping pins Unassigned above the combos, so display order is not index order.
 const grouped=[4,5,0,1].map(index=>({index}));
 assert.deepEqual(navigation(grouped,0),{previous:5,next:1,position:3,total:4});
 assert.deepEqual(navigation(grouped,4),{previous:null,next:5,position:1,total:4});
 assert.deepEqual(navigation(grouped,1),{previous:0,next:null,position:4,total:4});
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

test('the library groups by combination, pinning unparsed combos above the real ones',()=>{
 const g=(combo,over={})=>file({combo,...over});
 const entries=[g('22'),g(''),g('16'),g('16',{width:1024,height:768}),g('2')]
   .map((image,index)=>({image,index}));
 const groups=groupLibrary(entries);
 // Unassigned is pinned first so it can never be mistaken for a real combo; the rest sort numerically.
 assert.deepEqual(groups.map(x=>x.key),[UNASSIGNED,'2','16','22']);
 assert.equal(groups[0].needsCombo,true);
 assert.equal(groups[2].total,2);
 // Zones are size-specific, so a combo carrying two rasters reports both, ordered.
 assert.deepEqual(groups[2].sizes.map(s=>s.size),['640×480','1024×768']);
 assert.deepEqual(groups[2].sizes.map(s=>s.files.length),[1,1]);
});

test('group progress counts annotated files, not boxes',()=>{
 const entries=[file({combo:'16',frames:{0:[zone,zone]}}),file({combo:'16',frames:{0:[]}}),file({combo:'16',frames:{0:[zone]}})]
   .map((image,index)=>({image,index}));
 const [group]=groupLibrary(entries);
 assert.equal(group.annotated,2);assert.equal(group.total,3);
});

test('rows flatten for windowing, and a collapsed group costs exactly one row',()=>{
 const entries=[file({combo:'16'}),file({combo:'16',width:1024,height:768}),file({combo:'22'})]
   .map((image,index)=>({image,index}));
 const groups=groupLibrary(entries);
 const rows=libraryRows(groups);
 // Combo 16 has two sizes so it gets size headers; combo 22 has one and is not labelled twice.
 assert.deepEqual(rows.map(r=>r.type),['group','size','file','size','file','group','file']);
 const collapsed=libraryRows(groups,new Set(['16']));
 assert.deepEqual(collapsed.map(r=>r.type),['group','group','file']);
 assert.deepEqual(libraryRows([]),[]);
});

test('box counts are cached per image and invalidated only where they changed',()=>{
 const a=file({frames:{0:[zone]}}),b=file({frames:{0:[zone,zone]}});
 assert.equal(boxCount(a),1);assert.equal(boxCount(b),2);
 a.frames[0].push({...zone});
 assert.equal(boxCount(a),1,'a stale count is served until the edited image is invalidated');
 invalidateCount(a);
 assert.equal(boxCount(a),2);
 assert.equal(boxCount(b),2);
 invalidateCount(null); // tolerated, so callers need no guard
});
