// Export formats. v2 is keyed by the device attributes the files actually declare; v1 is
// the original combo-keyed schema, kept byte-identical for the consumer that reads it
// today. Both draw on the same zones and the same native-pixel normalisation — only the
// shape of the key differs.
import { exportZone, zoneKey, buildPipelineExport } from './coordinates.js';
import { deviceAttributes, attributesSource, attributeKey, DEVICE_FIELDS } from './device.js';
import { applySchema } from './schema.js';

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
  if (!size) group.sizes.set(key, size = { ref_width: source.width, ref_height: source.height, zones: [], seen: new Set(), files: new Set() });
  size.files.add(source.id ?? source);
  for (const value of zones) {
    const zone = exportZone(value, source);
    if (!zone || size.seen.has(zoneKey(zone))) continue;
    size.seen.add(zoneKey(zone));
    size.zones.push(zone);
  }
}

// One grouping pass that every format renders from, so a custom schema can never disagree
// with v2 about what a combination contains — only about what the fields are called.
export function exportRows(images, layouts = [], groupBy = 'attributes') {
  const groups = new Map();
  const groupFor = (key, attributes, source) => {
    let found = groups.get(key);
    if (!found) groups.set(key, found = { attributes, sources: new Set(), combos: new Map(), files: 0, sizes: new Map() });
    found.sources.add(source);
    return found;
  };
  const keyFor = (attributes, combo) => groupBy === 'combo' ? `combo ${combo}` : attributeKey(attributes);
  for (const image of images) {
    const zones = Object.values(image.frames).flat();
    if (!zones.length) continue;
    const attributes = deviceAttributes(image.metadata);
    const combo = image.combo || '';
    const found = groupFor(keyFor(attributes, combo), attributes, attributesSource(attributes));
    found.variants = (found.variants || new Map()).set(attributeKey(attributes),
      (found.variants?.get(attributeKey(attributes)) || 0) + 1);
    found.attributeSet = (found.attributeSet || new Map()).set(attributeKey(attributes), attributes);
    found.combos.set(combo, (found.combos.get(combo) || 0) + 1);
    found.files++;
    addZones(found, image, zones);
  }
  // A promoted import has no file and therefore no tags. It is marked as such rather than
  // being passed off as a partial read of a device that was never inspected.
  for (const layout of layouts) {
    if (!layout.promoted || !layout.zones.length) continue;
    const attributes = deviceAttributes(null);
    const found = groupFor(`imported ${layout.combo}`, attributes, 'imported');
    found.combos.set(layout.combo || '', (found.combos.get(layout.combo || '') || 0) + 1);
    found.files++;
    addZones(found, layout, layout.zones);
  }
  const rows = [...groups.values()].map(found => {
    // Grouping by combo can gather more than one device under one label. The commonest
    // set is reported and the source says plainly that it was not uniform.
    let attributes = found.attributes;
    if (found.variants && found.variants.size > 1) {
      const [best] = [...found.variants.entries()].sort((a, b) => b[1] - a[1]);
      attributes = found.attributeSet.get(best[0]);
    }
    const source = found.sources.size > 1 ? 'mixed'
      : found.variants && found.variants.size > 1 ? 'mixed' : [...found.sources][0];
    const sizes = [...found.sizes.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([size, value]) => ({ size, ref_width: value.ref_width, ref_height: value.ref_height,
        zones: value.zones, zone_count: value.zones.length, file_count: value.files.size }));
    return {
      combo_id: resolveComboId(found.combos),
      manufacturer: attributes.manufacturer, model: attributes.model,
      sop_class: attributes.sopClass, software_version: attributes.software,
      attributes_source: source, file_count: found.files,
      zone_count: sizes.reduce((n, size) => n + size.zone_count, 0), sizes,
    };
  });
  // Deterministic order, so two exports of the same workspace diff cleanly.
  return rows.sort((a, b) =>
    (Number(a.combo_id || Infinity) - Number(b.combo_id || Infinity)) ||
    a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model) ||
    a.sop_class.localeCompare(b.sop_class) || a.software_version.localeCompare(b.software_version));
}

export function buildAttributeExport(images, layouts = []) {
  const annotations = exportRows(images, layouts).map(row => ({
    combo_id: row.combo_id,
    manufacturer: row.manufacturer,
    model: row.model,
    sop_class: row.sop_class,
    software_version: row.software_version,
    attributes_source: row.attributes_source,
    sizes: Object.fromEntries(row.sizes.map(size =>
      [size.size, { ref_width: size.ref_width, ref_height: size.ref_height, zones: size.zones }])),
  }));
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

export const CUSTOM_PREFIX = 'custom:';
export const customFormatId = schema => `${CUSTOM_PREFIX}${schema.id}`;
export const findFormat = (id, schemas = []) =>
  EXPORT_FORMATS.find(format => format.id === id) ||
  schemas.filter(schema => customFormatId(schema) === id)
    .map(schema => ({ id, label: `${schema.name} (custom)`, file: 'annotations-custom.json',
      hint: 'A schema you defined. Field names and shape are yours; the coordinates are not changed.', schema }))[0] ||
  EXPORT_FORMATS[0];

export function buildExport(format, images, layouts = [], schemas = []) {
  if (format === 'v1') return buildPipelineExport(images, layouts);
  if (String(format).startsWith(CUSTOM_PREFIX)) {
    const schema = schemas.find(entry => customFormatId(entry) === format);
    if (!schema) throw new Error('That custom schema is no longer saved. Choose another format.');
    return applySchema(schema, exportRows(images, layouts, schema.group_by));
  }
  return buildAttributeExport(images, layouts);
}
