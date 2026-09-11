import { parseDicomTags } from './tags.js';
self.onmessage=async({data:file})=>{
  try{self.postMessage({ok:true,...parseDicomTags(new Uint8Array(await file.arrayBuffer()))});}
  catch(error){self.postMessage({ok:false,message:error.message||'Could not read DICOM tags.'});}
};
