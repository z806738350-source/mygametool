import sharp from "sharp";
import type { GPT_IMAGE_FORMATS } from "../shared/gpt-image-26.js";
import { sniffImageType } from "./image-format.js";
import { validateGeneratedSvg } from "./plugin-svg.js";
import { serializeRasterDecoding } from "./raster-policy.js";

/** Validate provider originals before assigning a filename or exposing them in the Library. */
export async function validateGeneratedImage(bytes: Buffer, format: typeof GPT_IMAGE_FORMATS[number], options?: { frameCount?: number; frameDurationMs?: number }): Promise<void> {
  if (format === "svg") { validateGeneratedSvg(bytes); return; }
  if (format === "gif" ? !/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)) : sniffImageType(bytes) !== `image/${format}`)
    throw new Error("Image signature does not match the requested format");
  await serializeRasterDecoding(async () => {
    const decoder = sharp(bytes, { animated: true, failOn: "warning", limitInputPixels: 32 * 1024 ** 2 }).timeout({ seconds: 10 });
    const metadata = await decoder.metadata();
    const frames = metadata.pages ?? 1;
    if (metadata.format !== format || !metadata.width || !metadata.height)
      throw new Error("Invalid generated image dimensions or format");
    if (format !== "gif" && frames !== 1) throw new Error("Expected a static image");
    if (format === "gif") {
      if (frames < 2 || frames > 16 || (options?.frameCount !== undefined && frames !== options.frameCount))
        throw new Error("GIF frame count does not match the request");
      const duration = options?.frameDurationMs;
      if (metadata.delay?.length !== frames || !metadata.delay.every(ms => ms > 0 && (duration === undefined || Math.abs(ms - duration) < 10)))
        throw new Error("GIF frame times do not match the request");
    }
    const pixels = await decoder.raw().toBuffer();
    if (format === "gif") {
      const stride = pixels.length / frames;
      const first = pixels.subarray(0, stride);
      for (let i = 1; i < frames; i++) if (!first.equals(pixels.subarray(i * stride, (i + 1) * stride))) return;
      throw new Error("GIF has no differences between its displayed frames");
    }
  });
}
