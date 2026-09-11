import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRegions, detectionsFrom, visibleDetections, mergeBoxes, aboveConfidence, validateSettings,
  isCovered, coverage, toZone, DEFAULT_SETTINGS, ACCEPTED_NOTE, GRANULARITIES } from '../src/ocr.js';

const image = { width: 640, height: 480 };
const at = (x0, y0, x1, y1, text = 'SMITH JANE', confidence = 88) => ({ bbox: { x0, y0, x1, y1 }, text, confidence });
// The engine's hierarchy: blocks hold paragraphs hold lines hold words.
const data = {
  blocks: [{
    bbox: { x0: 10, y0: 10, x1: 300, y1: 120 }, text: 'SMITH JANE DOB 1985', confidence: 80,
    paragraphs: [{
      bbox: { x0: 10, y0: 10, x1: 300, y1: 120 }, text: 'SMITH JANE DOB 1985', confidence: 82,
      lines: [
        { bbox: { x0: 10, y0: 10, x1: 200, y1: 40 }, text: 'SMITH JANE', confidence: 90,
          words: [at(10, 10, 90, 40, 'SMITH', 92), at(110, 10, 200, 40, 'JANE', 88)] },
        { bbox: { x0: 10, y0: 90, x1: 300, y1: 120 }, text: 'DOB 1985', confidence: 85,
          words: [at(10, 90, 80, 120, 'DOB', 86), at(100, 90, 300, 120, '1985', 84)] },
      ],
    }],
  }],
};

test('every granularity is reachable, and an unknown one falls back to the default',()=>{
  assert.deepEqual(GRANULARITIES, ['word', 'line', 'paragraph', 'block']);
  assert.equal(extractRegions(data, 'block').length, 1);
  assert.equal(extractRegions(data, 'paragraph').length, 1);
  assert.equal(extractRegions(data, 'line').length, 2);
  assert.equal(extractRegions(data, 'word').length, 4);
  // A flat line list from an older engine build is still read.
  assert.equal(extractRegions({ lines: [at(0,0,10,10)] }, 'line').length, 1);
  assert.deepEqual(extractRegions(null, 'word'), []);
  assert.equal(validateSettings({ granularity: 'sentence' }).granularity, 'line');
});

test('granularity changes how many boxes a single detection run yields',()=>{
  const counts = Object.fromEntries(GRANULARITIES.map(granularity =>
    [granularity, detectionsFrom(data, image, { ...DEFAULT_SETTINGS, granularity, confidence: 0 }).length]));
  assert.deepEqual(counts, { word: 4, line: 2, paragraph: 1, block: 1 });
  // A word box is tighter than the line that contains it.
  const [word] = detectionsFrom(data, image, { ...DEFAULT_SETTINGS, granularity: 'word' });
  const [line] = detectionsFrom(data, image, { ...DEFAULT_SETTINGS, granularity: 'line' });
  assert.ok(word.width < line.width);
});

test('padding is the tightness control, and never escapes the raster',()=>{
  const tight = detectionsFrom(data, image, { ...DEFAULT_SETTINGS, padding: 0 })[0];
  const loose = detectionsFrom(data, image, { ...DEFAULT_SETTINGS, padding: 12 })[0];
  assert.deepEqual([tight.x, tight.width], [10, 190]);
  assert.deepEqual([loose.x, loose.width], [0, 212], 'padding clamps at the edge rather than going negative');
  const corner = detectionsFrom({ lines: [at(600, 460, 640, 480, 'ID')] }, image, { ...DEFAULT_SETTINGS, padding: 30 })[0];
  assert.equal(corner.x + corner.width, 640);
  assert.equal(corner.y + corner.height, 480);
  assert.equal(validateSettings({ padding: 999 }).padding, 40, 'settings are clamped to a sane range');
});

test('size and character floors discard what cannot be a caption',()=>{
  const speck = { lines: [at(10, 10, 14, 14, 'a7'), at(20, 20, 200, 50, 'PATIENT')] };
  assert.equal(detectionsFrom(speck, image, { ...DEFAULT_SETTINGS, padding: 0, minWidth: 0, minHeight: 0 }).length, 2);
  assert.equal(detectionsFrom(speck, image, { ...DEFAULT_SETTINGS, padding: 0, minWidth: 20 }).length, 1);
  assert.equal(detectionsFrom(speck, image, { ...DEFAULT_SETTINGS, padding: 0, minHeight: 20 }).length, 1);
  // Raising the character floor drops short fragments; lowering it admits single glyphs.
  assert.equal(detectionsFrom({ lines: [at(0,0,40,20,'7')] }, image, { ...DEFAULT_SETTINGS, minChars: 1 }).length, 1);
  assert.equal(detectionsFrom({ lines: [at(0,0,40,20,'7')] }, image, DEFAULT_SETTINGS).length, 0);
  assert.equal(detectionsFrom({ lines: [at(0,0,40,20,'~ ..')] }, image, { ...DEFAULT_SETTINGS, minChars: 1 }).length, 0);
});

test('merging joins neighbours and keeps the weaker confidence of the pair',()=>{
  const words = detectionsFrom(data, image, { ...DEFAULT_SETTINGS, granularity: 'word', padding: 0, confidence: 0 });
  assert.equal(mergeBoxes(words, 0).length, 4, 'a gap of zero leaves them apart');
  const joined = mergeBoxes(words, 25);
  assert.equal(joined.length, 2, 'each line’s words become one box');
  assert.deepEqual([joined[0].x, joined[0].width], [10, 190]);
  assert.equal(joined[0].text, 'SMITH JANE');
  assert.equal(joined[0].confidence, 88, 'the lower of the pair, so a weak member is not flattered');
  // A large enough tolerance joins the lines too.
  assert.equal(mergeBoxes(words, 60).length, 1);
  assert.deepEqual(mergeBoxes([], 10), []);
});

test('the visible set is the floor applied first, then the join',()=>{
  const boxes = detectionsFrom({ lines: [
    at(10, 10, 200, 40, 'LEFT BREAST', 93),
    at(210, 10, 400, 40, 'RADIAL', 91),
    at(10, 200, 600, 230, 'wmm aa', 18),
  ] }, image, { ...DEFAULT_SETTINGS, padding: 0, confidence: 0 });
  assert.equal(boxes.length, 3, 'everything survives extraction; the floor is a view');
  assert.equal(visibleDetections(boxes, { ...DEFAULT_SETTINGS, mergeGap: 0 }).length, 2);
  // Speckle below the floor is gone before merging, so it cannot drag a real box outwards.
  const merged = visibleDetections(boxes, { ...DEFAULT_SETTINGS, mergeGap: 20 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].width, 390);
  assert.equal(aboveConfidence(boxes, 0).length, 3);
});

test('coverage is reported conservatively: partial overlap is not covered',()=>{
  const box = { x: 100, y: 100, width: 100, height: 20 };
  assert.equal(isCovered(box, [{ x: 90, y: 90, width: 120, height: 40 }]), true);
  assert.equal(isCovered(box, [{ x: 100, y: 100, width: 99, height: 20 }]), false);
  // Two abutting zones that jointly span it do not count: only whole containment does.
  assert.equal(isCovered(box, [{ x: 100, y: 100, width: 50, height: 20 }, { x: 150, y: 100, width: 50, height: 20 }]), false);
  assert.equal(isCovered(box, []), false);
  const report = coverage([box, { x: 0, y: 0, width: 10, height: 10 }], [{ x: 0, y: 0, width: 20, height: 20 }]);
  assert.deepEqual([report.detected, report.uncovered], [2, 1]);
});

test('accepting a suggestion never carries the recognised text into the zone',()=>{
  const [box] = detectionsFrom({ lines: [at(100, 50, 300, 70, 'SMITH^JANE 1985-03-12')] }, image);
  const zone = toZone(box);
  assert.deepEqual(Object.keys(zone), ['x','y','width','height','note']);
  // The recognised string IS the PHI. A note is persisted, backed up, shared in templates
  // and emitted in the export, so it must never receive it.
  assert.equal(zone.note, ACCEPTED_NOTE);
  assert.equal(JSON.stringify(zone).includes('SMITH'), false);
  assert.equal('text' in zone, false, 'nor does it ride along under another key');
  assert.equal(box.text, 'SMITH^JANE 1985-03-12', 'it stays readable in memory while deciding');
});
