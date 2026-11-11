export const LEGACY_RASTER_BYTES = 512 * 1024;
export const RASTER_BYTES = 32 * 1024 * 1024;
export const RASTER_PIXELS = 32 * 1024 * 1024;
export const RASTER_BATCH_BYTES = 64 * 1024 * 1024;

let decoding: Promise<void> = Promise.resolve();
/** Bound full pixel work across preparation, approval and publication callers. */
export function serializeRasterDecoding<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = decoding.then(operation);
  decoding = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Resource estimates describe RGBA8 pixels, not measured GPU allocation or FPS. */
export function rasterImageCost(
  encodedBytes: number,
  width: number,
  height: number,
) {
  if (
    ![encodedBytes, width, height].every(Number.isSafeInteger) ||
    encodedBytes < 1 ||
    encodedBytes > RASTER_BYTES ||
    width < 1 ||
    height < 1 ||
    width * height > RASTER_PIXELS
  )
    throw new Error("Invalid image resource dimensions");
  let mipPixels = 0,
    w = width,
    h = height;
  for (;;) {
    mipPixels += w * h;
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return {
    encodedBytes,
    pixelCount: width * height,
    decodedRgbaBytes: width * height * 4,
    estimatedTextureBytes: width * height * 4,
    estimatedMipmapBytes: mipPixels * 4,
    decodeLimitPixels: RASTER_PIXELS,
    performanceStatus: "estimate-only" as const,
  };
}
