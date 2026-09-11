import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDicomTags } from '../src/tags.js';
import { filterTags, tagCounts } from '../src/tag-search.js';
import { isPhiTag } from '../src/phi.js';
import { dicom, element, tagFixture, item } from './fixtures.mjs';
test('all standard/private tags, nested sequence items, and tags after Pixel Data are present',()=>{
  const result=parseDicomTags(tagFixture());assert.equal(result.partial,false);assert.deepEqual(result.warnings,[]);
  assert.equal(result.rows.find(r=>r.hex==='00100010').value,'SYNTHETIC^Zoë');
  assert.equal(result.rows.find(r=>r.hex==='00100030').value,'');
  assert.equal(result.rows.find(r=>r.hex==='00280010').value,'480');
  assert.equal(result.rows.find(r=>r.hex==='00280009').value,'(0018,0063)');
  assert.equal(result.rows.filter(r=>r.private).length,2);
  assert.equal(result.rows.find(r=>r.hex==='00111001').value,'private calibration');
  assert.equal(result.rows.filter(r=>r.hex==='00081155').length,3);
  assert.match(result.rows.find(r=>r.value==='2.25.222').path,/Referenced Study Sequence \[1\] › Referenced Image Sequence \[1\]/);
  assert.match(result.rows.find(r=>r.hex==='7fe00010').value,/921,600 bytes/);
  assert.ok(result.rows.some(r=>r.hex==='fffcfffc'));
});
test('search matches formatted/compact tags, keyword, name, value, and sequence context',()=>{
  const {rows}=parseDicomTags(tagFixture());
  for(const query of ['(0010,0010)','00100010','0010, 0010','x00100010','0x00100010','patientname','patient name','zoë'])assert.equal(filterTags(rows,query)[0].hex,'00100010',query);
  assert.equal(filterTags(rows,'calibration','private').length,1);
  assert.equal(filterTags(rows,'','sequences').length,2);
  assert.equal(filterTags(rows,'2.25.333')[0].path,'Referenced Study Sequence [2]');
  assert.equal(filterTags(rows,'no matching tag').length,0);
});
test('the PS3.15 lens flags identifying attributes and leaves image description alone',()=>{
  // Accepts either tag spelling, and folds the repeating overlay/curve groups like the dictionary.
  assert.equal(isPhiTag('x00100010'),true);assert.equal(isPhiTag('00100010'),true);
  assert.equal(isPhiTag('x60124000'),true);assert.equal(isPhiTag('x50021000'),false);
  // Pixel data and image geometry are not identity and must not be swept in.
  for(const tag of ['x7fe00010','x00280010','x00280011','x00280100','x00080060','x00080016'])
    assert.equal(isPhiTag(tag),false,tag);
  const {rows}=parseDicomTags(tagFixture());
  const identifying=filterTags(rows,'','phi');
  assert.deepEqual(identifying.map(r=>r.hex).sort(),
    ['00080018','00081110','00081140','00081155','00081155','00081155','00100010','00100020','00100030','0020000d','0020000e']);
  // Nested references inside sequences are reached, with their sequence context intact.
  assert.match(identifying.find(r=>r.value==='2.25.222').path,/Referenced Image Sequence/);
  // The filter composes with search, and every filter reports its own count.
  assert.equal(filterTags(rows,'zoë','phi').length,1);
  assert.equal(filterTags(rows,'columns','phi').length,0);
  const counts=tagCounts(rows);
  assert.equal(counts.phi,11);assert.equal(counts.private,2);assert.equal(counts.sequences,2);
  assert.equal(counts.all,rows.length);assert.equal(counts.standard+counts.private,rows.length);
  // Burned In Annotation is reported on its own, not folded into the profile list.
  assert.equal(rows.find(r=>r.hex==='00280301').value,'YES');
  assert.equal(rows.find(r=>r.hex==='00280301').phi,false);
});
test('implicit VR sequences use the dictionary and binary values remain summarized',()=>{
  const meta=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0x10,'UI','1.2.840.10008.1.2')]);
  const implicit=(group,tag,data)=>{const h=Buffer.alloc(8);h.writeUInt16LE(group);h.writeUInt16LE(tag,2);h.writeUInt32LE(data.length,4);return Buffer.concat([h,data]);};
  const bytes=Buffer.concat([meta,implicit(8,0x1110,item(implicit(8,0x1155,Buffer.from('2.25.444')))),implicit(0x28,0x10,Buffer.from([0xe0,1])),implicit(0x7fe0,0x10,Buffer.from([0,1,2,3]))]);
  const {rows}=parseDicomTags(bytes);assert.equal(rows.find(r=>r.hex==='00081110').vr,'SQ');assert.equal(rows.find(r=>r.hex==='00081155').value,'2.25.444');assert.equal(rows.find(r=>r.hex==='00280010').value,'480');assert.equal(rows.find(r=>r.hex==='7fe00010').binary,true);
});
test('unsupported character sets are reported without silently misdecoding text',()=>{
  const {warnings,rows}=parseDicomTags(dicom({extraTags:[element(8,5,'CS','UNSUPPORTED'),element(0x10,0x10,'PN','TEST')]}));
  assert.match(warnings.join(' '),/not supported/);assert.match(rows.find(r=>r.hex==='00100010').value,/Undecoded text/);
});
