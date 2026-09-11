import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { makeTemplate, templateFits, templateSize, sortTemplates, validateTemplateFile, templateFile } from '../src/templates.js';
import { openDatabase, putTemplate, loadTemplates, deleteTemplate, clearSession, saveSession, loadSession } from '../src/storage.js';
const image = { combo: '16', width: 640, height: 480 };
const strip = { x: 0, y: 0, width: 420, height: 40, note: 'patient strip' };

test('saving a template keeps native pixels and records the size it was built for',()=>{
  const t = makeTemplate({ name: '  iU22  header+DOB  ', image, zones: [strip], id: 'fixed' });
  assert.deepEqual(t, { id: 'fixed', name: 'iU22 header+DOB', combo: '16', width: 640, height: 480, zones: [strip], createdAt: t.createdAt });
  assert.equal(templateSize(t), '640×480');
  // Anything unusable is dropped at save time rather than surfacing on another file later.
  assert.deepEqual(makeTemplate({ name: 'n', image, zones: [strip, { x: 5, y: 5, width: 0, height: 9, note: '' }] }).zones, [strip]);
  // A non-numeric combo cannot key a pipeline layout, so it is not recorded as one.
  assert.equal(makeTemplate({ name: 'n', image: { ...image, combo: '' }, zones: [strip] }).combo, '');
  assert.throws(()=>makeTemplate({ name: '   ', image, zones: [strip] }), /name/);
  assert.throws(()=>makeTemplate({ name: 'n', image, zones: [] }), /no zones/);
  assert.throws(()=>makeTemplate({ name: 'n', image: { combo: '', width: 0, height: 0 }, zones: [strip] }), /raster size/);
});

test('a template is refused on any raster but the one it was built for',()=>{
  const t = makeTemplate({ name: 'n', image, zones: [strip] });
  assert.equal(templateFits(t, image), true);
  assert.equal(templateFits(t, { width: 1024, height: 768 }), false);
  assert.equal(templateFits(t, { width: 640, height: 481 }), false);
  assert.equal(templateFits(t, null), false);
});

test('templates list by combo then size then name, with unassigned last',()=>{
  const t = (combo, width, name) => ({ combo, width, height: 480, name });
  assert.deepEqual(sortTemplates([t('22',640,'b'), t('',640,'z'), t('16',1024,'a'), t('16',640,'b'), t('16',640,'a')])
    .map(x=>`${x.combo||'-'}/${x.width}/${x.name}`), ['16/640/a','16/640/b','16/1024/a','22/640/b','-/640/z']);
});

test('a template file round-trips and refuses anything malformed',()=>{
  const saved = [makeTemplate({ name: 'one', image, zones: [strip], id: 'a' })];
  const file = templateFile(saved);
  assert.equal(file.format, 'pixel-zone-templates');
  assert.deepEqual(validateTemplateFile(file).map(t=>t.name), ['one']);
  assert.deepEqual(validateTemplateFile(file)[0].zones, [strip]);
  assert.throws(()=>validateTemplateFile({ format: 'other', version: 1, templates: [] }), /Not an Occlude template file/);
  assert.throws(()=>validateTemplateFile({ format: 'pixel-zone-templates', version: 2, templates: [] }), /Not an Occlude template file/);
  // A rectangle outside the template's own raster is rejected, not silently clipped.
  assert.throws(()=>validateTemplateFile({ ...file, templates: [{ ...saved[0], zones: [{ ...strip, width: 900 }] }] }), /lies outside 640×480/);
  assert.throws(()=>validateTemplateFile({ ...file, templates: [{ ...saved[0], zones: [] }] }), /has no zones/);
  assert.throws(()=>validateTemplateFile({ ...file, templates: [{ ...saved[0], combo: 'abc' }] }), /combo ID/);
  // Duplicate ids are re-keyed rather than overwriting one another on import.
  const twins = validateTemplateFile({ ...file, templates: [saved[0], { ...saved[0], name: 'two' }] });
  assert.notEqual(twins[0].id, twins[1].id);
});

test('templates persist in their own store and survive clearing the workspace',async()=>{
  const db = await openDatabase();
  const t = makeTemplate({ name: 'keep me', image, zones: [strip], id: 'k1' });
  await putTemplate(db, t);
  await saveSession(db, { version: 1, images: [] });
  assert.deepEqual((await loadTemplates(db)).map(x=>x.name), ['keep me']);
  // Clearing a workspace throws away images and annotations; a template is a reusable
  // asset that outlives any one batch, so it stays.
  await clearSession(db);
  assert.equal(await loadSession(db), undefined);
  assert.deepEqual((await loadTemplates(db)).map(x=>x.name), ['keep me']);
  await deleteTemplate(db, 'k1');
  assert.deepEqual(await loadTemplates(db), []);
  db.close();
});
