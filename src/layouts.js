// Imported pipeline layouts. The pipeline export is a layout keyed by combo and size with
// no source files and no frame ownership, so an imported one cannot attach to a file — it
// stands on its own. It is held out of the export until the operator promotes it, so a
// layout produced by someone else is never re-exported without a deliberate review.
import { exportZone, zoneKey } from './coordinates.js';

export const layoutKey = layout => `${layout.combo}|${layout.width}x${layout.height}`;

export function validatePipelineFile(value) {
  const annotations = value?.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations))
    throw new Error('Not a pipeline annotations file.');
  const layouts = [];
  for (const [combo, sizes] of Object.entries(annotations)) {
    if (!/^\d+$/.test(combo)) throw new Error(`Invalid combo ID “${combo}”.`);
    if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) throw new Error(`Invalid sizes for combo ${combo}.`);
    for (const [size, group] of Object.entries(sizes)) {
      const match = /^(\d+)x(\d+)$/.exec(size);
      if (!match) throw new Error(`Invalid size key “${size}” in combo ${combo}.`);
      const width = Number(match[1]), height = Number(match[2]);
      if (group?.ref_width !== width || group?.ref_height !== height)
        throw new Error(`ref_width and ref_height disagree with “${size}” in combo ${combo}.`);
      if (!Array.isArray(group.zones)) throw new Error(`Missing zones for combo ${combo} at ${size}.`);
      const zones = group.zones.map(zone => {
        if (!zone || !['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger(zone[k])) || typeof zone.note !== 'string')
          throw new Error(`Invalid rectangle in combo ${combo} at ${size}.`);
        // Rejected rather than clipped, exactly as a project backup is: a layout that does
        // not fit the raster it names is a defect in the file, not something to repair.
        const normalized = exportZone(zone, { width, height });
        if (!normalized || ['x', 'y', 'width', 'height'].some(k => normalized[k] !== zone[k]))
          throw new Error(`A rectangle in combo ${combo} lies outside ${size}.`);
        return normalized;
      });
      if (zones.length) layouts.push({ combo, width, height, zones, promoted: false });
    }
  }
  if (!layouts.length) throw new Error('That file contains no zones.');
  return layouts;
}

export function mergeImported(existing, incoming) {
  const byKey = new Map(existing.map(layout => [layoutKey(layout), layout]));
  let added = 0, merged = 0;
  for (const layout of incoming) {
    const current = byKey.get(layoutKey(layout));
    if (!current) { byKey.set(layoutKey(layout), { ...layout }); added++; continue; }
    const seen = new Set(current.zones.map(zoneKey));
    let fresh = 0;
    for (const zone of layout.zones) if (!seen.has(zoneKey(zone))) { seen.add(zoneKey(zone)); current.zones.push(zone); fresh++; }
    // Zones arriving into a layout already promoted send it back for review: what was
    // confirmed is not what would now be exported.
    if (fresh) { current.promoted = false; merged += fresh; }
  }
  return { layouts: [...byKey.values()], added, merged };
}

export const promotedLayouts = layouts => layouts.filter(layout => layout.promoted);
