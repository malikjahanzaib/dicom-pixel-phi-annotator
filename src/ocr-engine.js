// The engine, kept behind a dynamic import so 16 MB of WASM and language data load only
// when the operator asks for a detection. Every path is pinned to a local asset staged by
// scripts/ocr-assets.mjs: tesseract.js would otherwise resolve its worker, core and
// traineddata from a CDN, which breaks the offline guarantee.
import { createWorker } from 'tesseract.js';

let engine = null, starting = null;

async function start() {
  // OEM 1 is LSTM-only, which is what the lstm cores staged in public/ocr/ provide.
  return createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/',
    langPath: '/ocr/',
    // The traineddata is already on disk beside the app; caching a copy in IndexedDB
    // would only add a second store holding the same bytes.
    cacheMethod: 'none',
    gzip: true,
  });
}

export async function recognize(canvas) {
  if (!engine) engine = await (starting ||= start()).finally(() => { starting = null; });
  const { data } = await engine.recognize(canvas, {}, { blocks: true });
  return data;
}

export async function shutdown() {
  const worker = engine;
  engine = null; starting = null;
  if (worker) await worker.terminate();
}
