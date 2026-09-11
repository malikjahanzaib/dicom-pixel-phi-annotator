// User-defined export schemas. A definition is data, never code: the content security
// policy forbids eval, and a schema that could compute would also be a schema that could
// alter a coordinate. So a definition may only rename keys, choose a shape, and add
// constants — the zone numbers it emits are always the native-pixel values it was given.
export const SCHEMA_FORMAT = 'occlude-schema';

// What an entry may draw on. A flat schema puts one entry per combination and size, so it
// can also read the size fields; a nested one carries them under its sizes object.
export const ENTRY_SOURCES = ['combo_id', 'manufacturer', 'model', 'sop_class', 'software_version',
  'attributes_source', 'file_count', 'zone_count', 'ref_width', 'ref_height', 'size'];
export const SIZE_ONLY = ['ref_width', 'ref_height', 'size', 'zone_count', 'file_count'];
export const ZONE_SOURCES = ['x', 'y', 'width', 'height', 'note'];
export const GROUP_BY = ['attributes', 'combo'];
export const SHAPES = ['nested', 'flat'];

const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' ? value.trim() : '';

function checkMap(map, allowed, where) {
  if (map === undefined) return {};
  if (!isPlain(map)) throw new Error(`${where} must be an object of "output key": "source".`);
  const out = {};
  for (const [key, source] of Object.entries(map)) {
    if (!key.trim()) throw new Error(`${where} has an empty output key.`);
    if (typeof source !== 'string' || !allowed.includes(source))
      throw new Error(`${where}.${key} reads "${source}", which is not one of: ${allowed.join(', ')}.`);
    out[key] = source;
  }
  return out;
}

function checkConstants(map, where) {
  if (map === undefined) return {};
  if (!isPlain(map)) throw new Error(`${where} must be an object of literal values.`);
  for (const [key, value] of Object.entries(map)) {
    if (!key.trim()) throw new Error(`${where} has an empty key.`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      throw new Error(`${where}.${key} must be a string, number, boolean or null.`);
  }
  return { ...map };
}

export function validateSchema(input, id = null) {
  if (!isPlain(input)) throw new Error('A schema definition must be an object.');
  const label = name(input.name);
  if (!label) throw new Error('Give the schema a name.');
  const groupBy = input.group_by ?? 'attributes';
  if (!GROUP_BY.includes(groupBy)) throw new Error(`group_by must be one of: ${GROUP_BY.join(', ')}.`);
  const shape = input.shape ?? 'nested';
  if (!SHAPES.includes(shape)) throw new Error(`shape must be one of: ${SHAPES.join(', ')}.`);

  const entry = checkMap(input.entry, ENTRY_SOURCES, 'entry');
  const size = checkMap(input.size, SIZE_ONLY, 'size');
  const zone = checkMap(input.zone, ZONE_SOURCES, 'zone');
  if (!Object.keys(zone).length) throw new Error('zone must map at least one coordinate; a schema with no zones exports nothing useful.');

  // A nested schema keeps sizes in their own object, so an entry cannot read a size it
  // does not have. Rejecting this is clearer than silently emitting undefined.
  if (shape === 'nested')
    for (const [key, source] of Object.entries(entry))
      if (['ref_width', 'ref_height', 'size'].includes(source))
        throw new Error(`entry.${key} reads "${source}", which only exists per size. Use shape "flat", or move it to "size".`);
  if (shape === 'flat' && Object.keys(size).length)
    throw new Error('shape "flat" has no sizes object; map the size fields in "entry" instead.');

  const entriesField = name(input.entries_field) || 'annotations';
  const zonesField = name(input.zones_field) || 'zones';
  const sizesField = name(input.sizes_field) || 'sizes';
  const timestampField = input.timestamp_field === undefined ? 'generated_at' : name(input.timestamp_field);
  const root = checkConstants(input.root, 'root');
  if (Object.prototype.hasOwnProperty.call(root, entriesField))
    throw new Error(`root.${entriesField} collides with the entries field.`);
  if (timestampField && Object.prototype.hasOwnProperty.call(root, timestampField))
    throw new Error(`root.${timestampField} collides with the timestamp field.`);

  return {
    id: typeof input.id === 'string' && input.id ? input.id : id || `s${Date.now()}${Math.random().toString(16).slice(2, 8)}`,
    name: label.slice(0, 60), group_by: groupBy, shape,
    root, timestamp_field: timestampField, entries_field: entriesField,
    entry, entry_constants: checkConstants(input.entry_constants, 'entry_constants'),
    sizes_field: sizesField, size,
    zones_field: zonesField, zone, zone_constants: checkConstants(input.zone_constants, 'zone_constants'),
  };
}

const project = (map, constants, source) => ({
  ...Object.fromEntries(Object.entries(map).map(([key, field]) => [key, source[field]])),
  ...constants,
});

// rows come from src/export.js and are already grouped, normalised and de-duplicated.
// Nothing here recomputes a coordinate; it only chooses names and nesting.
export function applySchema(schema, rows, now = new Date().toISOString()) {
  const entries = [];
  for (const row of rows) {
    if (schema.shape === 'flat') {
      for (const size of row.sizes) entries.push({
        ...project(schema.entry, schema.entry_constants, { ...row, ...size }),
        [schema.zones_field]: size.zones.map(zone => project(schema.zone, schema.zone_constants, zone)),
      });
      continue;
    }
    entries.push({
      ...project(schema.entry, schema.entry_constants, row),
      [schema.sizes_field]: Object.fromEntries(row.sizes.map(size => [size.size, {
        ...project(schema.size, {}, size),
        [schema.zones_field]: size.zones.map(zone => project(schema.zone, schema.zone_constants, zone)),
      }])),
    });
  }
  return {
    ...schema.root,
    ...(schema.timestamp_field ? { [schema.timestamp_field]: now } : {}),
    [schema.entries_field]: entries,
  };
}

export const schemaFile = schemas => ({ format: SCHEMA_FORMAT, version: 1,
  generated_at: new Date().toISOString(), schemas });

export function validateSchemaFile(value) {
  if (value?.format !== SCHEMA_FORMAT || value.version !== 1 || !Array.isArray(value.schemas))
    throw new Error('Not an Occlude schema file.');
  const seen = new Set();
  return value.schemas.map(input => {
    const schema = validateSchema(input);
    if (seen.has(schema.id)) schema.id = `${schema.id}-${seen.size}`;
    seen.add(schema.id);
    return schema;
  });
}

// A worked example, so the dialog opens on something real rather than an empty box.
export const EXAMPLE_SCHEMA = {
  name: 'Repository rows',
  group_by: 'attributes',
  shape: 'flat',
  root: { schema_version: 3 },
  entries_field: 'annotations',
  entry: {
    combination_id: 'combo_id',
    manufacturer: 'manufacturer',
    model: 'model',
    sop_class: 'sop_class',
    software_version: 'software_version',
    image_width: 'ref_width',
    image_height: 'ref_height',
    file_count: 'file_count',
  },
  zones_field: 'redaction_zones',
  zone: { x: 'x', y: 'y', width: 'width', height: 'height' },
  zone_constants: { label: 'Redact', source: 'occlude' },
};
