import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLines, suggestionBoxes, isCovered, coverage, toZone, aboveConfidence, OCR_PADDING, DEFAULT_CONFIDENCE, ACCEPTED_NOTE } from '../src/ocr.js';
const image = { width: 640, height: 480 };
const line = (x0, y0, x1, y1, text = 'SMITH^JANE', confidence = 88) => ({ bbox: { x0, y0, x1, y1 }, text, confidence });

test('lines are read whether the engine reports them flat or nested',()=>{
  assert.equal(extractLines({ lines: [line(0,0,10,10)] }).length, 1);
  assert.equal(extractLines({ blocks: [{ paragraphs: [{ lines: [line(0,0,10,10), line(0,0,20,10)] }] }] }).length, 2);
  // A flat list wins when both are present, and malformed shapes yield nothing rather than throwing.
  assert.deepEqual(extractLines({}), []);
  assert.deepEqual(extractLines(null), []);
  assert.deepEqual(extractLines({ blocks: [{}, { paragraphs: [{}] }] }), []);
});

test('a detection becomes a padded, clamped, native-pixel box',()=>{
  const [box] = suggestionBoxes([line(100, 50, 300, 70)], image);
  // Padded outwards on every side: tight bounds clip glyphs, and a clipped box uncovers text.
  assert.deepEqual(box, { x: 100-OCR_PADDING, y: 50-OCR_PADDING, width: 200+2*OCR_PADDING, height: 20+2*OCR_PADDING, text: 'SMITH^JANE', confidence: 88 });
  // Padding never escapes the raster, so an accepted box is always a legal zone.
  const [edge] = suggestionBoxes([line(0, 0, 640, 12)], image);
  assert.deepEqual([edge.x, edge.y, edge.width, edge.height], [0, 0, 640, 16]);
  const [corner] = suggestionBoxes([line(636, 474, 640, 480)], image);
  assert.equal(corner.x + corner.width, 640);
  assert.equal(corner.y + corner.height, 480);
  assert.equal(suggestionBoxes([line(10,10,200,30)], image, 0)[0].width, 190);
});

test('noise, empty boxes and duplicates never reach the operator',()=>{
  // No alphanumeric character means the engine found texture, not text.
  assert.deepEqual(suggestionBoxes([line(10,10,80,20,'~ ..'), line(10,10,80,20,'|')], image), []);
  // One stray glyph is the commonest thing speckle is misread as, and is never a caption.
  assert.deepEqual(suggestionBoxes([line(10,10,80,20,'l'), line(10,10,80,20,'. 7 .')], image), []);
  assert.equal(suggestionBoxes([line(10,10,80,20,'2D')], image).length, 1);
  assert.deepEqual(suggestionBoxes([{ text: 'DOB' }], image), []);
  // The same line reported twice is one suggestion.
  assert.equal(suggestionBoxes([line(10,10,80,20), line(10,10,80,20)], image).length, 1);
  // Text is collapsed to one line and capped, so a note stays readable in the list.
  const [box] = suggestionBoxes([line(10,10,300,30,'  ACC\n 12345\t678  ')], image);
  assert.equal(box.text, 'ACC 12345 678');
  assert.equal(suggestionBoxes([line(10,10,400,30,'A'.repeat(200))], image)[0].text.length, 80);
});

test('coverage is reported conservatively: partial overlap is not covered',()=>{
  const box = { x: 100, y: 100, width: 100, height: 20 };
  assert.equal(isCovered(box, [{ x: 90, y: 90, width: 120, height: 40 }]), true);
  assert.equal(isCovered(box, [{ x: 100, y: 100, width: 100, height: 20 }]), true, 'an exact fit counts as covered');
  // Text sticking out of a zone stays exposed after redaction, so it must still be flagged.
  assert.equal(isCovered(box, [{ x: 100, y: 100, width: 99, height: 20 }]), false);
  assert.equal(isCovered(box, [{ x: 101, y: 100, width: 100, height: 20 }]), false);
  // Two abutting zones that jointly span it do not count: only whole containment does.
  assert.equal(isCovered(box, [{ x: 100, y: 100, width: 50, height: 20 }, { x: 150, y: 100, width: 50, height: 20 }]), false);
  assert.equal(isCovered(box, []), false);
  const report = coverage([box, { x: 0, y: 0, width: 10, height: 10 }], [{ x: 0, y: 0, width: 20, height: 20 }]);
  assert.deepEqual([report.detected, report.uncovered], [2, 1]);
  assert.deepEqual(report.boxes, [box]);
});

test('accepting a suggestion never carries the recognised text into the zone',()=>{
  const [box] = suggestionBoxes([line(100,50,300,70,'SMITH^JANE 1985-03-12')], image);
  const zone = toZone(box);
  assert.deepEqual(Object.keys(zone), ['x','y','width','height','note']);
  // The recognised string IS the PHI. A note is persisted, backed up, shared in templates
  // and emitted in the export, so it must never receive it.
  assert.equal(zone.note, ACCEPTED_NOTE);
  assert.doesNotMatch(zone.note, /SMITH|1985/);
  assert.equal(JSON.stringify(zone).includes('SMITH'), false);
  assert.equal('text' in zone, false, 'the text does not ride along under another key');
  assert.equal('confidence' in zone, false);
  // It stays available in memory for the operator to read while deciding.
  assert.equal(box.text, 'SMITH^JANE 1985-03-12');
});

test('the confidence floor hides weak detections without discarding them',()=>{
  const boxes = suggestionBoxes([
    line(10,10,300,30,'LEFT RETROAREOLAR',93),
    line(10,60,300,80,'AREA OF PAIN',88),
    line(10,120,600,140,'wmm aa',21),      // speckle read as a text line
    line(10,180,600,200,'r ee te',44),
  ], image);
  assert.equal(boxes.length, 4, 'everything the engine returned is kept');
  assert.deepEqual(aboveConfidence(boxes, DEFAULT_CONFIDENCE).map(b=>b.text), ['LEFT RETROAREOLAR','AREA OF PAIN']);
  // Lowering the floor reveals them again — no second run of the engine is needed.
  assert.equal(aboveConfidence(boxes, 40).length, 3);
  assert.equal(aboveConfidence(boxes, 0).length, 4);
  assert.equal(aboveConfidence(boxes, 100).length, 0);
  assert.deepEqual(aboveConfidence([], 60), []);
});
