/** Closed, non-secret summary. Never paths, image bytes, credentials or provider URLs. */
export const VIDEO_REFERENCE_BUDGET_ERROR =
  "Video references exceed the local 768 KiB request target; no generation request was submitted. Use fewer or smaller opaque references. This is a local safety target, not a Kunpo limit.";
interface PngPreparationSummary {
  optimized: number;
  unchanged: number;
  unsupported: number;
  invalid: number;
  limited: number;
  originalBytes: number;
  sentBytes: number;
}
interface JpegPreparationSummary {
  jpegConverted: number;
  jpegSkipped: number;
  jpegTransparent: number;
  jpegLimited: number;
  jpegResized: number;
  jpegOriented: number;
  jpegQuality: 95;
  jpegMaxEdge: 2048;
  requestBytes: number;
  originalRequestBytes: number;
}
export type VideoReferencePreparation = PngPreparationSummary &
  (
    | { version: 1 }
    | (JpegPreparationSummary &
        (
          | { version: 2 }
          | {
              version: 3;
              requestBudgetBytes: 786432;
              requestBudgetMet: boolean;
              requestBudgetPasses: number;
              requestBudgetConverted: number;
              requestBudgetResized: number;
              requestBudgetQuality: 95 | 92 | 90;
              requestBudgetMaxEdge: 2048 | 1536 | 1024 | 768 | 512 | 384 | 256;
            }
        ))
  );

const COUNTS = [
  "optimized",
  "unchanged",
  "unsupported",
  "invalid",
  "limited",
] as const;
const KEYS = ["version", ...COUNTS, "originalBytes", "sentBytes"];
const JPEG_COUNTS = [
  "jpegConverted",
  "jpegSkipped",
  "jpegTransparent",
  "jpegLimited",
  "jpegResized",
  "jpegOriented",
] as const;
const BUDGET_KEYS = [
  "requestBudgetBytes",
  "requestBudgetMet",
  "requestBudgetPasses",
  "requestBudgetConverted",
  "requestBudgetResized",
  "requestBudgetQuality",
  "requestBudgetMaxEdge",
];

export function validVideoReferencePreparation(
  value: unknown,
): value is VideoReferencePreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys =
    entry.version === 2 || entry.version === 3
      ? [
          ...KEYS,
          ...JPEG_COUNTS,
          "jpegQuality",
          "jpegMaxEdge",
          "requestBytes",
          "originalRequestBytes",
          ...(entry.version === 3 ? BUDGET_KEYS : []),
        ]
      : KEYS;
  return (
    Object.keys(entry).length === keys.length &&
    keys.every((key) => Object.hasOwn(entry, key)) &&
    [1, 2, 3].includes(Number(entry.version)) &&
    typeof entry.version === "number" &&
    (entry.version === 1 ||
      (JPEG_COUNTS.every(
        (key) =>
          Number.isSafeInteger(entry[key]) &&
          Number(entry[key]) >= 0 &&
          Number(entry[key]) <= 30,
      ) &&
        entry.jpegQuality === 95 &&
        entry.jpegMaxEdge === 2048 &&
        Number(entry.jpegResized) <= Number(entry.jpegConverted) &&
        Number(entry.jpegOriented) <= Number(entry.jpegConverted) &&
        [entry.requestBytes, entry.originalRequestBytes].every(
          (bytes) =>
            Number.isSafeInteger(bytes) &&
            Number(bytes) >= 0 &&
            Number(bytes) <= 256 * 1024 * 1024,
        ) &&
        (entry.version === 3 ||
          Number(entry.requestBytes) <= Number(entry.originalRequestBytes)) &&
        Number(entry.jpegSkipped) +
          Number(entry.jpegTransparent) +
          Number(entry.jpegLimited) <=
          COUNTS.reduce((sum, key) => sum + Number(entry[key]), 0))) &&
    COUNTS.every(
      (key) =>
        Number.isSafeInteger(entry[key]) &&
        (entry[key] as number) >= 0 &&
        (entry[key] as number) <= 30,
    ) &&
    COUNTS.reduce((sum, key) => sum + Number(entry[key]), 0) +
      (entry.version !== 1 ? Number(entry.jpegConverted) : 0) <=
      30 &&
    [entry.originalBytes, entry.sentBytes].every(
      (bytes) =>
        Number.isSafeInteger(bytes) &&
        (bytes as number) >= 0 &&
        (bytes as number) <= 64 * 1024 * 1024,
    ) &&
    Number(entry.sentBytes) <= Number(entry.originalBytes) &&
    (entry.version !== 3 ||
      (entry.requestBudgetBytes === 786432 &&
        typeof entry.requestBudgetMet === "boolean" &&
        entry.requestBudgetMet === Number(entry.requestBytes) <= 786432 &&
        Number.isSafeInteger(entry.requestBudgetPasses) &&
        Number(entry.requestBudgetPasses) >= 0 &&
        Number(entry.requestBudgetPasses) <= 9 &&
        Number.isSafeInteger(entry.requestBudgetConverted) &&
        Number(entry.requestBudgetConverted) >= 0 &&
        Number(entry.requestBudgetConverted) <= 30 &&
        Number.isSafeInteger(entry.requestBudgetResized) &&
        Number(entry.requestBudgetResized) >= 0 &&
        Number(entry.requestBudgetResized) <=
          Number(entry.requestBudgetConverted) &&
        [95, 92, 90].includes(Number(entry.requestBudgetQuality)) &&
        typeof entry.requestBudgetQuality === "number" &&
        [2048, 1536, 1024, 768, 512, 384, 256].includes(
          Number(entry.requestBudgetMaxEdge),
        ) &&
        typeof entry.requestBudgetMaxEdge === "number"))
  );
}

export function parseVideoReferencePreparation(
  value: string | undefined,
): VideoReferencePreparation | undefined {
  if (value === undefined) return;
  try {
    const parsed: unknown =
      value.length <= 1024 ? JSON.parse(value) : undefined;
    return validVideoReferencePreparation(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}
