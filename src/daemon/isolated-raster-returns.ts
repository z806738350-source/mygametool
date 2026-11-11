import path from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { assertNoKnownSecretBytes } from "./safe-project-file.js";
import { sniffImageType } from "./image-format.js";
import {
  LEGACY_RASTER_BYTES,
  RASTER_BYTES,
  rasterImageCost,
  serializeRasterDecoding,
} from "./raster-policy.js";

const formats = new Map([
  [".png", "png"],
  [".jpg", "jpeg"],
  [".jpeg", "jpeg"],
  [".webp", "webp"],
]);
const decodeOptions = {
  failOn: "warning" as const,
  limitInputPixels: 32 * 1024 * 1024,
  limitInputChannels: 4,
  sequentialRead: true,
};

export interface RasterReturnReceipt {
  version: 1 | 2;
  path: string;
  beforeSha256?: string;
  afterSha256: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  format: string;
  imageCost?: ReturnType<typeof rasterImageCost>;
  hasTransparency?: boolean;
}

export function isStaticRasterPath(relative: string): boolean {
  return formats.has(path.posix.extname(relative).toLowerCase());
}

function refusal(reason: string): Error {
  return Object.assign(
    new Error(
      `Raster return requires review: ${reason}. Originals and guest changes are retained; do not rerun or regenerate.`,
    ),
    { code: "RASTER_RETURN_REVIEW_REQUIRED" },
  );
}

async function decode(bytes: Buffer, format: string) {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024)
    throw refusal("image input exceeds its existing 32 MiB bound");
  assertNoKnownSecretBytes(bytes);
  if (sniffImageType(bytes) !== `image/${format === "jpeg" ? "jpeg" : format}`)
    throw refusal("image signature and destination format differ");
  const metadata = await sharp(bytes, decodeOptions).metadata();
  if (
    metadata.format !== format ||
    (metadata.pages ?? 1) !== 1 ||
    metadata.depth !== "uchar" ||
    !metadata.width ||
    !metadata.height
  )
    throw refusal(
      "animated, high-bit-depth or invalid images need explicit preparation",
    );
  if (format === "png") {
    let offset = 8,
      ended = false;
    for (; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset),
        end = offset + length + 12;
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        end > bytes.length ||
        crc32(bytes.subarray(offset + 4, end - 4)) !==
          bytes.readUInt32BE(end - 4) ||
        ["acTL", "fcTL", "fdAT"].includes(kind)
      )
        throw refusal("invalid or animated PNG chunks");
      offset = end;
      if (kind === "IEND") {
        ended = length === 0;
        break;
      }
    }
    if (!ended || offset !== bytes.length)
      throw refusal("incomplete PNG or unrecognized trailing bytes");
  }
  // Force complete decoding. Header checks and a matching digest do not prove image integrity.
  const decoded = await sharp(bytes, decodeOptions)
    .timeout({ seconds: 5 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = false;
  if (metadata.hasAlpha) {
    for (
      let i = decoded.info.channels - 1;
      i < decoded.data.length;
      i += decoded.info.channels
    ) {
      if (decoded.data[i] !== 255) {
        transparent = true;
        break;
      }
    }
  }
  return { ...metadata, transparent };
}

/** No model or file mutation. A receipt records a validation decision, never the guest's claimed authority. */
export async function validateRasterReturn(
  relative: string,
  after: Buffer,
  before?: Buffer,
  policy: 1 | 2 = 1,
  signal?: AbortSignal,
): Promise<RasterReturnReceipt> {
  return serializeRasterDecoding(async () => {
    signal?.throwIfAborted();
    const result = await validateRasterReturnBytes(
      relative,
      after,
      before,
      policy,
      signal,
    );
    signal?.throwIfAborted();
    return result;
  });
}
async function validateRasterReturnBytes(
  relative: string,
  after: Buffer,
  before: Buffer | undefined,
  policy: 1 | 2,
  signal?: AbortSignal,
): Promise<RasterReturnReceipt> {
  const format = formats.get(path.posix.extname(relative).toLowerCase());
  if (!format)
    throw refusal("this media format has no raster return validator");
  if (policy !== 1 && policy !== 2)
    throw refusal("unknown raster validation policy");
  if (after.length > (policy === 1 ? LEGACY_RASTER_BYTES : RASTER_BYTES))
    throw refusal(
      policy === 1
        ? "working image exceeds the legacy 512 KiB contract; request a controlled retained review"
        : "image exceeds the 32 MiB controlled raster contract",
    );
  try {
    const result = await decode(after, format);
    signal?.throwIfAborted();
    // Identical validated bytes cannot remove alpha; avoid a second full decode.
    if (before && !after.equals(before)) {
      const original = await decode(before, format);
      signal?.throwIfAborted();
      if (original.hasAlpha && !result.hasAlpha)
        throw refusal("an alpha channel was removed");
      if (original.transparent && !result.transparent)
        throw refusal("transparent pixels became entirely opaque");
    }
    return {
      version: policy,
      path: relative,
      ...(before
        ? { beforeSha256: createHash("sha256").update(before).digest("hex") }
        : {}),
      afterSha256: createHash("sha256").update(after).digest("hex"),
      width: result.width!,
      height: result.height!,
      hasAlpha: result.hasAlpha === true,
      format,
      ...(policy === 2
        ? {
            imageCost: rasterImageCost(
              after.length,
              result.width!,
              result.height!,
            ),
            hasTransparency: result.transparent,
          }
        : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "RASTER_RETURN_REVIEW_REQUIRED"
    )
      throw error;
    throw refusal("complete local image decoding failed");
  }
}
