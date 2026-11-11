import { crc32, createDeflate, createInflate } from "node:zlib";
import { PNG_SIGNATURE } from "./image-format.js";

export type PngPreparationStatus =
  "optimized" | "unchanged" | "unsupported" | "invalid" | "limited";
const MAX_INPUT = 30 * 1024 * 1024;
export const MAX_PNG_SCANLINE_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const KNOWN = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "iCCP",
  "gAMA",
  "cHRM",
  "sRGB",
  "pHYs",
  "eXIf",
  "tEXt",
  "zTXt",
  "iTXt",
  "sBIT",
  "bKGD",
  "hIST",
  "tIME",
  "cICP",
  "mDCV",
  "cLLI",
]);
// ponytail: one codec operation at a time bounds native compression work; contention uses the original.
let busy = false;
class Limited extends Error {}
interface Chunk {
  type: string;
  data: Buffer;
  raw: Buffer;
}

function expectedScanlines(
  header: Buffer,
): Array<{ length: number; count: number }> {
  if (header.length !== 13) throw new Error();
  const width = header.readUInt32BE(),
    height = header.readUInt32BE(4),
    depth = header[8]!,
    color = header[9]!;
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (
    !width ||
    !height ||
    !depths[color]?.includes(depth) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    ![0, 1].includes(header[12]!)
  )
    throw new Error();
  const rows: Array<{ length: number; count: number }> = [];
  let size = 0;
  for (const [x, y, dx, dy] of header[12]
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]]) {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!)),
      count = Math.max(0, Math.ceil((height - y!) / dy!));
    if (!columns || !count) continue;
    const length = Math.ceil((columns * channels[color]! * depth) / 8) + 1;
    size += length * count;
    if (!Number.isSafeInteger(size) || size > MAX_PNG_SCANLINE_BYTES)
      throw new Limited();
    rows.push({ length, count });
  }
  return rows;
}

function parse(
  bytes: Buffer,
  signal: AbortSignal,
): { chunks: Chunk[]; rows: Array<{ length: number; count: number }> } {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error();
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    if (chunks.length >= MAX_CHUNKS) throw new Limited();
    if (offset + 12 > bytes.length) throw new Error();
    const length = bytes.readUInt32BE(offset),
      end = offset + length + 12;
    if (end > bytes.length) throw new Error();
    const type = bytes.toString("latin1", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, end - 4);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new Error();
    chunks.push({ type, data, raw: bytes.subarray(offset, end) });
    offset = end;
  }
  if (
    chunks[0]?.type !== "IHDR" ||
    chunks.at(-1)?.type !== "IEND" ||
    chunks.at(-1)!.data.length ||
    chunks.filter((chunk) => chunk.type === "IHDR").length !== 1 ||
    chunks.filter((chunk) => chunk.type === "IEND").length !== 1
  )
    throw new Error();
  for (const type of [
    "PLTE",
    "tRNS",
    "iCCP",
    "gAMA",
    "cHRM",
    "sRGB",
    "pHYs",
    "eXIf",
    "sBIT",
    "bKGD",
    "hIST",
    "cICP",
    "mDCV",
    "cLLI",
    "tIME",
  ])
    if (chunks.filter((chunk) => chunk.type === type).length > 1)
      throw new Error();
  if (
    chunks.some((chunk) => chunk.type === "iCCP") &&
    chunks.some((chunk) => chunk.type === "sRGB")
  )
    throw new Error();
  const color = chunks[0]!.data[9],
    palette = chunks.find((chunk) => chunk.type === "PLTE"),
    transparency = chunks.find((chunk) => chunk.type === "tRNS");
  if (
    (color === 3 && !palette) ||
    (palette &&
      (!palette.data.length ||
        palette.data.length % 3 ||
        palette.data.length > 768 ||
        color === 0 ||
        color === 4 ||
        chunks.indexOf(palette) >
          chunks.findIndex((chunk) => chunk.type === "IDAT")))
  )
    throw new Error();
  if (
    transparency &&
    (color === 3
      ? !palette || transparency.data.length > palette.data.length / 3
      : color === 0
        ? transparency.data.length !== 2
        : color === 2
          ? transparency.data.length !== 6
          : true)
  )
    throw new Error();
  return { chunks, rows: expectedScanlines(chunks[0]!.data) };
}

async function codec(
  bytes: Buffer,
  inflate: boolean,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const stream = inflate ? createInflate() : createDeflate({ level: 9 });
  const abort = () => stream.destroy(new Error("PNG preparation stopped"));
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    stream.end(bytes);
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw new Limited();
      chunks.push(chunk);
    }
    if (inflate && stream.bytesWritten !== bytes.length) throw new Error();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    stream.destroy();
  }
}

/** Only IDAT changes. Equal header + equal filtered scanlines + identical other chunks preserve every sample and its interpretation. */
export async function optimizeVideoReferencePng(
  bytes: Buffer,
  caller?: AbortSignal,
  timeoutMs = 5000,
): Promise<{ bytes: Buffer; status: PngPreparationStatus }> {
  caller?.throwIfAborted();
  if (busy || bytes.length > MAX_INPUT) return { bytes, status: "limited" };
  const timeout = AbortSignal.timeout(
      Math.min(5000, Math.max(1, Math.trunc(timeoutMs))),
    ),
    signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  busy = true;
  try {
    const { chunks, rows } = parse(bytes, signal);
    if (
      chunks.some(
        (chunk) =>
          ["acTL", "fcTL", "fdAT"].includes(chunk.type) ||
          !KNOWN.has(chunk.type),
      )
    )
      return { bytes, status: "unsupported" };
    const positions = chunks.flatMap((chunk, index) =>
      chunk.type === "IDAT" ? [index] : [],
    );
    if (
      !positions.length ||
      positions.some((value, index) => value !== positions[0]! + index)
    )
      throw new Error();
    const compressed = Buffer.concat(
      chunks
        .filter((chunk) => chunk.type === "IDAT")
        .map((chunk) => chunk.data),
    );
    const expected = rows.reduce((sum, row) => sum + row.length * row.count, 0);
    const original = await codec(compressed, true, expected, signal);
    if (original.length !== expected) throw new Error();
    let offset = 0;
    for (const { length, count } of rows)
      for (let row = 0; row < count; row++) {
        if (row % 65536 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
        }
        if (original[offset]! > 4) throw new Error();
        offset += length;
      }
    const encoded = await codec(original, false, MAX_INPUT, signal);
    if (!(await codec(encoded, true, expected, signal)).equals(original))
      throw new Error();
    const idat = Buffer.alloc(encoded.length + 12);
    idat.writeUInt32BE(encoded.length);
    idat.write("IDAT", 4);
    encoded.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
    let emitted = false;
    const result = Buffer.concat([
      PNG_SIGNATURE,
      ...chunks.flatMap((chunk) =>
        chunk.type !== "IDAT"
          ? [chunk.raw]
          : emitted
            ? []
            : ((emitted = true), [idat]),
      ),
    ]);
    signal.throwIfAborted();
    return result.length < bytes.length
      ? { bytes: result, status: "optimized" }
      : { bytes, status: "unchanged" };
  } catch (cause) {
    caller?.throwIfAborted();
    return {
      bytes,
      status:
        cause instanceof Limited || timeout.aborted ? "limited" : "invalid",
    };
  } finally {
    busy = false;
  }
}
