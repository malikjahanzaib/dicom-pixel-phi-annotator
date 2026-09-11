import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeFixtures,fixtureDir,dicom,tagFixture,element} from './fixtures.mjs';
makeFixtures();
await fs.writeFile(path.join(fixtureDir,'combo16_640x480_s1.dcm'),Buffer.concat([tagFixture(),...Array.from({length:180},(_,i)=>element(0x13,0x1000+i,'LO','SYNTHETIC PRIVATE '+i))]));
const origin='http://127.0.0.1:5174';
const server=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,PORT:'5174'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',c=>reject(Error('Test server exited '+c)));server.stderr.once('data',d=>reject(Error(d.toString())));});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
const context=await browser.newContext({viewport:{width:1500,height:1100},deviceScaleFactor:2});
const page=await context.newPage();const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));context.on('request',r=>requests.push({url:r.url(),method:r.method()}));
await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
page.on('dialog',d=>d.accept());
const waitImage=async()=>{await page.waitForFunction(()=>document.getElementById('metadata').textContent.includes('native px')||(!document.getElementById('warning').hidden&&document.getElementById('warning').textContent.startsWith('Unable to open')),{},{timeout:30000});assert.ok((await page.locator('#metadata').textContent()).includes('native px'),await page.locator('#warning').textContent());};
const open=async(name)=>{await page.locator('#library .library-item').filter({hasText:name}).click();await waitImage();};
async function draw(x,y,right,bottom,w=640,h=480){
 await page.locator('#fit').click();const b=await page.locator('#canvas').boundingBox();const s=Math.min((b.width-36)/w,(b.height-36)/h);const ox=b.x+(b.width-w*s)/2,oy=b.y+(b.height-h*s)/2;
 await page.mouse.move(ox+x*s,oy+y*s);await page.mouse.down();await page.mouse.move(ox+right*s,oy+bottom*s,{steps:5});await page.mouse.up();
}
const noOverflow=async label=>{for(const selector of ['.annotation-actions','.frame-strip','.toolbar'])
 assert.ok(await page.locator(selector).evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${selector} overflows at ${label}`);};
async function exportJson(button,then){if(button==='#backup')await page.locator('#workspaceMenu').evaluate(e=>e.open=true);
 if(then){await page.locator(button).click();button=then;}
 const pending=page.waitForEvent('download');await page.locator(button).click();const download=await pending;return JSON.parse(await fs.readFile(await download.path(),'utf8'));}
try{
 await page.goto(origin);await page.waitForFunction(()=>!document.getElementById('files').disabled);
 await page.locator('#files').setInputFiles(['combo16_640x480_s1.dcm','combo16_1024x768_s1.dcm','rle.dcm','signed16.dcm','mono1.dcm','rgb.dcm','broken.dcm'].map(n=>path.join(fixtureDir,n)));
 await waitImage();assert.match(await page.locator('#message').textContent(),/6 added/);assert.match(await page.locator('#message').textContent(),/broken.dcm/);
 // The library groups by combination. Unparsed combos are pinned above the real ones so
 // they can never be silently annotated under another combo's layout.
 assert.deepEqual(await page.locator('.lib-group strong').allTextContents(),['Unassigned','Combo 16']);
 const group=name=>page.locator('.lib-group').filter({hasText:name}).textContent();
 assert.match(await group('Unassigned'),/4 files · 640×480/);
 assert.match(await group('Unassigned'),/0\/4/);
 assert.match(await group('Unassigned'),/needs combo ID/);
 assert.match(await group('Combo 16'),/2 files · 640×480, 1024×768/);
 assert.match(await group('Combo 16'),/0\/2/);
 // A combo carrying two rasters labels them, because a zone only means anything at one size.
 assert.deepEqual(await page.locator('.lib-size span').allTextContents(),['640×480','1 file','1024×768','1 file']);
 // Collapsing a finished combo drops its rows and keeps its header — the core batch loop.
 await page.locator('.lib-group').filter({hasText:'Combo 16'}).click();
 assert.equal(await page.locator('#library .library-item').count(),4);
 assert.equal(await page.locator('.lib-size').count(),0);
 await page.locator('#comboJump').selectOption('16'); // jump-to re-expands and scrolls
 assert.equal(await page.locator('#library .library-item').count(),6);
 console.log('PASS library grouped by combination, unassigned pinned, per-size labelling, collapse and jump-to.');
 // Verify the displayed raster itself: pixel spacing must not letterbox or stretch the source.
 await page.locator('#fit').click();const samples=await page.locator('#canvas').evaluate(c=>{const r=c.getBoundingClientRect(),s=Math.min((r.width-36)/640,(r.height-36)/480),dpr=c.width/r.width,ox=(r.width-640*s)/2,oy=(r.height-480*s)/2;return [100,500].map(x=>c.getContext('2d').getImageData(Math.floor((ox+x*s)*dpr),Math.floor((oy+20*s)*dpr),1,1).data[0]);});assert.ok(samples[0]>200&&samples[1]<100,JSON.stringify(samples));
 await draw(0,0,420,40);assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=420, h=40/);
 await page.locator('#note').fill('patient strip');await page.locator('#note').press('Tab');
 await page.screenshot({path:'.test-output/main.png'});
 // The metadata dialog searches the full file, including sequences and private tags.
 await page.locator('#openTags').click();await page.waitForFunction(()=>document.getElementById('tagCount').textContent.includes(' of '));
 assert.ok(await page.locator('#tagNext').isEnabled());await page.locator('#tagNext').click();assert.match(await page.locator('#tagPage').textContent(),/2 \/ 2/);
 await page.locator('#tagSearch').fill('00100010');assert.match(await page.locator('#tagRows').textContent(),/SYNTHETIC\^Zoë/);
 await page.locator('#tagSearch').fill('PatientName');assert.match(await page.locator('#tagRows').textContent(),/Patient Name/);
 await page.locator('#tagSearch').fill('2.25.222');assert.match(await page.locator('#tagRows').textContent(),/Referenced Study Sequence/);
 await page.locator('#tagSearch').fill('');await page.locator('#tagFilter').selectOption('private');assert.equal(await page.locator('#tagRows .tag-private').count(),150);
 await page.locator('#tagSearch').fill('calibration');assert.match(await page.locator('#tagRows').textContent(),/private calibration/);
 // The PS3.15 lens narrows a 200-tag file to just the attributes that carry identity.
 await page.locator('#tagSearch').fill('');await page.locator('#tagFilter').selectOption('phi');
 assert.match(await page.locator('#tagFilter').textContent(),/Identifying \(PS3\.15\) \(11\)/);
 assert.equal(await page.locator('#tagRows tr').count(),11);
 assert.match(await page.locator('#tagCount').textContent(),/^11 of /);
 assert.ok(await page.locator('#tagPhiNote').isVisible());
 assert.match(await page.locator('#tagPhiNote').textContent(),/never removes or rewrites a tag/);
 assert.match(await page.locator('#tagRows').textContent(),/Patient Name/);
 assert.match(await page.locator('#tagRows').textContent(),/SYNTHETIC\^Zoë/);
 assert.doesNotMatch(await page.locator('#tagRows').textContent(),/Columns|Pixel Data/);
 assert.equal(await page.locator('#tagRows .tag-private').count(),0);
 assert.equal(await page.locator('#tagRows').textContent().then(t=>/Referenced Study Sequence/.test(t)),true);
 // The one metadata fact that speaks directly to burned-in text is surfaced, not searched for.
 assert.match(await page.locator('#tagBurnedIn').textContent(),/\(0028,0301\) = YES · the source device declares that text is burned into the pixels/);
 await page.screenshot({path:'.test-output/phi.png'});
 await page.locator('#tagFilter').selectOption('all');
 assert.equal(await page.locator('#tagPhiNote').isVisible(),false);
 await page.locator('#tagSearch').fill('7fe00010');assert.match(await page.locator('#tagRows').textContent(),/Pixel data/);
 await page.locator('#tagSearch').fill('fffcfffc');assert.match(await page.locator('#tagRows').textContent(),/Data Set Trailing Padding/);
 await page.locator('#tagSearch').fill('not-a-real-tag');assert.ok(await page.locator('#tagEmpty').isVisible());
 await page.locator('#tagSearch').fill('patient');await page.screenshot({path:'.test-output/tags.png',fullPage:true});
 await page.locator('#closeTags').focus();await page.keyboard.press('Delete');await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');assert.equal(await page.locator('#tagDialog').isVisible(),false);assert.equal(await page.locator('#zones .zone').count(),1);assert.match(await page.locator('#viewTitle').textContent(),/640x480/);
 console.log('PASS tag viewer: dictionary names, UTF-8, nested/private tags, pagination, search, trailing tags, and modal keyboard isolation.');
 // Adjust via native fields after zoom.
 await page.locator('#zoomIn').click();await page.locator('#width').fill('422');await page.locator('#width').press('Tab');assert.match(await page.locator('#boxReadout').textContent(),/w=422/);
 await page.locator('#undo').click();assert.match(await page.locator('#zones').textContent(),/w=420/);await page.locator('#redo').click();assert.match(await page.locator('#zones').textContent(),/w=422/);
 await page.locator('#frameNext').click();await waitImage();assert.match(await page.locator('#frameLabel').textContent(),/2 \/ 3/);assert.equal(await page.locator('#zones .zone').count(),0);await draw(5,45,185,75);await page.locator('#note').fill('DOB');
 await page.locator('#framePrevious').click();await waitImage();assert.match(await page.locator('#zones').textContent(),/patient strip/);assert.equal(await page.locator('#zones .zone').count(),1);
 // Reuse: one drawn box propagated across frames, priced before writing and undoable per frame.
 await page.locator('#openReuse').click();await page.waitForFunction(()=>document.getElementById('reuseDialog').open);
 assert.match(await page.locator('#reuseSource').textContent(),/1 box on frame 1 of combo16_640x480_s1\.dcm/);
 assert.match(await page.locator('#reuseSize').textContent(),/640 × 480/);
 assert.match(await page.locator('#reusePlan').textContent(),/2 boxes into 2 frames across 1 file/);
 await page.screenshot({path:'.test-output/reuse.png'});
 await page.locator('#applyReuse').click();await page.waitForFunction(()=>!document.getElementById('reuseDialog').open);
 assert.match(await page.locator('#message').textContent(),/Copied 2 boxes into 2 frames across 1 file/);
 await page.locator('#frameNext').click();await waitImage();assert.equal(await page.locator('#zones .zone').count(),2);
 assert.match(await page.locator('#zones').textContent(),/patient strip/);assert.match(await page.locator('#zones').textContent(),/DOB/);
 await page.locator('#frameNext').click();await waitImage();assert.match(await page.locator('#frameLabel').textContent(),/3 \/ 3/);
 assert.equal(await page.locator('#zones .zone').count(),1);
 await page.locator('#undo').click();assert.equal(await page.locator('#zones .zone').count(),0);
 await page.locator('#redo').click();assert.equal(await page.locator('#zones .zone').count(),1);
 // C pulls the previous frame's boxes forward; exact duplicates are skipped, not stacked.
 await page.keyboard.press('c');await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Copied'));
 assert.match(await page.locator('#message').textContent(),/Copied 1 box into 1 frame across 1 file · 1 duplicate skipped/);
 assert.equal(await page.locator('#zones .zone').count(),2);
 await page.locator('#framePrevious').click();await waitImage();await page.locator('#framePrevious').click();await waitImage();
 assert.match(await page.locator('#frameLabel').textContent(),/1 \/ 3/);
 await noOverflow('1500px');
 console.log('PASS box reuse across frames, plan preview, per-frame undo/redo, and the keyboard copy shortcut.');
 // Redaction preview: opaque fill of the merged pipeline layout, including the DOB zone
 // that lives on frame 2 only. Sample the raster itself rather than trusting the overlay.
 assert.match(await page.locator('#frameLabel').textContent(),/1 \/ 3/);
 await page.locator('#preview').click();
 assert.match(await page.locator('#toolHint').textContent(),/2 pipeline zones for combo 16 at 640 × 480 · 1 from other frames or files/);
 assert.equal(await page.locator('#hideZones').isDisabled(),true);
 await page.locator('#fit').click();
 const sample=async()=>page.locator('#canvas').evaluate(c=>{const r=c.getBoundingClientRect(),s=Math.min((r.width-36)/640,(r.height-36)/480),dpr=c.width/r.width,ox=(r.width-640*s)/2,oy=(r.height-480*s)/2;
  const at=(x,y)=>c.getContext('2d').getImageData(Math.floor((ox+x*s)*dpr),Math.floor((oy+y*s)*dpr),1,1).data;
  return {strip:at(100,20)[0],dob:at(100,60)[0],clear:at(300,300)[0]};});
 const redacted=await sample();
 assert.equal(redacted.strip,0,JSON.stringify(redacted));
 assert.equal(redacted.dob,0,JSON.stringify(redacted)); // drawn on frame 2, redacted here too
 assert.ok(redacted.clear>25,JSON.stringify(redacted));
 // Editing is suspended, so a drag cannot add a box the operator cannot see.
 await draw(200,200,300,260);assert.equal(await page.locator('#zones .zone').count(),1);
 // The combo ID chooses which layout is previewed; without one only this frame is shown.
 await page.locator('#comboId').fill('');await page.locator('#comboId').press('Tab');
 assert.match(await page.locator('#toolHint').textContent(),/this frame’s 1 box · assign a combo ID/);
 assert.equal((await sample()).dob>25,true); // the other frame's zone is no longer implied
 await page.locator('#comboId').fill('16');await page.locator('#comboId').press('Tab');
 assert.match(await page.locator('#toolHint').textContent(),/2 pipeline zones for combo 16/);
 await page.screenshot({path:'.test-output/preview.png'});
 await page.locator('#preview').click();
 assert.equal(await page.locator('#hideZones').isDisabled(),false);
 assert.ok((await sample()).strip>0,'boxes must return to a translucent overlay');
 console.log('PASS redaction preview: opaque union fill, cross-frame zones, suspended editing, and combo-scoped layout.');
 // Keyboard precision. Arrows nudge the selected box; a run of presses is one undo step.
 await page.locator('#zones .zone .choose').first().click();
 assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=422, h=40/);
 await page.locator('#canvas').focus();
 await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowUp');
 assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=422, h=40/); // clamped at the raster edge
 await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
 assert.match(await page.locator('#boxReadout').textContent(),/x=3, y=0, w=422, h=40/); // moved, never resized
 await page.waitForTimeout(500);
 await page.keyboard.press('Shift+ArrowDown');
 assert.match(await page.locator('#boxReadout').textContent(),/x=3, y=10/);
 await page.waitForTimeout(500);
 await page.locator('#undo').click();assert.match(await page.locator('#zones').textContent(),/x=3, y=0/);
 // One more undo, not three: the burst of arrow presses collapsed into a single step.
 await page.locator('#undo').click();assert.match(await page.locator('#zones').textContent(),/x=0, y=0, w=422, h=40/);
 // Tab cycles the boxes on this frame while the canvas holds focus.
 await page.locator('#frameNext').click();await waitImage();
 assert.equal(await page.locator('#zones .zone').count(),2);
 await page.locator('#canvas').focus();
 await page.keyboard.press('Tab');assert.match(await page.locator('#boxReadout').textContent(),/x=5, y=45, w=180, h=30/);
 await page.keyboard.press('Tab');assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=422, h=40/);
 await page.keyboard.press('Tab');assert.match(await page.locator('#boxReadout').textContent(),/x=5, y=45/); // wraps
 await page.keyboard.press('Shift+Tab');assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=422/);
 // A frame with no boxes has nothing to cycle, so Tab must not be swallowed there.
 await page.locator('#hideZones').click();
 assert.equal(await page.evaluate(()=>{const c=document.getElementById('canvas');c.focus();
  const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});c.dispatchEvent(e);return e.defaultPrevented;}),false);
 await page.locator('#hideZones').click();await page.locator('#canvas').focus();
 await page.keyboard.press('Tab');assert.match(await page.locator('#boxReadout').textContent(),/x=5, y=45/);
 // Escape unwinds: deselect, then release the canvas so the page tabs normally again.
 await page.keyboard.press('Escape');assert.equal(await page.locator('#boxReadout').textContent(),'—');
 assert.equal(await page.evaluate(()=>document.activeElement===document.getElementById('canvas')),true);
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement===document.getElementById('canvas')),false);
 // With nothing selected the arrow keys move between files again.
 await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('combo16_1024x768'));
 await page.locator('#library .library-item').filter({hasText:'combo16_640x480'}).click();await waitImage();
 assert.match(await page.locator('#frameLabel').textContent(),/2 \/ 3/);
 await page.locator('#framePrevious').click();await waitImage();
 assert.match(await page.locator('#zones').textContent(),/x=0, y=0, w=422, h=40/);
 console.log('PASS keyboard nudging with clamping and coalesced undo, Tab cycling, and the Escape focus ladder.');
 await page.locator('#windowWidth').fill('350');await page.locator('#windowWidth').press('Tab');await page.locator('#invert').click();assert.match(await page.locator('#zones').textContent(),/w=422/);
 await open('combo16_1024x768');await draw(0,0,670,64,1024,768);
 const payload=await exportJson('#export');assert.deepEqual(Object.keys(payload),['generated_at','annotations']);assert.equal(payload.annotations['16']['640x480'].zones.length,2);assert.equal(payload.annotations['16']['640x480'].zones[1].note,'DOB');assert.equal(payload.annotations['16']['1024x768'].zones[0].width,670);
 console.log('PASS DICOM import, frame-specific boxes, native geometry with anisotropic pixel spacing, zoom, undo/redo, window/level, pipeline JSON.');
 await page.waitForFunction(()=>document.getElementById('saveStatus').textContent==='Saved locally');await page.reload();await waitImage();assert.equal(await page.locator('#library .library-item').count(),6);await open('combo16_640x480');assert.match(await page.locator('#zones').textContent(),/patient strip/);await page.locator('#frameNext').click();await waitImage();assert.match(await page.locator('#zones').textContent(),/DOB/);console.log('PASS IndexedDB restores images, frame annotations, notes, and display settings after reload.');
 for(const name of ['rle.dcm','signed16.dcm','mono1.dcm','rgb.dcm']){await open(name);assert.equal(await page.locator('#warning').isVisible(),false,name);const variation=await page.locator('#canvas').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;for(let i=0;i<data.length;i+=4){lo=Math.min(lo,data[i]);hi=Math.max(hi,data[i]);}return hi-lo;});assert.ok(variation>100,name);}
 console.log('PASS RLE, signed 16-bit, MONOCHROME1, and RGB DICOM decoding.');
 // Exercise a WASM compressed codec using a JPEG created locally from a synthetic canvas.
 const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');ctx.fillStyle='#121212';ctx.fillRect(0,0,640,480);ctx.fillStyle='#eeeeee';ctx.fillRect(0,0,420,40);return c.toDataURL('image/jpeg').split(',')[1];});
 const compressed=path.join(fixtureDir,'jpeg.dcm');await fs.writeFile(compressed,dicom({syntax:'1.2.840.10008.1.2.4.50',photo:'YBR_FULL_422',compressed:Buffer.from(jpeg,'base64')}));await page.locator('#files').setInputFiles(compressed);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('1 added'));await open('jpeg.dcm');assert.equal(await page.locator('#warning').isVisible(),false);console.log('PASS JPEG baseline DICOM with locally bundled WASM codec.');
 await draw(0,0,420,40);assert.equal(await page.locator('#export').isDisabled(),true);await page.locator('#comboId').fill('022');await page.locator('#comboId').press('Tab');assert.equal(await page.locator('#export').isDisabled(),false);
 const backup=await exportJson('#backup');assert.equal(backup.format,'pixel-zone-project');assert.ok(backup.images.some(i=>i.frames[1]?.[0]?.note==='DOB'));
 await page.waitForFunction(()=>document.getElementById('saveStatus').textContent==='Saved locally');
 await page.screenshot({path:'.test-output/workspace.png',fullPage:true});
 const secondary=await context.newPage();await secondary.goto(origin);await secondary.waitForFunction(()=>document.getElementById('saveStatus').textContent.toLowerCase().includes('another tab'));await secondary.close();console.log('PASS secondary-tab protection against autosave overwrites.');
 const backupPath=path.resolve('.test-output/backup.json');await fs.writeFile(backupPath,JSON.stringify(backup));
 await page.locator('#workspaceMenu').evaluate(e=>e.open=true);await page.locator('#clearWorkspace').click();await page.waitForFunction(()=>document.querySelectorAll('#library button').length===0);
 await page.locator('#restoreBackup').setInputFiles(backupPath);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Backup restored'));
 assert.equal(await page.locator('#library .library-item').count(),7);assert.match(await page.locator('#warning').textContent(),/Source file is missing/);
 await page.locator('#files').setInputFiles(path.join(fixtureDir,'combo16_640x480_s1.dcm'));await page.waitForFunction(()=>document.getElementById('message').textContent.includes('1 reconnected'));await waitImage();await page.locator('#framePrevious').click();await waitImage();assert.match(await page.locator('#zones').textContent(),/patient strip/);
 await page.locator('#frameNext').click();await waitImage();assert.match(await page.locator('#zones').textContent(),/DOB/);console.log('PASS clear saved data, restore backup, hash-based source reconnection, and frame annotations.');
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');ctx.fillStyle='#aaa';ctx.fillRect(0,0,420,40);return c.toDataURL('image/png').split(',')[1];});
 const pngPath=path.join(fixtureDir,'combo33_640x480_s1.png');await fs.writeFile(pngPath,Buffer.from(png,'base64'));await page.locator('#files').setInputFiles(pngPath);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('1 added'));await open('combo33_640x480');await draw(0,0,420,40);assert.match(await page.locator('#boxReadout').textContent(),/w=420, h=40/);assert.equal(await page.locator('#openTags').isDisabled(),true);console.log('PASS PNG compatibility in the DICOM workspace.');
 // Batch reuse: same-size files only, optionally narrowed to one combo ID.
 await page.locator('#note').fill('copied strip');await page.locator('#note').press('Tab');
 await page.locator('#openReuse').click();await page.waitForFunction(()=>document.getElementById('reuseDialog').open);
 await page.locator('input[name=reuseScope][value=files]').check();await page.locator('#reuseSameCombo').check();
 assert.match(await page.locator('#reusePlan').textContent(),/No eligible destination/);
 assert.equal(await page.locator('#applyReuse').isDisabled(),true);
 await page.locator('#reuseSameCombo').uncheck();
 assert.match(await page.locator('#reusePlan').textContent(),/6 boxes into 6 frames across 6 files/);
 // Reuse is pure annotation metadata: these files lost their sources at the restore step
 // and still receive boxes, so the library counts are the check rather than the canvas.
 const libraryRow=name=>page.locator('#library .library-item').filter({hasText:name}).textContent();
 assert.match(await libraryRow('rgb.dcm'),/0 boxes · source needed/);
 await page.locator('#applyReuse').click();await page.waitForFunction(()=>!document.getElementById('reuseDialog').open);
 assert.match(await page.locator('#message').textContent(),/Copied 6 boxes into 6 frames across 6 files/);
 assert.match(await libraryRow('rgb.dcm'),/1 box · source needed/);
 assert.match(await libraryRow('combo16_1024x768'),/1 box · source needed/);
 console.log('PASS combo-filtered batch copy across same-size files, with other rasters excluded.');
 // Batch triage: the filter counts remaining work, and one action clears a whole view.
 // Four files carry copied boxes with no combo ID, so the pipeline export is blocked.
 assert.match(await page.locator('#libraryCount').textContent(),/8 files/);
 const options=async()=>page.locator('#libraryFilter').textContent();
 assert.match(await options(),/Needs combo ID \(4\)/);
 assert.match(await options(),/Source needed \(6\)/);
 assert.match(await options(),/No boxes \(0\)/);
 assert.equal(await page.locator('#export').isDisabled(),true);
 await page.locator('#libraryFilter').selectOption('unannotated');
 assert.match(await page.locator('.library-empty').textContent(),/Nothing in this view/);
 await page.locator('#libraryFilter').selectOption('needs-combo');
 assert.equal(await page.locator('#library .library-item').count(),4);
 assert.match(await page.locator('#libraryCount').textContent(),/4 of 8/);
 // The button targets the library view, using the selected file's committed combo ID.
 assert.match(await page.locator('#applyComboToShown').textContent(),/Apply combo 33 to 4 shown files/);
 await page.locator('#library .library-item').filter({hasText:'rgb.dcm'}).click();
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('rgb.dcm')&&document.getElementById('comboId').value==='');
 assert.equal(await page.locator('#applyComboToShown').isDisabled(),true); // nothing to propagate yet
 await page.locator('#comboId').fill('77');await page.locator('#comboId').press('Tab');
 // Committing to rgb.dcm drops it out of the filter, and the label follows honestly.
 assert.match(await page.locator('#applyComboToShown').textContent(),/Apply combo 77 to 3 shown files/);
 await page.screenshot({path:'.test-output/triage.png'});
 await page.locator('#applyComboToShown').click();
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('set to combo 77'));
 assert.match(await page.locator('#message').textContent(),/^3 files set to combo 77\.$/);
 assert.equal(await page.locator('#export').isDisabled(),false); // export unblocks
 assert.match(await page.locator('.library-empty').textContent(),/Nothing in this view/);
 assert.match(await options(),/Needs combo ID \(0\)/);
 await page.locator('#libraryFilter').selectOption('all');
 assert.match(await page.locator('#library .library-item').filter({hasText:'rgb.dcm'}).textContent(),/1 box · source needed/);
 // The combo now reads from the group header rather than being repeated on every row.
 assert.match(await page.locator('.lib-group').filter({hasText:'Combo 77'}).textContent(),/4 files · 640×480/);
 assert.match(await page.locator('.lib-group').filter({hasText:'Combo 77'}).textContent(),/4\/4/);
 await page.locator('#search').fill('77');assert.equal(await page.locator('#library .library-item').count(),4); // combo is searchable
 await page.locator('#search').fill('rle');assert.equal(await page.locator('#library .library-item').count(),1);
 await page.locator('#search').fill('');
 // Previous/Next follow the view. "combo" matches files 1, 2 and 8 of the eight imported,
 // so stepping across it must skip the six hidden files in between.
 await page.locator('#search').fill('combo');
 assert.equal(await page.locator('#library .library-item').count(),3);
 await page.locator('#library .library-item').filter({hasText:'combo16_1024x768'}).click();
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('combo16_1024x768'));
 assert.match(await page.locator('#counter').textContent(),/^2 of 3$/);
 await page.locator('#next').click();
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('combo33'));
 assert.match(await page.locator('#counter').textContent(),/^3 of 3$/);
 assert.equal(await page.locator('#next').isDisabled(),true);
 await page.keyboard.press('ArrowLeft'); // the arrow keys walk the same view
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('combo16_1024x768'));
 assert.match(await page.locator('#counter').textContent(),/^2 of 3$/);
 // A file outside the view has no position in it but still has neighbours to step to.
 await page.locator('#search').fill('rle');
 assert.match(await page.locator('#counter').textContent(),/^— of 1$/);
 assert.equal(await page.locator('#previous').isDisabled(),true);
 assert.equal(await page.locator('#next').isDisabled(),false);
 await page.locator('#next').click();
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('rle.dcm'));
 assert.match(await page.locator('#counter').textContent(),/^1 of 1$/);
 assert.equal(await page.locator('#next').isDisabled(),true);
 await page.locator('#search').fill('');
 // Grouped order pins Unassigned first then sorts combos numerically, so rle.dcm (combo 77) sits fifth.
 assert.match(await page.locator('#counter').textContent(),/^5 of 8$/);
 console.log('PASS Previous/Next, the arrow keys, and the counter all follow the library view.');
 assert.match(await page.locator('#libraryCount').textContent(),/8 files/);
 await open('combo33_640x480'); // leave a file with a live source selected
 console.log('PASS library filters with live counts, and one combo ID assigned across a filtered batch.');
 // OCR. The context route aborts anything not on the local origin, so a detection that
 // completes here proves the engine, its core and its language data all came from disk.
 const textPng=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;
  const x=c.getContext('2d');x.fillStyle='#050505';x.fillRect(0,0,640,480);
  x.fillStyle='#f4f4f4';x.font='bold 30px "Courier New", monospace';
  x.fillText('SMITH JANE',18,48);x.fillText('DOB 1985-03-12',18,96);
  return c.toDataURL('image/png').split(',')[1];});
 const textPath=path.join(fixtureDir,'combo44_640x480_s1.png');
 await fs.writeFile(textPath,Buffer.from(textPng,'base64'));
 await page.locator('#files').setInputFiles(textPath);
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('1 added'));
 await open('combo44_640x480');
 assert.equal(await page.locator('#ocrSection').isVisible(),false,'the panel appears only once detection is asked for');
 await page.locator('#detectText').click();
 await page.waitForFunction(()=>Number(document.getElementById('ocrCount').textContent)>0,{},{timeout:120000});
 const detected=Number(await page.locator('#ocrCount').textContent());
 assert.ok(detected>=2,`expected both text lines, got ${detected}`);
 // Every suggestion starts uncovered, and the wording reports findings, never a verdict.
 const status=await page.locator('#ocrStatus').textContent();
 assert.match(status,/text regions detected · \d+ not covered by a zone/);
 assert.doesNotMatch(status,/clean|all PHI|complete|safe|verified/i);
 assert.ok(await page.locator('#ocrCaveat').isVisible(),'the caveat is standing, not dismissible');
 assert.match(await page.locator('#ocrCaveat').textContent(),/never that an image is clean/);
 assert.match(await page.locator('#ocrList').textContent(),/SMITH/i);
 // Nothing is accepted automatically: no zone exists until the operator says so.
 assert.equal(await page.locator('#zones .zone').count(),0);
 await page.locator('#ocrList .ocr-accept').first().click();
 assert.equal(await page.locator('#zones .zone').count(),1);
 assert.match(await page.locator('#note').inputValue(),/SMITH/i);
 // The accepted box is padded outwards from the glyph bounds and sits in native pixels.
 const box=await page.locator('#zones .zone small').first().textContent();
 const [,bx,by,bw]=box.match(/x=(\d+), y=(\d+), w=(\d+)/).map(Number);
 assert.ok(bx>=0&&by>=0&&bw>0&&bx+bw<=640,`accepted box must lie inside the raster: ${box}`);
 assert.equal(Number(await page.locator('#ocrCount').textContent()),detected-1);
 await page.screenshot({path:'.test-output/ocr.png'});
 await page.locator('#acceptAllOcr').click();
 assert.equal(await page.locator('#zones .zone').count(),detected);
 assert.equal(await page.locator('#ocrList').textContent(),'');
 assert.match(await page.locator('#ocrStatus').textContent(),/No text regions detected on this frame\. That is not a finding of "no text"\./);
 console.log(`PASS OCR offline: ${detected} line suggestions, padded and clamped, accepted only on request, no completeness claim.`);
 // Contact sheet: a whole combo as thumbnails, each carrying the merged pipeline layout.
 await open('combo16_640x480');
 await page.locator('#openContact').click();
 await page.waitForFunction(()=>document.getElementById('contactDialog').open);
 assert.match(await page.locator('#contactSubject').textContent(),/Combo 16$/);
 assert.match(await page.locator('#contactCount').textContent(),/^2 files$/);
 // Thumbnails decode lazily, so wait for the raster rather than assuming it is there.
 // Only one of this combo's two files still has its source after the restore step; the
 // other must say so rather than sitting on a blank tile forever.
 await page.waitForFunction(()=>document.querySelectorAll('#contactGrid .cell canvas').length>=1,{},{timeout:60000});
 assert.match(await page.locator('#contactGrid .cell').filter({hasText:'combo16_1024x768'}).textContent(),/no source/);
 // The overlay is the merged layout: the strip is blacked out on the thumbnail itself.
 const painted=await page.locator('#contactGrid .cell canvas').first().evaluate(c=>{
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const at=(x,y)=>d[((y*c.width+x)*4)];
  return {strip:at(Math.floor(c.width*0.3),Math.floor(c.height*0.04)),lower:at(Math.floor(c.width*0.5),Math.floor(c.height*0.6))};});
 assert.equal(painted.strip,0,`the merged layout must be painted opaque: ${JSON.stringify(painted)}`);
 assert.ok(painted.lower>10,JSON.stringify(painted));
 // Scope narrows to one raster size, and widens to everything.
 await page.locator('#contactScope').selectOption('size');
 assert.match(await page.locator('#contactCount').textContent(),/^1 file$/);
 assert.match(await page.locator('#contactSubject').textContent(),/Combo 16 · 640×480/);
 await page.locator('#contactScope').selectOption('all');
 assert.match(await page.locator('#contactCount').textContent(),/^9 files$/);
 // Outliers are flagged: no zones, no combo, or no reachable source.
 assert.ok(await page.locator('#contactGrid .cell.flagged').count()>0);
 assert.match(await page.locator('#contactFlagged').textContent(),/\d+ flagged/);
 await page.screenshot({path:'.test-output/contact.png'});
 // A thumbnail opens its file, which is the point of the review pass.
 await page.locator('#contactGrid .cell').filter({hasText:'rgb.dcm'}).click();
 await page.waitForFunction(()=>!document.getElementById('contactDialog').open);
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('rgb.dcm'));
 await open('combo16_640x480');
 console.log('PASS contact sheet: merged layout overlaid on lazily decoded thumbnails, scoped, flagged, and clickable.');
 // Zone templates: save a layout, apply it cold to another file of the same raster.
 await open('combo16_640x480');
 await page.locator('#openTemplates').click();
 await page.waitForFunction(()=>document.getElementById('templateDialog').open);
 assert.match(await page.locator('#templateList').textContent(),/No templates yet/);
 await page.locator('#templateName').fill('iU22 header + DOB');
 await page.locator('#saveTemplate').click();
 await page.waitForFunction(()=>!document.querySelector('#templateList .empty'));
 assert.match(await page.locator('#templateList .tpl').first().textContent(),/iU22 header \+ DOB/);
 assert.match(await page.locator('#templateList .tpl').first().textContent(),/combo 16 · 640×480 · \d+ zones/);
 // Selecting it prices the operation before anything is written, exactly like Copy to….
 await page.locator('#templateList .pick').first().click();
 assert.match(await page.locator('#templatePlan').textContent(),/already has these boxes|boxes into/);
 // A template is refused on another raster rather than rescaled, and says where it fits.
 await page.locator('#closeTemplates').click();
 await page.locator('#library .library-item').filter({hasText:'combo16_1024x768'}).click();
 await page.waitForFunction(()=>document.getElementById('viewTitle').textContent.includes('combo16_1024x768'));
 await page.locator('#openTemplates').click();
 await page.locator('#templateList .pick').first().click();
 assert.match(await page.locator('#templatePlan').textContent(),/built for 640×480; this file is 1024×768/);
 assert.match(await page.locator('#templatePlan').textContent(),/never rescaled/);
 assert.equal(await page.locator('#applyTemplate').isDisabled(),true);
 await page.screenshot({path:'.test-output/templates.png'});
 // Applied cold to a fresh same-size file: no reference file open, zones land natively.
 await page.locator('#closeTemplates').click();
 await open('combo44_640x480');
 const before=await page.locator('#zones .zone').count();
 await page.locator('#openTemplates').click();
 await page.locator('#templateList .pick').first().click();
 await page.locator('input[name=templateScope][value="file"]').check();
 assert.match(await page.locator('#templatePlan').textContent(),/boxes into 1 frame across 1 file/);
 await page.locator('#applyTemplate').click();
 await page.waitForFunction(()=>!document.getElementById('templateDialog').open);
 assert.ok(await page.locator('#zones .zone').count()>before);
 assert.match(await page.locator('#zones').textContent(),/patient strip/);
 // Templates outlive the workspace and the session: they are in their own store.
 const exported=await exportJson('#openTemplates','#exportTemplates');
 assert.equal(exported.format,'pixel-zone-templates');
 assert.equal(exported.templates.length,1);
 assert.deepEqual(Object.keys(exported.templates[0]).sort(),['combo','createdAt','height','id','name','width','zones']);
 await page.locator('#closeTemplates').click();
 console.log('PASS zone templates: saved, priced, refused on a size mismatch, applied cold, and exported.');
 // Importing a prior annotations.json: standalone layouts, held out of the export until
 // promoted, and round-tripping back to an equivalent file.
 const priorPath=path.resolve('.test-output/prior-annotations.json');
 await fs.writeFile(priorPath,JSON.stringify({generated_at:'2026-01-01T00:00:00.000Z',annotations:{
   '16':{'640x480':{ref_width:640,ref_height:480,zones:[{x:11,y:12,width:300,height:22,note:'prior header'}]}},
   '99':{'800x600':{ref_width:800,ref_height:600,zones:[{x:0,y:0,width:80,height:16,note:'prior corner'}]}}}}));
 const zonesBefore=Number((await page.locator('#total').textContent()).match(/\d+/)[0]);
 await page.locator('#workspaceMenu').evaluate(e=>e.open=true);
 await page.locator('#importPipeline').setInputFiles(priorPath);
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Imported 2 layouts'));
 assert.match(await page.locator('#message').textContent(),/Nothing is exported until you promote it\./);
 assert.equal(await page.locator('#layoutList .layout').count(),2);
 // Combo 99 has no file in the library at all and is still listed and reviewable.
 assert.match(await page.locator('#layoutList .layout').filter({hasText:'Combo 99'}).textContent(),/800×600/);
 assert.equal(await page.locator('#layoutList .layout .state').first().textContent(),'held');
 // Held back: the export total has not moved.
 assert.equal(Number((await page.locator('#total').textContent()).match(/\d+/)[0]),zonesBefore);
 await page.screenshot({path:'.test-output/imported.png'});
 // Promoting is what admits a layout to the export.
 await page.locator('#layoutList .layout').filter({hasText:'Combo 99'}).locator('summary').click();
 await page.locator('#layoutList .layout').filter({hasText:'Combo 99'}).getByText('Promote to export').click();
 assert.equal(Number((await page.locator('#total').textContent()).match(/\d+/)[0]),zonesBefore+1);
 assert.match(await page.locator('#summary').textContent(),/Combo 99 · 800×600/);
 const withImport=await exportJson('#export');
 // Round trip: the promoted layout re-exports in the frozen schema, byte-shaped as it
 // arrived, alongside the zones that came from real files.
 assert.deepEqual(withImport.annotations['99'],{'800x600':{ref_width:800,ref_height:600,
   zones:[{x:0,y:0,width:80,height:16,note:'prior corner'}]}});
 assert.equal('16' in withImport.annotations,true);
 assert.deepEqual(Object.keys(withImport),['generated_at','annotations']);
 // Removing a zone withdraws the confirmation, because what was reviewed changed.
 await page.locator('#layoutList .layout').filter({hasText:'Combo 99'}).locator('.zone-line button').first().click();
 assert.equal(await page.locator('#layoutList .layout').count(),1,'an emptied layout is dropped');
 assert.equal(Number((await page.locator('#total').textContent()).match(/\d+/)[0]),zonesBefore);
 console.log('PASS annotations.json import: standalone layouts, held out of the export until promoted, and round-tripped.');
 await page.setViewportSize({width:760,height:1000}); await page.setViewportSize({width:760,height:1000});await page.locator('#fit').click();await noOverflow('760px');await page.screenshot({path:'.test-output/narrow.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});await noOverflow('600px');await page.setViewportSize({width:1500,height:1100});

 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>!r.url.startsWith(origin)&&!r.url.startsWith('blob:')&&!r.url.startsWith('data:')),[]);assert.ok(requests.every(r=>r.method==='GET'));console.log('PASS explicit combo assignment, frame-preserving backup, no external requests or upload API calls.');
 // Persistence unavailable: importing, drawing, and backup must remain usable.
 const memory=await browser.newContext();await memory.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw Error('Storage disabled');}}));const m=await memory.newPage();m.on('dialog',d=>d.accept());await m.goto(origin);await m.waitForFunction(()=>!document.getElementById('files').disabled);assert.match(await m.locator('#saveStatus').textContent(),/Not saving · storage unavailable/);await m.locator('#files').setInputFiles(path.join(fixtureDir,'rle.dcm'));await m.waitForFunction(()=>document.getElementById('metadata').textContent.includes('native px'));await memory.close();console.log('PASS usable session-only fallback when IndexedDB is unavailable.');
 // Scale: a thousand files must stay interactive. Restoring a backup builds the workspace
 // without decoding any pixels, which is exactly the library path under test.
 const bulk=[];
 for(let i=0;i<1000;i++){const wide=i%3===0;
  bulk.push({id:i.toString(16).padStart(64,'0'),name:`combo${(i%20)+1}_${wide?'1024x768':'640x480'}_s${i}.dcm`,
   path:`combo_${(i%20)+1}/s${i}.dcm`,combo:String((i%20)+1),kind:'DICOM',
   width:wide?1024:640,height:wide?768:480,frameCount:4,frameIndex:0,
   frames:{0:[{x:0,y:0,width:100,height:20,note:''}]},display:{},metadata:{}});}
 const bulkPath=path.resolve('.test-output/bulk.json');
 await fs.writeFile(bulkPath,JSON.stringify({format:'pixel-zone-project',version:1,images:bulk}));
 const many=await browser.newContext();const mp=await many.newPage();
 mp.on('dialog',d=>d.accept());mp.on('pageerror',e=>errors.push('bulk: '+e.message));
 await mp.goto(origin);await mp.waitForFunction(()=>!document.getElementById('files').disabled);
 await mp.locator('#restoreBackup').setInputFiles(bulkPath);
 await mp.waitForFunction(()=>document.getElementById('libraryCount').textContent==='1000 files',{},{timeout:60000});
 // All 20 groups exist in the model — the jump-to control lists them — while the DOM
 // holds only a windowed slice of rows, which is the whole point.
 assert.equal(await mp.locator('#comboJump option').count(),21); // 20 combos + the placeholder
 assert.ok(await mp.locator('.lib-group').count()<20,'group headers are windowed too');
 const rendered=await mp.locator('#library .library-item').count();
 assert.ok(rendered>0&&rendered<80,`expected a windowed slice, rendered ${rendered} rows`);
 const firstBefore=await mp.locator('#library .library-item').first().getAttribute('title');
 await mp.locator('#library').evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await mp.waitForFunction(t=>document.querySelector('#library .library-item')?.title!==t,firstBefore);
 assert.ok(await mp.locator('#library .library-item').count()<80,'rows are recycled, not accumulated');
 // Filtering the whole batch stays inside a frame budget.
 const ms=await mp.evaluate(async()=>{const box=document.getElementById('search');
  const t=performance.now();box.value='combo_7/';box.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>requestAnimationFrame(r));return performance.now()-t;});
 assert.ok(ms<400,`filtering 1000 files took ${ms.toFixed(0)}ms`);
 assert.match(await mp.locator('#libraryCount').textContent(),/ of 1000$/);
 await many.close();
 console.log(`PASS 1,000 files: 20 groups, ${rendered} rows in the DOM, filter in ${ms.toFixed(0)}ms.`);
 console.log('ALL BROWSER CHECKS PASSED');
}catch(error){console.error('Browser state:',await page.locator('#warning').textContent(),await page.locator('#message').textContent(),errors);await page.screenshot({path:'.test-output/failure.png',fullPage:true});throw error;}finally{await context.close();await browser.close();server.kill();}
