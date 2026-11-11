import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { containsKnownSensitiveValue, knownSensitiveValueOverlap } from "../shared/sensitive-values.js";

export const MAX_SAFE_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export class SafeProjectFileError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

/** Exact registered credentials only; ordinary binary bytes are never decoded and re-encoded for output. */
export function assertNoKnownSecretBytes(bytes: Uint8Array): void {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Registered values use JS character lengths. Four bytes per character also covers UTF-8 boundaries.
  const overlap = knownSensitiveValueOverlap() * 4;
  for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
    if (containsKnownSensitiveValue(value.subarray(Math.max(0, offset - overlap), offset + CHUNK_BYTES).toString("utf8")))
      throw new SafeProjectFileError("Protected credential data cannot be served", 403);
  }
}

async function withStableFile<T>(root: string, filename: string, limit: number, read: (handle: FileHandle, size: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const directory = await realpath(root);
  const candidate = path.resolve(filename);
  const relative = path.relative(directory, candidate);
  if (!path.isAbsolute(filename) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || await realpath(candidate) !== candidate)
    throw new SafeProjectFileError("Linked or outside project files cannot be served", 403);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n)
      throw new SafeProjectFileError("Only ordinary non-linked project files can be served", 403);
    if (initial.size > BigInt(limit))
      throw new SafeProjectFileError(`Project files above the ${limit / (1024 * 1024)} MiB secure inspection limit cannot be served`, 413);
    const result = await read(handle, Number(initial.size));
    signal?.throwIfAborted();
    const final = await handle.stat({ bigint: true });
    const current = await stat(candidate, { bigint: true });
    if (final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs || final.nlink !== 1n || current.dev !== final.dev || current.ino !== final.ino || await realpath(candidate) !== candidate)
      throw new SafeProjectFileError("Project file changed during secure inspection; retry the request", 409);
    signal?.throwIfAborted();
    return result;
  } finally { await handle.close(); }
}

/** Read and validate one bounded snapshot before releasing headers or any content bytes. */
export function readSafeProjectFile(root: string, filename: string, limit = MAX_SAFE_PROJECT_FILE_BYTES): Promise<Buffer> {
  return withStableFile(root, filename, Math.min(limit, MAX_SAFE_PROJECT_FILE_BYTES), async (handle, size) => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(CHUNK_BYTES, size - offset), offset);
      if (!bytesRead) throw new SafeProjectFileError("Project file changed during secure inspection; retry the request", 409);
      offset += bytesRead;
    }
    assertNoKnownSecretBytes(bytes);
    return bytes;
  });
}

/** Describe a secret-checked media snapshot without retaining the full payload for every preview. */
export function inspectSafeProjectMedia(root: string, filename: string, limit: number, prefixBytes = 16, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isInteger(prefixBytes) || prefixBytes < 1 || prefixBytes > 256) throw new Error("Invalid media inspection prefix bound");
  return withStableFile(root, filename, Math.min(limit, MAX_SAFE_PROJECT_FILE_BYTES), async (handle, size) => {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const prefix = Buffer.alloc(Math.min(size, prefixBytes));
    const overlap = knownSensitiveValueOverlap() * 4;
    let tail: Buffer = Buffer.alloc(0);
    let offset = 0;
    while (offset < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!bytesRead) throw new SafeProjectFileError("Project file changed during secure inspection; retry the request", 409);
      const bytes = chunk.subarray(0, bytesRead);
      if (offset < prefix.length) bytes.copy(prefix, offset, 0, Math.min(bytesRead, prefix.length - offset));
      const span = tail.length ? Buffer.concat([tail, bytes]) : bytes;
      if (containsKnownSensitiveValue(span.toString("utf8"))) throw new SafeProjectFileError("Protected credential data cannot be served", 403);
      if (overlap) tail = Buffer.from(span.subarray(Math.max(0, span.length - overlap)));
      hash.update(bytes);
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    return { size, prefix, sha256: hash.digest("hex") };
  }, signal);
}
