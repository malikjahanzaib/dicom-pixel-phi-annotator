import { defineConfig } from 'vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
export default defineConfig({
  resolve: { alias: { events: 'events/', url: 'url/' } },
  plugins: [viteCommonjs()],
  optimizeDeps: { exclude: ['@cornerstonejs/dicom-image-loader'], include: ['dicom-parser'] },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  build: { target: 'es2022' },
});
