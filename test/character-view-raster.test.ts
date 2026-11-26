import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { inspectCharacterViewRaster, prepareCharacterRaster } from "../src/daemon/character-view-raster.js";
import { RASTER_BYTES } from "../src/daemon/raster-policy.js";

const base = {
  canvas: { width: 10, height: 10 },
  pivot: { x: 5, y: 5 },
  sourceGroundPoint: { x: 3, y: 3 },
  scale: 1,
  sampling: "nearest" as const,
};
const paint = [214, 19, 52, 240];

function sprite(width = 7, height = 7, fill = 0) {
  return Buffer.alloc(width * height * 4, fill);
}

function png(data: Buffer, width = 7, height = 7) {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function pixel(data: Buffer, width: number, x: number, y: number) {
  const start = (y * width + x) * 4;
  return [...data.subarray(start, start + 4)];
}

describe("derive a character direction PNG", () => {
  it("reports a nearly opaque sprite interior when the generator has capped alpha below 255", async () => {
    const source = sprite();
    for (const [x, alpha] of [1, 249, 250, 253, 254].entries()) source[(3 * 7 + x) * 4 + 3] = alpha;
    expect(await inspectCharacterViewRaster(await png(source))).toMatchObject({
      alpha: { clear: 44, soft: 5, opaque: 0 }, nearOpaquePixels: 3,
    });
  });

  it("uses one fractional edge-coordinate transform and preserves each nonzero nearest alpha", async () => {
    const source = sprite();
    source.set([122, 205, 30, 1], (3 * 7 + 3) * 4);
    source.set([88, 36, 30, 91], (3 * 7 + 4) * 4);
    source.set([11, 32, 99, 255], (4 * 7 + 3) * 4);
    const bytes = await png(source);
    const before = Buffer.from(bytes);
    const result = await prepareCharacterRaster(bytes, {
      ...base,
      canvas: { width: 12, height: 11 },
      sourceGroundPoint: { x: 3.5, y: 4 },
      pivot: { x: 5.75, y: 6.5 },
      scale: 1.5,
    });
    expect(bytes.equals(before)).toBe(true);
    expect(result.translation).toEqual({ x: 0.5, y: 0.5 });
    expect(result.source).toEqual({ width: 7, height: 7 });
    expect(result.output).toEqual({ width: 12, height: 11 });
    expect(result.bounds).toEqual({ left: 5, top: 5, right: 8, bottom: 8 });
    expect(result.alpha).toEqual({ clear: 127, soft: 3, opaque: 2 });
    const { data, info } = await sharp(result.png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(pixel(data, 12, 5, 5)).toEqual([122, 205, 30, 1]);
    expect(pixel(data, 12, 7, 5)).toEqual([88, 36, 30, 91]);
    expect(pixel(data, 12, 5, 7)).toEqual([11, 32, 99, 255]);
    expect(pixel(data, 12, 7, 7)).toEqual([0, 0, 0, 0]);
  });

  it("can move transparent margins outside the canvas but refuses cropping even one alpha step", async () => {
    const source = sprite();
    source.set([214, 19, 52, 1], (3 * 7 + 3) * 4);
    const input = await png(source);
    const edge = await prepareCharacterRaster(input, { ...base, pivot: { x: 0, y: 0 } });
    expect(edge.bounds).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
    expect(edge.alpha.soft).toBe(1);
    await expect(prepareCharacterRaster(input, {
      ...base,
      pivot: { x: 0, y: 0 },
      sourceGroundPoint: { x: 3.125, y: 3 },
    })).rejects.toThrow(/alpha footprint would leave/);
  });

  it("tests the Lanczos3 footprint beyond the visible source box and filters premultiplied color", async () => {
    const source = sprite();
    for (let i = 0; i < source.length; i += 4) source[i + 1] = 255;
    source.set(paint, (3 * 7 + 3) * 4);
    const bytes = await png(source);
    const options = { ...base, pivot: { x: 1, y: 5 }, scale: 1.5 };
    await expect(prepareCharacterRaster(bytes, options)).resolves.toBeDefined();
    await expect(prepareCharacterRaster(bytes, { ...options, sampling: "lanczos3" }))
      .rejects.toThrow(/Lanczos3 alpha footprint would leave/);

    const result = await prepareCharacterRaster(bytes, {
      ...options, pivot: { x: 5, y: 5 }, sampling: "lanczos3",
    });
    expect(result.bounds).toEqual({ left: 1, top: 1, right: 10, bottom: 10 });
    const data = await sharp(result.png).raw().toBuffer();
    expect(pixel(data, 10, 5, 5)).toEqual([214, 19, 52, 217]);
    expect(pixel(data, 10, 1, 5)).toEqual([214, 19, 52, 1]);
  });

  it("exports a deterministic PNG from a validated static WebP without changing its integer placement", async () => {
    const source = sprite();
    source.set(paint, (3 * 7 + 3) * 4);
    const input = await sharp(source, { raw: { width: 7, height: 7, channels: 4 } })
      .webp({ lossless: true }).toBuffer();
    const options = { ...base, sampling: "lanczos3" as const };
    const first = await prepareCharacterRaster(input, options);
    const second = await prepareCharacterRaster(input, options);
    expect(first.png.equals(second.png)).toBe(true);
    const image = sharp(first.png);
    expect((await image.metadata()).format).toBe("png");
    expect(pixel(await image.raw().toBuffer(), 10, 5, 5)).toEqual(paint);
    expect(first.bounds).toEqual({ left: 5, top: 5, right: 6, bottom: 6 });
  });

  it("rejects invalid or unsupported RGBA inputs and output bounds", async () => {
    const source = sprite();
    source.set(paint, (3 * 7 + 3) * 4);
    const valid = await png(source);
    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 1] ^= 1;
    const animated = Buffer.alloc(20);
    animated.writeUInt32BE(8);
    animated.write("acTL", 4);
    animated.writeUInt32BE(1, 8);
    animated.writeUInt32BE(crc32(animated.subarray(4, 16)), 16);
    const animatedPng = Buffer.concat([valid.subarray(0, 33), animated, valid.subarray(33)]);
    const oversizedPixels = Buffer.from(valid);
    oversizedPixels.writeUInt32BE(10_000, 16);
    oversizedPixels.writeUInt32BE(10_000, 20);
    oversizedPixels.writeUInt32BE(crc32(oversizedPixels.subarray(12, 29)), 29);
    for (const input of [valid.subarray(0, valid.length - 8), corrupt, animatedPng, oversizedPixels]) {
      await expect(prepareCharacterRaster(input, base)).rejects.toThrow(/Raster return requires review/);
    }
    await expect(prepareCharacterRaster(Buffer.from("GIF89a"), base)).rejects.toThrow(/static PNG or WebP/);
    await expect(prepareCharacterRaster(await png(sprite()), base)).rejects.toThrow(/no visible pixels/);
    await expect(prepareCharacterRaster(await png(sprite(7, 7, 255)), base)).rejects.toThrow(/fully opaque/);
    await expect(prepareCharacterRaster(Buffer.alloc(RASTER_BYTES + 1), base)).rejects.toThrow(/encoded size/);
    await expect(prepareCharacterRaster(valid, { ...base, canvas: { width: 10_000, height: 10_000 } }))
      .rejects.toThrow(/pixel budget/);
    await expect(prepareCharacterRaster(valid, { ...base, sourceGroundPoint: { x: 8, y: 3 } }))
      .rejects.toThrow(/ground point/);
    await expect(prepareCharacterRaster(valid, { ...base, sampling: "lanczos3", scale: 1e-10 }))
      .rejects.toThrow(/processing budget/);
  });
});
