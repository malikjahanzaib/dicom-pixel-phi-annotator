// Pure OCR geometry. The engine reports line boxes in the pixels of the raster it was
// handed; because that raster is always the native one, a detection is already in the
// coordinate space every zone uses. Turning detections into zones happens only here, so
// padding, clamping and the native-pixel invariant are enforced in one testable place.
import { clamp } from './coordinates.js';

// Tight OCR bounds clip glyph edges, and a clipped PHI box uncovers text. Padding out is
// the safe direction; padding in is not.
export const OCR_PADDING = 4;
export const MAX_NOTE = 80;

// A line with no alphanumeric character is engine noise over anatomy, not text.
const readable = text => /[a-z0-9]/i.test(text || '');
const cleanText = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
const key = box => `${box.x}|${box.y}|${box.width}|${box.height}`;

// Versions of the engine report lines either flat or nested under blocks and paragraphs.
export function extractLines(data) {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  const lines = [];
  for (const block of data?.blocks || [])
    for (const paragraph of block?.paragraphs || [])
      for (const line of paragraph?.lines || []) lines.push(line);
  return lines;
}

export function suggestionBoxes(lines, image, padding = OCR_PADDING) {
  const boxes = [], seen = new Set();
  for (const line of lines || []) {
    const bounds = line?.bbox;
    if (!bounds || !readable(line.text)) continue;
    const x = clamp(Math.round(bounds.x0) - padding, 0, image.width);
    const y = clamp(Math.round(bounds.y0) - padding, 0, image.height);
    const right = clamp(Math.round(bounds.x1) + padding, 0, image.width);
    const bottom = clamp(Math.round(bounds.y1) + padding, 0, image.height);
    const box = { x, y, width: right - x, height: bottom - y,
      note: cleanText(line.text), confidence: Math.round(Number(line.confidence) || 0) };
    if (box.width < 1 || box.height < 1 || seen.has(key(box))) continue;
    seen.add(key(box));
    boxes.push(box);
  }
  return boxes;
}

// A detection counts as covered only when it lies wholly inside a single zone. Partial
// overlap leaves glyphs outside the redaction, so it is reported as uncovered. The bias is
// deliberate: over-reporting wastes a glance, under-reporting hides exposed PHI.
export const isCovered = (box, zones) => zones.some(zone =>
  box.x >= zone.x && box.y >= zone.y &&
  box.x + box.width <= zone.x + zone.width &&
  box.y + box.height <= zone.y + zone.height);

export function coverage(suggestions, zones) {
  const uncovered = suggestions.filter(box => !isCovered(box, zones));
  return { detected: suggestions.length, uncovered: uncovered.length, boxes: uncovered };
}

export const toZone = ({ x, y, width, height, note }) => ({ x, y, width, height, note });
