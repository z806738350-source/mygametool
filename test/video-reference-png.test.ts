import { describe, expect, it } from "vitest";
import {
  MAX_PNG_SCANLINE_BYTES,
  optimizeVideoReferencePng,
} from "../src/daemon/video-reference-png.js";
import {
  pngChunk,
  pngChunks,
  pngScanlines,
  referencePng,
} from "./video-reference-png-fixture.js";
import { deflateSync } from "node:zlib";
import {
  parseVideoReferencePreparation,
  validVideoReferencePreparation,
} from "../src/shared/video-reference-preparation.js";

describe("lossless PNG video references", () => {
  it.each([
    { color: 6 },
    { color: 2 },
    { color: 3 },
    { color: 0, depth: 16 },
    { color: 6, interlace: true },
  ])(
    "preserves every filtered sample, alpha/palette and metadata for %j",
    async (options) => {
      const metadata: Array<[string, Buffer]> = [
        [
          "iCCP",
          Buffer.from(
            "SUNDIFByb2ZpbGUAAHicdZG9S0JRGMZ/aWFY4VBDRISERUNCFERj2eAiIWaQ1aLXr+Bql3uVkNagpUFoiFr6GvoPag1aC4KgCCKaG/taIm7vUUEJPZdz3x/POc/Le58LjpCu5az2WcjlC2YkGPAux1a8rjfcDOFiGFdcs4y5cDhEy/X9QJuq937Vq/W9pqsrmbI0aOsUntYMsyAs0xDaLBiKd4X7tGw8KXwsPG7KgMI3Sk9U+VVxpsqfis1oZB4cqqc308CJBtayZk54TNiX04tabR71Jd2p/NKi1AHZg1hECBLAS4Ii6+gU8EvNS2bNfRMV3wIb4tHkbVDCFEeGrHjHRS1K15TUtOgpeXRKKvf/eVrpqclq9+4AdLzY9scIuPbgt2zbPye2/XsKzme4ytf9G5LTzJfo5brmOwLPNlxc17XEPlzuQP+TETfjFckp25FOw/s59MSg9w7cq9WsauecPUJ0S37RLRwcwqjc96z9AflHaAY=",
            "base64",
          ),
        ],
        ["gAMA", Buffer.from([0, 0, 177, 143])],
        [
          "eXIf",
          Buffer.from(
            "49492a0008000000010012010300010000000600000000000000",
            "hex",
          ),
        ],
      ];
      const original = referencePng({
          ...options,
          metadata:
            options.color === 0
              ? metadata.filter(([type]) => type !== "iCCP")
              : metadata,
        }),
        snapshot = Buffer.from(original),
        result = await optimizeVideoReferencePng(original);
      expect(result.status).toBe("optimized");
      expect(result.bytes.length).toBeLessThan(original.length);
      expect(original).toEqual(snapshot);
      expect(pngScanlines(result.bytes)).toEqual(pngScanlines(original));
      expect(
        pngChunks(result.bytes)
          .filter((chunk) => chunk.type !== "IDAT")
          .map((chunk) => chunk.raw),
      ).toEqual(
        pngChunks(original)
          .filter((chunk) => chunk.type !== "IDAT")
          .map((chunk) => chunk.raw),
      );
    },
  );

  it("keeps already-compressed high-entropy input and unsupported structures byte-identical", async () => {
    const noise = referencePng({ level: 9, noise: true });
    const result = await optimizeVideoReferencePng(noise);
    expect(result.status).toBe("unchanged");
    expect(result.bytes).toBe(noise);
    for (const type of ["acTL", "vpAg"]) {
      const bytes = referencePng({ metadata: [[type, Buffer.alloc(8)]] });
      expect(await optimizeVideoReferencePng(bytes)).toEqual({
        bytes,
        status: "unsupported",
      });
    }
  });

  it("falls back without attempting huge allocations, invalid data, extra zlib streams or CRC/trailing damage", async () => {
    const valid = referencePng(),
      crc = Buffer.from(valid);
    crc[35]! ^= 1;
    const ihdr = Buffer.from(pngChunks(valid)[0]!.data);
    ihdr.writeUInt32BE(1_000_000, 4);
    const huge = Buffer.concat([
      valid.subarray(0, 8),
      pngChunk("IHDR", ihdr),
      ...pngChunks(valid)
        .slice(1)
        .map((chunk) => chunk.raw),
    ]);
    const inflatedTooLong = Buffer.concat([
      valid.subarray(0, 8),
      pngChunks(valid)[0]!.raw,
      pngChunk("IDAT", deflateSync(Buffer.alloc(MAX_PNG_SCANLINE_BYTES + 1))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const extra = Buffer.concat([
      valid.subarray(0, 8),
      pngChunks(valid)[0]!.raw,
      pngChunk(
        "IDAT",
        Buffer.concat([
          deflateSync(pngScanlines(valid)),
          Buffer.from("unused"),
        ]),
      ),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    for (const bytes of [
      crc,
      huge,
      inflatedTooLong,
      extra,
      valid.subarray(0, -1),
      Buffer.concat([valid, Buffer.from("trailing")]),
    ]) {
      const result = await optimizeVideoReferencePng(bytes);
      expect(["invalid", "limited"]).toContain(result.status);
      expect(result.bytes).toBe(bytes);
    }
  });

  it("cancels native work and releases the bounded optimizer slot", async () => {
    const controller = new AbortController(),
      bytes = referencePng({ width: 736, height: 736 });
    const active = optimizeVideoReferencePng(bytes, controller.signal);
    expect((await optimizeVideoReferencePng(bytes)).status).toBe("limited");
    controller.abort();
    await expect(active).rejects.toThrow();
    expect((await optimizeVideoReferencePng(bytes)).status).toBe("optimized");
    const already = new AbortController();
    already.abort();
    await expect(
      optimizeVideoReferencePng(bytes, already.signal),
    ).rejects.toThrow();
  });

  it("bounds input, chunks and preparation time while retaining original bytes", async () => {
    const oversized = Buffer.alloc(30 * 1024 * 1024 + 1);
    const largeResult = await optimizeVideoReferencePng(oversized);
    expect(largeResult.status).toBe("limited");
    expect(largeResult.bytes === oversized).toBe(true);
    const chunks = referencePng({
      metadata: Array.from(
        { length: 4096 },
        () => ["tEXt", Buffer.from("test\0value")] as [string, Buffer],
      ),
    });
    const chunkResult = await optimizeVideoReferencePng(chunks);
    expect(chunkResult.status).toBe("limited");
    expect(chunkResult.bytes === chunks).toBe(true);
    const bytes = referencePng({ width: 736, height: 736, noise: true });
    const timedResult = await optimizeVideoReferencePng(bytes, undefined, 1);
    expect(timedResult.status).toBe("limited");
    expect(timedResult.bytes === bytes).toBe(true);
    expect((await optimizeVideoReferencePng(referencePng())).status).toBe(
      "optimized",
    );
  });

  it("only accepts bounded, closed preparation summaries without arbitrary data", () => {
    const valid = {
      version: 1,
      optimized: 1,
      unchanged: 0,
      unsupported: 0,
      invalid: 0,
      limited: 0,
      originalBytes: 8192,
      sentBytes: 2048,
    };
    expect(parseVideoReferencePreparation(JSON.stringify(valid))).toEqual(
      valid,
    );
    for (const invalid of [
      { ...valid, url: "private-canary" },
      { ...valid, optimized: 31 },
      { ...valid, optimized: -1 },
      { ...valid, sentBytes: 9000 },
      { ...valid, originalBytes: 65 * 1024 * 1024 },
    ]) {
      expect(validVideoReferencePreparation(invalid)).toBe(false);
      expect(
        parseVideoReferencePreparation(JSON.stringify(invalid)),
      ).toBeUndefined();
    }
    expect(parseVideoReferencePreparation("x".repeat(1025))).toBeUndefined();
    expect(parseVideoReferencePreparation("{broken")).toBeUndefined();
    const v2 = {
      ...valid,
      version: 2,
      optimized: 0,
      jpegConverted: 1,
      jpegSkipped: 0,
      jpegTransparent: 0,
      jpegLimited: 0,
      jpegResized: 0,
      jpegOriented: 0,
      jpegQuality: 95,
      jpegMaxEdge: 2048,
      requestBytes: 3000,
      originalRequestBytes: 12000,
    };
    expect(parseVideoReferencePreparation(JSON.stringify(v2))).toEqual(v2);
    for (const invalid of [
      { ...v2, jpegConverted: 31 },
      { ...v2, jpegQuality: 50 },
      { ...v2, jpegResized: 2 },
      { ...v2, requestBytes: 13000 },
      { ...v2, prompt: "private" },
    ])
      expect(validVideoReferencePreparation(invalid)).toBe(false);
  });
});
