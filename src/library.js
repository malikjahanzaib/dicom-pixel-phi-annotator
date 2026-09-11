// Library triage: which files are shown, and assigning one combo ID to a whole batch.
// Kept pure so the counts an operator uses to judge "is this batch finished" are testable.
import { deviceSignature, deviceSignatures } from './device.js';

export const FILTERS = ['all', 'unannotated', 'annotated', 'needs-combo', 'source-needed'];
export const UNASSIGNED = 'unassigned';
// Counting walks every frame of an image, so at a thousand multiframe files it is the
// hot path behind each keystroke. Cache per image; only the edited image is invalidated.
const counted = new WeakMap();
export function boxCount(image) {
  let n = counted.get(image);
  if (n === undefined) {
    n = 0;
    for (const zones of Object.values(image.frames)) n += zones.length;
    counted.set(image, n);
  }
  return n;
}
export const invalidateCount = image => { if (image) counted.delete(image); };
// The same gate buildPipelineExport enforces, so this filter means exactly "blocks export".
const exportable = image => /^\d+$/.test(image.combo || '');
export function matchesFilter(image, filter) {
  switch (filter) {
    case 'unannotated': return boxCount(image) === 0;
    case 'annotated': return boxCount(image) > 0;
    case 'needs-combo': return boxCount(image) > 0 && !exportable(image);
    case 'source-needed': return !image.file;
    default: return true;
  }
}
// Indices are the library's identity for showImage, so they survive filtering.
export function filterLibrary(images, query = '', filter = 'all') {
  const q = query.trim().toLowerCase();
  return images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => matchesFilter(image, filter) &&
      (!q || `${image.name} ${image.path || ''} ${image.combo}`.toLowerCase().includes(q)));
}
export function filterCounts(images) {
  const counts = Object.fromEntries(FILTERS.map(f => [f, 0]));
  for (const image of images) {
    const boxes = boxCount(image);
    counts.all++;
    if (boxes) { counts.annotated++; if (!exportable(image)) counts['needs-combo']++; } else counts.unannotated++;
    if (!image.file) counts['source-needed']++;
  }
  return counts;
}
// Navigation follows the library view. The open file may not be in that view — assigning
// its combo ID can drop it straight out of a "Needs combo ID" filter — so neighbours are
// defined by underlying position rather than by membership, and position may be null.
export function navigation(shown, index) {
  // Grouping reorders the view — Unassigned is pinned above the combos — so stepping
  // follows the order rows are actually drawn in, not the order files were imported.
  const at = shown.findIndex(entry => entry.index === index);
  if (at >= 0) return {
    previous: at > 0 ? shown[at - 1].index : null,
    next: at < shown.length - 1 ? shown[at + 1].index : null,
    position: at + 1, total: shown.length };
  // The open file is not in the view at all; fall back to the nearest row on either
  // side by underlying position, so there is still somewhere to step to.
  let previous = null, next = null;
  for (const entry of shown) { if (entry.index < index) previous = entry.index; else if (next === null) next = entry.index; }
  return { previous, next, position: null, total: shown.length };
}
const sizeKey = image => `${image.width}\u00d7${image.height}`;
// One group per device combination, because the operator works a combo at a time.
// Files whose combo could not be parsed go to a pinned group of their own rather than
// being folded into a real combo, where they would be annotated under the wrong layout.
export function groupLibrary(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const combo = entry.image.combo || '';
    const key = combo || UNASSIGNED;
    let group = groups.get(key);
    if (!group) {
      group = { key, combo, files: [], sizes: [], annotated: 0, needsCombo: !combo };
      groups.set(key, group);
    }
    group.files.push(entry);
    if (boxCount(entry.image)) group.annotated++;
    const size = sizeKey(entry.image);
    let bucket = group.sizes.find(s => s.size === size);
    if (!bucket) group.sizes.push(bucket = { size, width: entry.image.width, height: entry.image.height, files: [] });
    bucket.files.push(entry);
  }
  for (const group of groups.values()) {
    group.total = group.files.length;
    group.sizes.sort((a, b) => a.width - b.width || a.height - b.height);
    // What the files themselves say they came from. More than one signature means the
    // combo ID is grouping different machines.
    group.devices = deviceSignatures(group.files.map(entry => entry.image));
    group.device = group.files.map(entry => entry.image).find(image => deviceSignature(image.metadata))?.metadata || null;
    group.mixedDevices = group.devices.length > 1;
  }
  return [...groups.values()].sort((a, b) =>
    (a.key === UNASSIGNED ? -1 : 0) - (b.key === UNASSIGNED ? -1 : 0) ||
    Number(a.combo) - Number(b.combo) || a.combo.localeCompare(b.combo));
}
// A flat row list is what makes windowing possible: collapsed groups contribute their
// header only, so the rendered DOM never grows with the size of the batch.
export function libraryRows(groups, collapsed = new Set()) {
  const rows = [];
  for (const group of groups) {
    rows.push({ type: 'group', group });
    if (collapsed.has(group.key)) continue;
    const single = group.sizes.length === 1;
    for (const bucket of group.sizes) {
      if (!single) rows.push({ type: 'size', group, bucket });
      for (const entry of bucket.files) rows.push({ type: 'file', group, entry });
    }
  }
  return rows;
}
export function planComboAssignment(images, combo) {
  const unchanged = [], assigned = [], overwritten = [];
  for (const image of images) {
    const now = image.combo || '';
    if (now === combo) unchanged.push(image);
    else if (now === '') assigned.push(image);
    else overwritten.push(image);
  }
  return { unchanged, assigned, overwritten, changed: assigned.length + overwritten.length };
}
const files = n => `${n} file${n === 1 ? '' : 's'}`;
export function describeComboAssignment(plan, combo) {
  const lines = [combo ? `Set ${files(plan.changed)} to combo ${combo}?` : `Clear the combo ID on ${files(plan.changed)}?`];
  if (plan.overwritten.length) {
    const ids = [...new Set(plan.overwritten.map(image => image.combo))];
    lines.push(`${files(plan.overwritten.length)} already carry a different ID (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}) and will be overwritten.`);
  }
  if (plan.unchanged.length) lines.push(`${files(plan.unchanged.length)} already match and stay as they are.`);
  lines.push('Combo IDs are not covered by undo.');
  return lines.join('\n');
}
