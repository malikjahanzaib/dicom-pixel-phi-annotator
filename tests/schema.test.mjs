import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema, applySchema, validateSchemaFile, schemaFile, EXAMPLE_SCHEMA } from '../src/schema.js';
import { exportRows, buildExport, customFormatId, findFormat } from '../src/export.js';
import { hydrate } from '../src/coordinates.js';

const GE = { manufacturer: 'GE Medical Systems', model: 'LOGIQ9', sopClass: '1.2.840.10008.5.1.4.1.1.6.1', software: 'LOGIQ9:R7.0.2' };
const strip = { x: 0, y: 0, width: 420, height: 40, note: 'name strip' };
let seq = 0;
const file = (over = {}) => hydrate({
  id: String(seq++).padStart(64, 'a'), name: `s${seq}.dcm`, path: 'x', kind: 'DICOM',
  combo: '16', width: 640, height: 480, frameCount: 1, frameIndex: 0,
  frames: { 0: [strip] }, display: {}, metadata: { ...GE }, ...over,
}, null);

test('a definition is data: it may rename and nest, never compute',()=>{
  const schema = validateSchema(EXAMPLE_SCHEMA);
  assert.equal(schema.name, 'Repository rows');
  assert.equal(schema.shape, 'flat');
  assert.ok(schema.id);
  // Defaults fill in, so a minimal definition is valid.
  const minimal = validateSchema({ name: 'Bare', zone: { x: 'x', y: 'y', width: 'width', height: 'height' } });
  assert.deepEqual([minimal.group_by, minimal.shape, minimal.entries_field, minimal.zones_field, minimal.timestamp_field],
    ['attributes', 'nested', 'annotations', 'zones', 'generated_at']);
});

test('an invalid definition is refused with the reason, not silently repaired',()=>{
  const ok = { name: 'x', zone: { x: 'x' } };
  assert.throws(()=>validateSchema(null), /must be an object/);
  assert.throws(()=>validateSchema({ zone: { x: 'x' } }), /Give the schema a name/);
  assert.throws(()=>validateSchema({ name: 'x' }), /zone must map at least one coordinate/);
  // Only the documented sources are readable; a typo is caught rather than emitting undefined.
  assert.throws(()=>validateSchema({ ...ok, zone: { x: 'left' } }), /zone\.x reads "left"/);
  assert.throws(()=>validateSchema({ ...ok, entry: { a: 'patient_name' } }), /entry\.a reads "patient_name"/);
  assert.throws(()=>validateSchema({ ...ok, group_by: 'sop' }), /group_by must be one of/);
  assert.throws(()=>validateSchema({ ...ok, shape: 'tree' }), /shape must be one of/);
  // A nested schema has no size on its entry, so reading one there is a mistake worth naming.
  assert.throws(()=>validateSchema({ ...ok, shape: 'nested', entry: { w: 'ref_width' } }), /only exists per size/);
  assert.throws(()=>validateSchema({ ...ok, shape: 'flat', size: { w: 'ref_width' } }), /no sizes object/);
  // Constants may not collide with the fields the writer controls.
  assert.throws(()=>validateSchema({ ...ok, root: { annotations: 1 } }), /collides with the entries field/);
  assert.throws(()=>validateSchema({ ...ok, root: { generated_at: 1 } }), /collides with the timestamp field/);
  assert.throws(()=>validateSchema({ ...ok, root: { a: { nested: true } } }), /string, number, boolean or null/);
});

test('a flat schema renders one entry per combination and size',()=>{
  const rows = exportRows([file(), file({ width: 1024, height: 768, frames: { 0: [{ ...strip, width: 670 }] } })]);
  const out = applySchema(validateSchema(EXAMPLE_SCHEMA), rows, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(out), ['schema_version', 'generated_at', 'annotations']);
  assert.equal(out.schema_version, 3);
  assert.equal(out.generated_at, '2026-01-01T00:00:00.000Z');
  assert.equal(out.annotations.length, 2, 'two sizes become two rows');
  assert.deepEqual(out.annotations[0], {
    combination_id: '16', manufacturer: 'GE Medical Systems', model: 'LOGIQ9',
    sop_class: '1.2.840.10008.5.1.4.1.1.6.1', software_version: 'LOGIQ9:R7.0.2',
    image_width: 1024, image_height: 768, file_count: 1,
    redaction_zones: [{ x: 0, y: 0, width: 670, height: 40, label: 'Redact', source: 'occlude' }],
  });
  // In a flat schema an entry IS a combination and a size, so its counts are that size's:
  // one file at 1024x768, two at 640x480, rather than the group total in both.
  assert.equal(out.annotations[1].image_width, 640);
  assert.equal(out.annotations[1].file_count, 1);
  // The note was not mapped, so it is absent — which is how a schema opts out of carrying one.
  assert.equal('note' in out.annotations[0].redaction_zones[0], false);
});

test('a nested schema keeps the sizes object and can rename every level',()=>{
  const schema = validateSchema({
    name: 'Nested', shape: 'nested', entries_field: 'devices', sizes_field: 'rasters', zones_field: 'boxes',
    timestamp_field: '', root: { kind: 'occlude' },
    entry: { make: 'manufacturer', model: 'model' },
    size: { w: 'ref_width', h: 'ref_height', n: 'zone_count' },
    zone: { left: 'x', top: 'y', w: 'width', h: 'height', label: 'note' },
  });
  const out = applySchema(schema, exportRows([file()]));
  assert.deepEqual(Object.keys(out), ['kind', 'devices'], 'an empty timestamp field omits it');
  assert.deepEqual(out.devices[0], {
    make: 'GE Medical Systems', model: 'LOGIQ9',
    rasters: { '640x480': { w: 640, h: 480, n: 1, boxes: [{ left: 0, top: 0, w: 420, h: 40, label: 'name strip' }] } },
  });
});

test('coordinates pass through a custom schema untouched',()=>{
  const schema = validateSchema({ name: 'Odd', shape: 'flat',
    entry: { id: 'combo_id' }, zone: { a: 'x', b: 'y', c: 'width', d: 'height' } });
  const zone = { x: 37, y: 412, width: 1, height: 1, note: '' };
  const out = applySchema(schema, exportRows([file({ width: 1024, height: 768, frames: { 0: [zone] } })]));
  // Renaming a key is all a schema can do; the native-pixel values are the ones it was given.
  assert.deepEqual(out.annotations[0], { id: '16', zones: [{ a: 37, b: 412, c: 1, d: 1 }] });
});

test('grouping by combo reports that the group was not one device',()=>{
  const odd = file({ metadata: { ...GE, model: 'LOGIQ7' } });
  const byAttributes = exportRows([file(), odd]);
  assert.equal(byAttributes.length, 2, 'attributes keep them apart');
  const byCombo = exportRows([file(), odd], [], 'combo');
  assert.equal(byCombo.length, 1, 'the label gathers them');
  assert.equal(byCombo[0].attributes_source, 'mixed', 'and says so rather than picking one silently');
  assert.equal(byCombo[0].file_count, 2);
});

test('rows carry the counts a schema can report',()=>{
  const [row] = exportRows([file(), file(), file({ frames: { 0: [{ ...strip, y: 100 }] } })]);
  assert.equal(row.file_count, 3);
  assert.equal(row.zone_count, 2, 'the repeated zone is counted once');
  assert.deepEqual(row.sizes.map(s => [s.size, s.zone_count, s.file_count]), [['640x480', 2, 3]]);
});

test('a schema file round-trips and rejects anything malformed',()=>{
  const saved = [validateSchema(EXAMPLE_SCHEMA, 'fixed')];
  const out = schemaFile(saved);
  assert.equal(out.format, 'occlude-schema');
  assert.deepEqual(validateSchemaFile(out).map(s => s.name), ['Repository rows']);
  assert.throws(()=>validateSchemaFile({ format: 'other', version: 1, schemas: [] }), /Not an Occlude schema file/);
  assert.throws(()=>validateSchemaFile({ ...out, schemas: [{ name: 'broken' }] }), /zone must map/);
  // Colliding ids are re-keyed rather than overwriting one another.
  const twins = validateSchemaFile({ ...out, schemas: [saved[0], { ...saved[0], name: 'Second' }] });
  assert.notEqual(twins[0].id, twins[1].id);
});

test('the selector reaches a custom schema, and says so when one has gone',()=>{
  const schema = validateSchema(EXAMPLE_SCHEMA, 'fixed');
  const id = customFormatId(schema);
  assert.equal(id, 'custom:fixed');
  assert.match(findFormat(id, [schema]).label, /Repository rows \(custom\)/);
  const out = buildExport(id, [file()], [], [schema]);
  assert.equal(out.schema_version, 3);
  assert.ok(Array.isArray(out.annotations));
  // A format id whose schema was deleted fails loudly rather than quietly exporting v2.
  assert.throws(()=>buildExport(id, [file()], [], []), /no longer saved/);
  // The presets are unaffected by any of this.
  assert.equal(buildExport('v2', [file()], [], [schema]).schema_version, 2);
  assert.equal('schema_version' in buildExport('v1', [file()], [], [schema]), false);
  assert.equal(findFormat('nonsense', [schema]).id, 'v2');
});
