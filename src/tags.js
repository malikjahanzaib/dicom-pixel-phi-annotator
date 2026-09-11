import dicomParser from 'dicom-parser';
import dictionary from 'dcmjs/dictionary';
import { inflateRaw } from 'pako';
import { isPhiTag } from './phi.js';

export const formatTag = tag => `(${tag.slice(1,5)},${tag.slice(5,9)})`.toUpperCase();
const privateTag = tag => parseInt(tag.slice(1,5),16)%2===1;
const stringVRs = new Set(['AE','AS','CS','DA','DS','DT','IS','LO','LT','PN','SH','ST','TM','UC','UI','UR','UT']);
const binaryVRs = new Set(['OB','OW','OF','OD','OL','OV','UN','ox']);
const numericVRs = { US:['uint16',2], SS:['int16',2], UL:['uint32',4], SL:['int32',4], FL:['float',4], FD:['double',8] };
function definition(tag) {
  if(privateTag(tag)) return null; // A private creator is needed before vendor names are meaningful.
  const exact=dictionary[formatTag(tag)];
  if(exact) return exact;
  // Repeating retired curve / overlay groups use the 5000 / 6000 definitions.
  if(/^x(50|60)[0-9a-f]{2}/.test(tag)) return dictionary[formatTag('x'+tag.slice(1,3)+'00'+tag.slice(5))];
}
function resolveVR(tag, element, dataSet) {
  const vr=element.vr||definition(tag)?.vr;
  if(vr==='xs') return dataSet.uint16('x00280103')===1?'SS':'US';
  if(vr==='ox') return 'OW';
  return vr||'UN';
}
const encodings={'':'ascii','ISO_IR 6':'ascii','ISO_IR 100':'iso-8859-1','ISO_IR 101':'iso-8859-2','ISO_IR 109':'iso-8859-3','ISO_IR 110':'iso-8859-4','ISO_IR 144':'iso-8859-5','ISO_IR 127':'iso-8859-6','ISO_IR 126':'iso-8859-7','ISO_IR 138':'iso-8859-8','ISO_IR 148':'iso-8859-9','ISO_IR 166':'windows-874','ISO_IR 13':'shift_jis','ISO_IR 192':'utf-8','GB18030':'gb18030','GBK':'gbk'};
function textValue(bytes, charset, warnings) {
  const sets=charset.split('\\').map(s=>s.trim());
  let encoding=encodings[charset.trim()];
  if(!encoding&&sets.every(s=>['','ISO 2022 IR 6','ISO 2022 IR 13','ISO 2022 IR 87','ISO 2022 IR 159'].includes(s)))encoding='iso-2022-jp';
  if(!encoding){warnings.add(`Character set ${charset} is not supported by the tag viewer; affected text is shown as bytes.`);return '[Undecoded text] '+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' ');}
  try{return new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/[\0 ]+$/g,'');}
  catch{warnings.add(`Some text could not be decoded as ${charset||'ASCII'}; replacement characters are shown.`);return new TextDecoder(encoding).decode(bytes).replace(/[\0 ]+$/g,'');}
}
function valueFor(dataSet, tag, element, vr, charset, warnings) {
  if(element.items) return {value:`${element.items.length} sequence item${element.items.length===1?'':'s'}`,binary:false};
  if(element.fragments) return {value:`Encapsulated pixel data · ${element.fragments.length} fragments · ${element.fragments.reduce((n,f)=>n+f.length,0).toLocaleString('en-US')} bytes`,binary:true};
  const length=element.length;
  if(length===0) return {value:'',binary:false};
  if(['x7fe00010','x7fe00008','x7fe00009'].includes(tag))return {value:`Pixel data · ${length.toLocaleString('en-US')} bytes`,binary:true};
  const bytes=dataSet.byteArray.subarray(element.dataOffset,element.dataOffset+length);
  if(bytes.length!==length)throw new Error('Value extends past the available data');
  if(stringVRs.has(vr))return {value:textValue(bytes,['PN','LO','LT','SH','ST','UC','UT'].includes(vr)?charset:'',warnings),binary:false};
  if(numericVRs[vr]){
    const [method,size]=numericVRs[vr];if(length%size)throw new Error(`Invalid ${vr} length`);
    return {value:Array.from({length:length/size},(_,i)=>String(dataSet[method](tag,i))).join(' \\ '),binary:false};
  }
  if(vr==='AT'){
    if(length%4)throw new Error('Invalid AT length');
    const parser=element.parser||dataSet.byteArrayParser;
    return {value:Array.from({length:length/4},(_,i)=>`(${parser.readUint16(dataSet.byteArray,element.dataOffset+i*4).toString(16).padStart(4,'0')},${parser.readUint16(dataSet.byteArray,element.dataOffset+i*4+2).toString(16).padStart(4,'0')})`.toUpperCase()).join(' \\ '),binary:false};
  }
  if(vr==='SV'||vr==='UV'){
    if(length%8)throw new Error(`Invalid ${vr} length`);
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),little=(element.parser||dataSet.byteArrayParser)===dicomParser.littleEndianByteArrayParser;
    return {value:Array.from({length:length/8},(_,i)=>String(vr==='SV'?view.getBigInt64(i*8,little):view.getBigUint64(i*8,little))).join(' \\ '),binary:false};
  }
  const prefix=binaryVRs.has(vr)?'Binary data':'Unknown value';
  return {value:`${prefix} · ${length.toLocaleString('en-US')} bytes\n${Array.from(bytes.subarray(0,32),b=>b.toString(16).padStart(2,'0')).join(' ')}${length>32?' …':''}`,binary:true};
}
export function parseDicomTags(bytes) {
  const warnings=new Set();let dataSet,partial=false;
  try{
    dataSet=dicomParser.parseDicom(bytes,{
      vrCallback:tag=>{const vr=definition(tag)?.vr;return vr?.length===2&&vr===vr.toUpperCase()?vr:undefined;},
      inflater:(source,position)=>{const inflated=inflateRaw(source.subarray(position));const result=new Uint8Array(position+inflated.length);result.set(source.subarray(0,position));result.set(inflated,position);return result;},
    });
  }catch(error){
    if(!error.dataSet)throw new Error('Could not parse the DICOM metadata. The source file may be incomplete or unsupported.');
    dataSet=error.dataSet;partial=true;warnings.add('Partial metadata: parsing stopped at a malformed or unsupported element. Only successfully parsed tags are shown.');
  }
  const rows=[],stack=[{dataSet,path:[],charset:''}];
  while(stack.length){
    const node=stack.pop();if(node.row){rows.push(node.row);continue;}
    const ds=node.dataSet,charset=ds.string('x00080005')||node.charset;
    for(const warning of ds.warnings||[])warnings.add(String(warning));
    for(const tag of Object.keys(ds.elements).sort().reverse()){
      const element=ds.elements[tag],def=definition(tag),isPrivate=privateTag(tag),creator=isPrivate&&parseInt(tag.slice(5),16)>=0x10&&parseInt(tag.slice(5),16)<=0xff;
      const vr=creator&&!element.vr?'LO':resolveVR(tag,element,ds);
      const keyword=def?.name||(creator?'PrivateCreator':isPrivate?'PrivateTag':'UnknownTag');
      const name=keyword.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2');
      let value;try{value=valueFor(ds,tag,element,vr,charset,warnings);}catch{value={value:'[Unable to read this value]',binary:true};warnings.add(`${formatTag(tag)} contains an unreadable value.`);}
      const row={tag:formatTag(tag),hex:tag.slice(1),vr,name,keyword,value:value.value,binary:value.binary,private:isPrivate,phi:isPhiTag(tag),sequence:!!element.items,path:node.path.join(' › '),length:element.length};
      if(element.items)for(let i=element.items.length-1;i>=0;i--){const child=element.items[i].dataSet;if(child)stack.push({dataSet:child,path:[...node.path,`${name} [${i+1}]`],charset});}
      stack.push({row});
    }
  }
  return {rows,warnings:[...warnings],partial};
}
