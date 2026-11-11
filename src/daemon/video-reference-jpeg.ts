import sharp, { type Sharp } from "sharp";

// Local input policy, not a discovered provider limit. Small PNGs stay lossless.
export const VIDEO_REFERENCE_PNG_TARGET_BYTES = 512 * 1024;
export const VIDEO_REFERENCE_JPEG_QUALITY = 95;
export const VIDEO_REFERENCE_JPEG_MAX_EDGE = 2048;
const MAX_PIXELS = 8 * 1024 * 1024;
let busy = false;
export type VideoReferenceJpeg = {
  bytes: Buffer;
  status: "converted" | "transparent" | "skipped" | "limited";
  resized?: boolean;
  oriented?: boolean;
};

/** PNG callers first use the bounded lossless validator; JPEG/WebP additionally require an explicit video budget policy. Never writes a file. */
export async function prepareVideoReferenceJpeg(
  bytes: Buffer,
  caller?: AbortSignal,
  budgetMs = 5000,
  policy?: {
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    quality: 95 | 92 | 90;
    maxEdge: 2048 | 1536 | 1024 | 768 | 512 | 384 | 256;
  },
): Promise<VideoReferenceJpeg | undefined> {
  caller?.throwIfAborted();
  const png = !policy || policy.mediaType === "image/png";
  if (png && (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR"))
    return;
  let width = png ? bytes.readUInt32BE(16) : 0,
    height = png ? bytes.readUInt32BE(20) : 0;
  if (
    !policy &&
    bytes.length <= VIDEO_REFERENCE_PNG_TARGET_BYTES &&
    Math.max(width, height) <= VIDEO_REFERENCE_JPEG_MAX_EDGE
  )
    return;
  if (busy || width * height > MAX_PIXELS || budgetMs <= 0)
    return { bytes, status: "limited" };
  // ponytail: one native codec operation at a time; cancellation holds the slot until native work settles.
  busy = true;
  const timeout = AbortSignal.timeout(
      Math.min(5000, Math.max(1, Math.trunc(budgetMs))),
    ),
    signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  const inputOptions = {
    failOn: "warning" as const,
    limitInputPixels: MAX_PIXELS,
    limitInputChannels: 4,
    sequentialRead: true,
  };
  let pipeline: Sharp | undefined;
  const work = (async (): Promise<VideoReferenceJpeg> => {
    try {
      const metadata = await sharp(bytes, inputOptions).metadata();
      signal.throwIfAborted();
      if (metadata.hasAlpha) return { bytes, status: "transparent" };
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;
      if (
        metadata.format !== (policy?.mediaType.split("/")[1] ?? "png") ||
        (metadata.pages ?? 1) !== 1 ||
        metadata.depth !== "uchar" ||
        !width ||
        !height ||
        width * height > MAX_PIXELS ||
        (!metadata.icc && !["srgb", "b-w"].includes(metadata.space ?? ""))
      )
        return { bytes, status: "skipped" };
      // PNG gamma/chromaticity outside sRGB requires a usable ICC transform. Do not guess a profile or tone-map HDR.
      for (let offset = 8; png && offset + 12 <= bytes.length;) {
        const size = bytes.readUInt32BE(offset),
          end = offset + size + 12;
        if (end > bytes.length) return { bytes, status: "skipped" };
        const type = bytes.toString("ascii", offset + 4, offset + 8),
          data = bytes.subarray(offset + 8, end - 4);
        if (["acTL", "fcTL", "fdAT", "cICP", "mDCV", "cLLI"].includes(type))
          return { bytes, status: "skipped" };
        if (
          !metadata.icc &&
          ((type === "gAMA" && (size !== 4 || data.readUInt32BE() !== 45455)) ||
            (type === "cHRM" &&
              !data.equals(
                Buffer.from(
                  "00007a26000080840000fa00000080e8000075300000ea6000003a9800001770",
                  "hex",
                ),
              )))
        )
          return { bytes, status: "skipped" };
        offset = end;
      }
      pipeline = sharp(bytes, inputOptions)
        .autoOrient()
        .withIccProfile("srgb")
        .resize({
          width: policy?.maxEdge ?? VIDEO_REFERENCE_JPEG_MAX_EDGE,
          height: policy?.maxEdge ?? VIDEO_REFERENCE_JPEG_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: policy?.quality ?? VIDEO_REFERENCE_JPEG_QUALITY,
          chromaSubsampling: "4:4:4",
        })
        .timeout({
          seconds: Math.max(1, Math.ceil(Math.min(5000, budgetMs) / 1000)),
        });
      const output = await pipeline.toBuffer({ resolveWithObject: true });
      signal.throwIfAborted();
      const oriented = (metadata.orientation ?? 1) !== 1;
      const orientedWidth = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
        ? height
        : width;
      const orientedHeight = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
        ? width
        : height;
      if (
        4 * Math.ceil(output.data.length / 3) + 1 >=
          4 * Math.ceil(bytes.length / 3) ||
        output.info.format !== "jpeg" ||
        Math.min(output.info.width, output.info.height) <
          Math.min(256, width, height)
      )
        return { bytes, status: "skipped" };
      return {
        bytes: output.data,
        status: "converted",
        resized:
          output.info.width !== orientedWidth ||
          output.info.height !== orientedHeight,
        oriented,
      };
    } catch {
      caller?.throwIfAborted();
      return { bytes, status: timeout.aborted ? "limited" : "skipped" };
    }
  })();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      pipeline?.destroy();
      reject(new Error("Video reference JPEG preparation stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  // Do not release the global slot merely because the caller stopped waiting.
  void work
    .finally(() => {
      busy = false;
    })
    .catch(() => {});
  try {
    return await Promise.race([work, interrupted]);
  } catch {
    caller?.throwIfAborted();
    return { bytes, status: "limited" };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
