
import { clamp, rectangleBetween, exportZone, parseFilename, buildPipelineExport, pipelineLayout, zoneKey, nudgeZone, cycleIndex, imageRecord, hydrate } from './coordinates.js';
import { openTagViewer } from './tag-viewer.js';
import { sourceZones, reuseTargets, planReuse, applyPlan, describePlan } from './reuse.js';
import { extractLines, suggestionBoxes, coverage, toZone, aboveConfidence, DEFAULT_CONFIDENCE } from './ocr.js';
import { contactFiles, thumbFlags, scaleZones, gridWindow } from './contact.js';
import { deviceLabel, deviceDetail, hasDevice } from './device.js';
import { EXPORT_FORMATS, DEFAULT_FORMAT, buildExport, comboConflicts, describeConflicts, exportRows, customFormatId, findFormat } from './export.js';
import { validateSchema, applySchema, validateSchemaFile, schemaFile, EXAMPLE_SCHEMA } from './schema.js';
import { FILTERS, UNASSIGNED, boxCount, invalidateCount, filterLibrary, filterCounts, groupLibrary, libraryRows, navigation, planComboAssignment, describeComboAssignment } from './library.js';
import { inspectFile } from './import.js';
import { openDatabase, loadSession, loadFile, saveFile, saveSession, clearSession, removeFile, loadTemplates, putTemplate, deleteTemplate, loadSchemas, putSchema, deleteSchema } from './storage.js';
import { makeTemplate, templateFits, templateSize, sortTemplates, validateTemplateFile, templateFile } from './templates.js';
import { validatePipelineFile, mergeImported, layoutKey } from './layouts.js';
// Images stay in local File objects / IndexedDB. The local server serves app assets only.
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d'), viewport = $('viewport');
const state = { images: [], index: -1, selected: -1, bitmap: null, view: {scale:1,x:0,y:0}, mode:'draw', space:false, drag:null, loadToken:0, dirty:false, preview:false, previewLayout:null,
  collapsed:new Set(), rows:[], offsets:[0], window:null, suggestions:[], ocrKey:null, ocrBusy:false, layouts:[], ocrFloor:DEFAULT_CONFIDENCE, format:DEFAULT_FORMAT };
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
let schemas=[],chosenSchema=null;
const exportFormat=()=>findFormat(state.format,schemas);
function changed() { flushNudge(); state.dirty=true; rememberHistory(); persist(); $('exportStatus').textContent='Unexported changes.'; updateLibrary(); }
function updateSummary() {
  const groups=new Map(); let count=0,unassigned=0;
  for(const im of state.images){const n=boxCount(im);if(!n)continue;count+=n;if(!im.combo)unassigned+=n;
    const key=`${im.combo ? 'Combo '+im.combo : 'Unassigned'} · ${im.width}×${im.height}`;groups.set(key,(groups.get(key)||0)+n);}
  // Promoted imports are part of what will be exported even when no file carries them.
  for(const layout of state.layouts){if(!layout.promoted)continue;count+=layout.zones.length;
    const key=`Combo ${layout.combo} · ${layout.width}×${layout.height}`;groups.set(key,(groups.get(key)||0)+layout.zones.length);}
  $('summary').replaceChildren();
  for(const [label,n] of groups){const row=document.createElement('div');row.className='summary-row';const span=document.createElement('span');span.textContent=label;const value=document.createElement('b');value.textContent=`${n} zone${n===1?'':'s'}`;row.append(span,value);$('summary').append(row);}
  if(!count)$('summary').textContent='No zones';
  $('total').textContent=`${count} zone${count===1?'':'s'}`;
  const blocking=state.format==='v1'&&unassigned>0;
  $('export').disabled=!count||blocking;
  $('export').title=blocking?'The combo schema is keyed by combo ID, so every annotated file needs one.':'';
  if(blocking)$('exportStatus').textContent=`${unassigned} zones without a combo ID · filter: Needs combo ID`;
  else if(unassigned)$('exportStatus').textContent=`${unassigned} zones have no combo ID · exported with an empty label`;
  else if(/combo ID/.test($('exportStatus').textContent))$('exportStatus').textContent='Ready to export.';
  updateExportFormat();
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
  });invalidateCount(current());updateEditor();updateSummary();updateReuseButtons();if(state.suggestions.length)updateOcrPanel();
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
  const imported=state.preview||state.hideZones?[]:matchingLayouts(im);
  if(imported.length){
    ctx.save();ctx.translate(v.x,v.y);ctx.scale(v.scale,v.scale);
    ctx.beginPath();ctx.rect(0,0,im.width,im.height);ctx.clip();
    for(const layout of imported)for(const zone of layout.zones){
      ctx.setLineDash([2/v.scale,3/v.scale]);
      ctx.lineWidth=3/v.scale;ctx.strokeStyle='rgba(0,0,0,.55)';ctx.strokeRect(zone.x,zone.y,zone.width,zone.height);
      ctx.lineWidth=1.25/v.scale;ctx.strokeStyle=layout.promoted?'rgba(167,139,208,.45)':'#a78bd0';
      ctx.strokeRect(zone.x,zone.y,zone.width,zone.height);
    }
    ctx.setLineDash([]);ctx.restore();
  }
  if(state.suggestions.length&&!state.preview&&!state.hideZones){
    const zones=im.zones,dash=6/v.scale;
    ctx.save();ctx.translate(v.x,v.y);ctx.scale(v.scale,v.scale);
    ctx.beginPath();ctx.rect(0,0,im.width,im.height);ctx.clip();
    for(const box of state.suggestions){
      const open=!coveredBySomeZone(box,zones);
      ctx.setLineDash([dash,dash]);
      ctx.lineWidth=3/v.scale;ctx.strokeStyle='rgba(0,0,0,.55)';ctx.strokeRect(box.x,box.y,box.width,box.height);
      ctx.lineWidth=1.25/v.scale;ctx.strokeStyle=open?'#6fc3d4':'rgba(111,195,212,.35)';
      ctx.strokeRect(box.x,box.y,box.width,box.height);
    }
    ctx.setLineDash([]);ctx.restore();
  }
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
  const token=++state.loadToken;state.index=index;state.selected=-1;state.bitmap?.close?.();state.bitmap=null;state.decoded=null;clearSuggestions();
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
    if(!e.shiftKey&&state.suggestions.length){
      const hit=[...state.suggestions].reverse().find(b=>raw.x>=b.x&&raw.x<=b.x+b.width&&raw.y>=b.y&&raw.y<=b.y+b.height);
      if(hit){acceptSuggestion(hit);return;}
    }
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
  if(e.key.toLowerCase()==='t'){e.preventDefault();detectText();}
  if(e.key.toLowerCase()==='g'){e.preventDefault();openContact();}
  if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.25);}if(e.key==='-'){e.preventDefault();zoom(.8);}
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){state.space=false;canvas.style.cursor=state.mode==='pan'?'grab':'crosshair';}});
window.addEventListener('blur',()=>{state.space=false;cancelDrag();});
// The chosen format is stated in the button, in the file name and inside the file, so
// which schema was produced is never a guess.
function updateExportFormat(){
  const format=exportFormat(),conflicts=comboConflicts(state.images);
  $('exportFormat').replaceChildren(...[...EXPORT_FORMATS,...schemas.map(schema=>({id:customFormatId(schema),label:`${schema.name} (custom)`}))]
    .map(option=>{const el=document.createElement('option');el.value=option.id;el.textContent=option.label;return el;}));
  $('exportFormat').value=format.id;
  $('exportFormatHint').textContent=format.hint;
  $('export').textContent=`Export ${format.label}`;
  const text=describeConflicts(conflicts);
  $('exportConflicts').hidden=!text;
  $('exportConflicts').textContent=text&&`${text}\n\nThe tags win: these files export as separate device combinations.`;
}
$('exportFormat').onchange=()=>{state.format=$('exportFormat').value;persist();updateSummary();};
$('export').onclick=()=>{
  try{
  if(state.drag)finishDrag();
  const format=exportFormat(),conflicts=comboConflicts(state.images);
  if(conflicts.length&&!confirm(`${describeConflicts(conflicts)}\n\nThe tags win, so these export as separate device combinations. Continue?`))return;
  const payload=buildExport(format.id,state.images,state.layouts,schemas);
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=format.file;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);$('exportStatus').textContent=`Exported ${format.label}.`;}catch(error){$('exportStatus').textContent=error.message;}
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
    const snapshot=structuredClone({version:1,images:state.images.map(imageRecord),activeId:current()?.id,collapsed:[...state.collapsed],layouts:state.layouts,ocrFloor:state.ocrFloor,thumbStep,format:state.format});
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
const ROW_H={group:68,size:22,file:44},OVERSCAN=6,VIRTUALIZE_ABOVE=60;
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
  head.className='lib-group'+(state.collapsed.has(group.key)?' collapsed':'')+(group.mixedDevices?' mixed':'');
  head.setAttribute('aria-expanded',String(!state.collapsed.has(group.key)));
  const title=document.createElement('span');title.className='lib-group-title';
  const name=document.createElement('strong');name.textContent=group.key===UNASSIGNED?'Unassigned':`Combo ${group.combo}`;
  title.append(name);
  if(group.needsCombo){const badge=document.createElement('em');badge.className='badge';badge.textContent='needs combo ID';title.append(badge);}
  if(group.mixedDevices){const badge=document.createElement('em');badge.className='badge alert';badge.textContent=`${group.devices.length} devices`;
    badge.title='Files in this combo report different manufacturer, model, SOP class or software version. Either the combo ID is wrong or the layout assumption behind it is.';title.append(badge);}
  // Progress sits on the title row: it is the number the operator scans for, and the
  // size list below is long enough to push it out of sight if they share a line.
  const progress=document.createElement('span');progress.className='lib-progress';
  progress.textContent=`${group.annotated}/${group.total}`;
  progress.title=`${group.annotated} of ${group.total} files have zones`;
  title.append(progress);
  const meta=document.createElement('span');meta.className='lib-group-meta';
  meta.textContent=`${group.total} file${group.total===1?'':'s'} · ${group.sizes.map(s=>s.size).join(', ')}`;
  // The row height is fixed for the windowing, so this line is always present — an
  // absent device is stated rather than silently collapsing the row.
  const device=document.createElement('span');device.className='lib-group-device';
  device.textContent=group.mixedDevices?'mixed devices — see files'
    :group.device?deviceLabel(group.device):'no device tags';
  if(group.device)device.title=deviceDetail(group.device);
  head.append(title,meta,device);
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
  const own=sourceZones(im,im.frameIndex),union=pipelineLayout(state.images,im.combo,im.width,im.height,state.layouts);
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
// Detection runs against the native raster, so a box the engine reports is already in the
// coordinate space every zone uses — no display transform is involved at any point.
function nativeRaster(im){
  const canvas=document.createElement('canvas');canvas.width=im.width;canvas.height=im.height;
  canvas.getContext('2d').drawImage(state.bitmap,0,0,im.width,im.height);
  return canvas;
}
const coveredBySomeZone=(box,zones)=>zones.some(z=>box.x>=z.x&&box.y>=z.y&&box.x+box.width<=z.x+z.width&&box.y+box.height<=z.y+z.height);
const ocrResults=new Map();            // "<image id>:<frame>" → every detection, session only
const ocrKeyFor=im=>im?`${im.id}:${im.frameIndex}`:null;
// Restore any detection already made for this image and frame instead of discarding it,
// so stepping through a combo does not re-run the engine on every return.
function clearSuggestions(){
  const im=current(),key=ocrKeyFor(im);
  state.ocrKey=key;state.raw=key&&ocrResults.get(key)||[];
  applyConfidenceFloor();
}
function rememberSuggestions(){if(state.ocrKey)ocrResults.set(state.ocrKey,state.raw);}
// The floor hides weak detections; it never discards them, so lowering it brings them
// straight back without another run of the engine.
function applyConfidenceFloor(){
  state.suggestions=aboveConfidence(state.raw||[],state.ocrFloor);
  updateOcrPanel();
}
const uncoveredFor=im=>{
  const found=ocrResults.get(ocrKeyFor(im));
  return found?coverage(found,Object.values(im.frames).flat()).uncovered:0;
};
async function detectText(){
  const im=current();
  if(!im||!state.bitmap||state.ocrBusy)return;
  state.ocrBusy=true;$('detectText').disabled=true;
  updateOcrPanel('Reading the image…');
  const token=state.loadToken,frame=im.frameIndex;
  state.raw=state.raw||[];
  try{
    const {recognize}=await import('./ocr-engine.js');
    const data=await recognize(nativeRaster(im));
    if(token!==state.loadToken||im.frameIndex!==frame)return;   // the operator moved on
    state.raw=suggestionBoxes(extractLines(data),im);
    state.ocrKey=`${im.id}:${frame}`;rememberSuggestions();
    applyConfidenceFloor();render();
  }catch(error){
    state.raw=[];state.suggestions=[];state.ocrKey=null;
    updateOcrPanel(`Could not run detection: ${error?.message||'the local OCR engine did not start.'}`);
  }finally{state.ocrBusy=false;updateImageControls();}
}
function acceptSuggestion(box){
  const im=current();if(!im)return;
  ensureHistory();im.zones.push(toZone(box));
  state.raw=(state.raw||[]).filter(s=>s!==box);state.suggestions=state.suggestions.filter(s=>s!==box);rememberSuggestions();
  state.selected=im.zones.length-1;
  changed();updateOcrPanel();updateZones();render();
}
function dismissSuggestion(box){state.raw=(state.raw||[]).filter(s=>s!==box);state.suggestions=state.suggestions.filter(s=>s!==box);rememberSuggestions();updateOcrPanel();render();}
// Wording is load-bearing: it reports what was found and what is uncovered, and never
// characterises the image. "No text detected" is not "no text present".
const ocrStatusText=()=>{
  const report=coverage(state.suggestions,current()?.zones||[]);
  const hidden=(state.raw||[]).length-state.suggestions.length;
  const below=hidden?` · ${hidden} below ${state.ocrFloor}%`:'';
  if(report.detected)return `${report.detected} text region${report.detected===1?'':'s'} shown · ${report.uncovered} not covered by a zone${below}`;
  return hidden
    ?`Nothing above ${state.ocrFloor}% confidence · ${hidden} weaker detection${hidden===1?'':'s'} hidden. Lower the floor to see them.`
    :'No text regions detected on this frame. That is not a finding of "no text".';
};
function updateOcrPanel(status){
  const boxes=state.suggestions,im=current();
  $('ocrSection').hidden=!boxes.length&&!(state.raw||[]).length&&status===undefined&&!state.ocrBusy;
  $('ocrCount').textContent=String(boxes.length);
  $('ocrStatus').textContent=status??ocrStatusText();
  $('acceptAllOcr').disabled=!boxes.length;$('dismissAllOcr').disabled=!boxes.length;
  $('ocrList').replaceChildren();
  for(const box of boxes){
    const row=document.createElement('div');row.className='ocr-row'+(coveredBySomeZone(box,im?.zones||[])?' covered':'');
    const accept=document.createElement('button');accept.className='ocr-accept';
    const text=document.createElement('strong');text.textContent=box.text;
    const meta=document.createElement('small');meta.textContent=`${box.x},${box.y} · ${box.width}×${box.height} · ${box.confidence}%`;
    accept.append(text,meta);accept.title='Accept as a zone';accept.onclick=()=>acceptSuggestion(box);
    const drop=document.createElement('button');drop.className='ocr-drop';drop.textContent='×';
    drop.setAttribute('aria-label',`Dismiss the detection at ${box.x},${box.y}`);drop.onclick=()=>dismissSuggestion(box);
    row.append(accept,drop);$('ocrList').append(row);
  }
}
$('detectText').onclick=detectText;
$('ocrConfidence').addEventListener('input',()=>{
  state.ocrFloor=Number($('ocrConfidence').value);
  $('ocrConfidenceValue').textContent=`${state.ocrFloor}%`;
  applyConfidenceFloor();render();persist();
});
$('acceptAllOcr').onclick=()=>{
  const im=current();if(!im||!state.suggestions.length)return;
  ensureHistory();
  const taking=new Set(state.suggestions);
  for(const box of state.suggestions)im.zones.push(toZone(box));
  state.raw=(state.raw||[]).filter(s=>!taking.has(s));state.suggestions=[];rememberSuggestions();state.selected=-1;
  changed();updateOcrPanel();updateZones();render();
  $('message').textContent='Accepted suggestions are ordinary zones now — check coverage, then use Copy to… to reuse them across the combo.';
};
$('dismissAllOcr').onclick=()=>{const dropping=new Set(state.suggestions);state.raw=(state.raw||[]).filter(s=>!dropping.has(s));state.suggestions=[];rememberSuggestions();updateOcrPanel();render();};
function updateToolHint(){
  $('toolHint').textContent=!state.bitmap?'Open an image to begin.':state.preview?previewHint():state.mode==='pan'?'Drag to pan.':state.mode==='window'?'Drag ↔ for contrast, ↕ for brightness.':state.hideZones?'Boxes hidden.':selected()?'Drag to move or resize · arrows nudge 1 px, Shift 10 px · Tab for next box':'Drag to draw · Shift-drag to overlap · arrows move between files';
}
function updateImageControls(){
  const im=current(),decoded=state.decoded,gray=!!decoded&&!decoded.color;
  $('viewTitle').textContent=im?.name||'No file';$('viewSubtitle').textContent=im?`${im.kind} · ${im.width}×${im.height} · ${im.combo?'combo '+im.combo:'no combo'}`:'';
  const device=im&&hasDevice(im.metadata)?deviceDetail(im.metadata):'';
  $('viewDevice').textContent=device;$('viewDevice').hidden=!device;
  $('comboId').disabled=!im;$('comboId').value=im?.combo||'';$('removeImage').disabled=!im;
  $('frameLabel').textContent=im?`${im.frameIndex+1} / ${im.frameCount}`:'—';
  $('frameSlider').max=im?im.frameCount-1:0;$('frameSlider').value=im?.frameIndex||0;$('frameSlider').disabled=!im||im.frameCount===1;
  $('framePrevious').disabled=!im||im.frameIndex===0;$('frameNext').disabled=!im||im.frameIndex===im.frameCount-1;
  for(const id of ['windowWidth','windowCenter','windowMode'])$(id).disabled=!gray;
  $('windowWidth').value=gray?Math.round(im.display.windowWidth??decoded.windowWidth):'';$('windowCenter').value=gray?Math.round(im.display.windowCenter??decoded.windowCenter):'';
  $('invert').disabled=!decoded;$('resetDisplay').disabled=!decoded;$('invert').setAttribute('aria-pressed',String(!!im?.display.invert));
  $('openTags').disabled=im?.kind!=='DICOM'||!im?.file;
  for(const id of ['drawMode','panMode','zoomIn','zoomOut','fit','actual','hideZones','preview','detectText','openContact'])$(id).disabled=!state.bitmap;
  $('openTemplates').disabled=!im;
  if(state.ocrBusy)$('detectText').disabled=true;
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
// Contact sheet. Thumbnails decode lazily, cache as small canvases, and the grid renders
// a window of rows, so opening a thousand-file scope costs a screenful of decodes.
// Four fixed steps rather than a continuous zoom: the window arithmetic needs a definite
// cell size, and thumbnails are re-decoded per step so enlarging sharpens rather than
// upscales. The cache is keyed by size, so stepping back down is instant.
const THUMB_STEPS=[
  {label:'S', thumb:[100,64],  cell:[114,104]},
  {label:'M', thumb:[142,96],  cell:[156,136]},
  {label:'L', thumb:[202,136], cell:[216,176]},
  {label:'XL',thumb:[286,192], cell:[300,232]},
];
const THUMB_CACHE_MAX=400;
let thumbStep=1,THUMB_W=142,THUMB_H=96,CELL_W=156,CELL_H=136;
const thumbs=new Map();
let contactEntries=[],contactPass=0,contactKey=null,thumbVersion=0;
function thumbLayout(im){
  const union=pipelineLayout(state.images,im.combo,im.width,im.height,state.layouts);
  return union??Object.values(im.frames).flat().map(z=>exportZone(z,im)).filter(Boolean);
}
const thumbKey=im=>`${im.id}@${THUMB_W}`;
async function buildThumb(im){
  if(!im.file)return null;
  let source=null;
  if(im.kind==='DICOM'){
    const {decodeDicom,renderDicom}=await import('./dicom.js');
    source=await renderDicom(await decodeDicom(im.file,im.frameIndex),im.display);
  }else source=await createImageBitmap(im.file);
  const scale=Math.min(THUMB_W/im.width,THUMB_H/im.height);
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(im.width*scale));canvas.height=Math.max(1,Math.round(im.height*scale));
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
  source.close?.();
  if(thumbs.size>=THUMB_CACHE_MAX)thumbs.delete(thumbs.keys().next().value);
  thumbs.set(thumbKey(im),canvas);
  return canvas;
}
let thumbQueue=Promise.resolve();const thumbPending=new Set();
function requestThumb(im,pass){
  const key=thumbKey(im);
  if(thumbs.has(key)||thumbPending.has(key)||!im.file)return;
  thumbPending.add(key);
  thumbQueue=thumbQueue.then(async()=>{
    if(pass!==contactPass||!$('contactDialog').open)return;
    try{if(await buildThumb(im)){thumbVersion++;renderContact();}}catch{}
    finally{thumbPending.delete(thumbKey(im));}
  });
}
function contactCell(entry){
  const im=entry.image,flags=thumbFlags(im,uncoveredFor(im));
  const cell=document.createElement('button');
  cell.className='cell'+(flags.length?' flagged':'')+(entry.index===state.index?' active':'');
  cell.title=im.path||im.name;
  const shot=document.createElement('div');shot.className='shot';
  const cached=thumbs.get(thumbKey(im));
  if(cached){
    // The overlay is the merged layout the pipeline will apply, drawn opaque exactly as
    // Preview draws it, so a mismatch between image and layout is visible at a glance.
    const view=document.createElement('canvas');view.width=cached.width;view.height=cached.height;
    const ctx2=view.getContext('2d');ctx2.drawImage(cached,0,0);ctx2.fillStyle='#000';
    for(const zone of scaleZones(thumbLayout(im),im,view.width,view.height))
      ctx2.fillRect(zone.x,zone.y,zone.width,zone.height);
    shot.append(view);
  }else{
    const pending=document.createElement('span');pending.className='pending';
    pending.textContent=im.file?'…':'no source';shot.append(pending);
    requestThumb(im,contactPass);
  }
  const name=document.createElement('span');name.className='name';name.textContent=im.name;
  const marks=document.createElement('span');marks.className='flags';
  for(const flag of flags){const tag=document.createElement('em');tag.textContent=flag;marks.append(tag);}
  cell.append(shot,name,marks);
  cell.onclick=()=>{$('contactDialog').close();showImage(entry.index);};
  return cell;
}
function renderContact(){
  const host=$('contactGrid');
  const grid=gridWindow({count:contactEntries.length,width:host.clientWidth||CELL_W,
    cellWidth:CELL_W,cellHeight:CELL_H,scrollTop:host.scrollTop,viewportHeight:host.clientHeight||CELL_H});
  // Rebuild only when the window or a thumbnail actually changed. Without this, every
  // scroll event and every decode replaced the whole grid, so a cell was never still
  // long enough to click.
  const key=`${grid.from}:${grid.to}:${grid.columns}:${contactEntries.length}:${thumbVersion}:${thumbStep}`;
  if(contactKey===key)return;
  contactKey=key;
  const canvas=document.createElement('div');canvas.className='contact-canvas';canvas.style.height=`${grid.height}px`;
  const pane=document.createElement('div');pane.className='contact-pane';
  pane.style.transform=`translateY(${grid.offset}px)`;
  for(let i=grid.from;i<grid.to;i++)pane.append(contactCell(contactEntries[i]));
  canvas.append(pane);host.replaceChildren(canvas);
}
function openContact(){
  const im=current();if(!im)return;
  cancelDrag();contactPass++;
  const scope=$('contactScope').value;
  contactEntries=contactFiles(state.images,im,scope);
  const flagged=contactEntries.filter(e=>thumbFlags(e.image,uncoveredFor(e.image)).length).length;
  $('contactSubject').textContent=scope==='all'?'Whole library'
    :`${im.combo?'Combo '+im.combo:'Unassigned'}${scope==='size'?` · ${im.width}×${im.height}`:''}`;
  $('contactCount').textContent=`${contactEntries.length} file${contactEntries.length===1?'':'s'}`;
  $('contactFlagged').textContent=flagged?`${flagged} flagged`:'';
  applyThumbStep();
  if(!$('contactDialog').open)$('contactDialog').showModal();
  $('contactGrid').scrollTop=0;contactKey=null;renderContact();
}
function applyThumbStep(){
  const step=THUMB_STEPS[thumbStep];
  [THUMB_W,THUMB_H]=step.thumb;[CELL_W,CELL_H]=step.cell;
  $('contactGrid').style.setProperty('--cell-w',`${CELL_W}px`);
  $('contactGrid').style.setProperty('--cell-h',`${CELL_H}px`);
  $('contactSize').textContent=step.label;
  $('contactSmaller').disabled=thumbStep===0;
  $('contactLarger').disabled=thumbStep===THUMB_STEPS.length-1;
}
function stepThumbs(by){
  const next=clamp(thumbStep+by,0,THUMB_STEPS.length-1);
  if(next===thumbStep)return;
  thumbStep=next;applyThumbStep();persist();
  contactKey=null;$('contactGrid').scrollTop=0;renderContact();
}
$('contactSmaller').onclick=()=>stepThumbs(-1);
$('contactLarger').onclick=()=>stepThumbs(1);
$('openContact').onclick=openContact;
$('contactScope').onchange=openContact;
$('closeContact').onclick=()=>$('contactDialog').close();
$('contactGrid').addEventListener('scroll',renderContact,{passive:true});
$('contactDialog').addEventListener('close',()=>{contactPass++;contactEntries=[];contactKey=null;$('contactGrid').replaceChildren();});
// Zone templates. Applying one runs through planReuse, the same planner Copy to… uses, so
// merge, dedupe, pricing and per-frame history are identical — a template supplies zones,
// it does not introduce a second way of writing them.
let templates=[],chosenTemplate=null;
const templateScope=()=>document.querySelector('input[name=templateScope]:checked').value;
function templateTargets(template,scope){
  const im=current();if(!im||!templateFits(template,im))return [];
  if(scope==='frame')return [{image:im,frameIndex:im.frameIndex}];
  const files=scope==='file'?[im]:state.images.filter(other=>
    (other.combo||'')===(im.combo||'')&&other.width===im.width&&other.height===im.height);
  return files.flatMap(file=>Array.from({length:file.frameCount},(_,frameIndex)=>({image:file,frameIndex})));
}
function templatePlanNow(){
  if(!chosenTemplate)return null;
  const mode=$('templateReplace').checked?'replace':'merge';
  return planReuse(chosenTemplate.zones,templateTargets(chosenTemplate,templateScope()),mode);
}
function renderTemplates(){
  const im=current();
  $('templateList').replaceChildren();
  if(!templates.length){
    const empty=document.createElement('div');empty.className='empty';
    empty.textContent='No templates yet. Annotate a frame, then save it here.';
    $('templateList').append(empty);
  }
  for(const template of sortTemplates(templates)){
    const fits=templateFits(template,im);
    const row=document.createElement('div');
    row.className='tpl'+(chosenTemplate?.id===template.id?' chosen':'')+(fits?'':' mismatch');
    const pick=document.createElement('button');pick.className='pick';
    const name=document.createElement('strong');name.textContent=template.name;
    const meta=document.createElement('small');
    meta.textContent=`${template.combo?'combo '+template.combo:'no combo'} · ${templateSize(template)} · ${template.zones.length} zone${template.zones.length===1?'':'s'}${fits?'':' · wrong size'}`;
    pick.append(name,meta);pick.onclick=()=>{chosenTemplate=template;updateTemplateDialog();};
    const drop=document.createElement('button');drop.className='drop';drop.textContent='×';
    drop.setAttribute('aria-label',`Delete template ${template.name}`);
    drop.onclick=async()=>{
      if(!confirm(`Delete the template “${template.name}”? Zones already applied from it are unaffected.`))return;
      templates=templates.filter(t=>t.id!==template.id);
      if(chosenTemplate?.id===template.id)chosenTemplate=null;
      if(db)try{await deleteTemplate(db,template.id);}catch{}
      updateTemplateDialog();
    };
    row.append(pick,drop);$('templateList').append(row);
  }
}
function updateTemplateDialog(){
  const im=current();
  $('templateSubject').textContent=im?`${im.name} · ${im.width}×${im.height} · ${im.combo?'combo '+im.combo:'no combo'}`:'No file open';
  $('saveTemplate').disabled=!im||!sourceZones(im,im.frameIndex).length;
  renderTemplates();
  const fits=chosenTemplate&&templateFits(chosenTemplate,im);
  $('templateApply').hidden=!chosenTemplate;
  for(const [scope,id] of [['file','templateFileHint'],['combo','templateComboHint']]){
    const n=chosenTemplate?templateTargets(chosenTemplate,scope).length:0;
    $(id).textContent=`\u00b7 ${n} frame${n===1?'':'s'}`;
  }
  if(!chosenTemplate){$('templatePlan').textContent='Choose a template to apply.';$('applyTemplate').disabled=true;return;}
  if(!fits){
    // Refused rather than rescaled, and the refusal names where it would work.
    const elsewhere=state.images.filter(other=>other.width===chosenTemplate.width&&other.height===chosenTemplate.height).length;
    $('templatePlan').textContent=`“${chosenTemplate.name}” was built for ${templateSize(chosenTemplate)}; this file is ${im?`${im.width}×${im.height}`:'not open'}. Zones are native pixels and are never rescaled.${elsewhere?` ${elsewhere} file${elsewhere===1?'':'s'} in the library ${elsewhere===1?'is':'are'} ${templateSize(chosenTemplate)}.`:''}`;
    $('applyTemplate').disabled=true;return;
  }
  const plan=templatePlanNow();
  $('templatePlan').textContent=describePlan(plan,chosenTemplate.zones.length);
  $('applyTemplate').disabled=!plan.frames.length;
}
$('openTemplates').onclick=async()=>{
  cancelDrag();
  if(db&&!templates.length){try{templates=(await loadTemplates(db))||[];}catch{}}
  $('templateName').value='';updateTemplateDialog();
  if(!$('templateDialog').open)$('templateDialog').showModal();
};
$('closeTemplates').onclick=()=>$('templateDialog').close();
$('templateDialog').addEventListener('close',()=>{chosenTemplate=null;});
$('templateReplace').addEventListener('change',updateTemplateDialog);
for(const input of document.querySelectorAll('input[name=templateScope]'))input.addEventListener('change',updateTemplateDialog);
$('saveTemplate').onclick=async()=>{
  const im=current();if(!im)return;
  try{
    const template=makeTemplate({name:$('templateName').value,image:im,zones:sourceZones(im,im.frameIndex)});
    templates=[...templates.filter(t=>t.id!==template.id),template];
    chosenTemplate=template;$('templateName').value='';
    if(db)try{await putTemplate(db,template);}catch{storageFailed('Template not saved · storage unavailable');}
    updateTemplateDialog();
    $('message').textContent=`Saved template “${template.name}” · ${template.zones.length} zone${template.zones.length===1?'':'s'} at ${templateSize(template)}.`;
  }catch(error){$('templatePlan').textContent=error.message;}
};
$('applyTemplate').onclick=()=>{
  const plan=templatePlanNow();if(!plan?.frames.length)return;
  if(plan.replaced&&!confirm(`Replace ${plan.replaced} existing box${plan.replaced===1?'':'es'} in ${plan.frames.length} frame${plan.frames.length===1?'':'s'}? Each frame can be undone on its own.`))return;
  $('templateDialog').close();commitReuse(plan,chosenTemplate.zones.length);
};
$('exportTemplates').onclick=()=>{
  if(!templates.length){$('templatePlan').textContent='There are no templates to export.';return;}
  downloadJSON(templateFile(sortTemplates(templates)),'occlude-templates.json');
};
$('importTemplates').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{
    const incoming=validateTemplateFile(JSON.parse(await file.text()));
    const known=new Set(templates.map(t=>t.id));
    const added=incoming.filter(t=>!known.has(t.id));
    templates=[...templates,...added];
    if(db)for(const template of added){try{await putTemplate(db,template);}catch{}}
    updateTemplateDialog();
    $('templatePlan').textContent=`Imported ${added.length} template${added.length===1?'':'s'}${incoming.length-added.length?` · ${incoming.length-added.length} already present`:''}.`;
  }catch(error){$('templatePlan').textContent=`Templates not imported: ${error.message}`;}
};
// Imported pipeline layouts. They carry no source file and no frame ownership, so they
// stand on their own; they are drawn over a matching image for review and stay out of the
// export until the operator promotes them.
// Which layouts the operator has expanded, so acting on one does not collapse the panel
// underneath them when the list re-renders.
const openLayouts=new Set();
const matchingLayouts=im=>im?state.layouts.filter(l=>l.combo===(im.combo||'')&&l.width===im.width&&l.height===im.height):[];
function updateLayoutPanel(){
  const list=$('layoutList');
  $('layoutSection').hidden=!state.layouts.length;
  $('layoutCount').textContent=String(state.layouts.length);
  list.replaceChildren();
  for(const layout of state.layouts){
    const key=layoutKey(layout);
    const row=document.createElement('details');row.className='layout'+(layout.promoted?' promoted':'');
    row.open=openLayouts.has(key);
    row.addEventListener('toggle',()=>{if(row.open)openLayouts.add(key);else openLayouts.delete(key);});
    const summary=document.createElement('summary');
    const label=document.createElement('b');label.textContent=`Combo ${layout.combo} · ${layout.width}×${layout.height}`;
    const count=document.createElement('span');count.className='num';
    count.textContent=`${layout.zones.length} zone${layout.zones.length===1?'':'s'}`;
    const badge=document.createElement('em');badge.className='state';badge.textContent=layout.promoted?'in export':'held';
    summary.append(label,count,badge);
    const body=document.createElement('div');body.className='body';
    for(const zone of layout.zones){
      const line=document.createElement('div');line.className='zone-line';
      const text=document.createElement('span');
      text.textContent=`x=${zone.x}, y=${zone.y}, w=${zone.width}, h=${zone.height}${zone.note?' · '+zone.note:''}`;
      const drop=document.createElement('button');drop.textContent='×';drop.setAttribute('aria-label','Remove this zone');
      drop.onclick=()=>{
        layout.zones=layout.zones.filter(z=>z!==zone);
        if(!layout.zones.length)state.layouts=state.layouts.filter(l=>l!==layout);
        else layout.promoted=false;   // what was reviewed is no longer what would export
        layoutsChanged();
      };
      line.append(text,drop);body.append(line);
    }
    const actions=document.createElement('div');actions.className='btn-row';
    const promote=document.createElement('button');
    promote.textContent=layout.promoted?'Hold back':'Promote to export';
    promote.onclick=()=>{layout.promoted=!layout.promoted;layoutsChanged();};
    const discard=document.createElement('button');discard.className='danger';discard.textContent='Discard';
    discard.onclick=()=>{
      if(!confirm(`Discard the imported layout for combo ${layout.combo} at ${layout.width}×${layout.height}? Zones already on files are unaffected.`))return;
      state.layouts=state.layouts.filter(l=>l!==layout);layoutsChanged();
    };
    actions.append(promote,discard);body.append(actions);
    row.append(summary,body);list.append(row);
  }
}
function layoutsChanged(){state.dirty=true;persist();updateLayoutPanel();updateSummary();render();}
$('importPipeline').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{
    const incoming=validatePipelineFile(JSON.parse(await file.text()));
    const {layouts,added,merged}=mergeImported(state.layouts,incoming);
    state.layouts=layouts;layoutsChanged();
    $('message').textContent=`Imported ${added} layout${added===1?'':'s'}${merged?` · ${merged} zone${merged===1?'':'s'} merged`:''}. Nothing is exported until you promote it.`;
  }catch(error){$('message').textContent=`Layout not imported: ${error.message}`;}
};
// Custom schemas. A definition is validated the moment it is typed and previewed against
// the real workspace, so what the file will contain is visible before it is written.
function renderSchemaList(){
  $('schemaCount').textContent=String(schemas.length);
  $('schemaList').replaceChildren();
  if(!schemas.length){
    const empty=document.createElement('div');empty.className='empty';
    empty.textContent='No custom schemas yet. Load the example to start from something real.';
    $('schemaList').append(empty);
  }
  for(const schema of schemas){
    const row=document.createElement('div');row.className='sch'+(chosenSchema?.id===schema.id?' chosen':'');
    const pick=document.createElement('button');pick.className='pick';
    const name=document.createElement('strong');name.textContent=schema.name;
    const meta=document.createElement('small');
    meta.textContent=`${schema.shape} · by ${schema.group_by} · ${Object.keys(schema.entry).length} entry field${Object.keys(schema.entry).length===1?'':'s'}`;
    pick.append(name,meta);
    pick.onclick=()=>{chosenSchema=schema;$('schemaText').value=JSON.stringify(schema,null,2);renderSchemaList();previewSchema();};
    const drop=document.createElement('button');drop.className='drop';drop.textContent='×';
    drop.setAttribute('aria-label',`Delete schema ${schema.name}`);
    drop.onclick=async()=>{
      if(!confirm(`Delete the schema “${schema.name}”? Exports already written are unaffected.`))return;
      schemas=schemas.filter(entry=>entry.id!==schema.id);
      if(chosenSchema?.id===schema.id)chosenSchema=null;
      if(state.format===customFormatId(schema))state.format=DEFAULT_FORMAT;
      if(db)try{await deleteSchema(db,schema.id);}catch{}
      renderSchemaList();previewSchema();updateSummary();
    };
    row.append(pick,drop);$('schemaList').append(row);
  }
}
function previewSchema(){
  const text=$('schemaText').value.trim();
  if(!text){$('schemaState').textContent='';$('schemaState').className='num';$('schemaPreview').textContent='';return null;}
  let schema;
  try{schema=validateSchema(JSON.parse(text));}
  catch(error){
    $('schemaState').textContent='invalid';$('schemaState').className='num bad';
    $('schemaPreview').textContent=error.message;return null;
  }
  $('schemaState').textContent='valid';$('schemaState').className='num good';
  const rows=exportRows(state.images,state.layouts,schema.group_by);
  const sample=applySchema(schema,rows.slice(0,1));
  $('schemaPreview').textContent=rows.length
    ?JSON.stringify(sample,null,2)
    :JSON.stringify(applySchema(schema,[]),null,2)+'\n\n// No annotated files yet, so there are no entries to show.';
  return schema;
}
$('openSchemas').onclick=async()=>{
  cancelDrag();
  if(db&&!schemas.length){try{schemas=(await loadSchemas(db))||[];}catch{}}
  renderSchemaList();previewSchema();
  $('schemaMessage').textContent=schemas.length?'Choose a schema to edit, or write a new one.':'Load the example, adjust it, then save.';
  if(!$('schemaDialog').open)$('schemaDialog').showModal();
};
$('closeSchemas').onclick=$('doneSchemas').onclick=()=>{$('schemaDialog').close();updateSummary();};
$('schemaText').addEventListener('input',previewSchema);
$('schemaExample').onclick=()=>{chosenSchema=null;$('schemaText').value=JSON.stringify(EXAMPLE_SCHEMA,null,2);renderSchemaList();previewSchema();};
$('saveSchema').onclick=async()=>{
  const schema=previewSchema();
  if(!schema){$('schemaMessage').textContent='Fix the definition before saving — the problem is shown in the preview.';return;}
  if(chosenSchema)schema.id=chosenSchema.id;
  schemas=[...schemas.filter(entry=>entry.id!==schema.id),schema];
  chosenSchema=schema;
  if(db)try{await putSchema(db,schema);}catch{storageFailed('Schema not saved · storage unavailable');}
  renderSchemaList();updateSummary();
  $('schemaMessage').textContent=`Saved “${schema.name}”. It is now in the export format list.`;
};
$('exportSchemas').onclick=()=>{
  if(!schemas.length){$('schemaMessage').textContent='There are no schemas to export.';return;}
  downloadJSON(schemaFile(schemas),'occlude-schemas.json');
};
$('importSchemas').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{
    const incoming=validateSchemaFile(JSON.parse(await file.text()));
    const known=new Set(schemas.map(schema=>schema.id));
    const added=incoming.filter(schema=>!known.has(schema.id));
    schemas=[...schemas,...added];
    if(db)for(const schema of added){try{await putSchema(db,schema);}catch{}}
    renderSchemaList();updateSummary();
    $('schemaMessage').textContent=`Imported ${added.length} schema${added.length===1?'':'s'}${incoming.length-added.length?` · ${incoming.length-added.length} already present`:''}.`;
  }catch(error){$('schemaMessage').textContent=`Not imported: ${error.message}`;}
};
function downloadJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
$('backup').onclick=()=>{downloadJSON({format:'occlude-project',version:1,generated_at:new Date().toISOString(),images:state.images.map(imageRecord)},'occlude-annotations.json');};
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
// Notes travel: into the workspace, into project backups, into templates meant to be
// shared, and into the pipeline export. This is how text that should never have been
// written into one gets removed without disturbing a single box position.
function countNotes(){
  let n=0;
  for(const im of state.images)for(const zones of Object.values(im.frames))for(const zone of zones)if(zone.note)n++;
  for(const layout of state.layouts)for(const zone of layout.zones)if(zone.note)n++;
  for(const template of templates)for(const zone of template.zones)if(zone.note)n++;
  return n;
}
$('clearNotes').onclick=async()=>{
  if(db&&!templates.length){try{templates=(await loadTemplates(db))||[];}catch{}}
  const total=countNotes();
  if(!total){$('message').textContent='No notes to clear.';return;}
  if(!confirm(`Clear the text from ${total} note${total===1?'':'s'}?\n\nNotes are written into the pipeline export, project backups and templates, so this is how text that should not leave this machine is removed from them. Every box keeps its position, and each frame can be undone on its own.`))return;
  for(const im of state.images)for(const [frame,zones] of Object.entries(im.frames)){
    if(!zones.some(zone=>zone.note))continue;
    const index=Number(frame);
    ensureHistory(im,index);
    for(const zone of zones)zone.note='';
    rememberHistory(im,index);
  }
  for(const layout of state.layouts)for(const zone of layout.zones)zone.note='';
  for(const template of templates){
    if(!template.zones.some(zone=>zone.note))continue;
    for(const zone of template.zones)zone.note='';
    if(db)try{await putTemplate(db,template);}catch{}
  }
  state.dirty=true;persist();updateZones();updateLibrary();updateLayoutPanel();render();
  $('message').textContent=`Cleared ${total} note${total===1?'':'s'}. Box positions are unchanged.`;
};
$('clearWorkspace').onclick=async()=>{
  if(importing)return;if(!confirm('Delete every imported image and annotation from this browser? Source files and saved templates are untouched.'))return;
  cancelDrag();clearTimeout(saveTimer);revision++;await saving;
  try{if(db)await clearSession(db);}catch{storageFailed('Could not clear browser storage.');return;}
  state.images=[];state.layouts=[];resetView();updateLayoutPanel();persistenceFailed=false;persist();$('message').textContent='Workspace cleared.';
};
async function initialize(){
  for(const id of ['files','folder','restoreBackup'])$(id).disabled=true;
  try {
    // Keep two tabs from silently overwriting the same saved workspace. The secondary tab
    // may view the last save and work in memory; it can export a backup of its own edits.
    if(navigator.locks)ownsWorkspace=await new Promise(resolve=>{
      navigator.locks.request('occlude-workspace-writer',{ifAvailable:true},lock=>{
        resolve(!!lock);if(lock)return new Promise(()=>{});
      }).catch(()=>resolve(false));
    });
    db=await openDatabase();
    const saved=await loadSession(db);
    if(saved?.version===1){for(const record of saved.images)state.images.push(hydrate(record,await loadFile(db,record.id)));state.index=-1;
      if(Array.isArray(saved.collapsed))state.collapsed=new Set(saved.collapsed.filter(key=>typeof key==='string'));
      if(Number.isFinite(saved.ocrFloor))state.ocrFloor=clamp(saved.ocrFloor,0,100);
      if(Number.isFinite(saved.thumbStep))thumbStep=clamp(saved.thumbStep,0,THUMB_STEPS.length-1);
      if(EXPORT_FORMATS.some(f=>f.id===saved.format))state.format=saved.format;
      // Re-validated on the way back in, so a hand-edited store cannot reintroduce a zone
      // that never passed the import checks.
      if(Array.isArray(saved.layouts))try{
        const promoted=new Set(saved.layouts.filter(l=>l?.promoted).map(layoutKey));
        state.layouts=validatePipelineFile({annotations:Object.fromEntries(saved.layouts.map(l=>
          [l.combo,{[`${l.width}x${l.height}`]:{ref_width:l.width,ref_height:l.height,zones:l.zones}}]))})
          .map(l=>({...l,promoted:promoted.has(layoutKey(l))}));
      }catch{state.layouts=[];}}
    try{schemas=(await loadSchemas(db))||[];}catch{}
    if(!ownsWorkspace){db.close();db=null;persistenceFailed=true;}
    ready=true;$('saveStatus').textContent=ownsWorkspace?'Saved locally':'Not saving · another tab is open';
    if(state.images.length)await showImage(Math.max(0,state.images.findIndex(im=>im.id===saved.activeId)));
  }catch{db=null;ready=true;storageFailed('Not saving · storage unavailable');}
  for(const id of ['files','folder','restoreBackup'])$(id).disabled=false;
  $('ocrConfidence').value=String(state.ocrFloor);$('ocrConfidenceValue').textContent=`${state.ocrFloor}%`;
  updateLibrary();updateImageControls();updateZones();updateLayoutPanel();
}
initialize();
