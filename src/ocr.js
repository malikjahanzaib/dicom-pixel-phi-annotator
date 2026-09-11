// Detection geometry and the settings that shape it. The engine reports a hierarchy —
// blocks, paragraphs, lines, words — and which level to take, how far to pad it, what to
// discard and what to join are judgement calls that depend on the modality and the
// overlay. They belong to the operator, so they are settings rather than constants.
//
// Everything here is pure and derives from the engine's raw output, which the editor
// caches. Changing any setting re-derives; it never re-runs the engine.
import { clamp } from './coordinates.js';

export const GRANULARITIES = ['word', 'line', 'paragraph', 'block'];

// What an accepted suggestion is labelled. The recognised string is NOT used: it is the
// PHI itself, and a note is persisted, backed up, shared in templates and exported.
export const ACCEPTED_NOTE = 'detected text';
export const MAX_TEXT = 80;

export const DEFAULT_SETTINGS = {
  granularity: 'line',   // one box per text line suits most burned-in captions
  padding: 4,            // tight bounds clip glyphs, and a clipped box uncovers text
  confidence: 60,        // speckle reads as low-confidence text; clean overlays score high
  minWidth: 6,
  minHeight: 6,
  minChars: 2,           // a lone glyph is the commonest thing texture is misread as
  mergeGap: 0,           // join detections within this many pixels; 0 leaves them apart
  scale: 1,              // see ENGINE_SETTINGS
};

// Everything except scale reshapes output the engine has already produced, so moving those
// controls re-derives instantly. scale changes what the engine is given, so it only takes
// effect on the next run. The editor uses this list to say so.
export const ENGINE_SETTINGS = ['scale'];

const LIMITS = { padding: [0, 40], confidence: [0, 100], minWidth: [0, 400],
  minHeight: [0, 400], minChars: [1, 20], mergeGap: [0, 200], scale: [1, 4] };

export function validateSettings(input) {
  const out = { ...DEFAULT_SETTINGS };
  if (GRANULARITIES.includes(input?.granularity)) out.granularity = input.granularity;
  for (const [field, [lo, hi]] of Object.entries(LIMITS))
    if (Number.isFinite(input?.[field])) out[field] = clamp(Math.round(input[field]), lo, hi);
  return out;
}

// Versions of the engine report lines flat or nested; words and blocks only ever nest.
export function extractRegions(data, granularity = 'line') {
  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  if (granularity === 'block') return blocks;
  const paragraphs = blocks.flatMap(block => block?.paragraphs || []);
  if (granularity === 'paragraph') return paragraphs;
  const lines = paragraphs.flatMap(paragraph => paragraph?.lines || []);
  if (granularity === 'line') return lines.length || !Array.isArray(data?.lines) ? lines : data.lines;
  return lines.flatMap(line => line?.words || []);
}

const cleanText = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const readable = (text, minChars) => (String(text || '').match(/[a-z0-9]/gi) || []).length >= minChars;
const key = box => `${box.x}|${box.y}|${box.width}|${box.height}`;

// Steps 1 to 4: take the chosen level, drop what is not text, pad outwards, clamp to the
// raster, drop what is too small to be a caption. Confidence and merging come later, so
// moving those controls costs nothing.
// sourceScale is the factor the raster was enlarged by before the engine saw it. Dividing
// it out here is what keeps the result in source-raster pixels whatever the upscale was.
export function detectionsFrom(data, image, settings = DEFAULT_SETTINGS, sourceScale = 1) {
  const config = validateSettings(settings);
  const factor = sourceScale > 0 ? sourceScale : 1;
  const boxes = [], seen = new Set();
  for (const region of extractRegions(data, config.granularity)) {
    const bounds = region?.bbox;
    if (!bounds || !readable(region.text, config.minChars)) continue;
    const x = clamp(Math.round(bounds.x0 / factor) - config.padding, 0, image.width);
    const y = clamp(Math.round(bounds.y0 / factor) - config.padding, 0, image.height);
    const right = clamp(Math.round(bounds.x1 / factor) + config.padding, 0, image.width);
    const bottom = clamp(Math.round(bounds.y1 / factor) + config.padding, 0, image.height);
    // Held as `text`, deliberately not as `note`: nothing named note may receive it.
    const box = { x, y, width: right - x, height: bottom - y,
      text: cleanText(region.text), confidence: Math.round(Number(region.confidence) || 0) };
    if (box.width < Math.max(1, config.minWidth) || box.height < Math.max(1, config.minHeight)) continue;
    if (seen.has(key(box))) continue;
    seen.add(key(box));
    boxes.push(box);
  }
  return boxes;
}

export const aboveConfidence = (boxes, threshold) => boxes.filter(box => box.confidence >= threshold);

// Words on one caption line are separate detections but one redaction. Merging joins
// boxes whose gap is within the tolerance, keeping the lowest confidence of the pair so a
// weak member never inherits a strong one's score.
export function mergeBoxes(boxes, gap) {
  if (!(gap > 0) || boxes.length < 2) return boxes;
  const near = (a, b) =>
    a.x - gap <= b.x + b.width && b.x - gap <= a.x + a.width &&
    a.y - gap <= b.y + b.height && b.y - gap <= a.y + a.height;
  const join = (a, b) => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
      text: cleanText(`${a.text} ${b.text}`),
      confidence: Math.min(a.confidence, b.confidence) };
  };
  const out = boxes.map(box => ({ ...box }));
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        if (near(out[i], out[j])) {
          out[i] = join(out[i], out[j]);
          out.splice(j, 1);
          changed = true;
          break outer;
        }
  }
  return out;
}

// What the operator actually sees: above the floor, then joined.
export const visibleDetections = (boxes, settings = DEFAULT_SETTINGS) =>
  mergeBoxes(aboveConfidence(boxes, validateSettings(settings).confidence), validateSettings(settings).mergeGap);

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

export const toZone = ({ x, y, width, height }) => ({ x, y, width, height, note: ACCEPTED_NOTE });

// A profile is a named settings object and nothing more. One corpus wants tight word boxes
// at a low floor, another wants a padded block over a caption bar; retyping six controls
// per corpus is how an operator ends up leaving them wrong.
export const MAX_PROFILES = 24;

export function validateProfiles(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set(), out = [];
  for (const entry of input.slice(0, MAX_PROFILES)) {
    const name = String(entry?.name || '').trim().slice(0, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, settings: validateSettings(entry?.settings) });
  }
  return out;
}

export const sameSettings = (a, b) => {
  const [x, y] = [validateSettings(a), validateSettings(b)];
  return Object.keys(DEFAULT_SETTINGS).every(field => x[field] === y[field]);
};
