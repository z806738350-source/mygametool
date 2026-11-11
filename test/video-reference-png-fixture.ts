import { crc32, deflateSync, inflateSync } from "node:zlib";
export function pngChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
export function pngChunks(
  bytes: Buffer,
): Array<{ type: string; data: Buffer; raw: Buffer }> {
  const chunks = [];
  for (let i = 8; i < bytes.length;) {
    const size = bytes.readUInt32BE(i),
      end = i + size + 12;
    chunks.push({
      type: bytes.toString("ascii", i + 4, i + 8),
      data: bytes.subarray(i + 8, end - 4),
      raw: bytes.subarray(i, end),
    });
    i = end;
  }
  return chunks;
}
export function pngScanlines(bytes: Buffer): Buffer {
  return inflateSync(
    Buffer.concat(
      pngChunks(bytes)
        .filter((chunk) => chunk.type === "IDAT")
        .map((chunk) => chunk.data),
    ),
  );
}
export function referencePng(
  options: {
    width?: number;
    height?: number;
    color?: number;
    depth?: number;
    interlace?: boolean;
    metadata?: Array<[string, Buffer]>;
    level?: number;
    noise?: boolean;
  } = {},
): Buffer {
  const width = options.width ?? 128,
    height = options.height ?? 64,
    color = options.color ?? 6,
    depth = options.depth ?? 8;
  const channels = ({ 0: 1, 2: 3, 3: 1, 6: 4 } as Record<number, number>)[
    color
  ]!;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[12] = options.interlace ? 1 : 0;
  let seed = 53;
  const rows = [];
  for (const [xs, ys, dx, dy] of options.interlace
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
    for (let y = ys!; y < height; y += dy!) {
      const row = [0];
      for (let x = xs!; x < width; x += dx!)
        for (let c = 0; c < channels; c++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const value = options.noise
            ? seed & 255
            : color === 3
              ? (x + y) % 3
              : c === 3
                ? [0, 73, 155, 255][x % 4]!
                : (x * 3 + y * 5 + c * 11) & 255;
          if (depth === 16) row.push(value, (x + y) & 255);
          else row.push(value);
        }
      rows.push(Buffer.from(row));
    }
  }
  const metadata = [...(options.metadata ?? [])];
  if (color === 3)
    metadata.unshift(
      ["PLTE", Buffer.from([1, 5, 9, 55, 111, 222, 255, 99, 33])],
      ["tRNS", Buffer.from([0, 128, 255])],
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...metadata.map(([type, bytes]) => pngChunk(type, bytes)),
    pngChunk(
      "IDAT",
      deflateSync(Buffer.concat(rows), { level: options.level ?? 0 }),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
