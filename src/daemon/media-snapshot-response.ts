import type { Readable } from "node:stream";
import type { CheckedMediaSnapshot } from "./checked-media-snapshot.js";

type ByteRange = { start: number; end: number };

/** Display inspection budgets only; these do not change generation or isolated execution limits. */
export function mediaPreviewReadLimit(contentType: string): number {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "video/mp4" || type === "video/webm") return 256 * 1024 * 1024;
  if (type === "audio/wav" || type === "audio/mpeg" || type === "audio/ogg")
    return 200 * 1024 * 1024;
  if (type === "model/gltf-binary") return 100 * 1024 * 1024;
  return 64 * 1024 * 1024;
}

/** Preserve the static server's full-200 response for malformed or multiple ranges. */
function byteRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  const match =
    typeof header === "string" && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return undefined;
  const start = first ?? Math.max(0, size - last!);
  const end =
    first !== undefined && last !== undefined
      ? Math.min(last, size - 1)
      : size - 1;
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

/** HEAD/416 leave release to the caller; a GET body owns and releases its snapshot lease. */
export function mediaSnapshotResponse(
  snapshot: CheckedMediaSnapshot,
  options: {
    method: string;
    range?: string;
    ifRange?: string;
    contentType: string;
    cacheControl: string;
    signal?: AbortSignal;
  },
): { status: number; headers: Record<string, string>; body?: Readable } {
  options.signal?.throwIfAborted();
  snapshot.assertCurrentPolicy();
  if (options.method !== "GET" && options.method !== "HEAD")
    throw new Error("Unsupported media response method");
  const etag = `"${snapshot.sha256}"`;
  const headers: Record<string, string> = {
    "content-type": options.contentType,
    "cache-control": options.cacheControl,
    "accept-ranges": "bytes",
    "content-length": String(snapshot.size),
    etag,
  };
  if (options.contentType.split(";", 1)[0] === "image/svg+xml")
    headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  if (options.method === "HEAD") return { status: 200, headers };
  const range =
    options.ifRange === undefined || options.ifRange.trim() === etag
      ? byteRange(options.range, snapshot.size)
      : undefined;
  if (range === "unsatisfiable")
    return {
      status: 416,
      headers: {
        ...headers,
        "content-length": "0",
        "content-range": `bytes */${snapshot.size}`,
      },
    };
  if (range) {
    headers["content-length"] = String(range.end - range.start + 1);
    headers["content-range"] =
      `bytes ${range.start}-${range.end}/${snapshot.size}`;
  }
  return {
    status: range ? 206 : 200,
    headers,
    body: snapshot.stream(range, options.signal),
  };
}
