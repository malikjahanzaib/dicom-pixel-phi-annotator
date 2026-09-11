export const zoneKey = z => `${z.x}|${z.y}|${z.width}|${z.height}|${z.note}`;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function rectangleBetween(a, b, image) {
  const x1 = clamp(Math.round(Math.min(a.x, b.x)), 0, image.width);
  const y1 = clamp(Math.round(Math.min(a.y, b.y)), 0, image.height);
  const x2 = clamp(Math.round(Math.max(a.x, b.x)), 0, image.width);
  const y2 = clamp(Math.round(Math.max(a.y, b.y)), 0, image.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
export function exportZone(zone, image) {
  const rect = rectangleBetween(zone, { x: zone.x + zone.width, y: zone.y + zone.height }, image);
  return rect.width && rect.height ? { ...rect, note: zone.note || '' } : null;
}
// Keyboard nudging shares the pointer-drag rule: a box slides but never leaves the raster,
// and a nudge that would push past an edge is simply no movement at all.
export function nudgeZone(zone, dx, dy, image) {
  return { ...zone,
    x: clamp(zone.x + dx, 0, image.width - zone.width),
    y: clamp(zone.y + dy, 0, image.height - zone.height) };
}
export const cycleIndex = (selected, count, direction) =>
  !count ? -1 : selected < 0 ? (direction > 0 ? 0 : count - 1) : (selected + direction + count) % count;
export function parseFilename(name) {
  const match = /^combo(\d+)_(\d+)x(\d+)_s(\d+)\.(png|dcm|dicom|ima)$/i.exec(name);
  if (!match) return null;
  const width = Number(match[2]), height = Number(match[3]);
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  return { combo: match[1], width, height, sample: match[4] };
}
// Imported layouts join the export only once promoted; see src/layouts.js. The schema is
// unchanged — a promoted layout contributes zones to the same combo and size grouping an
// annotated file would, and duplicates collapse the same way.
export function buildPipelineExport(images, layouts = []) {
  const annotations = {};
  const add = (combo, width, height, zone) => {
    const group = annotations[combo] ||= {};
    const size = group[`${width}x${height}`] ||= { ref_width: width, ref_height: height, zones: [] };
    if (!size.zones.some(z => zoneKey(z) === zoneKey(zone))) size.zones.push(zone);
  };
  for (const image of images) {
    const zones = Object.values(image.frames).flat();
    if (!zones.length) continue;
    if (!/^\d+$/.test(image.combo || '')) throw new Error(`Assign a numeric combo ID to ${image.name} before pipeline export.`);
    // The pipeline consumes layout zones: union across samples AND frames, never a frame
    // index. Keep different notes, remove only exact duplicates.
    for (const value of zones) {
      const zone = exportZone(value, image);
      if (zone) add(image.combo, image.width, image.height, zone);
    }
  }
  for (const layout of layouts) {
    if (!layout.promoted) continue;
    for (const value of layout.zones) {
      const zone = exportZone(value, layout);
      if (zone) add(layout.combo, layout.width, layout.height, zone);
    }
  }
  return { generated_at: new Date().toISOString(), annotations };
}
// The pipeline applies ONE layout per combo + size, so verifying coverage means previewing
// that union — including zones contributed by other frames and other samples — not only the
// boxes drawn on the open frame. Null means no combo ID groups this image yet.
export function pipelineLayout(images, combo, width, height, layouts = []) {
  if (!/^\d+$/.test(combo || '')) return null;
  const zones = [], seen = new Set();
  const add = zone => { if (zone && !seen.has(zoneKey(zone))) { seen.add(zoneKey(zone)); zones.push(zone); } };
  for (const image of images) {
    if (image.combo !== combo || image.width !== width || image.height !== height) continue;
    for (const value of Object.values(image.frames).flat()) add(exportZone(value, image));
  }
  // Promoted imports are part of what the pipeline will apply, so Preview must show them.
  for (const layout of layouts) {
    if (!layout.promoted || layout.combo !== combo || layout.width !== width || layout.height !== height) continue;
    for (const value of layout.zones) add(exportZone(value, layout));
  }
  return zones;
}
export function imageRecord(image) {
  const { id, name, path, combo, width, height, filenameWidth, filenameHeight, sample, kind, frameCount, frameIndex, frames, display, metadata } = image;
  return { id, name, path, combo, width, height, filenameWidth, filenameHeight, sample, kind, frameCount, frameIndex, frames, display, metadata };
}
export function hydrate(record, file) {
  const image = { ...record, file, history: new Map() };
  Object.defineProperty(image, 'zones', { get() { return this.frames[this.frameIndex] ||= []; }, set(zones) { this.frames[this.frameIndex] = zones; } });
  return image;
}
