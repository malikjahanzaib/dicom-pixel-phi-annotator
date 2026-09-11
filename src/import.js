import dicomParser from 'dicom-parser';
import { parseFilename, hydrate } from './coordinates.js';
export async function inspectFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const id = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
  let width, height, frameCount = 1, metadata = {};
  if (png) {
    const image = await createImageBitmap(file);
    width = image.width; height = image.height; image.close();
  } else {
    let data;
    try { data = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' }); }
    catch { throw new Error('Not a readable DICOM Part 10 file or PNG.'); }
    width = data.uint16('x00280011'); height = data.uint16('x00280010');
    frameCount = Number(data.string('x00280008') || 1);
    if (!data.elements.x7fe00010) throw new Error('DICOM contains no supported image Pixel Data.');
    metadata = { modality: data.string('x00080060') || '—', photometric: data.string('x00280004') || '—', bits: data.uint16('x00280100'), transferSyntax: data.string('x00020010') || '—' };
  }
  if (![width,height,frameCount].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Invalid image dimensions or frame count.');
  const parsed = parseFilename(file.name);
  return hydrate({ id, name: file.name, path: file.webkitRelativePath || file.name, combo: parsed?.combo || '',
    width, height, filenameWidth: parsed?.width, filenameHeight: parsed?.height, sample: parsed?.sample || '',
    kind: png ? 'PNG' : 'DICOM', frameCount, frameIndex: 0, frames: { 0: [] }, display: {}, metadata }, file);
}
