import { exportZone, imageRecord } from './coordinates.js';
export function validateBackup(value) {
  if(value?.format!=='pixel-zone-project'||value.version!==1||!Array.isArray(value.images))throw new Error('Not a supported Pixel Zone annotation backup.');
  const ids=new Set();
  return value.images.map(input=>{
    if(!input||!/^([a-f0-9]{64})$/.test(input.id)||ids.has(input.id))throw new Error('Invalid or duplicate image identifier.');
    ids.add(input.id);
    if(typeof input.name!=='string'||!['PNG','DICOM'].includes(input.kind)||![input.width,input.height,input.frameCount].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid image information.');
    if(input.combo!==''&&!/^\d+$/.test(input.combo||''))throw new Error('Invalid combo ID.');
    if(!input.frames||typeof input.frames!=='object'||Array.isArray(input.frames))throw new Error('Missing frame annotations.');
    const frames={};
    for(const [key,zones]of Object.entries(input.frames)){
      if(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=input.frameCount||!Array.isArray(zones))throw new Error('Invalid frame index.');
      frames[key]=zones.map(z=>{
        if(!z||!['x','y','width','height'].every(k=>Number.isSafeInteger(z[k]))||typeof z.note!=='string')throw new Error('Invalid native-pixel rectangle.');
        const normalized=exportZone(z,input);
        if(!normalized||['x','y','width','height'].some(k=>normalized[k]!==z[k]))throw new Error('Rectangle lies outside the source image.');
        return normalized;
      });
    }
    const frameIndex=Number.isSafeInteger(input.frameIndex)&&input.frameIndex>=0&&input.frameIndex<input.frameCount?input.frameIndex:0;
    const display={};
    if(Number.isFinite(input.display?.windowWidth)&&input.display.windowWidth>=1)display.windowWidth=input.display.windowWidth;
    if(Number.isFinite(input.display?.windowCenter))display.windowCenter=input.display.windowCenter;
    display.invert=!!input.display?.invert;
    return imageRecord({...input,path:typeof input.path==='string'?input.path:input.name,combo:input.combo,frameIndex,frames,display,metadata:input.metadata&&typeof input.metadata==='object'?input.metadata:{}});
  });
}
