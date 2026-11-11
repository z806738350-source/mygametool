import { prepareVideoReferenceJpeg } from "./video-reference-jpeg.js";

// An application policy with headroom around the successful 773,385-byte fixture, not a provider limit.
export const VIDEO_REFERENCE_REQUEST_TARGET_BYTES = 768 * 1024;
const PASSES = [
  [95, 2048],
  [92, 2048],
  [90, 2048],
  [90, 1536],
  [90, 1024],
  [90, 768],
  [90, 512],
  [90, 384],
  [90, 256],
] as const;
export interface LocalVideoImage {
  bytes: Buffer;
  mediaType: string;
}
export interface VideoReferenceBudget {
  targetBytes: number;
  passes: number;
  met: boolean;
  converted: number;
  resized: number;
  quality: 95 | 92 | 90;
  maxEdge: 2048 | 1536 | 1024 | 768 | 512 | 384 | 256;
}

/** Only new video submissions. Measure the complete model-specific JSON, including URL/local mixtures and text. */
export async function fitVideoReferenceBudget(
  originals: readonly (LocalVideoImage | undefined)[],
  initial: readonly (LocalVideoImage | undefined)[],
  measure: (images: readonly (LocalVideoImage | undefined)[]) => number,
  signal: AbortSignal,
  budgetMs: number,
): Promise<{
  images: Array<LocalVideoImage | undefined>;
  budget: VideoReferenceBudget;
}> {
  signal.throwIfAborted();
  const images = [...initial],
    converted = new Set<number>(),
    resized = new Set<number>(),
    blocked = new Set<number>();
  const budget: VideoReferenceBudget = {
    targetBytes: VIDEO_REFERENCE_REQUEST_TARGET_BYTES,
    passes: 0,
    met: false,
    converted: 0,
    resized: 0,
    quality: 95,
    maxEdge: 2048,
  };
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (const [quality, maxEdge] of PASSES) {
    if (measure(images) <= budget.targetBytes) break;
    if (Date.now() >= deadline) break;
    budget.passes++;
    for (const [index, original] of originals.entries()) {
      signal.throwIfAborted();
      if (
        !original ||
        blocked.has(index) ||
        !["image/png", "image/jpeg", "image/webp"].includes(original.mediaType)
      )
        continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Always encode from the validated original, never from a JPEG created on an earlier pass.
      const result = await prepareVideoReferenceJpeg(
        original.bytes,
        signal,
        remaining,
        {
          mediaType: original.mediaType as
            "image/png" | "image/jpeg" | "image/webp",
          quality,
          maxEdge,
        },
      );
      if (!result || result.status !== "converted") {
        if (!result || result.status !== "skipped") blocked.add(index);
        continue;
      }
      const previous = images[index]!;
      const wireSize = (image: LocalVideoImage) =>
        Buffer.byteLength(`data:${image.mediaType};base64,`) +
        4 * Math.ceil(image.bytes.length / 3);
      if (
        wireSize({ bytes: result.bytes, mediaType: "image/jpeg" }) >=
        wireSize(previous)
      )
        continue;
      images[index] = { bytes: result.bytes, mediaType: "image/jpeg" };
      converted.add(index);
      if (result.resized) resized.add(index);
      budget.quality = Math.min(
        budget.quality,
        quality,
      ) as VideoReferenceBudget["quality"];
      budget.maxEdge = Math.min(
        budget.maxEdge,
        maxEdge,
      ) as VideoReferenceBudget["maxEdge"];
    }
  }
  signal.throwIfAborted();
  budget.converted = converted.size;
  budget.resized = resized.size;
  budget.met = measure(images) <= budget.targetBytes;
  return { images, budget };
}
