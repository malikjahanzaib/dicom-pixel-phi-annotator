const DB_NAME = 'pixel-zone-workspace-v1';
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('files'); request.result.createObjectStore('workspace'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Pixel Zone tabs, then reload.'));
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
