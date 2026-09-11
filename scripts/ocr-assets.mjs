// Copies the OCR engine and its language data out of node_modules into public/, so the
// build carries them and the running app fetches nothing. This is what keeps the offline
// guarantee true: tesseract.js otherwise resolves its worker, core and traineddata from a
// CDN at runtime, which the content security policy would block and the operator would
// experience as a feature that silently never works.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('public/ocr');
// LSTM-only cores: smaller than the full engine and all that OEM 1 needs. Both the SIMD
// and plain builds ship so a browser without SIMD still runs.
const assets = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // All three SIMD tiers ship. The engine picks one from what the browser reports, so a
  // missing variant is not a slower path — it is a hard load failure at detection time.
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-relaxedsimd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  // The integerised model: a quarter the size of the float one, and localisation — which
  // is what a redaction box needs — is comparable.
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];

await mkdir(out, { recursive: true });
let total = 0;
for (const [from, to] of assets) {
  const source = path.resolve('node_modules', from);
  try { total += (await stat(source)).size; } catch {
    console.error(`Missing OCR asset: ${from}\nRun npm ci, then build again.`);
    process.exit(1);
  }
  await copyFile(source, path.join(out, to));
}
console.log(`OCR assets staged: ${assets.length} files, ${(total / 1048576).toFixed(1)} MB`);
