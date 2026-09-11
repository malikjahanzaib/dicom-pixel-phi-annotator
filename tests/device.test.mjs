import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceSignature, deviceLabel, deviceDetail, deviceSignatures, sopClassName, hasDevice, shortSoftware } from '../src/device.js';
const ge = { manufacturer: 'GE Medical Systems', model: 'LOGIQ9', software: 'LOGIQ9:R9.0.0', sopClass: '1.2.840.10008.5.1.4.1.1.6.1' };

test('the four attributes form one comparable signature',()=>{
  assert.equal(deviceSignature(ge), 'GE Medical Systems|LOGIQ9|1.2.840.10008.5.1.4.1.1.6.1|LOGIQ9:R9.0.0');
  // Whitespace is normalised, so padded DICOM values still compare equal.
  assert.equal(deviceSignature({ ...ge, model: '  LOGIQ9 ' }), deviceSignature(ge));
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
  assert.equal(deviceSignature({ model: 'LOGIQ9' }), '|LOGIQ9||');
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
