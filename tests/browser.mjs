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
const open=async(name)=>{await page.locator('#library button').filter({hasText:name}).click();await waitImage();};
async function draw(x,y,right,bottom,w=640,h=480){
 await page.locator('#fit').click();const b=await page.locator('#canvas').boundingBox();const s=Math.min((b.width-36)/w,(b.height-36)/h);const ox=b.x+(b.width-w*s)/2,oy=b.y+(b.height-h*s)/2;
 await page.mouse.move(ox+x*s,oy+y*s);await page.mouse.down();await page.mouse.move(ox+right*s,oy+bottom*s,{steps:5});await page.mouse.up();
}
const noOverflow=async label=>{for(const selector of ['.annotation-actions','.frame-strip','.toolbar'])
 assert.ok(await page.locator(selector).evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${selector} overflows at ${label}`);};
async function exportJson(button){if(button==='#backup')await page.locator('#workspaceMenu').evaluate(e=>e.open=true);const pending=page.waitForEvent('download');await page.locator(button).click();const download=await pending;return JSON.parse(await fs.readFile(await download.path(),'utf8'));}
try{
 await page.goto(origin);await page.waitForFunction(()=>!document.getElementById('files').disabled);
 await page.locator('#files').setInputFiles(['combo16_640x480_s1.dcm','combo16_1024x768_s1.dcm','rle.dcm','signed16.dcm','mono1.dcm','rgb.dcm','broken.dcm'].map(n=>path.join(fixtureDir,n)));
 await waitImage();assert.match(await page.locator('#message').textContent(),/6 added/);assert.match(await page.locator('#message').textContent(),/broken.dcm/);
 // Verify the displayed raster itself: pixel spacing must not letterbox or stretch the source.
 await page.locator('#fit').click();const samples=await page.locator('#canvas').evaluate(c=>{const r=c.getBoundingClientRect(),s=Math.min((r.width-36)/640,(r.height-36)/480),dpr=c.width/r.width,ox=(r.width-640*s)/2,oy=(r.height-480*s)/2;return [100,500].map(x=>c.getContext('2d').getImageData(Math.floor((ox+x*s)*dpr),Math.floor((oy+20*s)*dpr),1,1).data[0]);});assert.ok(samples[0]>200&&samples[1]<100,JSON.stringify(samples));
 await draw(0,0,420,40);assert.match(await page.locator('#boxReadout').textContent(),/x=0, y=0, w=420, h=40/);
 await page.locator('#note').fill('patient strip');await page.locator('#note').press('Tab');
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
 await page.locator('#library button').filter({hasText:'combo16_640x480'}).click();await waitImage();
 assert.match(await page.locator('#frameLabel').textContent(),/2 \/ 3/);
 await page.locator('#framePrevious').click();await waitImage();
 assert.match(await page.locator('#zones').textContent(),/x=0, y=0, w=422, h=40/);
 console.log('PASS keyboard nudging with clamping and coalesced undo, Tab cycling, and the Escape focus ladder.');
 await page.locator('#windowWidth').fill('350');await page.locator('#windowWidth').press('Tab');await page.locator('#invert').click();assert.match(await page.locator('#zones').textContent(),/w=422/);
 await open('combo16_1024x768');await draw(0,0,670,64,1024,768);
 const payload=await exportJson('#export');assert.deepEqual(Object.keys(payload),['generated_at','annotations']);assert.equal(payload.annotations['16']['640x480'].zones.length,2);assert.equal(payload.annotations['16']['640x480'].zones[1].note,'DOB');assert.equal(payload.annotations['16']['1024x768'].zones[0].width,670);
 console.log('PASS DICOM import, frame-specific boxes, native geometry with anisotropic pixel spacing, zoom, undo/redo, window/level, pipeline JSON.');
 await page.waitForFunction(()=>document.getElementById('saveStatus').textContent==='Saved on this device');await page.reload();await waitImage();assert.equal(await page.locator('#library button').count(),6);await open('combo16_640x480');assert.match(await page.locator('#zones').textContent(),/patient strip/);await page.locator('#frameNext').click();await waitImage();assert.match(await page.locator('#zones').textContent(),/DOB/);console.log('PASS IndexedDB restores images, frame annotations, notes, and display settings after reload.');
 for(const name of ['rle.dcm','signed16.dcm','mono1.dcm','rgb.dcm']){await open(name);assert.equal(await page.locator('#warning').isVisible(),false,name);const variation=await page.locator('#canvas').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;for(let i=0;i<data.length;i+=4){lo=Math.min(lo,data[i]);hi=Math.max(hi,data[i]);}return hi-lo;});assert.ok(variation>100,name);}
 console.log('PASS RLE, signed 16-bit, MONOCHROME1, and RGB DICOM decoding.');
 // Exercise a WASM compressed codec using a JPEG created locally from a synthetic canvas.
 const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');ctx.fillStyle='#121212';ctx.fillRect(0,0,640,480);ctx.fillStyle='#eeeeee';ctx.fillRect(0,0,420,40);return c.toDataURL('image/jpeg').split(',')[1];});
 const compressed=path.join(fixtureDir,'jpeg.dcm');await fs.writeFile(compressed,dicom({syntax:'1.2.840.10008.1.2.4.50',photo:'YBR_FULL_422',compressed:Buffer.from(jpeg,'base64')}));await page.locator('#files').setInputFiles(compressed);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('1 added'));await open('jpeg.dcm');assert.equal(await page.locator('#warning').isVisible(),false);console.log('PASS JPEG baseline DICOM with locally bundled WASM codec.');
 await draw(0,0,420,40);assert.equal(await page.locator('#export').isDisabled(),true);await page.locator('#comboId').fill('022');await page.locator('#comboId').press('Tab');assert.equal(await page.locator('#export').isDisabled(),false);
 const backup=await exportJson('#backup');assert.equal(backup.format,'pixel-zone-project');assert.ok(backup.images.some(i=>i.frames[1]?.[0]?.note==='DOB'));
 await page.waitForFunction(()=>document.getElementById('saveStatus').textContent==='Saved on this device');
 await page.screenshot({path:'.test-output/workspace.png',fullPage:true});
 const secondary=await context.newPage();await secondary.goto(origin);await secondary.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('Another tab'));await secondary.close();console.log('PASS secondary-tab protection against autosave overwrites.');
 const backupPath=path.resolve('.test-output/backup.json');await fs.writeFile(backupPath,JSON.stringify(backup));
 await page.locator('#workspaceMenu').evaluate(e=>e.open=true);await page.locator('#clearWorkspace').click();await page.waitForFunction(()=>document.querySelectorAll('#library button').length===0);
 await page.locator('#restoreBackup').setInputFiles(backupPath);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Backup restored'));
 assert.equal(await page.locator('#library button').count(),7);assert.match(await page.locator('#warning').textContent(),/Source file is missing/);
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
 const libraryRow=name=>page.locator('#library button').filter({hasText:name}).textContent();
 assert.match(await libraryRow('rgb.dcm'),/0 boxes · source needed/);
 await page.locator('#applyReuse').click();await page.waitForFunction(()=>!document.getElementById('reuseDialog').open);
 assert.match(await page.locator('#message').textContent(),/Copied 6 boxes into 6 frames across 6 files/);
 assert.match(await libraryRow('rgb.dcm'),/1 box · source needed/);
 assert.match(await libraryRow('combo16_1024x768'),/1 box · combo 16 · source needed/);
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
 assert.match(await page.locator('.library-empty').textContent(),/Nothing left in this view/);
 await page.locator('#libraryFilter').selectOption('needs-combo');
 assert.equal(await page.locator('#library button').count(),4);
 assert.match(await page.locator('#libraryCount').textContent(),/4 of 8/);
 // The button targets the library view, using the selected file's committed combo ID.
 assert.match(await page.locator('#applyComboToShown').textContent(),/Apply combo 33 to 4 shown files/);
 await page.locator('#library button').filter({hasText:'rgb.dcm'}).click();
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
 assert.match(await page.locator('.library-empty').textContent(),/Nothing left in this view/);
 assert.match(await options(),/Needs combo ID \(0\)/);
 await page.locator('#libraryFilter').selectOption('all');
 assert.match(await page.locator('#library button').filter({hasText:'rgb.dcm'}).textContent(),/1 box · combo 77 · source needed/);
 await page.locator('#search').fill('77');assert.equal(await page.locator('#library button').count(),4); // combo is searchable
 await page.locator('#search').fill('rle');assert.equal(await page.locator('#library button').count(),1);
 await page.locator('#search').fill('');
 // Previous/Next follow the view. "combo" matches files 1, 2 and 8 of the eight imported,
 // so stepping across it must skip the six hidden files in between.
 await page.locator('#search').fill('combo');
 assert.equal(await page.locator('#library button').count(),3);
 await page.locator('#library button').filter({hasText:'combo16_1024x768'}).click();
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
 assert.match(await page.locator('#counter').textContent(),/^3 of 8$/); // unfiltered counter is unchanged
 console.log('PASS Previous/Next, the arrow keys, and the counter all follow the library view.');
 assert.match(await page.locator('#libraryCount').textContent(),/8 files/);
 await open('combo33_640x480'); // leave a file with a live source selected
 console.log('PASS library filters with live counts, and one combo ID assigned across a filtered batch.');
 await page.setViewportSize({width:760,height:1000});await page.locator('#fit').click();await noOverflow('760px');await page.screenshot({path:'.test-output/narrow.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});await noOverflow('600px');await page.setViewportSize({width:1500,height:1100});

 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>!r.url.startsWith(origin)&&!r.url.startsWith('blob:')&&!r.url.startsWith('data:')),[]);assert.ok(requests.every(r=>r.method==='GET'));console.log('PASS explicit combo assignment, frame-preserving backup, no external requests or upload API calls.');
 // Persistence unavailable: importing, drawing, and backup must remain usable.
 const memory=await browser.newContext();await memory.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw Error('Storage disabled');}}));const m=await memory.newPage();m.on('dialog',d=>d.accept());await m.goto(origin);await m.waitForFunction(()=>!document.getElementById('files').disabled);assert.match(await m.locator('#saveStatus').textContent(),/Session only/);await m.locator('#files').setInputFiles(path.join(fixtureDir,'rle.dcm'));await m.waitForFunction(()=>document.getElementById('metadata').textContent.includes('native px'));await memory.close();console.log('PASS usable session-only fallback when IndexedDB is unavailable.');
 console.log('ALL BROWSER CHECKS PASSED');
}catch(error){console.error('Browser state:',await page.locator('#warning').textContent(),await page.locator('#message').textContent(),errors);await page.screenshot({path:'.test-output/failure.png',fullPage:true});throw error;}finally{await context.close();await browser.close();server.kill();}
