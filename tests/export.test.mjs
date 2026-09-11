import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttributeExport, buildExport, comboConflicts, describeConflicts, resolveComboId, EXPORT_FORMATS } from '../src/export.js';
import { hydrate } from '../src/coordinates.js';
import { validatePipelineFile } from '../src/layouts.js';

const GE = { manufacturer: 'GE Medical Systems', model: 'LOGIQ9', sopClass: '1.2.840.10008.5.1.4.1.1.6.1', software: 'LOGIQ9:R7.0.2' };
const strip = { x: 0, y: 0, width: 420, height: 40, note: 'name strip' };
const dob = { x: 5, y: 45, width: 180, height: 30, note: 'DOB' };
let seq = 0;
const file = (over = {}) => hydrate({
  id: String(seq++).padStart(64, 'a'), name: over.name || `s${seq}.dcm`, path: 'x', kind: 'DICOM',
  combo: '16', width: 640, height: 480, frameCount: 1, frameIndex: 0,
  frames: { 0: [strip] }, display: {}, metadata: { ...GE }, ...over,
}, null);

test('v2 keys each entry by the device attributes the file declares',()=>{
  const out = buildAttributeExport([file(), file()]);
  assert.deepEqual(Object.keys(out), ['schema_version', 'generated_at', 'annotations']);
  assert.equal(out.schema_version, 2);
  assert.match(out.generated_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(out.annotations.length, 1, 'two files from one device are one entry');
  assert.deepEqual(out.annotations[0], {
    combo_id: '16',
    manufacturer: 'GE Medical Systems',
    model: 'LOGIQ9',
    sop_class: '1.2.840.10008.5.1.4.1.1.6.1',
    software_version: 'LOGIQ9:R7.0.2',
    attributes_source: 'dicom_tags',
    sizes: { '640x480': { ref_width: 640, ref_height: 480, zones: [strip] } },
  });
});

test('the attributes are the key, so the combo label never merges two devices',()=>{
  // Same combo ID from the filename, different software version in the tags.
  const out = buildAttributeExport([file(), file({ metadata: { ...GE, software: 'LOGIQ9:R9.0.0' }, frames: { 0: [dob] } })]);
  assert.equal(out.annotations.length, 2, 'the tags win over the shared label');
  assert.deepEqual(out.annotations.map(a => a.software_version), ['LOGIQ9:R7.0.2', 'LOGIQ9:R9.0.0']);
  // And the converse: different labels, identical tags, is one entry.
  const merged = buildAttributeExport([file(), file({ combo: '22', frames: { 0: [dob] } })]);
  assert.equal(merged.annotations.length, 1);
  assert.deepEqual(merged.annotations[0].sizes['640x480'].zones, [strip, dob]);
});

test('zones stay grouped by raster size, merged across frames and de-duplicated',()=>{
  const multi = file({ frameCount: 3, frames: { 0: [strip], 1: [dob, strip], 2: [] } });
  const other = file({ width: 1024, height: 768, frames: { 0: [{ ...strip, width: 670 }] } });
  const [entry] = buildAttributeExport([multi, other]).annotations;
  assert.deepEqual(Object.keys(entry.sizes), ['1024x768', '640x480']);
  assert.deepEqual(entry.sizes['640x480'].zones, [strip, dob], 'the repeated zone appears once');
  assert.deepEqual(entry.sizes['1024x768'], { ref_width: 1024, ref_height: 768, zones: [{ ...strip, width: 670 }] });
});

test('a missing attribute is emitted empty and marks the key as partial',()=>{
  const [entry] = buildAttributeExport([file({ metadata: { ...GE, software: '' } })]).annotations;
  assert.equal(entry.software_version, '');
  assert.equal(entry.attributes_source, 'partial');
  // A file with no tags at all is still exported rather than dropped.
  const [none] = buildAttributeExport([file({ metadata: {} })]).annotations;
  assert.deepEqual([none.manufacturer, none.model, none.sop_class, none.software_version], ['', '', '', '']);
  assert.equal(none.attributes_source, 'partial');
  assert.deepEqual(none.sizes['640x480'].zones, [strip]);
});

test('values pass through exactly, because the downstream match is exact-string',()=>{
  const odd = { manufacturer: 'GE  Medical', model: ' LOGIQ9 ', sopClass: '1.2.3', software: 'R7.0.2\\' };
  const [entry] = buildAttributeExport([file({ metadata: odd })]).annotations;
  assert.equal(entry.manufacturer, 'GE  Medical', 'internal spacing is not collapsed');
  assert.equal(entry.model, ' LOGIQ9 ', 'surrounding space is not trimmed');
  assert.equal(entry.software_version, 'R7.0.2\\');
});

test('combo_id is the commonest label, ties going to the lowest number',()=>{
  assert.equal(resolveComboId(new Map([['16', 3], ['22', 1]])), '16');
  assert.equal(resolveComboId(new Map([['22', 2], ['16', 2]])), '16', 'a tie goes to the lower number');
  assert.equal(resolveComboId(new Map([['', 5], ['16', 1]])), '', 'unassigned can win on count');
  assert.equal(resolveComboId(new Map([['', 2], ['16', 2]])), '16', 'but never on a tie');
  assert.equal(resolveComboId(new Map()), '');
  // One entry, two labels: the majority is kept as a convenience label.
  const out = buildAttributeExport([file(), file({ frames: { 0: [dob] } }), file({ combo: '22', frames: { 0: [] } })]);
  assert.equal(out.annotations[0].combo_id, '16');
});

test('an unlabelled file still exports, because the label is not the key',()=>{
  const [entry] = buildAttributeExport([file({ combo: '' })]).annotations;
  assert.equal(entry.combo_id, '');
  assert.equal(entry.sizes['640x480'].zones.length, 1);
});

test('a promoted import is marked imported, never passed off as a device read',()=>{
  const layout = { combo: '16', width: 640, height: 480, zones: [dob], promoted: true };
  const out = buildAttributeExport([file()], [layout, { ...layout, combo: '22', promoted: false }]);
  assert.equal(out.annotations.length, 2, 'an import is its own entry; an unpromoted one is absent');
  const imported = out.annotations.find(a => a.attributes_source === 'imported');
  assert.deepEqual([imported.manufacturer, imported.model, imported.sop_class, imported.software_version], ['', '', '', '']);
  assert.deepEqual(imported.sizes['640x480'].zones, [dob]);
});

test('files sharing a combo but not their tags are reported, not merged',()=>{
  const a = file({ name: 'a.dcm' }), b = file({ name: 'b.dcm' });
  const odd = file({ name: 'odd.dcm', metadata: { ...GE, model: 'LOGIQ7' } });
  assert.deepEqual(comboConflicts([a, b]), [], 'agreement is silent');
  const [conflict] = comboConflicts([a, b, odd]);
  assert.equal(conflict.combo, '16');
  assert.equal(conflict.variants.length, 2);
  assert.deepEqual(conflict.variants[0].files, ['a.dcm', 'b.dcm'], 'the majority is listed first');
  assert.deepEqual(conflict.variants[1].files, ['odd.dcm']);
  const text = describeConflicts([conflict]);
  assert.match(text, /Combo 16 holds 2 different device combinations/);
  assert.match(text, /LOGIQ7/);
  assert.match(text, /odd\.dcm/);
  assert.equal(describeConflicts([]), '');
  // An unannotated file is not part of the export and so raises nothing.
  assert.deepEqual(comboConflicts([a, file({ name: 'empty.dcm', metadata: { ...GE, model: 'X' }, frames: { 0: [] } })]), []);
  // Neither does an unlabelled one: there is no label to be in conflict with.
  assert.deepEqual(comboConflicts([a, file({ name: 'nolabel.dcm', combo: '', metadata: { ...GE, model: 'X' } })]), []);
});

test('the selector produces each preset, and v1 stays exactly as it was',()=>{
  assert.deepEqual(EXPORT_FORMATS.map(f => f.id), ['v2', 'v1']);
  const images = [file()];
  assert.equal(buildExport('v2', images).schema_version, 2);
  const v1 = buildExport('v1', images);
  // Byte-identical to the original schema: no version field, combo-keyed, same shape.
  assert.deepEqual(Object.keys(v1), ['generated_at', 'annotations']);
  assert.equal('schema_version' in v1, false);
  assert.deepEqual(v1.annotations, { '16': { '640x480': { ref_width: 640, ref_height: 480, zones: [strip] } } });
  // v1 still round-trips through the importer, which only understands that shape.
  assert.deepEqual(validatePipelineFile(v1).map(l => l.zones), [[strip]]);
  // An unknown id falls back to the default rather than producing nothing.
  assert.equal(buildExport('nonsense', images).schema_version, 2);
});
