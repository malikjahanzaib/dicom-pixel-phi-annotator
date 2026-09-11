// Export formats. v2 is keyed by the device attributes the files actually declare; v1 is
// the original combo-keyed schema, kept byte-identical for the consumer that reads it
// today. Both draw on the same zones and the same native-pixel normalisation — only the
// shape of the key differs.
import { exportZone, zoneKey, buildPipelineExport } from './coordinates.js';
import { deviceAttributes, attributesSource, attributeKey, DEVICE_FIELDS } from './device.js';

export const EXPORT_FORMATS = [
  { id: 'v2', label: 'Attributes (v2)', file: 'annotations.json',
    hint: 'Keyed by the device attributes read from each file. Carries schema_version 2.' },
  { id: 'v1', label: 'Combo (v1, legacy)', file: 'annotations-combo-v1.json',
    hint: 'The original combo-keyed schema, unchanged and unversioned.' },
];
export const DEFAULT_FORMAT = 'v2';

const sizeKeyOf = image => `${image.width}x${image.height}`;

// combo_id is a label, not the key, so a device group can hold files carrying different
// ones. The most common wins; ties go to the lowest numeric value, and an unassigned file
// only wins when nothing else is present.
export function resolveComboId(counts) {
  let best = '', bestCount = -1;
  for (const [combo, count] of counts) {
    if (count > bestCount) { best = combo; bestCount = count; continue; }
    if (count !== bestCount) continue;
    if (!best) { best = combo; continue; }
    if (!combo) continue;
    if (Number(combo) < Number(best)) best = combo;
  }
  return best;
}

function addZones(group, source, zones) {
  const key = sizeKeyOf(source);
  let size = group.sizes.get(key);
  if (!size) group.sizes.set(key, size = { ref_width: source.width, ref_height: source.height, zones: [], seen: new Set() });
  for (const value of zones) {
    const zone = exportZone(value, source);
    if (!zone || size.seen.has(zoneKey(zone))) continue;
    size.seen.add(zoneKey(zone));
    size.zones.push(zone);
  }
}

export function buildAttributeExport(images, layouts = []) {
  const groups = new Map();
  const groupFor = (key, attributes, source) => {
    let found = groups.get(key);
    if (!found) groups.set(key, found = { attributes, source, combos: new Map(), sizes: new Map() });
    return found;
  };
  for (const image of images) {
    const zones = Object.values(image.frames).flat();
    if (!zones.length) continue;
    const attributes = deviceAttributes(image.metadata);
    const found = groupFor(attributeKey(attributes), attributes, attributesSource(attributes));
    const combo = image.combo || '';
    found.combos.set(combo, (found.combos.get(combo) || 0) + 1);
    addZones(found, image, zones);
  }
  // A promoted import has no file and therefore no tags. It is marked as such rather than
  // being passed off as a partial read of a device that was never inspected.
  for (const layout of layouts) {
    if (!layout.promoted || !layout.zones.length) continue;
    const found = groupFor(`imported ${layout.combo}`, deviceAttributes(null), 'imported');
    found.combos.set(layout.combo || '', (found.combos.get(layout.combo || '') || 0) + 1);
    addZones(found, layout, layout.zones);
  }
  const annotations = [...groups.values()].map(found => ({
    combo_id: resolveComboId(found.combos),
    manufacturer: found.attributes.manufacturer,
    model: found.attributes.model,
    sop_class: found.attributes.sopClass,
    software_version: found.attributes.software,
    attributes_source: found.source,
    sizes: Object.fromEntries([...found.sizes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, size]) => [key, { ref_width: size.ref_width, ref_height: size.ref_height, zones: size.zones }])),
  }));
  // Deterministic order, so two exports of the same workspace diff cleanly.
  annotations.sort((a, b) =>
    (Number(a.combo_id || Infinity) - Number(b.combo_id || Infinity)) ||
    a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model) ||
    a.sop_class.localeCompare(b.sop_class) || a.software_version.localeCompare(b.software_version));
  return { schema_version: 2, generated_at: new Date().toISOString(), annotations };
}

// A combo ID comes from a filename and a filename can be wrong. Where files sharing one
// disagree on their tags, the tags win — the same rule the tool already applies when a
// filename's dimensions disagree with the raster. The conflict is reported, never merged.
export function comboConflicts(images) {
  const byCombo = new Map();
  for (const image of images) {
    if (!Object.values(image.frames).flat().length) continue;
    const combo = image.combo || '';
    if (!combo) continue;
    const attributes = deviceAttributes(image.metadata);
    const key = attributeKey(attributes);
    let variants = byCombo.get(combo);
    if (!variants) byCombo.set(combo, variants = new Map());
    let variant = variants.get(key);
    if (!variant) variants.set(key, variant = { attributes, files: [] });
    variant.files.push(image.name);
  }
  const conflicts = [];
  for (const [combo, variants] of byCombo) {
    if (variants.size < 2) continue;
    conflicts.push({ combo, variants: [...variants.values()]
      .sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0])) });
  }
  return conflicts.sort((a, b) => Number(a.combo) - Number(b.combo));
}

export function describeConflicts(conflicts) {
  if (!conflicts.length) return '';
  return conflicts.map(({ combo, variants }) => {
    const lines = variants.map(variant => {
      const label = DEVICE_FIELDS.map(field => variant.attributes[field]).filter(Boolean).join(' · ') || 'no device tags';
      const shown = variant.files.slice(0, 3).join(', ');
      const more = variant.files.length > 3 ? `, and ${variant.files.length - 3} more` : '';
      return `  ${label} — ${variant.files.length} file${variant.files.length === 1 ? '' : 's'}: ${shown}${more}`;
    });
    return [`Combo ${combo} holds ${variants.length} different device combinations:`, ...lines].join('\n');
  }).join('\n\n');
}

export const buildExport = (format, images, layouts = []) =>
  format === 'v1' ? buildPipelineExport(images, layouts) : buildAttributeExport(images, layouts);
