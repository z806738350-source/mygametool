import { createHash } from "node:crypto";
import sharp from "sharp";
import { knownSensitiveValueRevision } from "../shared/sensitive-values.js";
import { sniffImageType } from "./image-format.js";
import { validateRasterReturn } from "./isolated-raster-returns.js";
import { serializeRasterDecoding } from "./raster-policy.js";
import { assertNoKnownSecretBytes } from "./safe-project-file.js";

export const SESSION_IMAGE_DISPLAY_BYTES = 1024 * 1024;
export const SESSION_IMAGE_DISPLAY_EDGE = 1536;
export type SessionImageMimeType = "image/png" | "image/jpeg" | "image/webp";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** A bounded model display copy, never a replacement or preparation of a project asset. */
export async function prepareSessionImageDisplay(
  input: Buffer,
  mimeType: SessionImageMimeType,
  signal?: AbortSignal,
  maxBytes = SESSION_IMAGE_DISPLAY_BYTES,
) {
  const byteLimit = Math.min(SESSION_IMAGE_DISPLAY_BYTES, maxBytes);
  signal?.throwIfAborted();
  if (
    !input.length ||
    input.length > 32 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
  )
    throw new Error(
      "Image display requires a static raster within its 32 MiB bound",
    );
  assertNoKnownSecretBytes(input);
  const revision = knownSensitiveValueRevision(),
    sourceSha256 = hash(input);
  const current = () => {
    signal?.throwIfAborted();
    if (revision !== knownSensitiveValueRevision())
      throw new Error(
        "Image display policy changed; request the saved image again",
      );
  };
  if (sniffImageType(input) !== mimeType)
    throw new Error("Image display format does not match its verified bytes");
  const relative =
    mimeType === "image/png"
      ? "display.png"
      : mimeType === "image/jpeg"
        ? "display.jpg"
        : "display.webp";
  const source = await validateRasterReturn(
    relative,
    input,
    undefined,
    2,
    signal,
  );
  current();
  if (hash(input) !== sourceSha256)
    throw new Error("Image display source changed during validation");
  const sourceInfo = {
    sourceSha256,
    sourceBytes: input.length,
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceHasAlpha: source.hasAlpha,
    sourceMimeType: mimeType,
  };
  if (
    input.length <= byteLimit &&
    Math.max(source.width, source.height) <= SESSION_IMAGE_DISPLAY_EDGE
  )
    return {
      bytes: input,
      mimeType,
      ...sourceInfo,
      displaySha256: sourceSha256,
      displayWidth: source.width,
      displayHeight: source.height,
      displayBytes: input.length,
      isProxy: false,
      scannerRevision: revision,
    };
  return serializeRasterDecoding(async () => {
    const edges = byteLimit < SESSION_IMAGE_DISPLAY_BYTES ? [SESSION_IMAGE_DISPLAY_EDGE, 768, 384, 192, 96] : [SESSION_IMAGE_DISPLAY_EDGE, 768, 384];
    for (const edge of edges) {
      current();
      const pipeline = sharp(input, {
        failOn: "warning",
        limitInputPixels: 32 * 1024 * 1024,
        limitInputChannels: 4,
        sequentialRead: true,
      })
        .resize({
          width: edge,
          height: edge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .timeout({ seconds: 5 });
      const encoded = await (
        source.hasAlpha
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.jpeg({ quality: 80 })
      ).toBuffer({ resolveWithObject: true });
      current();
      if (encoded.data.length > byteLimit) continue;
      const displayMimeType = source.hasAlpha
        ? ("image/png" as const)
        : ("image/jpeg" as const);
      if (
        encoded.info.width > source.width ||
        encoded.info.height > source.height ||
        Math.max(encoded.info.width, encoded.info.height) >
          SESSION_IMAGE_DISPLAY_EDGE ||
        (source.hasAlpha && encoded.info.channels !== 4) ||
        sniffImageType(encoded.data) !== displayMimeType
      )
        throw new Error(
          "Image display preparation returned inconsistent dimensions or alpha",
        );
      assertNoKnownSecretBytes(encoded.data);
      if (hash(input) !== sourceSha256)
        throw new Error("Image display source changed during preparation");
      current();
      return {
        bytes: encoded.data,
        mimeType: displayMimeType,
        ...sourceInfo,
        displaySha256: hash(encoded.data),
        displayWidth: encoded.info.width,
        displayHeight: encoded.info.height,
        displayBytes: encoded.data.length,
        isProxy: true,
        scannerRevision: revision,
      };
    }
    throw new Error(
      "The saved image cannot fit the bounded model display; originals were not changed",
    );
  });
}
