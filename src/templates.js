// Named zone layouts, saved per combo and raster size. Reuse ("Copy to…") needs an
// annotated file already open; a template lets a fresh batch start cold. Applying one goes
// through the same planner reuse uses, so merge, dedupe, pricing and per-frame history
// behave identically — a template is a source of zones, not a second way to write them.
import { exportZone } from './coordinates.js';

export const TEMPLATE_FORMAT = 'pixel-zone-templates';
export const MAX_NAME = 80;

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}${Math.random().toString(16).slice(2)}`);

export function makeTemplate({ name, image, zones, id = newId(), createdAt = new Date().toISOString() }) {
  const label = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!label) throw new Error('Give the template a name.');
  if (![image?.width, image?.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Unknown raster size.');
  // Normalising through exportZone is what keeps a template in native pixels: anything
  // out of bounds or zero-area is dropped here rather than reappearing on another file.
  const kept = (zones || []).map(zone => exportZone(zone, image)).filter(Boolean);
  if (!kept.length) throw new Error('This frame has no zones to save.');
  return { id, name: label, combo: /^\d+$/.test(image.combo || '') ? image.combo : '',
    width: image.width, height: image.height, zones: kept, createdAt };
}

// A native-pixel zone means nothing on a raster of another size, so a template names the
// size it was built for and is refused elsewhere rather than being rescaled.
export const templateFits = (template, image) =>
  !!image && template.width === image.width && template.height === image.height;

export const templateSize = template => `${template.width}×${template.height}`;

export function sortTemplates(templates) {
  return [...templates].sort((a, b) =>
    (a.combo === b.combo ? 0 : !a.combo ? 1 : !b.combo ? -1 : Number(a.combo) - Number(b.combo)) ||
    a.width - b.width || a.height - b.height || a.name.localeCompare(b.name));
}

function validateTemplate(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid template.');
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('A template is missing its name.');
  if (![input.width, input.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error(`Invalid raster size in “${input.name}”.`);
  if (input.combo !== '' && !/^\d+$/.test(input.combo || '')) throw new Error(`Invalid combo ID in “${input.name}”.`);
  if (!Array.isArray(input.zones) || !input.zones.length) throw new Error(`“${input.name}” has no zones.`);
  const zones = input.zones.map(zone => {
    if (!zone || !['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger(zone[k])) || typeof zone.note !== 'string')
      throw new Error(`Invalid rectangle in “${input.name}”.`);
    const normalized = exportZone(zone, input);
    if (!normalized || ['x', 'y', 'width', 'height'].some(k => normalized[k] !== zone[k]))
      throw new Error(`A rectangle in “${input.name}” lies outside ${input.width}×${input.height}.`);
    return normalized;
  });
  return { id: typeof input.id === 'string' && input.id ? input.id : newId(),
    name: input.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME), combo: input.combo || '',
    width: input.width, height: input.height, zones,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString() };
}

export function validateTemplateFile(value) {
  if (value?.format !== TEMPLATE_FORMAT || value.version !== 1 || !Array.isArray(value.templates))
    throw new Error('Not a Pixel Zone template file.');
  const seen = new Set();
  return value.templates.map(input => {
    const template = validateTemplate(input);
    if (seen.has(template.id)) template.id = newId();
    seen.add(template.id);
    return template;
  });
}

export const templateFile = templates => ({ format: TEMPLATE_FORMAT, version: 1,
  generated_at: new Date().toISOString(), templates });
