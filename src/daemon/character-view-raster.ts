import sharp, { type OverlayOptions } from "sharp";
import { sniffImageType } from "./image-format.js";
import { validateRasterReturn } from "./isolated-raster-returns.js";
import { SESSION_IMAGE_DISPLAY_BYTES } from "./retained-image-display.js";
import {
  MAX_CHARACTER_PREVIEW_SIZE,
  RASTER_BYTES,
  RASTER_PIXELS,
  serializeRasterDecoding,
} from "./raster-policy.js";

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };

interface CharacterRasterOptions {
  canvas: Size;
  pivot: Point;
  sourceGroundPoint: Point;
  scale: number;
  sampling: "nearest" | "lanczos3";
}

function pixelFootprint(data: Buffer, { width, height }: Size, allowOpaque = false) {
  const bounds = { left: width, top: height, right: 0, bottom: 0 };
  const alpha = { clear: 0, soft: 0, opaque: 0 };
  let nearOpaquePixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const opacity = data[(y * width + x) * 4 + 3];
      if (opacity === 0) {
        alpha.clear++;
        continue;
      }
      if (opacity === 255) alpha.opaque++;
      else alpha.soft++;
      if (opacity >= 250) nearOpaquePixels++;
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x + 1);
      bounds.bottom = Math.max(bounds.bottom, y + 1);
    }
  }
  if (alpha.clear === width * height)
    throw new Error("Character raster has no visible pixels");
  if (!allowOpaque && alpha.opaque === width * height)
    throw new Error("Character raster is fully opaque");
  return { bounds, alpha, nearOpaquePixels };
}

const decodeOptions = { failOn: "warning" as const, limitInputPixels: RASTER_PIXELS, limitInputChannels: 4, sequentialRead: true };

async function decodeCharacterView(bytes: Buffer) {
  if (!bytes.length || bytes.length > RASTER_BYTES)
    throw new Error("Character raster input exceeds the supported encoded size");
  return sharp(bytes, decodeOptions).autoOrient().toColourspace("srgb")
    .ensureAlpha().raw().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
}

/** Source pixels and half-open alpha bounds. Opaque references can still guide a new pose. */
export async function inspectCharacterViewRaster(bytes: Buffer) {
  return serializeRasterDecoding(async () => {
    const { data, info } = await decodeCharacterView(bytes);
    return { width: info.width, height: info.height, ...pixelFootprint(data, info, true) };
  });
}

async function previewSprite(bytes: Buffer, height: number) {
  const { data, info } = await decodeCharacterView(bytes);
  const { bounds } = pixelFootprint(data, info, true);
  return sharp(data, { raw: info })
    .extract({ left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top })
    .resize({ width: MAX_CHARACTER_PREVIEW_SIZE, height, fit: "inside" })
    .png().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
}

/** Keep the original orientations. Single views use two panels, comparisons use matching light and dark rows. */
export async function renderCharacterViewPreview(images: readonly Buffer[], height: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(height) || height < 1 || height > MAX_CHARACTER_PREVIEW_SIZE)
    throw new Error(`Choose a character preview height from 1 to ${MAX_CHARACTER_PREVIEW_SIZE} pixels`);
  if (!images.length || images.length > 3) throw new Error("Preview one character with up to two reference images");
  return serializeRasterDecoding(async () => {
    const sprites = [];
    for (const bytes of images) {
      signal?.throwIfAborted();
      const sprite = await previewSprite(bytes, height);
      if (images.length > 1 && sprite.info.height !== height)
        throw new Error(`This wide silhouette fits at ${sprite.info.height} pixels high. Choose that height or smaller for every view.`);
      sprites.push(sprite);
    }
    const padding = 8;
    const width = sprites.reduce((sum, sprite) => sum + sprite.info.width + 2 * padding, 0);
    const panel = { width, height: sprites[0]!.info.height + 2 * padding, channels: 3 as const };
    const dark = images.length === 1 ? { left: width, top: 0 } : { left: 0, top: panel.height };
    const overlays: OverlayOptions[] = [{ input: { create: { ...panel, background: "#242424" } }, ...dark }];
    let left = padding;
    for (const sprite of sprites) {
      overlays.push({ input: sprite.data, left, top: padding }, { input: sprite.data, left: left + dark.left, top: padding + dark.top });
      left += sprite.info.width + 2 * padding;
    }
    const preview = await sharp({ create: { ...panel, width: width + dark.left, height: panel.height + dark.top, background: "#f2f2f2" } })
      .composite(overlays).removeAlpha().png().timeout({ seconds: 5 }).toBuffer();
    if (preview.length > SESSION_IMAGE_DISPLAY_BYTES) throw new Error("Choose a smaller preview height to fit the session image budget");
    return preview;
  });
}

function nearest(
  source: Buffer, width: number, output: Buffer, canvas: Size,
  bounds: Bounds, translation: Point, scale: number,
) {
  for (let y = Math.floor(bounds.top); y < Math.ceil(bounds.bottom); y++) {
    const sourceY = Math.floor((y + 0.5 - translation.y) / scale);
    for (let x = Math.floor(bounds.left); x < Math.ceil(bounds.right); x++) {
      const sourceX = Math.floor((x + 0.5 - translation.x) / scale);
      if (sourceX < 0 || sourceX >= width || sourceY < 0) continue;
      const from = (sourceY * width + sourceX) * 4;
      if (source[from + 3]) {
        source.copy(output, (y * canvas.width + x) * 4, from, from + 4);
      }
    }
  }
}

function sinc(distance: number) {
  if (distance === 0) return 1;
  const angle = Math.PI * distance;
  return Math.sin(angle) / angle;
}

function axisFilter(
  lower: number, upper: number, offset: number, scale: number,
  first: number, last: number,
) {
  const filterScale = Math.min(scale, 1);
  const radius = 3 / filterScale;
  return Array.from({ length: last - first }, (_, index) => {
    const center = (index + first + 0.5 - offset) / scale - 0.5;
    const from = Math.ceil(center - radius);
    const to = Math.floor(center + radius) + 1;
    const start = Math.min(upper, Math.max(lower, from));
    const weights = new Float64Array(Math.max(0, Math.min(upper, to) - start));
    let sum = 0;
    // Include transparent pixels in normalization, including padding outside the source.
    for (let pixel = from; pixel < to; pixel++) {
      const distance = (center - pixel) * filterScale;
      const weight = Math.abs(distance) < 3 ? sinc(distance) * sinc(distance / 3) : 0;
      sum += weight;
      if (pixel >= start && pixel < start + weights.length) weights[pixel - start] = weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    return { start: start - lower, weights };
  });
}

function lanczos(
  source: Buffer, width: number, output: Buffer, canvas: Size,
  bounds: Bounds, translation: Point, scale: number,
) {
  // A filter lobe can paint outside the geometric footprint. Sample that region too.
  const radius = 3 * Math.max(scale, 1);
  const left = Math.floor((bounds.left + 0.5) * scale + translation.x - radius);
  const top = Math.floor((bounds.top + 0.5) * scale + translation.y - radius);
  const right = Math.ceil((bounds.right - 0.5) * scale + translation.x + radius);
  const bottom = Math.ceil((bounds.bottom - 0.5) * scale + translation.y + radius);
  const columns = right - left;
  const rows = bottom - top;
  const sourceWidth = bounds.right - bounds.left;
  const sourceRows = bounds.bottom - bounds.top;
  const maxTaps = Math.ceil(6 / Math.min(scale, 1)) + 2;
  const xTaps = Math.min(maxTaps, sourceWidth);
  const yTaps = Math.min(maxTaps, sourceRows);
  const horizontalSamples = columns * sourceRows;
  const work = (columns + rows) * maxTaps + horizontalSamples * xTaps + columns * rows * yTaps;
  // Count axis weights and a conservative allowance for their small per-position objects.
  const scratchBytes = horizontalSamples * 16 + columns * (256 + 8 * xTaps) + rows * (256 + 8 * yTaps);
  // ponytail: one RGBA8 decode's bytes for filter scratch and 64M synchronous taps.
  // Tile or offload if larger transforms are needed.
  if (scratchBytes > 4 * RASTER_PIXELS || work > 2 * RASTER_PIXELS)
    throw new Error("Lanczos3 character transform exceeds the raster processing budget");
  const xFilters = axisFilter(bounds.left, bounds.right, translation.x, scale, left, right);
  const yFilters = axisFilter(bounds.top, bounds.bottom, translation.y, scale, top, bottom);
  const horizontal = new Float32Array(horizontalSamples * 4);
  for (let y = 0; y < sourceRows; y++) {
    for (let x = 0; x < columns; x++) {
      const { start, weights } = xFilters[x];
      const to = (y * columns + x) * 4;
      for (let i = 0; i < weights.length; i++) {
        const from = ((y + bounds.top) * width + bounds.left + start + i) * 4;
        const alpha = source[from + 3] * weights[i];
        horizontal[to] += source[from] * alpha;
        horizontal[to + 1] += source[from + 1] * alpha;
        horizontal[to + 2] += source[from + 2] * alpha;
        horizontal[to + 3] += alpha;
      }
    }
  }
  const byte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
  for (let y = top; y < bottom; y++) {
    const { start, weights } = yFilters[y - top];
    for (let x = left; x < right; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let i = 0; i < weights.length; i++) {
        const from = ((start + i) * columns + x - left) * 4;
        red += horizontal[from] * weights[i];
        green += horizontal[from + 1] * weights[i];
        blue += horizontal[from + 2] * weights[i];
        alpha += horizontal[from + 3] * weights[i];
      }
      const opacity = byte(alpha);
      if (opacity === 0) continue;
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
        throw new Error("Lanczos3 alpha footprint would leave the common canvas");
      const to = (y * canvas.width + x) * 4;
      output[to] = byte(red / alpha);
      output[to + 1] = byte(green / alpha);
      output[to + 2] = byte(blue / alpha);
      output[to + 3] = opacity;
    }
  }
}

function pointIn(point: Point, size: Size) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height;
}

/** Coordinates are pixel edges. Bounds are half-open and describe the rendered alpha footprint. */
export async function prepareCharacterRaster(
  bytes: Uint8Array, options: CharacterRasterOptions,
) {
  const { canvas, pivot, sourceGroundPoint, scale, sampling } = options;
  if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height) ||
      canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > RASTER_PIXELS)
    throw new Error("Character canvas exceeds the supported raster pixel budget");
  if (!pointIn(pivot, canvas) || !Number.isFinite(scale) || scale <= 0 ||
      (sampling !== "nearest" && sampling !== "lanczos3"))
    throw new Error("Invalid character pivot, scale or sampling");
  if (bytes.byteLength < 1 || bytes.byteLength > RASTER_BYTES)
    throw new Error("Character raster input exceeds the supported encoded size");

  const input = Buffer.from(bytes);
  const type = sniffImageType(input);
  if (type !== "image/png" && type !== "image/webp")
    throw new Error("Character raster input must be static PNG or WebP with alpha");
  const source = await validateRasterReturn(type === "image/png" ? "character.png" : "character.webp", input, undefined, 2);
  if (!source.hasTransparency) throw new Error("Character raster is fully opaque");
  if (!pointIn(sourceGroundPoint, source)) throw new Error("Character ground point is outside the source");

  const translation = {
    x: pivot.x - scale * sourceGroundPoint.x,
    y: pivot.y - scale * sourceGroundPoint.y,
  };
  return serializeRasterDecoding(async () => {
    const image = sharp(input, decodeOptions);
    const { orientation } = await image.metadata();
    if (orientation && orientation !== 1)
      throw new Error("Character raster orientation needs explicit preparation before measuring its ground point");
    const raw = await image.toColourspace("srgb").ensureAlpha()
      .raw().timeout({ seconds: 5 }).toBuffer();
    const { bounds } = pixelFootprint(raw, source);
    const mapped = {
      left: pivot.x + (bounds.left - sourceGroundPoint.x) * scale,
      top: pivot.y + (bounds.top - sourceGroundPoint.y) * scale,
      right: pivot.x + (bounds.right - sourceGroundPoint.x) * scale,
      bottom: pivot.y + (bounds.bottom - sourceGroundPoint.y) * scale,
    };
    if (![mapped.left, mapped.top, mapped.right, mapped.bottom].every(Number.isFinite) ||
        mapped.left < 0 || mapped.top < 0 || mapped.right > canvas.width || mapped.bottom > canvas.height)
      throw new Error("Character alpha footprint would leave the common canvas");
    const output = Buffer.alloc(canvas.width * canvas.height * 4);
    // Lanczos3 is exact at integer-center translations when the scale is one.
    if (sampling === "nearest" ||
        (scale === 1 && Number.isInteger(translation.x) && Number.isInteger(translation.y))) {
      nearest(raw, source.width, output, canvas, mapped, translation, scale);
    } else {
      lanczos(raw, source.width, output, canvas, bounds, translation, scale);
    }
    const measured = pixelFootprint(output, canvas);
    const png = await sharp(output, { raw: { ...canvas, channels: 4 }, limitInputPixels: RASTER_PIXELS })
      .png().timeout({ seconds: 5 }).toBuffer();
    if (png.length > RASTER_BYTES) throw new Error("Character PNG output exceeds the supported encoded size");
    return {
      png, source: { width: source.width, height: source.height },
      output: { width: canvas.width, height: canvas.height }, ...measured, translation,
    };
  });
}
