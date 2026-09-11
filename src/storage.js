const DB_NAME = 'occlude-workspace-v1';
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    // Templates outlive a workspace, so they get their own store and survive Clear workspace.
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ['files', 'workspace', 'templates', 'schemas'])
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Occlude tabs, then reload.'));
  });
}
export function transact(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode); let result;
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local save interrupted.'));
    try { result = run(tx); } catch(error) { tx.abort(); reject(error); }
  });
}
export const loadSession = db => transact(db, ['workspace'], 'readonly', tx => tx.objectStore('workspace').get('current'));
export const loadFile = (db, id) => transact(db, ['files'], 'readonly', tx => tx.objectStore('files').get(id));
export const saveFile = (db, id, file) => transact(db, ['files'], 'readwrite', tx => tx.objectStore('files').put(file, id));
export const saveSession = (db, value) => transact(db, ['workspace'], 'readwrite', tx => tx.objectStore('workspace').put(value, 'current'));
export const clearSession = db => transact(db, ['files', 'workspace'], 'readwrite', tx => { tx.objectStore('files').clear(); tx.objectStore('workspace').clear(); });
export const removeFile = (db, id) => transact(db, ['files'], 'readwrite', tx => tx.objectStore('files').delete(id));
export const loadTemplates = db => transact(db, ['templates'], 'readonly', tx => tx.objectStore('templates').getAll());
export const putTemplate = (db, template) => transact(db, ['templates'], 'readwrite', tx => tx.objectStore('templates').put(template, template.id));
export const deleteTemplate = (db, id) => transact(db, ['templates'], 'readwrite', tx => tx.objectStore('templates').delete(id));
export const loadSchemas = db => transact(db, ['schemas'], 'readonly', tx => tx.objectStore('schemas').getAll());
export const putSchema = (db, schema) => transact(db, ['schemas'], 'readwrite', tx => tx.objectStore('schemas').put(schema, schema.id));
export const deleteSchema = (db, id) => transact(db, ['schemas'], 'readwrite', tx => tx.objectStore('schemas').delete(id));
