// Reusing boxes across frames and files. A box is native-pixel geometry, so a copy is
// only meaningful when the destination raster is EXACTLY the same size: a clamped PHI
// box could uncover text, so mismatched sizes are excluded rather than adjusted.
import { exportZone, zoneKey as identity } from './coordinates.js';
export const sameRaster = (a, b) => a.width === b.width && a.height === b.height;
export function sourceZones(image, frameIndex = image?.frameIndex) {
  return (image?.frames?.[frameIndex] || [])
    .filter(zone => exportZone(zone, image))
    .map(({ x, y, width, height, note }) => ({ x, y, width, height, note: note || '' }));
}
export function reuseTargets({ image, images = [], scope, sameCombo = false }) {
  if (!image) return [];
  if (scope === 'frames') return Array.from({ length: image.frameCount }, (_, i) => i)
    .filter(i => i !== image.frameIndex).map(frameIndex => ({ image, frameIndex }));
  const targets = [];
  for (const other of images) {
    if (other.id === image.id || !sameRaster(other, image)) continue;
    if (sameCombo && (other.combo || '') !== (image.combo || '')) continue;
    if (scope === 'files-all-frames') for (let i = 0; i < other.frameCount; i++) targets.push({ image: other, frameIndex: i });
    else targets.push({ image: other, frameIndex: other.frameIndex });
  }
  return targets;
}
// Planning is pure: nothing is written until applyPlan runs, so the UI can price the
// operation first. Merge keeps existing work and drops only exact duplicates, matching
// the union semantics the pipeline export already uses.
export function planReuse(zones, targets, mode = 'merge') {
  const frames = [];
  let added = 0, duplicates = 0, replaced = 0;
  for (const { image, frameIndex } of targets) {
    const existing = image.frames[frameIndex] || [];
    const next = mode === 'replace' ? [] : existing.map(zone => ({ ...zone }));
    const seen = new Set(next.map(identity));
    let frameAdded = 0;
    for (const zone of zones) {
      if (seen.has(identity(zone))) { duplicates++; continue; }
      seen.add(identity(zone)); next.push({ ...zone }); frameAdded++;
    }
    if (next.length === existing.length && next.every((zone, i) => identity(zone) === identity(existing[i]))) continue;
    added += frameAdded;
    if (mode === 'replace') replaced += existing.length;
    frames.push({ image, frameIndex, zones: next, added: frameAdded });
  }
  return { frames, added, duplicates, replaced, mode, files: new Set(frames.map(f => f.image.id)).size };
}
export function applyPlan(plan, beforeWrite) {
  for (const frame of plan.frames) { beforeWrite?.(frame.image, frame.frameIndex); frame.image.frames[frame.frameIndex] = frame.zones; }
  return plan;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;
export function describePlan(plan, zoneCount) {
  if (!zoneCount) return 'This frame has no boxes to copy.';
  if (!plan.frames.length) return plan.duplicates ? 'Every eligible frame already has these boxes.' : 'No eligible destination frames.';
  const parts = [`${plural(plan.added, 'box')} into ${plan.frames.length} frame${plan.frames.length === 1 ? '' : 's'} across ${plan.files} file${plan.files === 1 ? '' : 's'}`];
  if (plan.replaced) parts.push(`${plural(plan.replaced, 'box')} replaced`);
  if (plan.duplicates) parts.push(`${plan.duplicates} duplicate${plan.duplicates === 1 ? '' : 's'} skipped`);
  return parts.join(' · ');
}
