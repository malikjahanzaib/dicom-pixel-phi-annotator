import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePipelineFile, mergeImported, layoutKey, promotedLayouts } from '../src/layouts.js';
import { buildPipelineExport, pipelineLayout, hydrate } from '../src/coordinates.js';
const strip = { x: 0, y: 0, width: 420, height: 40, note: 'patient strip' };
const dob = { x: 5, y: 45, width: 180, height: 30, note: 'DOB' };
const file = (zones, over = {}) => ({ format: 'occlude-x', generated_at: 'now',
  annotations: { 16: { '640x480': { ref_width: 640, ref_height: 480, zones } } }, ...over });

test('a pipeline file parses into standalone layouts keyed by combo and size',()=>{
  const layouts = validatePipelineFile(file([strip, dob]));
  assert.deepEqual(layouts, [{ combo: '16', width: 640, height: 480, zones: [strip, dob], promoted: false }]);
  assert.equal(layoutKey(layouts[0]), '16|640x480');
  // Nothing arrives promoted: an imported layout is always reviewed before it can export.
  assert.deepEqual(promotedLayouts(layouts), []);
});

test('a malformed pipeline file is refused rather than repaired',()=>{
  assert.throws(()=>validatePipelineFile({}), /Not a pipeline annotations file/);
  assert.throws(()=>validatePipelineFile(file([], { annotations: { abc: {} } })), /Invalid combo ID/);
  assert.throws(()=>validatePipelineFile({ annotations: { 16: { '640-480': {} } } }), /Invalid size key/);
  // The declared reference size has to agree with the key, or zone bounds mean nothing.
  assert.throws(()=>validatePipelineFile({ annotations: { 16: { '640x480': { ref_width: 800, ref_height: 480, zones: [] } } } }), /disagree/);
  assert.throws(()=>validatePipelineFile(file([{ ...strip, width: 900 }])), /lies outside 640x480/);
  assert.throws(()=>validatePipelineFile(file([{ x: 0, y: 0, width: 10, height: 10 }])), /Invalid rectangle/);
  assert.throws(()=>validatePipelineFile(file([])), /contains no zones/);
});

test('importing again merges zones and sends a promoted layout back for review',()=>{
  const first = validatePipelineFile(file([strip]));
  first[0].promoted = true;
  const same = mergeImported(first, validatePipelineFile(file([strip])));
  assert.deepEqual([same.added, same.merged], [0, 0]);
  assert.equal(same.layouts[0].promoted, true, 'nothing new arrived, so the review still stands');
  // A new zone changes what would be exported, so the confirmation no longer applies.
  const grown = mergeImported(same.layouts, validatePipelineFile(file([strip, dob])));
  assert.deepEqual([grown.added, grown.merged], [0, 1]);
  assert.equal(grown.layouts[0].promoted, false);
  assert.deepEqual(grown.layouts[0].zones, [strip, dob]);
  const other = mergeImported(grown.layouts, validatePipelineFile(file([strip], { annotations: { 22: { '640x480': { ref_width: 640, ref_height: 480, zones: [strip] } } } })));
  assert.equal(other.added, 1);
  assert.deepEqual(other.layouts.map(layoutKey), ['16|640x480', '22|640x480']);
});

test('an imported layout reaches the export only once promoted, and round-trips',()=>{
  const layouts = validatePipelineFile(file([strip, dob]));
  // Held out while unreviewed: importing someone else's layout must not silently re-export.
  assert.deepEqual(buildPipelineExport([], layouts).annotations, {});
  assert.deepEqual(pipelineLayout([], '16', 640, 480, layouts), []);
  layouts[0].promoted = true;
  const exported = buildPipelineExport([], layouts);
  assert.deepEqual(Object.keys(exported), ['generated_at', 'annotations']);
  assert.deepEqual(exported.annotations, file([strip, dob]).annotations);
  // Import → promote → export reproduces the layout it came from.
  assert.deepEqual(validatePipelineFile(exported), [{ ...layouts[0], promoted: false }]);
  assert.deepEqual(pipelineLayout([], '16', 640, 480, layouts), [strip, dob]);
});

test('a promoted layout merges with file zones into one group without duplicating',()=>{
  const image = hydrate({ id: 'a'.repeat(64), name: 'x.dcm', combo: '16', width: 640, height: 480,
    frameCount: 1, frameIndex: 0, frames: { 0: [strip] }, display: {}, metadata: {} }, null);
  const layouts = validatePipelineFile(file([strip, dob]));
  layouts[0].promoted = true;
  const group = buildPipelineExport([image], layouts).annotations['16']['640x480'];
  assert.deepEqual(group.zones, [strip, dob], 'the shared zone appears once, not twice');
  assert.deepEqual(pipelineLayout([image], '16', 640, 480, layouts), [strip, dob]);
  // The existing signature still works, so callers that know nothing of layouts are unaffected.
  assert.deepEqual(pipelineLayout([image], '16', 640, 480), [strip]);
  assert.deepEqual(buildPipelineExport([image]).annotations['16']['640x480'].zones, [strip]);
});
