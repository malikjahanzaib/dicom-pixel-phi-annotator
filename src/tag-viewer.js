// Search is kept independent of parsing so the DICOM dictionary stays in the worker.
import { filterTags, tagCounts, TAG_FILTERS } from './tag-search.js';
const $=id=>document.getElementById(id),pageSize=150;
let rows=[],filtered=[],pageIndex=0,worker=null;
const FILTER_LABELS={all:'All tags',phi:'Identifying (PS3.15)',standard:'Standard tags',private:'Private tags',sequences:'Sequences'};
function applyFilter(){
  const filter=$('tagFilter').value;
  $('tagPhiNote').hidden=filter!=='phi';
  filtered=filterTags(rows,$('tagSearch').value,filter);pageIndex=0;renderRows();
}
// Counts sit in the option labels so the control that narrows the file also reports it.
function labelFilters(){
  const counts=rows.length?tagCounts(rows):null;
  for(const filter of TAG_FILTERS)
    $('tagFilter').querySelector(`option[value="${filter}"]`).textContent=counts?`${FILTER_LABELS[filter]} (${counts[filter]})`:FILTER_LABELS[filter];
}
// (0028,0301) is the one metadata fact that speaks directly to this tool's job, so it is
// surfaced rather than left for the operator to search out.
function showBurnedInFlag(){
  const row=rows.find(entry=>entry.hex==='00280301'),value=(row?.value||'').trim();
  $('tagBurnedIn').hidden=!row;
  if(row)$('tagBurnedIn').textContent=`Burned In Annotation (0028,0301) = ${value||'(empty)'} · the source device declares ${/^yes$/i.test(value)?'that text is burned into the pixels':/^no$/i.test(value)?'no burned-in text':'an unrecognized value'}. Confirm against the image either way — this attribute can be absent or wrong.`;
}
function renderRows(){
  $('tagRows').replaceChildren();const fragment=document.createDocumentFragment();
  for(const row of filtered.slice(pageIndex*pageSize,(pageIndex+1)*pageSize)){
    const tr=document.createElement('tr'),tagCell=document.createElement('td'),nameCell=document.createElement('td'),valueCell=document.createElement('td');
    const tag=document.createElement('span');tag.className='tag-number';tag.textContent=row.tag;const vr=document.createElement('span');vr.className='tag-vr';vr.textContent=row.vr;tagCell.append(tag,vr);
    if(row.private){const badge=document.createElement('span');badge.className='tag-vr tag-private';badge.textContent='Private';tagCell.append(badge);}
    const name=document.createElement('span');name.className='tag-name';name.textContent=row.name;name.title=row.keyword;nameCell.append(name);
    if(row.path){const path=document.createElement('span');path.className='tag-context';path.textContent=row.path;nameCell.append(path);}
    valueCell.className='tag-value'+(row.binary?' binary':'');
    if(row.value.length>240){const preview=document.createElement('span');preview.textContent=row.value.slice(0,180)+'…';const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`Show full value (${row.value.length.toLocaleString()} characters)`;const full=document.createElement('div');details.append(summary,full);details.addEventListener('toggle',()=>{full.textContent=details.open?row.value:'';});valueCell.append(preview,details);}
    else valueCell.textContent=row.value||'(empty)';
    tr.append(tagCell,nameCell,valueCell);fragment.append(tr);
  }
  $('tagRows').append(fragment);$('tagEmpty').hidden=filtered.length>0;
  $('tagCount').textContent=`${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} tags`;
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize));$('tagPage').textContent=`${pageIndex+1} / ${pages}`;$('tagPrevious').disabled=pageIndex===0;$('tagNext').disabled=pageIndex>=pages-1;
  document.querySelector('.tag-table-wrap').scrollTop=0;
}
export function openTagViewer(image){
  worker?.terminate();worker=null;rows=[];filtered=[];pageIndex=0;
  $('tagFilename').textContent=image.name;$('tagSearch').value='';$('tagFilter').value='all';$('tagNotice').hidden=true;$('tagBurnedIn').hidden=true;$('tagPhiNote').hidden=true;labelFilters();$('tagRows').replaceChildren();$('tagEmpty').hidden=false;$('tagEmpty').textContent='Reading metadata from the local file…';$('tagCount').textContent='Reading tags…';$('tagPage').textContent='—';$('tagPrevious').disabled=true;$('tagNext').disabled=true;
  if(!$('tagDialog').open)$('tagDialog').showModal();$('tagSearch').focus();
  worker=new Worker(new URL('./tags.worker.js',import.meta.url),{type:'module'});
  const active=worker;
  const failed=message=>{if(worker!==active)return;$('tagEmpty').textContent=message;$('tagCount').textContent='Metadata unavailable';active.terminate();worker=null;};
  worker.onerror=()=>failed('Could not start the local tag reader. Close this panel and try again.');
  worker.onmessage=({data})=>{
    if(worker!==active)return;
    if(!data.ok){failed(data.message);return;}
    rows=data.rows;$('tagEmpty').textContent='No matching tags. Try another name, value, or tag number.';labelFilters();showBurnedInFlag();
    $('tagNotice').hidden=!data.warnings.length;$('tagNotice').textContent=data.warnings.join(' ');applyFilter();active.terminate();worker=null;
  };
  worker.postMessage(image.file);
}
$('closeTags').onclick=()=>$('tagDialog').close();
$('tagDialog').addEventListener('close',()=>{worker?.terminate();worker=null;rows=[];filtered=[];$('tagRows').replaceChildren();$('tagSearch').value='';$('tagBurnedIn').hidden=true;$('tagPhiNote').hidden=true;});
$('tagSearch').addEventListener('input',applyFilter);$('tagFilter').addEventListener('change',applyFilter);
$('tagPrevious').onclick=()=>{pageIndex--;renderRows();};$('tagNext').onclick=()=>{pageIndex++;renderRows();};
