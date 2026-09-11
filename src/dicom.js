import { init as coreInit, utilities } from '@cornerstonejs/core';
import { init as loaderInit, wadouri } from '@cornerstonejs/dicom-image-loader';
let initialized = false;
export async function decodeDicom(file, frameIndex) {
  if (!initialized) { coreInit({ rendering: { useCPURendering: true } }); loaderInit({ maxWebWorkers: 2, useLegacyMetadataProvider: true }); initialized = true; }
  const id = wadouri.fileManager.add(file);
  let load;
  try {
    // Cornerstone uses ONE-based frame identifiers. The application uses zero-based indices.
    load = wadouri.loadImage(`${id}?frame=${frameIndex + 1}`, { useRGBA: true, preScale: { enabled: false } });
    return await load.promise;
  } finally {
    load?.decache?.();
    wadouri.fileManager.remove(Number(id.split(':')[1]));
  }
}
export async function renderDicom(image, display = {}) {
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  // Render the source raster 1:1. Physical pixel spacing must NOT stretch the raster used
  // by the annotation transform. DICOM rescale/VOI/color conversion remain Cornerstone's job.
  const presentation = { ...image, rowPixelSpacing: 1, columnPixelSpacing: 1,
    invert: Boolean(image.invert) !== Boolean(display.invert),
    windowWidth: display.windowWidth ?? image.windowWidth,
    windowCenter: display.windowCenter ?? image.windowCenter,
    voiLUT: display.windowWidth != null ? undefined : image.voiLUT,
  };
  await utilities.renderToCanvasCPU(canvas, presentation);
  return canvas;
}
