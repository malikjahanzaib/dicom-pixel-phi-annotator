import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceSignature, deviceLabel, deviceDetail, deviceSignatures, sopClassName, hasDevice, shortSoftware, deviceAttributes, attributesSource, attributeKey } from '../src/device.js';
const ge = { manufacturer: 'GE Medical Systems', model: 'LOGIQ9', software: 'LOGIQ9:R9.0.0', sopClass: '1.2.840.10008.5.1.4.1.1.6.1' };

test('the four attributes form one comparable signature, compared exactly',()=>{
  const NUL = '\u0000';
  assert.equal(deviceSignature(ge), ['GE Medical Systems','LOGIQ9','1.2.840.10008.5.1.4.1.1.6.1','LOGIQ9:R9.0.0'].join(NUL));
  // NUL separates because it cannot occur in a DICOM string value. A printable separator
  // could appear inside a software version and make two different devices collide.
  assert.equal(deviceSignature({ ...ge, model: 'A|B', software: '' }), deviceSignature({ ...ge, model: 'A', software: 'B|' }) === undefined ? undefined : deviceSignature({ ...ge, model: 'A|B', software: '' }));
  assert.notEqual(deviceSignature({ ...ge, model: 'A|B', software: 'C' }), deviceSignature({ ...ge, model: 'A', software: 'B|C' }));
  // Values are compared exactly: the downstream repository matches these strings, so a
  // stray space is a different device rather than something to tidy away here.
  assert.notEqual(deviceSignature({ ...ge, model: ' LOGIQ9' }), deviceSignature(ge));
  assert.notEqual(deviceSignature({ ...ge, model: 'LOGIQ  9' }), deviceSignature({ ...ge, model: 'LOGIQ 9' }));
  // A change in any one of the four is a different combination.
  for (const field of ['manufacturer','model','software','sopClass'])
    assert.notEqual(deviceSignature({ ...ge, [field]: 'other' }), deviceSignature(ge));
});

test('a file with no device tags is unknown, never equal to another unknown',()=>{
  assert.equal(deviceSignature({}), null);
  assert.equal(deviceSignature(undefined), null);
  assert.equal(deviceSignature({ modality: 'US' }), null, 'other metadata does not count');
  assert.equal(hasDevice(ge), true);
  assert.equal(hasDevice({ manufacturer: '' }), false);
  // Partial information still signs, so two half-known files are not assumed identical.
  assert.equal(deviceSignature({ model: 'LOGIQ9' }), ['','LOGIQ9','',''].join('\u0000'));
});

test('SOP class UIDs read as names, and an unknown one is shown rather than guessed',()=>{
  assert.equal(sopClassName('1.2.840.10008.5.1.4.1.1.6.1'), 'Ultrasound Image');
  assert.equal(sopClassName('1.2.840.10008.5.1.4.1.1.7'), 'Secondary Capture Image');
  assert.equal(sopClassName('1.2.3.4.5'), '1.2.3.4.5');
  assert.equal(sopClassName(''), '');
  assert.equal(sopClassName(undefined), '');
});

test('labels read for a sidebar, and drop what is missing rather than printing gaps',()=>{
  // The model prefix is dropped for display so the version survives a narrow rail.
  assert.equal(deviceLabel(ge), 'GE Medical Systems · LOGIQ9 · R9.0.0');
  assert.equal(deviceDetail(ge), 'GE Medical Systems · LOGIQ9 · R9.0.0 · Ultrasound Image');
  assert.equal(shortSoftware(ge), 'R9.0.0');
  assert.equal(shortSoftware({ model: 'LOGIQ9', software: 'LOGIQ9 - R9.0.0' }), 'R9.0.0');
  // Only a genuine prefix is dropped, and never the whole value.
  assert.equal(shortSoftware({ model: 'LOGIQ9', software: 'R9.0.0' }), 'R9.0.0');
  assert.equal(shortSoftware({ model: 'LOGIQ9', software: 'LOGIQ9' }), 'LOGIQ9');
  assert.equal(shortSoftware({ model: 'EPIQ 7', software: 'EPIQ 7:1.2' }), '1.2', 'a model with a space is still matched');
  assert.equal(shortSoftware({ software: 'R9.0.0' }), 'R9.0.0');
  // The signature is unaffected: it compares what the file actually says.
  assert.match(deviceSignature(ge), /LOGIQ9:R9\.0\.0/);
  assert.equal(deviceLabel({ manufacturer: 'GE Medical Systems', model: 'LOGIQ9' }), 'GE Medical Systems · LOGIQ9');
  assert.equal(deviceLabel({}), '');
});

test('a combo carrying more than one signature is what a wrong ID looks like',()=>{
  const file = metadata => ({ metadata });
  assert.deepEqual(deviceSignatures([file(ge), file({ ...ge })]).length, 1);
  assert.equal(deviceSignatures([file(ge), file({ ...ge, software: 'LOGIQ9:R8.0.0' })]).length, 2);
  // Files with no tags neither create nor mask a disagreement.
  assert.equal(deviceSignatures([file(ge), file({}), file(undefined)]).length, 1);
  assert.deepEqual(deviceSignatures([]), []);
});

test('extraction keeps tag values verbatim and reports completeness',()=>{
  // Exactly the four, exactly as the tag carried them — no trimming or reformatting,
  // because the downstream match is exact-string on these values.
  assert.deepEqual(deviceAttributes({ ...ge, modality: 'US', bits: 8 }),
    { manufacturer: 'GE Medical Systems', model: 'LOGIQ9', sopClass: '1.2.840.10008.5.1.4.1.1.6.1', software: 'LOGIQ9:R9.0.0' });
  assert.deepEqual(deviceAttributes({ manufacturer: ' GE ' }), { manufacturer: ' GE ', model: '', sopClass: '', software: '' });
  assert.deepEqual(deviceAttributes(undefined), { manufacturer: '', model: '', sopClass: '', software: '' });
  assert.equal(attributesSource(deviceAttributes(ge)), 'dicom_tags');
  // One missing attribute is enough to mark the key as not authoritative.
  assert.equal(attributesSource(deviceAttributes({ ...ge, software: '' })), 'partial');
  assert.equal(attributesSource(deviceAttributes({})), 'partial');
  // Unlike the library's signature, the export key always exists, so tagless files group
  // together and are emitted as partial rather than dropped.
  assert.equal(attributeKey(deviceAttributes({})), '\u0000\u0000\u0000');
  assert.equal(deviceSignature({}), null);
});
