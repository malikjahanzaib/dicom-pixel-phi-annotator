// Contact-sheet logic. Per-file Preview verifies one image; this is what makes an outlier
// across a whole combo obvious — the scanner variant that puts the strip bottom-left, or
// the file nobody annotated. Kept pure so scope, flags and grid arithmetic are testable.
import { boxCount } from './library.js';

export const CONTACT_SCOPES = ['combo', 'size', 'all'];

export function contactFiles(images, open, scope) {
  const entries = images.map((image, index) => ({ image, index }));
  if (!open || scope === 'all') return entries;
  const combo = open.combo || '';
  return entries.filter(({ image }) => (image.combo || '') === combo &&
    (scope !== 'size' || (image.width === open.width && image.height === open.height)));
}

// What makes a thumbnail worth a second look. None of these is a verdict — a file with no
// flags has not been checked, it has merely not tripped one of these three tests.
export function thumbFlags(image, uncoveredText = 0) {
  const flags = [];
  if (!image.file) flags.push('no source');
  else if (!boxCount(image)) flags.push('no zones');
  if (!/^\d+$/.test(image.combo || '')) flags.push('no combo');
  if (uncoveredText > 0) flags.push(`${uncoveredText} uncovered`);
  return flags;
}

// Presentation only: a thumbnail is a scaled view, and nothing computed here is ever
// written back to a zone. Saved geometry stays in native source pixels.
export function scaleZones(zones, image, width, height) {
  const sx = width / image.width, sy = height / image.height;
  return zones.map(zone => ({
    x: zone.x * sx, y: zone.y * sy,
    width: Math.max(1, zone.width * sx), height: Math.max(1, zone.height * sy) }));
}

// Uniform cells, so the visible rows are arithmetic rather than measurement — the same
// approach the library list uses, which is what keeps a thousand-file scope interactive.
export function gridWindow({ count, width, cellWidth, cellHeight, scrollTop, viewportHeight, overscan = 1 }) {
  const columns = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.ceil(count / columns);
  const firstRow = Math.max(0, Math.floor(scrollTop / cellHeight) - overscan);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + viewportHeight) / cellHeight) + overscan);
  return { columns, rows, height: rows * cellHeight, offset: firstRow * cellHeight,
    from: firstRow * columns, to: Math.min(count, lastRow * columns) };
}
