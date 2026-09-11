// Library triage: which files are shown, and assigning one combo ID to a whole batch.
// Kept pure so the counts an operator uses to judge "is this batch finished" are testable.
export const FILTERS = ['all', 'unannotated', 'annotated', 'needs-combo', 'source-needed'];
export const boxCount = image => Object.values(image.frames).flat().length;
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
  let previous = null, next = null, position = null;
  for (const [at, entry] of shown.entries()) {
    if (entry.index < index) previous = entry.index;
    else if (entry.index === index) position = at + 1;
    else if (next === null) next = entry.index;
  }
  return { previous, next, position, total: shown.length };
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
