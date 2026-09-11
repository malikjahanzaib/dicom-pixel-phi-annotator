import fs from 'node:fs';
import path from 'node:path';
export const fixtureDir=path.resolve('.test-output/fixtures');
const ushort=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
export function element(group,tag,vr,value){
 let data=typeof value==='string'?Buffer.from(value):Buffer.isBuffer(value)?value:ushort(value);
 if(data.length%2)data=Buffer.concat([data,Buffer.from([vr==='UI'||vr==='OB'||vr==='OW'?0:32])]);
 const wide=['OB','OW','SQ','UN','UT'].includes(vr),h=Buffer.alloc(wide?12:8);h.writeUInt16LE(group);h.writeUInt16LE(tag,2);h.write(vr,4);
 if(wide)h.writeUInt32LE(data.length,8);else h.writeUInt16LE(data.length,6);return Buffer.concat([h,data]);
}
function encapsulate(data){if(data.length%2)data=Buffer.concat([data,Buffer.from([0])]);const header=Buffer.from('e07f10004f420000ffffffff','hex'),bot=Buffer.from('feff00e000000000','hex'),item=Buffer.alloc(8);item.writeUInt16LE(0xfffe);item.writeUInt16LE(0xe000,2);item.writeUInt32LE(data.length,4);return Buffer.concat([header,bot,item,data,Buffer.from('feffdde000000000','hex')]);}
export function dicom({width=640,height=480,frames=1,syntax='1.2.840.10008.1.2.1',bits=8,photo='MONOCHROME2',signed=false,compressed=null,spacing='0.8\\0.3',slope='1',intercept='0',extraTags=[],trailingTags=[]}={}){
 const color=photo==='RGB'||photo.startsWith('YBR'),components=color?3:1;
 const parts=[Buffer.alloc(128),Buffer.from('DICM'),element(2,1,'OB',Buffer.from([0,1])),element(2,2,'UI','1.2.840.10008.5.1.4.1.1.7'),element(2,3,'UI','2.25.123456789'),element(2,0x10,'UI',syntax),element(2,0x12,'UI','2.25.987654321'),
 element(8,0x16,'UI','1.2.840.10008.5.1.4.1.1.7'),element(8,0x18,'UI','2.25.123456789'),element(8,0x60,'CS','US'),element(0x20,0xd,'UI','2.25.1'),element(0x20,0xe,'UI','2.25.2'),
 element(0x28,2,'US',components),element(0x28,4,'CS',photo),...(color?[element(0x28,6,'US',0)]:[]),element(0x28,8,'IS',String(frames)),element(0x28,0x10,'US',height),element(0x28,0x11,'US',width),element(0x28,0x30,'DS',spacing),element(0x28,0x100,'US',bits),element(0x28,0x101,'US',bits),element(0x28,0x102,'US',bits-1),element(0x28,0x103,'US',signed?1:0),element(0x28,0x1050,'DS',bits===16?'0':'128'),element(0x28,0x1051,'DS',bits===16?'4096':'256'),element(0x28,0x1052,'DS',intercept),element(0x28,0x1053,'DS',slope)];
 parts.push(...extraTags);
 const pixels=Buffer.alloc(width*height*frames*components*bits/8);
 for(let f=0;f<frames;f++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const v=x<420&&y<40?240:(x>=5&&x<185&&y>=45&&y<75?180:20+f*35+Math.floor(y/height*30));
   for(let c=0;c<components;c++){const i=((f*height+y)*width+x)*components+c;if(bits===8)pixels[i]=color?(c===0?v:30):v;else if(signed)pixels.writeInt16LE((v-128)*8,i*2);else pixels.writeUInt16LE(v*8,i*2);}
 }
 if(syntax==='1.2.840.10008.1.2.5'){
  const header=Buffer.alloc(64);header.writeUInt32LE(1);header.writeUInt32LE(64,4);const runs=[];for(let y=0;y<height;y++)for(let x=0;x<width;x+=128){const chunk=pixels.subarray(y*width+x,y*width+Math.min(x+128,width));runs.push(Buffer.from([chunk.length-1]),chunk);}parts.push(encapsulate(Buffer.concat([header,...runs])));
 }else if(compressed)parts.push(encapsulate(compressed));else parts.push(element(0x7fe0,0x10,bits===8?'OB':'OW',pixels));
 return Buffer.concat([...parts,...trailingTags]);
}
export function makeFixtures(){fs.mkdirSync(fixtureDir,{recursive:true});for(const [name,options]of Object.entries({
 'combo16_640x480_s1.dcm':{frames:3},'combo16_1024x768_s1.dcm':{width:1024,height:768},'rle.dcm':{syntax:'1.2.840.10008.1.2.5'},'signed16.dcm':{bits:16,signed:true,slope:'2',intercept:'-100'},'mono1.dcm':{photo:'MONOCHROME1'},'rgb.dcm':{photo:'RGB'},'broken.dcm':null}))fs.writeFileSync(path.join(fixtureDir,name),options?dicom(options):'broken');}

export const item=bytes=>{const header=Buffer.from('feff00e000000000','hex');header.writeUInt32LE(bytes.length,4);return Buffer.concat([header,bytes]);};
export function tagFixture(){
  return dicom({frames:3,extraTags:[
    element(8,5,'CS','ISO_IR 192'),element(0x10,0x10,'PN',Buffer.from('SYNTHETIC^Zoë')),
    element(0x10,0x20,'LO','SYNTHETIC-TEST-001'),element(0x10,0x30,'DA',''),
    element(0x11,0x10,'LO','TEST_CREATOR'),element(0x11,0x1001,'LO','private calibration'),
    element(8,0x1110,'SQ',Buffer.concat([
      item(Buffer.concat([element(8,0x1155,'UI','2.25.111'),element(8,0x1140,'SQ',item(element(8,0x1155,'UI','2.25.222')))])),
      item(element(8,0x1155,'UI','2.25.333')),
    ])),
    element(0x28,9,'AT',Buffer.from([0x18,0,0x63,0])),element(0x28,0x301,'CS','YES'),
  ],trailingTags:[element(0xfffc,0xfffc,'OB',Buffer.from([1,2,3,4]))]});
}
