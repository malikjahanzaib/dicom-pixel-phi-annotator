
import { clamp, rectangleBetween, exportZone, parseFilename, buildPipelineExport, pipelineLayout, zoneKey, nudgeZone, cycleIndex, imageRecord, hydrate } from './coordinates.js';
import { openTagViewer } from './tag-viewer.js';
import { sourceZones, reuseTargets, planReuse, applyPlan, describePlan } from './reuse.js';
import { FILTERS, UNASSIGNED, boxCount, invalidateCount, filterLibrary, filterCounts, groupLibrary, libraryRows, navigation, planComboAssignment, describeComboAssignment } from './library.js';
import { inspectFile } from './import.js';
import { openDatabase, loadSession, loadFile, saveFile, saveSession, clearSession, removeFile } from './storage.js';
// Images stay in local File objects / IndexedDB. The local server serves app assets only.
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d'), viewport = $('viewport');
const state = { images: [], index: -1, selected: -1, bitmap: null, view: {scale:1,x:0,y:0}, mode:'draw', space:false, drag:null, loadToken:0, dirty:false, preview:false, previewLayout:null,
  collapsed:new Set(), rows:[], offsets:[0], window:null };
let cssWidth=1, cssHeight=1;
const current = () => state.images[state.index];
const selected = () => current()?.zones[state.selected];
const coordText = z => `x=${z.x}, y=${z.y}, w=${z.width}, h=${z.height}`;
// SINGLE inverse display transform. Pointer coordinates are CSS pixels, not backing-store
// pixels: DPR belongs exclusively to rendering. Every persisted zone is in native pixels.
function toNative(clientX,clientY,bounded=true) {
  const r=canvas.getBoundingClientRect(), v=state.view, im=current();
  const p={x:((clientX-r.left)*cssWidth/r.width-v.x)/v.scale, y:((clientY-r.top)*cssHeight/r.height-v.y)/v.scale};
  return bounded && im ? {x:clamp(p.x,0,im.width), y:clamp(p.y,0,im.height)} : p;
}
function buildExport() { return buildPipelineExport(state.images); }
function changed() { flushNudge(); state.dirty=true; rememberHistory(); persist(); $('exportStatus').textContent='Unexported changes.'; updateLibrary(); }
function updateSummary() {
  const groups=new Map(); let count=0,unassigned=0;
  for(const im of state.images){const n=boxCount(im);if(!n)continue;count+=n;if(!im.combo)unassigned+=n;
    const key=`${im.combo ? 'Combo '+im.combo : 'Unassigned'} · ${im.width}×${im.height}`;groups.set(key,(groups.get(key)||0)+n);}
  $('summary').replaceChildren();
  for(const [label,n] of groups){const row=document.createElement('div');row.className='summary-row';const span=document.createElement('span');span.textContent=label;const value=document.createElement('b');value.textContent=`${n} zone${n===1?'':'s'}`;row.append(span,value);$('summary').append(row);}
  if(!count)$('summary').textContent='No zones';
  $('total').textContent=`${count} zone${count===1?'':'s'}`; $('export').disabled=!count||unassigned>0;
  $('export').title=unassigned?'Assign combo IDs to all annotated files first.':'';
  if(unassigned)$('exportStatus').textContent=`${unassigned} zones without a combo ID · filter: Needs combo ID`;
  else if($('exportStatus').textContent.includes('without a combo ID'))$('exportStatus').textContent='Ready to export.';
  updateHistoryButtons();refreshPreview();updateToolHint();
}
function updateEditor() {
  updateToolHint();
  const z=selected(), im=current(); $('editor').hidden=!z;
  $('boxReadout').textContent=z?coordText(z):'—';
  if (!z) return;
  for (const k of ['x','y','width','height']) { $(k).value=z[k]; $(k).max=k==='x'?im.width-z.width:k==='y'?im.height-z.height:k==='width'?im.width-z.x:im.height-z.y; }
  if (document.activeElement!==$('note')) $('note').value=z.note;
}
function updateZones() {
  const zs=current()?.zones || []; $('zoneCount').textContent=String(zs.length);
  $('zones').replaceChildren();
  if (!zs.length) {const empty=document.createElement('div');empty.className='zone-empty';empty.textContent='No boxes on this frame';$('zones').append(empty);}
  zs.forEach((z,i)=>{
    const row=document.createElement('div');row.className='zone'+(i===state.selected?' selected':'');
    const choose=document.createElement('button');choose.className='choose';choose.setAttribute('aria-pressed',String(i===state.selected));
    const name=document.createElement('strong');name.textContent=`${i+1}. ${z.note || 'Untitled zone'}`;
    const coords=document.createElement('small');coords.textContent=coordText(z);choose.append(name,coords);
    choose.onclick=()=>{state.selected=i;updateZones();render();};
    const remove=document.createElement('button');remove.className='remove danger';remove.textContent='×';remove.setAttribute('aria-label',`Delete zone ${i+1}`);remove.onclick=()=>deleteZone(i);
    row.append(choose,remove);$('zones').append(row);
  });invalidateCount(current());updateEditor();updateSummary();updateReuseButtons();
}
function deleteZone(i=state.selected) {
  if (!current() || i<0 || !current().zones[i]) return;
  current().zones.splice(i,1);state.selected=-1;changed();updateZones();render();
}
function handles(z) { const x=z.x,y=z.y,r=x+z.width,b=y+z.height,mx=(x+r)/2,my=(y+b)/2;
  return [['nw',x,y],['n',mx,y],['ne',r,y],['e',r,my],['se',r,b],['s',mx,b],['sw',x,b],['w',x,my]];
}
function hitHandle(p) {
  const z=selected();if (!z) return null;const tolerance=7/state.view.scale;
  const candidates=handles(z).filter(h=>Math.abs(p.x-h[1])<=tolerance&&Math.abs(p.y-h[2])<=tolerance);
  candidates.sort((a,b)=>Math.hypot(p.x-a[1],p.y-a[2])-Math.hypot(p.x-b[1],p.y-b[2]));return candidates[0]?.[0] || null;
}
function hitZone(p) {const zs=current().zones;for(let i=zs.length-1;i>=0;i--){const z=zs[i];if(p.x>=z.x&&p.x<=z.x+z.width&&p.y>=z.y&&p.y<=z.y+z.height)return i;}return -1;}
function render() {
  const dpr=window.devicePixelRatio||1;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssWidth,cssHeight);
  if (!state.bitmap || !current()) return;
  const v=state.view, im=current();ctx.save();ctx.translate(v.x,v.y);ctx.scale(v.scale,v.scale);
  ctx.imageSmoothingEnabled=v.scale<1;ctx.drawImage(state.bitmap,0,0,im.width,im.height);
  ctx.beginPath();ctx.rect(0,0,im.width,im.height);ctx.clip();
  // Redaction preview replaces the editing overlay with what a redaction actually leaves
  // behind, so nothing translucent can be mistaken for covered pixels.
  if(state.preview){ctx.fillStyle='#000';for(const z of state.previewLayout?.zones||[])ctx.fillRect(z.x,z.y,z.width,z.height);}
  else if(!state.hideZones)im.zones.forEach((z,i)=>{
    const on=i===state.selected;
    ctx.fillStyle=on?'rgba(255,255,255,.13)':'rgba(214,171,63,.11)';ctx.fillRect(z.x,z.y,z.width,z.height);
    ctx.lineWidth=4/v.scale;ctx.strokeStyle='rgba(0,0,0,.78)';ctx.strokeRect(z.x,z.y,z.width,z.height);
    ctx.lineWidth=1.5/v.scale;ctx.strokeStyle=on?'#fff':'#d6ab3f';ctx.strokeRect(z.x,z.y,z.width,z.height);
  });
  ctx.restore();
  const z=selected();if(z&&!state.hideZones&&!state.preview){
    ctx.fillStyle='#fff';ctx.strokeStyle='rgba(0,0,0,.75)';ctx.lineWidth=1;
    for(const [,x,y] of handles(z)){const px=Math.round(v.x+x*v.scale)-3.5,py=Math.round(v.y+y*v.scale)-3.5;ctx.fillRect(px,py,7,7);ctx.strokeRect(px,py,7,7);}}
  $('zoomValue').textContent=`${Math.round(v.scale*100)}%`;
}
function fit() {const im=current();if(!state.bitmap||!im)return;const scale=Math.max(.01,Math.min((cssWidth-36)/im.width,(cssHeight-36)/im.height));state.view={scale,x:(cssWidth-im.width*scale)/2,y:(cssHeight-im.height*scale)/2};render();}
function zoom(factor,cx=cssWidth/2,cy=cssHeight/2,absolute=false) {
  if (!state.bitmap || state.drag) return;const v=state.view, scale=clamp(absolute?factor:v.scale*factor,.01,32);
  const nx=(cx-v.x)/v.scale,ny=(cy-v.y)/v.scale;
  state.view={scale,x:cx-nx*scale,y:cy-ny*scale};render();
}
new ResizeObserver(()=>{const r=viewport.getBoundingClientRect(),oldW=cssWidth,oldH=cssHeight;cssWidth=r.width;cssHeight=r.height;const dpr=window.devicePixelRatio||1;canvas.width=Math.round(cssWidth*dpr);canvas.height=Math.round(cssHeight*dpr);state.view.x+=(cssWidth-oldW)/2;state.view.y+=(cssHeight-oldH)/2;render();}).observe(viewport);
async function showImage(index, frame, preserveView=false) {
  if(index<0||index>=state.images.length)return; cancelDrag();flushNudge();
  const token=++state.loadToken;state.index=index;state.selected=-1;state.bitmap?.close?.();state.bitmap=null;state.decoded=null;
  const im=current();if(frame!==undefined)im.frameIndex=clamp(frame,0,im.frameCount-1);
  ensureHistory();$('filename').textContent=im.name;$('metadata').textContent=`${im.kind} · Loading…`;
  $('warning').hidden=true;$('cursorReadout').textContent='—';$('empty').hidden=true;
  $('loading').hidden=false;$('loading').textContent=`Decoding ${im.kind}${im.frameCount>1?' · frame '+(im.frameIndex+1):''}…`;
  updateLibrary();updateZones();updateImageControls();render();
  try {
    if(!im.file)throw new Error('Source file is missing. Reopen the same file to reconnect its saved annotations.');
    if(im.kind==='DICOM'){
      const {decodeDicom,renderDicom}=await import('./dicom.js');
      const decoded=await decodeDicom(im.file,im.frameIndex);if(token!==state.loadToken)return;
      if(decoded.width!==im.width||decoded.height!==im.height)throw new Error('Decoded dimensions differ from DICOM Rows/Columns. Annotation is blocked to protect coordinates.');
      const bitmap=await renderDicom(decoded,im.display);if(token!==state.loadToken)return;
      state.decoded=decoded;state.bitmap=bitmap;
    }else{
      const bitmap=await createImageBitmap(im.file);if(token!==state.loadToken){bitmap.close();return;}if(bitmap.width!==im.width||bitmap.height!==im.height){bitmap.close();throw new Error('Saved dimensions differ from the source PNG. Annotation is blocked.');}state.bitmap=bitmap;
    }
    if(im.filenameWidth&&(im.width!==im.filenameWidth||im.height!==im.filenameHeight)){
      $('warning').textContent=`Filename says ${im.filenameWidth}×${im.filenameHeight}; actual source is ${im.width}×${im.height}. Coordinates use the actual size.`;$('warning').hidden=false;
    }
    $('metadata').textContent=`${im.kind} · ${im.width} × ${im.height} native px`;
    if(!preserveView)fit();else render();updateImageControls();updateZones();persist();
  }catch(error){if(token===state.loadToken){state.bitmap=null;state.decoded=null;$('warning').textContent=`Unable to open image: ${error.message || error.error?.message || 'This DICOM encoding is unsupported or the file is damaged.'}`;$('warning').hidden=false;$('metadata').textContent=`${im.kind} · Image unavailable`;}}
  finally {if(token===state.loadToken){$('loading').hidden=true;updateImageControls();}}
}
let importing=false;
async function addFiles(files) {
  if(importing){$('message').textContent='An import is already in progress.';return;} importing=true;
  let added=0,reconnected=0,duplicates=0;const failures=[];
  try {
    for(const [i,file] of files.entries()){
      if(file.name.startsWith('.')||file.name==='DICOMDIR')continue;
      $('message').textContent=`Reading ${i+1} of ${files.length}: ${file.name}`;
      try {
        const im=await inspectFile(file),existing=state.images.find(x=>x.id===im.id);
        if(existing){if(!existing.file){existing.file=file;reconnected++;}else duplicates++;}else{state.images.push(im);added++;}
        if(db){try{await saveFile(db,im.id,file);}catch{storageFailed('Image not saved · download a backup');}}
      }catch(error){failures.push(`${file.name}: ${error.message}`);}
    }
    $('message').textContent=`${added} added${reconnected?' · '+reconnected+' reconnected':''}${duplicates?' · '+duplicates+' duplicates skipped':''}${failures.length?'\n'+failures.join('\n'):''}`;
    if(state.index<0&&state.images.length)await showImage(0);else if(reconnected&&current()?.file)await showImage(state.index);else updateLibrary();
    persist();
  }finally{importing=false;}
}
for (const id of ['files','folder']) $(id).addEventListener('change',async e=>{await addFiles(Array.from(e.target.files));e.target.value='';});
async function readEntry(entry) {
  if(entry.isFile)return [await new Promise((resolve,reject)=>entry.file(resolve,reject))];
  if(!entry.isDirectory)return [];const reader=entry.createReader(),files=[];
  while(true){const entries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const child of entries)files.push(...await readEntry(child));}return files;
}
document.addEventListener('dragover',e=>{e.preventDefault();viewport.classList.add('dragover');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)viewport.classList.remove('dragover');});
document.addEventListener('drop',async e=>{
  e.preventDefault();viewport.classList.remove('dragover');
  const fallback=Array.from(e.dataTransfer.files),entries=Array.from(e.dataTransfer.items||[]).map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
  try {const files=[];if(entries.length){for(const entry of entries)files.push(...await readEntry(entry));}else files.push(...fallback);await addFiles(files);}catch(err){$('message').textContent='Could not read the dropped folder. Use Open folder or Open PNGs instead.';}
});
function finishDrag() {const d=state.drag;if(!d)return;state.drag=null;
  if(d.type==='draw'){const z=selected();if(!z||!z.width||!z.height){current().zones.splice(state.selected,1);state.selected=-1;}else changed();}
  if(d.type==='window')persist();
  if((d.type==='move'||d.type==='resize')&&JSON.stringify(selected())!==JSON.stringify(d.original))changed();
  if(canvas.hasPointerCapture(d.pointerId))canvas.releasePointerCapture(d.pointerId);updateZones();render();
}
function cancelDrag() {const d=state.drag;if(!d)return;state.drag=null;
  if(d.type==='draw'){current().zones.splice(state.selected,1);state.selected=-1;}
  else if(d.original)current().zones[state.selected]=d.original;
  else if(d.view)state.view=d.view;
  else if(d.type==='window'){current().display=d.display;refreshDicom();}
  if(canvas.hasPointerCapture(d.pointerId))canvas.releasePointerCapture(d.pointerId);updateZones();render();
}
canvas.addEventListener('pointerdown',e=>{
  if(!state.bitmap||state.drag||![0,1].includes(e.button))return;
  if((state.hideZones||state.preview)&&state.mode==='draw'&&!state.space&&e.button===0)return;e.preventDefault();canvas.focus();
  const p=toNative(e.clientX,e.clientY),raw=toNative(e.clientX,e.clientY,false),im=current();
  ensureHistory();
  const common={pointerId:e.pointerId,start:p,clientX:e.clientX,clientY:e.clientY};
  if(state.mode==='window'&&state.decoded&&!state.decoded.color&&!state.space&&e.button===0)state.drag={...common,type:'window',display:{...im.display},ww:Number($('windowWidth').value),wc:Number($('windowCenter').value)};
  else if(state.mode==='pan'||state.space||e.button===1)state.drag={...common,type:'pan',view:{...state.view}};
  else {
    const blind=e.shiftKey||state.hideZones||state.preview;
    const handle=blind?null:hitHandle(raw),hit=blind?-1:hitZone(raw);
    if(handle)state.drag={...common,type:'resize',handle,original:{...selected()}};
    else if(hit>=0){state.selected=hit;state.drag={...common,type:'move',original:{...selected()}};}
    else {state.selected=-1;if(raw.x<0||raw.x>im.width||raw.y<0||raw.y>im.height){updateZones();render();return;}
      im.zones.push({x:Math.round(p.x),y:Math.round(p.y),width:0,height:0,note:''});state.selected=im.zones.length-1;state.drag={...common,type:'draw'};}
  }
  canvas.setPointerCapture(e.pointerId);updateZones();render();
});
canvas.addEventListener('pointermove',e=>{
  if(!state.bitmap)return;const raw=toNative(e.clientX,e.clientY,false),p=toNative(e.clientX,e.clientY),im=current(),d=state.drag;
  $('cursorReadout').textContent=raw.x<0||raw.y<0||raw.x>im.width||raw.y>im.height?'outside image':`x=${Math.round(p.x)}, y=${Math.round(p.y)}`;
  if(!d){const grab=state.mode==='pan'||state.space,h=grab||state.preview?null:hitHandle(raw);
    canvas.style.cursor=grab?'grab':state.preview?'default':h?({nw:'nwse',se:'nwse',ne:'nesw',sw:'nesw',n:'ns',s:'ns',e:'ew',w:'ew'}[h]+'-resize'):hitZone(raw)>=0?'move':'crosshair';return;}
  if(e.pointerId!==d.pointerId)return;
  if(d.type==='window'){im.display.windowWidth=Math.max(1,d.ww+(e.clientX-d.clientX)*Math.max(1,d.ww/250));im.display.windowCenter=d.wc+(e.clientY-d.clientY)*Math.max(1,d.ww/250);refreshDicom();return;}
  if(d.type==='pan'){state.view.x=d.view.x+e.clientX-d.clientX;state.view.y=d.view.y+e.clientY-d.clientY;canvas.style.cursor='grabbing';}
  else if(d.type==='draw')Object.assign(selected(),rectangleBetween(d.start,p,im));
  else if(d.type==='move'){const z=selected(),o=d.original;z.x=clamp(o.x+Math.round(p.x-d.start.x),0,im.width-o.width);z.y=clamp(o.y+Math.round(p.y-d.start.y),0,im.height-o.height);}
  else if(d.type==='resize'){
    const o=d.original,h=d.handle;let l=o.x,t=o.y,r=o.x+o.width,b=o.y+o.height;
    if(h.includes('w'))l=clamp(Math.round(p.x),0,r-1);if(h.includes('e'))r=clamp(Math.round(p.x),l+1,im.width);
    if(h.includes('n'))t=clamp(Math.round(p.y),0,b-1);if(h.includes('s'))b=clamp(Math.round(p.y),t+1,im.height);
    Object.assign(selected(),{x:l,y:t,width:r-l,height:b-t});
  }
  if(d.type!=='pan'){updateEditor();const row=$('zones').children[state.selected];if(row)row.querySelector('small').textContent=coordText(selected());}render();
});
canvas.addEventListener('pointerup',e=>{if(state.drag?.pointerId===e.pointerId)finishDrag();});
canvas.addEventListener('pointercancel',cancelDrag);canvas.addEventListener('lostpointercapture',cancelDrag);
canvas.addEventListener('pointerleave',()=>{if(!state.drag)$('cursorReadout').textContent='—';});
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top);},{passive:false});
function setMode(mode){state.mode=mode;updateToolHint();$('drawMode').setAttribute('aria-pressed',String(mode==='draw'));$('panMode').setAttribute('aria-pressed',String(mode==='pan'));$('windowMode').setAttribute('aria-pressed',String(mode==='window'));canvas.style.cursor=mode==='pan'?'grab':'crosshair';}
$('drawMode').onclick=()=>setMode('draw');$('panMode').onclick=()=>setMode('pan');
$('zoomIn').onclick=()=>zoom(1.25);$('zoomOut').onclick=()=>zoom(.8);$('fit').onclick=fit;$('actual').onclick=()=>zoom(1,cssWidth/2,cssHeight/2,true);
$('previous').onclick=()=>goRelative(-1);$('next').onclick=()=>goRelative(1);$('imageSelect').onchange=e=>showImage(Number(e.target.value));
$('deleteSelected').onclick=()=>deleteZone();
for (const k of ['x','y','width','height']) $(k).addEventListener('change',()=>{
  const z=selected(),im=current();if(!z)return;const value=$(k).valueAsNumber;
  if(!Number.isFinite(value)){updateEditor();return;}
  z[k]=clamp(Math.round(value),k==='width'||k==='height'?1:0,k==='x'?im.width-z.width:k==='y'?im.height-z.height:k==='width'?im.width-z.x:im.height-z.y);
  changed();updateZones();render();
});
$('note').addEventListener('input',()=>{if(!selected())return;selected().note=$('note').value;
  flushNudge();state.dirty=true;rememberHistory();persist();$('exportStatus').textContent='Unexported changes.';updateZones();});
document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]'))return; // Modal search/navigation must never edit the image behind it.
  if(e.target.closest('input,textarea,select,[contenteditable="true"]'))return;
  if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();if(!state.drag)deleteZone();}
  if(e.key==='Escape'){e.preventDefault();
    if(state.drag)cancelDrag();
    else if(state.selected>=0){state.selected=-1;updateZones();render();}
    else if(document.activeElement===canvas)canvas.blur();}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();travelHistory(e.shiftKey?1:-1);return;}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.code==='Space'){e.preventDefault();state.space=true;canvas.style.cursor='grab';}
  if(state.drag)return;
  const arrow={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
  if(arrow){e.preventDefault();
    if(selected()&&!state.preview&&!state.hideZones)nudge(arrow[0]*(e.shiftKey?10:1),arrow[1]*(e.shiftKey?10:1));
    else if(arrow[0])goRelative(arrow[0]);
    return;}
  // Tab is only taken while the canvas itself holds focus, so the rest of the page tabs normally.
  if(e.key==='Tab'&&document.activeElement===canvas&&!state.preview&&!state.hideZones&&current()?.zones.length){e.preventDefault();cycleSelection(e.shiftKey?-1:1);return;}
  if(e.key.toLowerCase()==='d')setMode('draw');if(e.key.toLowerCase()==='p')setMode('pan');
  if(e.key.toLowerCase()==='c'){e.preventDefault();copyPreviousFrame();}
  if(e.key.toLowerCase()==='r'){e.preventDefault();togglePreview();}
  if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.25);}if(e.key==='-'){e.preventDefault();zoom(.8);}
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){state.space=false;canvas.style.cursor=state.mode==='pan'?'grab':'crosshair';}});
window.addEventListener('blur',()=>{state.space=false;cancelDrag();});
$('export').onclick=()=>{
  try{
  if(state.drag)finishDrag();const payload=buildExport();
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='annotations.json';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);$('exportStatus').textContent='Exported.';}catch(error){$('exportStatus').textContent=error.message;}
};
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});

// Persistent workspace: only metadata is rewritten after an edit; original files are stored once.
let ownsWorkspace=true;
let db=null, saving=Promise.resolve(), revision=0, saveTimer, ready=false, persistenceFailed=false;
function storageFailed(message){persistenceFailed=true;$('saveStatus').textContent=message || 'Not saving · download a backup';state.dirty=true;}
function persist(){
  if(!ready)return;
  state.dirty=true;const rev=++revision;clearTimeout(saveTimer);
  if(!db){storageFailed(ownsWorkspace?'Not saving · storage unavailable':'Not saving · another tab is open');return;}
  $('saveStatus').textContent='Saving…';
  saveTimer=setTimeout(()=>{
    const snapshot=structuredClone({version:1,images:state.images.map(imageRecord),activeId:current()?.id,collapsed:[...state.collapsed]});
    saving=saving.then(()=>saveSession(db,snapshot)).then(()=>{
      if(rev===revision&&!persistenceFailed){state.dirty=false;$('saveStatus').textContent='Saved locally';}
    }).catch(()=>storageFailed('Save failed · download a backup'));
  },180);
}
// History is per file and per frame. Box reuse writes frames other than the open one,
// so both helpers take an explicit target rather than assuming the current frame.
function ensureHistory(im=current(),frame=im?.frameIndex){if(!im)return; if(!im.history.has(frame)) im.history.set(frame,{snapshots:[structuredClone(im.frames[frame]||[])],index:0});}
function rememberHistory(im=current(),frame=im?.frameIndex){
  if(!im)return;ensureHistory(im,frame);const h=im.history.get(frame),snapshot=structuredClone(im.frames[frame]||[]);
  if(JSON.stringify(snapshot)===JSON.stringify(h.snapshots[h.index]))return;
  h.snapshots.splice(h.index+1);h.snapshots.push(snapshot);if(h.snapshots.length>100)h.snapshots.shift();h.index=h.snapshots.length-1;updateHistoryButtons();
}
let nudgeTimer=null,nudgePending=null;
function flushNudge(){
  if(!nudgePending)return;
  clearTimeout(nudgeTimer);nudgeTimer=null;
  const {image,frame}=nudgePending;nudgePending=null;rememberHistory(image,frame);
}
function nudge(dx,dy){
  const z=selected(),im=current();if(!z||!im)return;
  const moved=nudgeZone(z,dx,dy,im);
  if(moved.x===z.x&&moved.y===z.y)return; // already against the edge: no edit, no history entry
  ensureHistory();z.x=moved.x;z.y=moved.y;
  nudgePending={image:im,frame:im.frameIndex};
  clearTimeout(nudgeTimer);nudgeTimer=setTimeout(flushNudge,350);
  state.dirty=true;persist();$('exportStatus').textContent='Unexported changes.';
  // Patch the one row that changed rather than rebuilding the list on every keypress.
  updateEditor();const row=$('zones').children[state.selected];if(row)row.querySelector('small').textContent=coordText(z);
  refreshPreview();render();
}
function cycleSelection(direction){
  const zones=current()?.zones;if(!zones?.length)return;
  state.selected=cycleIndex(state.selected,zones.length,direction);
  updateZones();revealSelection();render();
  $('zones').children[state.selected]?.scrollIntoView({block:'nearest'});
}
// Cycling is useless when zoomed into a corner, so pan to a box that is off-screen.
function revealSelection(){
  const z=selected();if(!z||!state.bitmap)return;const v=state.view;
  const cx=v.x+(z.x+z.width/2)*v.scale,cy=v.y+(z.y+z.height/2)*v.scale;
  if(cx>=0&&cx<=cssWidth&&cy>=0&&cy<=cssHeight)return;
  state.view={...v,x:v.x+cssWidth/2-cx,y:v.y+cssHeight/2-cy};
}
function updateHistoryButtons(){const h=current()?.history.get(current().frameIndex);$('undo').disabled=!h||h.index===0;$('redo').disabled=!h||h.index===h.snapshots.length-1;}
function travelHistory(direction){if(state.drag)return;flushNudge();const im=current(),h=im?.history.get(im.frameIndex);if(!h)return;const index=h.index+direction;if(index<0||index>=h.snapshots.length)return;h.index=index;im.zones=structuredClone(h.snapshots[index]);state.selected=-1;persist();updateZones();updateLibrary();render();}
const shownFiles=()=>libraryEntries();
// Row geometry is fixed so the window can be found by arithmetic instead of measurement.
// These must match the heights in style.css exactly.
const ROW_H={group:52,size:22,file:44},OVERSCAN=6,VIRTUALIZE_ABOVE=60;
function libraryEntries(){
  const flat=[];
  for(const row of state.rows) if(row.type==='file') flat.push(row.entry);
  return flat;
}
function buildLibraryModel(){
  const entries=filterLibrary(state.images,$('search').value,$('libraryFilter').value);
  const groups=groupLibrary(entries);
  state.groups=groups;
  state.rows=libraryRows(groups,state.collapsed);
  const offsets=[0];let y=0;
  for(const row of state.rows){y+=ROW_H[row.type];offsets.push(y);}
  state.offsets=offsets;
  return groups;
}
function visibleRange(){
  const host=$('library'),rows=state.rows,offsets=state.offsets;
  if(rows.length<=VIRTUALIZE_ABOVE)return [0,rows.length];
  const top=host.scrollTop,bottom=top+host.clientHeight;
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(offsets[mid+1]<=top)lo=mid+1;else hi=mid;}
  let end=lo;while(end<rows.length&&offsets[end]<bottom)end++;
  return [Math.max(0,lo-OVERSCAN),Math.min(rows.length,end+OVERSCAN)];
}
function groupHeader(group){
  const head=document.createElement('button');
  head.className='lib-group'+(state.collapsed.has(group.key)?' collapsed':'');
  head.setAttribute('aria-expanded',String(!state.collapsed.has(group.key)));
  const title=document.createElement('span');title.className='lib-group-title';
  const name=document.createElement('strong');name.textContent=group.key===UNASSIGNED?'Unassigned':`Combo ${group.combo}`;
  title.append(name);
  if(group.needsCombo){const badge=document.createElement('em');badge.className='badge';badge.textContent='needs combo ID';title.append(badge);}
  // Progress sits on the title row: it is the number the operator scans for, and the
  // size list below is long enough to push it out of sight if they share a line.
  const progress=document.createElement('span');progress.className='lib-progress';
  progress.textContent=`${group.annotated}/${group.total}`;
  progress.title=`${group.annotated} of ${group.total} files have zones`;
  title.append(progress);
  const meta=document.createElement('span');meta.className='lib-group-meta';
  meta.textContent=`${group.total} file${group.total===1?'':'s'} · ${group.sizes.map(s=>s.size).join(', ')}`;
  head.append(title,meta);
  head.onclick=()=>{
    if(state.collapsed.has(group.key))state.collapsed.delete(group.key);else state.collapsed.add(group.key);
    persist();updateLibrary();
  };
  return head;
}
function sizeHeader(bucket){
  const row=document.createElement('div');row.className='lib-size';
  const label=document.createElement('span');label.textContent=bucket.size;
  const count=document.createElement('span');count.textContent=`${bucket.files.length} file${bucket.files.length===1?'':'s'}`;
  row.append(label,count);return row;
}
function fileRow(entry){
  const {image:im,index}=entry;
  const button=document.createElement('button');button.className='library-item'+(index===state.index?' active':'');
  button.setAttribute('aria-current',String(index===state.index));button.title=im.path||im.name;
  const badge=document.createElement('span');badge.className='file-type';badge.textContent=im.kind==='DICOM'?'DCM':'PNG';badge.setAttribute('aria-hidden','true');
  const info=document.createElement('span');info.className='file-info';
  const title=document.createElement('strong');title.textContent=im.name;
  const detail=document.createElement('small');detail.dataset.row=String(index);detail.textContent=rowDetail(im);
  info.append(title,detail);button.append(badge,info);button.onclick=()=>showImage(index);
  return button;
}
// Combo lives in the group header now, so repeating it on every row is noise.
const rowDetail=im=>{const n=boxCount(im);return `${im.width}\u00d7${im.height}${im.frameCount>1?` · ${im.frameCount} frames`:''} · ${n} box${n===1?'':'es'}${im.file?'':' · source needed'}`;};
function renderLibraryWindow(){
  const host=$('library'),rows=state.rows;
  const [from,to]=visibleRange();
  const key=`${from}:${to}:${rows.length}`;
  if(state.window===key)return;
  state.window=key;
  const canvas=document.createElement('div');canvas.className='lib-canvas';
  canvas.style.height=`${state.offsets[rows.length]}px`;
  const pane=document.createElement('div');pane.className='lib-pane';
  pane.style.transform=`translateY(${state.offsets[from]}px)`;
  for(let i=from;i<to;i++){
    const row=rows[i];
    pane.append(row.type==='group'?groupHeader(row.group):row.type==='size'?sizeHeader(row.bucket):fileRow(row.entry));
  }
  canvas.append(pane);host.replaceChildren(canvas);
}
function updateLibrary(){
  const query=$('search').value.trim(),filter=$('libraryFilter').value,total=state.images.length;
  const groups=buildLibraryModel(),shown=libraryEntries();
  $('libraryCount').textContent=shown.length===total?`${total} file${total===1?'':'s'}`:`${shown.length} of ${total}`;
  const counts=filterCounts(state.images),labels={all:'All files',unannotated:'No boxes',annotated:'Annotated','needs-combo':'Needs combo ID','source-needed':'Source needed'};
  for(const key of FILTERS)$('libraryFilter').querySelector(`option[value="${key}"]`).textContent=`${labels[key]} (${counts[key]})`;
  $('comboJump').replaceChildren(...[{v:'',t:groups.length?'Jump to combo…':'No combos'},
    ...groups.map(g=>({v:g.key,t:`${g.key===UNASSIGNED?'Unassigned':'Combo '+g.combo} · ${g.total}`}))]
    .map(o=>{const option=document.createElement('option');option.value=o.v;option.textContent=o.t;return option;}));
  $('comboJump').disabled=!groups.length;$('comboJump').value='';
  state.window=null;renderLibraryWindow();
  if(!shown.length){const empty=document.createElement('div');empty.className='library-empty';empty.innerHTML='<strong></strong><span></span>';
    const [heading,detail]=!total?['No files','Open files or a folder.']
      :query?['No matches','Try another name, path, or combo ID.']
      :['Nothing in this view','No files match this filter.'];
    empty.querySelector('strong').textContent=heading;empty.querySelector('span').textContent=detail;$('library').replaceChildren(empty);}
  const combo=current()?.combo||'';
  $('applyComboToShown').hidden=total<2;$('applyComboToShown').disabled=!shown.length||!combo;
  $('applyComboToShown').textContent=combo?`Apply combo ${combo} to ${shown.length===total?`all ${total} files`:`${shown.length} shown file${shown.length===1?'':'s'}`}`:'Apply combo ID to shown files';
  $('applyComboToShown').title=combo?`Give every file in the current library view combo ${combo}.`:'Give the selected file a combo ID first, then apply it across the view.';
  $('imageSelect').replaceChildren(...shown.map(({image,index})=>{const option=document.createElement('option');option.value=index;option.textContent=image.path;return option;}));
  $('imageSelect').disabled=!shown.length;$('imageSelect').value=state.index;
  const nav=navigation(shown,state.index);
  $('counter').textContent=`${nav.position??'\u2014'} of ${nav.total}`;
  $('counter').title=nav.position?'':'The open file is not in this library view.';
  $('previous').disabled=nav.previous===null;$('next').disabled=nav.next===null;
}
function goRelative(direction){
  const nav=navigation(shownFiles(),state.index),target=direction<0?nav.previous:nav.next;
  if(target!==null)showImage(target);
}
$('library').addEventListener('scroll',()=>{if(state.rows.length>VIRTUALIZE_ABOVE)renderLibraryWindow();},{passive:true});
$('comboJump').onchange=()=>{
  const key=$('comboJump').value;if(!key)return;
  state.collapsed.delete(key);updateLibrary();
  const index=state.rows.findIndex(row=>row.type==='group'&&row.group.key===key);
  if(index>=0)$('library').scrollTop=state.offsets[index];
  renderLibraryWindow();$('comboJump').value='';
};
// Fidelity rule: the canvas shows only the redaction result, so the accounting for where
// those zones came from belongs in text rather than in markers drawn over the pixels.
function previewHint(){
  const im=current(),layout=state.previewLayout;
  if(!im||!layout)return 'Redaction preview.';
  const n=layout.zones.length;
  if(layout.scope==='frame')return n?`Redaction preview · this frame\u2019s ${n} box${n===1?'':'es'} · assign a combo ID to preview the whole pipeline layout.`:'Redaction preview · no boxes on this frame yet.';
  const group=`combo ${im.combo} at ${im.width} \u00d7 ${im.height}`;
  if(!n)return `Redaction preview · no zones yet for ${group}.`;
  return `Redaction preview · ${n} pipeline zone${n===1?'':'s'} for ${group}${layout.extra?` \u00b7 ${layout.extra} from other frames or files`:''}.`;
}
function computePreview(){
  const im=current();if(!im)return null;
  const own=sourceZones(im,im.frameIndex),union=pipelineLayout(state.images,im.combo,im.width,im.height);
  if(!union)return {zones:own,scope:'frame',extra:0};
  const mine=new Set(own.map(zoneKey));
  return {zones:union,scope:'union',extra:union.reduce((n,z)=>n+(mine.has(zoneKey(z))?0:1),0)};
}
function refreshPreview(){state.previewLayout=state.preview?computePreview():null;}
function togglePreview(){
  if(!state.bitmap)return;
  state.preview=!state.preview;$('preview').setAttribute('aria-pressed',String(state.preview));
  refreshPreview();updateImageControls();render();
}
$('preview').onclick=togglePreview;
function updateToolHint(){
  $('toolHint').textContent=!state.bitmap?'Open an image to begin.':state.preview?previewHint():state.mode==='pan'?'Drag to pan.':state.mode==='window'?'Drag ↔ for contrast, ↕ for brightness.':state.hideZones?'Boxes hidden.':selected()?'Drag to move or resize · arrows nudge 1 px, Shift 10 px · Tab for next box':'Drag to draw · Shift-drag to overlap · arrows move between files';
}
function updateImageControls(){
  const im=current(),decoded=state.decoded,gray=!!decoded&&!decoded.color;
  $('viewTitle').textContent=im?.name||'No file';$('viewSubtitle').textContent=im?`${im.kind} · ${im.width}×${im.height} · ${im.combo?'combo '+im.combo:'no combo'}`:'';
  $('comboId').disabled=!im;$('comboId').value=im?.combo||'';$('removeImage').disabled=!im;
  $('frameLabel').textContent=im?`${im.frameIndex+1} / ${im.frameCount}`:'—';
  $('frameSlider').max=im?im.frameCount-1:0;$('frameSlider').value=im?.frameIndex||0;$('frameSlider').disabled=!im||im.frameCount===1;
  $('framePrevious').disabled=!im||im.frameIndex===0;$('frameNext').disabled=!im||im.frameIndex===im.frameCount-1;
  for(const id of ['windowWidth','windowCenter','windowMode'])$(id).disabled=!gray;
  $('windowWidth').value=gray?Math.round(im.display.windowWidth??decoded.windowWidth):'';$('windowCenter').value=gray?Math.round(im.display.windowCenter??decoded.windowCenter):'';
  $('invert').disabled=!decoded;$('resetDisplay').disabled=!decoded;$('invert').setAttribute('aria-pressed',String(!!im?.display.invert));
  $('openTags').disabled=im?.kind!=='DICOM'||!im?.file;
  for(const id of ['drawMode','panMode','zoomIn','zoomOut','fit','actual','hideZones','preview'])$(id).disabled=!state.bitmap;
  $('hideZones').disabled=!state.bitmap||state.preview; // the preview already stands in for it
  if(!gray&&state.mode==='window')setMode('draw');
  updateReuseButtons();updateToolHint();
}
let displayRevision=0;
async function refreshDicom(){
  if(!state.decoded)return;const token=state.loadToken,rev=++displayRevision,decoded=state.decoded,im=current();
  try{const {renderDicom}=await import('./dicom.js');const bitmap=await renderDicom(decoded,im.display);if(token!==state.loadToken||rev!==displayRevision)return;state.bitmap=bitmap;updateImageControls();render();}
  catch{$('warning').textContent='Could not apply display settings. Reset display to recover.';$('warning').hidden=false;}
}
$('openTags').onclick=()=>{if(current()?.file){cancelDrag();openTagViewer(current());}};
$('emptyOpen').onclick=()=>$('files').click();
document.addEventListener('click',e=>{if(!$('workspaceMenu').contains(e.target))$('workspaceMenu').open=false;});
$('windowMode').onclick=()=>setMode('window');
$('undo').onclick=()=>travelHistory(-1);$('redo').onclick=()=>travelHistory(1);
$('search').oninput=updateLibrary;
function comboInput(){
  const value=$('comboId').value.trim();
  if(value&&!/^\d+$/.test(value)){$('comboId').setCustomValidity('Use a numeric combo ID, e.g. 16.');$('comboId').reportValidity();return null;}
  $('comboId').setCustomValidity('');return value;
}
function comboChanged(){persist();updateImageControls();updateLibrary();updateSummary();render();}
$('comboId').onchange=()=>{const value=comboInput();if(value===null||!current())return;current().combo=value;comboChanged();};
$('libraryFilter').onchange=updateLibrary;
$('applyComboToShown').onclick=()=>{
  const combo=current()?.combo||'';if(!combo)return;
  const shown=shownFiles().map(entry=>entry.image),plan=planComboAssignment(shown,combo);
  if(!plan.changed){$('message').textContent=`All ${shown.length} shown file${shown.length===1?'':'s'} already use combo ${combo}.`;return;}
  if(!confirm(describeComboAssignment(plan,combo)))return;
  for(const image of [...plan.assigned,...plan.overwritten])image.combo=combo;
  comboChanged();
  $('message').textContent=`${plan.changed} file${plan.changed===1?'':'s'} set to combo ${combo}${plan.overwritten.length?` · ${plan.overwritten.length} previous ID${plan.overwritten.length===1?'':'s'} replaced`:''}.`;
};
$('comboId').oninput=()=>$('comboId').setCustomValidity('');
for(const key of ['windowWidth','windowCenter'])$(key).onchange=()=>{const value=$(key).valueAsNumber;if(!Number.isFinite(value)||key==='windowWidth'&&value<1){updateImageControls();return;}current().display[key]=value;refreshDicom();persist();};
$('invert').onclick=()=>{current().display.invert=!current().display.invert;refreshDicom();persist();};
$('resetDisplay').onclick=()=>{current().display={};refreshDicom();persist();};
$('framePrevious').onclick=()=>showImage(state.index,current().frameIndex-1,true);
$('frameNext').onclick=()=>showImage(state.index,current().frameIndex+1,true);
$('frameSlider').onchange=()=>showImage(state.index,Number($('frameSlider').value),true);
$('hideZones').onclick=()=>{state.hideZones=!state.hideZones;$('hideZones').setAttribute('aria-pressed',String(state.hideZones));$('hideZones').textContent=state.hideZones?'Show':'Hide';updateToolHint();render();};
// Copying boxes between frames and between same-size files. Planning is pure, so the
// dialog can price the operation before anything is written; each destination frame
// receives its own history entry and stays independently undoable.
const reuseScope=()=>document.querySelector('input[name=reuseScope]:checked').value;
const reuseMode=()=>document.querySelector('input[name=reuseMode]:checked').value;
function reusePlanFor(){
  const im=current();if(!im)return null;const zones=sourceZones(im,im.frameIndex);
  const targets=reuseTargets({image:im,images:state.images,scope:reuseScope(),sameCombo:$('reuseSameCombo').checked});
  return {zones,plan:planReuse(zones,targets,reuseMode())};
}
function commitReuse(plan,zoneCount){
  applyPlan(plan,(image,frame)=>ensureHistory(image,frame));
  for(const {image} of plan.frames)invalidateCount(image);
  for(const {image,frameIndex} of plan.frames)rememberHistory(image,frameIndex);
  const im=current();
  if(im&&plan.frames.some(f=>f.image.id===im.id&&f.frameIndex===im.frameIndex))state.selected=-1;
  state.dirty=true;persist();updateZones();updateLibrary();render();
  $('message').textContent=`Copied ${describePlan(plan,zoneCount)}.`;
}
function updateReuseButtons(){
  const im=current(),open=im?sourceZones(im,im.frameIndex).length:0;
  $('openReuse').disabled=!open;
  $('openReuse').title=open?`Copy ${open} box${open===1?'':'es'} to other frames or same-size files`:'Draw a box on this frame first.';
  const previous=im&&im.frameIndex>0?sourceZones(im,im.frameIndex-1).length:0;
  $('copyPreviousFrame').disabled=!previous;
  $('copyPreviousFrame').title=!im?'Open an image first.':im.frameIndex===0?'This is the first frame.':previous?`Copy ${previous} box${previous===1?'':'es'} from frame ${im.frameIndex} (C)`:`Frame ${im.frameIndex} has no boxes to copy.`;
}
function updateReuseDialog(){
  const im=current();if(!im)return;
  for(const [scope,id] of [['frames','reuseFramesHint'],['files','reuseFilesHint'],['files-all-frames','reuseAllHint']]){
    const n=reuseTargets({image:im,images:state.images,scope,sameCombo:$('reuseSameCombo').checked}).length;
    $(id).textContent=`\u00b7 ${n} frame${n===1?'':'s'}`;
  }
  const {zones,plan}=reusePlanFor();
  $('reusePlan').textContent=describePlan(plan,zones.length);$('applyReuse').disabled=!plan.frames.length;
}
$('openReuse').onclick=()=>{
  const im=current();if(!im)return;cancelDrag();
  const zones=sourceZones(im,im.frameIndex);
  $('reuseSource').textContent=`${zones.length} box${zones.length===1?'':'es'} on frame ${im.frameIndex+1} of ${im.name}`;
  $('reuseSize').textContent=`${im.width} \u00d7 ${im.height} px`;
  updateReuseDialog();if(!$('reuseDialog').open)$('reuseDialog').showModal();
};
$('applyReuse').onclick=()=>{
  const result=reusePlanFor();if(!result)return;const {zones,plan}=result;
  if(!plan.frames.length){updateReuseDialog();return;}
  if(plan.replaced&&!confirm(`Replace ${plan.replaced} existing box${plan.replaced===1?'':'es'} in ${plan.frames.length} frame${plan.frames.length===1?'':'s'}? Each frame can be undone on its own.`))return;
  $('reuseDialog').close();commitReuse(plan,zones.length);
};
$('closeReuse').onclick=$('cancelReuse').onclick=()=>$('reuseDialog').close();
$('reuseSameCombo').addEventListener('change',updateReuseDialog);
for(const input of document.querySelectorAll('input[name=reuseScope],input[name=reuseMode]'))input.addEventListener('change',updateReuseDialog);
function copyPreviousFrame(){
  const im=current();if(!im||im.frameIndex===0)return;
  const zones=sourceZones(im,im.frameIndex-1);
  if(!zones.length){$('message').textContent=`Frame ${im.frameIndex} has no boxes to copy.`;return;}
  const plan=planReuse(zones,[{image:im,frameIndex:im.frameIndex}],'merge');
  if(!plan.frames.length){$('message').textContent=`This frame already has frame ${im.frameIndex}\u2019s boxes.`;return;}
  commitReuse(plan,zones.length);
}
$('copyPreviousFrame').onclick=copyPreviousFrame;
function downloadJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
$('backup').onclick=()=>{downloadJSON({format:'pixel-zone-project',version:1,generated_at:new Date().toISOString(),images:state.images.map(imageRecord)},'pixel-zone-annotations.json');};
$('restoreBackup').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{
    const {validateBackup}=await import('./project.js');const records=validateBackup(JSON.parse(await file.text()));
    if(state.images.length&&!confirm('Replace the open annotations with this backup? Download a backup of current work first if needed.'))return;
    cancelDrag();const existing=new Map(state.images.map(im=>[im.id,im.file]));
    const restored=[];for(const record of records)restored.push(hydrate(record,existing.get(record.id)||(db?await loadFile(db,record.id):null)));
    state.images=restored;state.index=-1;if(restored.length)await showImage(0);else resetView();persist();$('message').textContent='Backup restored. Reopen any missing source files to reconnect them.';
  }catch(error){$('message').textContent=`Backup not restored: ${error.message}`;}
};
function resetView(){state.index=-1;state.selected=-1;state.bitmap?.close?.();state.bitmap=null;state.decoded=null;state.loadToken++;$('empty').hidden=false;$('loading').hidden=true;$('warning').hidden=true;$('filename').textContent='No image loaded';$('metadata').textContent='Combo — · Native size —';updateLibrary();updateImageControls();updateZones();render();}
$('removeImage').onclick=async()=>{
  if(!current()||importing)return;const im=current();if(!confirm(`Remove ${im.name} and its annotations from this workspace?`))return;
  cancelDrag();state.images.splice(state.index,1);if(state.images.length)await showImage(Math.min(state.index,state.images.length-1));else resetView();
  if(db)try{await removeFile(db,im.id);}catch{storageFailed();}persist();
};
$('clearWorkspace').onclick=async()=>{
  if(importing)return;if(!confirm('Delete every imported image and annotation from this browser? Source files are untouched.'))return;
  cancelDrag();clearTimeout(saveTimer);revision++;await saving;
  try{if(db)await clearSession(db);}catch{storageFailed('Could not clear browser storage.');return;}
  state.images=[];resetView();persistenceFailed=false;persist();$('message').textContent='Workspace cleared.';
};
async function initialize(){
  for(const id of ['files','folder','restoreBackup'])$(id).disabled=true;
  try {
    // Keep two tabs from silently overwriting the same saved workspace. The secondary tab
    // may view the last save and work in memory; it can export a backup of its own edits.
    if(navigator.locks)ownsWorkspace=await new Promise(resolve=>{
      navigator.locks.request('pixel-zone-workspace-writer',{ifAvailable:true},lock=>{
        resolve(!!lock);if(lock)return new Promise(()=>{});
      }).catch(()=>resolve(false));
    });
    db=await openDatabase();
    const saved=await loadSession(db);
    if(saved?.version===1){for(const record of saved.images)state.images.push(hydrate(record,await loadFile(db,record.id)));state.index=-1;
      if(Array.isArray(saved.collapsed))state.collapsed=new Set(saved.collapsed.filter(key=>typeof key==='string'));}
    if(!ownsWorkspace){db.close();db=null;persistenceFailed=true;}
    ready=true;$('saveStatus').textContent=ownsWorkspace?'Saved locally':'Not saving · another tab is open';
    if(state.images.length)await showImage(Math.max(0,state.images.findIndex(im=>im.id===saved.activeId)));
  }catch{db=null;ready=true;storageFailed('Not saving · storage unavailable');}
  for(const id of ['files','folder','restoreBackup'])$(id).disabled=false;
  updateLibrary();updateImageControls();updateZones();
}
initialize();
