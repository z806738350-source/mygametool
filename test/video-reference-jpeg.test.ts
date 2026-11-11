import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { prepareVideoReferenceJpeg } from "../src/daemon/video-reference-jpeg.js";
import { referencePng } from "./video-reference-png-fixture.js";
import {
  fitVideoReferenceBudget,
  VIDEO_REFERENCE_REQUEST_TARGET_BYTES,
  type LocalVideoImage,
} from "../src/daemon/video-reference-budget.js";
import { validVideoReferencePreparation } from "../src/shared/video-reference-preparation.js";

const opaque = (width = 512, height = 512) =>
  referencePng({ width, height, color: 2, noise: true });
async function psnr(original: Buffer, jpeg: Buffer) {
  const size = await sharp(jpeg).metadata();
  const [expected, actual] = await Promise.all([
    sharp(original)
      .autoOrient()
      .withIccProfile("srgb")
      .resize(size.width, size.height)
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(jpeg).removeAlpha().raw().toBuffer(),
  ]);
  expect(actual.length).toBe(expected.length);
  let squared = 0;
  for (let index = 0; index < actual.length; index++)
    squared += (actual[index]! - expected[index]!) ** 2;
  return 10 * Math.log10(255 ** 2 / (squared / actual.length));
}
describe("local lossy video reference copies", () => {
  it("keeps the persisted budget summary closed, internally consistent and compatible with earlier versions", () => {
    const legacy = {
      version: 2,
      optimized: 0,
      unchanged: 1,
      unsupported: 0,
      invalid: 0,
      limited: 0,
      originalBytes: 1000,
      sentBytes: 1000,
      jpegConverted: 0,
      jpegSkipped: 0,
      jpegTransparent: 0,
      jpegLimited: 0,
      jpegResized: 0,
      jpegOriented: 0,
      jpegQuality: 95,
      jpegMaxEdge: 2048,
      requestBytes: 1000,
      originalRequestBytes: 1500,
    };
    const current = {
      ...legacy,
      version: 3,
      requestBudgetBytes: 786432,
      requestBudgetMet: true,
      requestBudgetPasses: 1,
      requestBudgetConverted: 1,
      requestBudgetResized: 0,
      requestBudgetQuality: 92,
      requestBudgetMaxEdge: 2048,
    };
    expect(validVideoReferencePreparation(legacy)).toBe(true);
    expect(validVideoReferencePreparation(current)).toBe(true);
    for (const invalid of [
      { requestBudgetBytes: 1 },
      { requestBudgetMet: false },
      { requestBudgetPasses: 10 },
      { requestBudgetQuality: 89 },
      { requestBudgetResized: 2 },
      { requestBudgetMaxEdge: 255 },
      { url: "https://private.invalid/secret" },
      { image: "data:image/png;base64,private" },
    ])
      expect(validVideoReferencePreparation({ ...current, ...invalid })).toBe(
        false,
      );
  });
  it("measures the full mixed request and avoids re-encoding JPEG/WebP when already within the local target", async () => {
    const jpeg = await sharp(opaque(128, 128)).jpeg().toBuffer(),
      webp = await sharp(opaque(128, 128)).webp().toBuffer();
    const images = [
      { bytes: jpeg, mediaType: "image/jpeg" },
      undefined,
      { bytes: webp, mediaType: "image/webp" },
    ];
    const measure = (values: readonly (LocalVideoImage | undefined)[]) =>
      Buffer.byteLength(
        JSON.stringify({
          model: "synthetic",
          prompt: "fixed",
          images: values.map((image) =>
            image
              ? `data:${image.mediaType};base64,${image.bytes.toString("base64")}`
              : "https://kunpoapiimg.ziy.cc/private-synthetic-url",
          ),
        }),
      );
    const result = await fitVideoReferenceBudget(
      images,
      images,
      measure,
      new AbortController().signal,
      15_000,
    );
    expect(result.budget).toMatchObject({ met: true, passes: 0, converted: 0 });
    expect(result.images).toEqual(images);
    expect(result.budget.targetBytes).toBe(
      VIDEO_REFERENCE_REQUEST_TARGET_BYTES,
    );
  });

  it("coordinates multiple opaque PNG/JPEG/WebP copies without altering originals or silently changing their order", async () => {
    const png = await sharp(opaque(768, 768)).blur(0.7).png().toBuffer();
    const originals = [
      { bytes: png, mediaType: "image/png" },
      {
        bytes: await sharp(png)
          .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
          .toBuffer(),
        mediaType: "image/jpeg",
      },
      {
        bytes: await sharp(png).webp({ lossless: true }).toBuffer(),
        mediaType: "image/webp",
      },
    ];
    const before = originals.map((image) => Buffer.from(image.bytes));
    const measure = (values: readonly (LocalVideoImage | undefined)[]) =>
      Buffer.byteLength(
        JSON.stringify({
          model: "synthetic",
          prompt: "fixed",
          images: values.map(
            (image) =>
              `data:${image!.mediaType};base64,${image!.bytes.toString("base64")}`,
          ),
        }),
      );
    expect(measure(originals)).toBeGreaterThan(
      VIDEO_REFERENCE_REQUEST_TARGET_BYTES,
    );
    const result = await fitVideoReferenceBudget(
      originals,
      originals,
      measure,
      new AbortController().signal,
      15_000,
    );
    expect(
      result.budget,
      JSON.stringify({
        ...result.budget,
        requestBytes: measure(result.images),
      }),
    ).toMatchObject({ met: true, converted: 3 });
    expect(measure(result.images)).toBeLessThanOrEqual(
      VIDEO_REFERENCE_REQUEST_TARGET_BYTES,
    );
    for (const [index, image] of result.images.entries()) {
      expect(originals[index]!.bytes).toEqual(before[index]);
      expect(image!.mediaType).toBe("image/jpeg");
      const metadata = await sharp(image!.bytes).metadata();
      expect(metadata.width).toBe(metadata.height);
      expect(metadata.width).toBeGreaterThanOrEqual(256);
      expect(image!.bytes.length).toBeLessThan(originals[index]!.bytes.length);
      expect(await psnr(originals[index]!.bytes, image!.bytes)).toBeGreaterThan(
        25,
      );
    }
    expect(result.budget.quality).toBeGreaterThanOrEqual(90);
  });

  it("retains animated WebP and alpha without silently choosing a frame or background", async () => {
    const pixels = Buffer.alloc(16 * 32 * 3, 20);
    pixels.fill(230, 16 * 16 * 3);
    const bytes = await sharp(pixels, {
      raw: { width: 16, height: 32, channels: 3, pageHeight: 16 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    const result = await prepareVideoReferenceJpeg(bytes, undefined, 5000, {
      mediaType: "image/webp",
      quality: 90,
      maxEdge: 256,
    });
    expect(result?.status).toBe("skipped");
    expect(result?.bytes).toEqual(bytes);
    const alpha = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 0, g: 0, b: 1, alpha: 0.2 },
      },
    })
      .webp()
      .toBuffer();
    expect(
      (
        await prepareVideoReferenceJpeg(alpha, undefined, 5000, {
          mediaType: "image/webp",
          quality: 90,
          maxEdge: 256,
        })
      )?.status,
    ).toBe("transparent");
  });

  it.each(["jpeg", "webp"] as const)(
    "handles %s EXIF orientation and ICC only in its derived copy",
    async (format) => {
      const original = await sharp(opaque(512, 384))
        .withExif({ IFD0: { Artist: "synthetic-private-artist" } })
        .withMetadata({ orientation: 6 })
        .withIccProfile("p3")
        .toFormat(format, { quality: 100 })
        .toBuffer();
      const before = Buffer.from(original),
        result = await prepareVideoReferenceJpeg(original, undefined, 5000, {
          mediaType: `image/${format}`,
          quality: 90,
          maxEdge: 2048,
        });
      expect(result?.status).toBe("converted");
      expect(result?.oriented).toBe(true);
      expect(original).toEqual(before);
      const metadata = await sharp(result!.bytes).metadata();
      expect(metadata).toMatchObject({
        format: "jpeg",
        width: 384,
        height: 512,
        space: "srgb",
      });
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.icc).toBeTruthy();
      expect(
        result!.bytes.includes(Buffer.from("synthetic-private-artist")),
      ).toBe(false);
      expect(await psnr(original, result!.bytes)).toBeGreaterThan(25);
    },
  );

  it("cancels while coordinating JPEG copies and never changes input bytes", async () => {
    const bytes = await sharp(opaque()).jpeg({ quality: 100 }).toBuffer(),
      before = Buffer.from(bytes);
    const images = [{ bytes, mediaType: "image/jpeg" }],
      controller = new AbortController();
    const pending = fitVideoReferenceBudget(
      images,
      images,
      () => 2_000_000,
      controller.signal,
      15_000,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(bytes).toEqual(before);
    await vi.waitFor(async () =>
      expect((await prepareVideoReferenceJpeg(opaque()))?.status).toBe(
        "converted",
      ),
    );
  });

  it("does not flatten alpha/animation or alter immutable URL slots to force an impossible request target", async () => {
    const alpha = {
      bytes: referencePng({ width: 512, height: 512, color: 6, noise: true }),
      mediaType: "image/png",
    };
    const animated = {
      bytes: referencePng({
        width: 512,
        height: 512,
        color: 2,
        noise: true,
        metadata: [["acTL", Buffer.alloc(8)]],
      }),
      mediaType: "image/png",
    };
    const inputs = [alpha, undefined, animated];
    const measure = (values: readonly (LocalVideoImage | undefined)[]) =>
      values.reduce(
        (size, image) =>
          size + (image ? 4 * Math.ceil(image.bytes.length / 3) : 100),
        0,
      );
    const result = await fitVideoReferenceBudget(
      inputs,
      inputs,
      measure,
      new AbortController().signal,
      15_000,
    );
    expect(result.budget.met).toBe(false);
    expect(result.images).toEqual(inputs);
    expect(result.budget.converted).toBe(0);
    await expect(
      fitVideoReferenceBudget(
        inputs,
        inputs,
        measure,
        AbortSignal.abort(),
        15_000,
      ),
    ).rejects.toThrow();
    expect(
      (
        await fitVideoReferenceBudget(
          inputs,
          inputs,
          measure,
          new AbortController().signal,
          0,
        )
      ).budget,
    ).toMatchObject({ met: false, passes: 0 });
  });

  it("makes a smaller high-quality sRGB JPEG without changing an opaque PNG", async () => {
    const original = opaque(),
      snapshot = Buffer.from(original),
      result = await prepareVideoReferenceJpeg(original);
    expect(result?.status).toBe("converted");
    expect(result!.bytes.length).toBeLessThan(original.length);
    expect(original).toEqual(snapshot);
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata).toMatchObject({
      format: "jpeg",
      width: 512,
      height: 512,
      hasAlpha: false,
      space: "srgb",
    });
    expect(metadata.icc).toBeTruthy();
    expect(metadata.exif).toBeUndefined();
    expect(await psnr(original, result!.bytes)).toBeGreaterThan(28);
  });
  it("applies EXIF rotation and ICC conversion once, without retaining private EXIF", async () => {
    const original = await sharp(opaque(512, 384))
      .withExif({ IFD0: { Artist: "synthetic-private-metadata" } })
      .withMetadata({ orientation: 6 })
      .withIccProfile("p3")
      .png()
      .toBuffer();
    expect((await sharp(original).metadata()).orientation).toBe(6);
    const result = await prepareVideoReferenceJpeg(original);
    expect(result?.status).toBe("converted");
    expect(result?.oriented).toBe(true);
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata).toMatchObject({ width: 384, height: 512 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeTruthy();
    expect(await psnr(original, result!.bytes)).toBeGreaterThan(28);
    expect(
      result!.bytes.includes(Buffer.from("synthetic-private-metadata")),
    ).toBe(false);
  });
  it("downscales proportionally without enlarging or cropping and skips unsafe thin reductions", async () => {
    const large = referencePng({
        width: 3000,
        height: 600,
        color: 2,
        noise: true,
      }),
      result = await prepareVideoReferenceJpeg(large);
    expect(result?.status).toBe("converted");
    expect(result?.resized).toBe(true);
    expect(await sharp(result!.bytes).metadata()).toMatchObject({
      width: 2048,
      height: 410,
    });
    const thin = referencePng({
        width: 3000,
        height: 256,
        color: 2,
        noise: true,
      }),
      skipped = await prepareVideoReferenceJpeg(thin);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.bytes === thin).toBe(true);
  });
  it("keeps small PNGs, transparency, animation, higher bit depth and unknown colour interpretation", async () => {
    expect(
      await prepareVideoReferenceJpeg(referencePng({ color: 2 })),
    ).toBeUndefined();
    const alpha = referencePng({
      width: 512,
      height: 512,
      color: 6,
      noise: true,
    });
    expect((await prepareVideoReferenceJpeg(alpha))?.status).toBe(
      "transparent",
    );
    const samples = [
      referencePng({
        width: 512,
        height: 512,
        color: 0,
        depth: 16,
        noise: true,
      }),
      referencePng({
        width: 512,
        height: 512,
        color: 2,
        noise: true,
        metadata: [["acTL", Buffer.alloc(8)]],
      }),
      referencePng({
        width: 512,
        height: 512,
        color: 2,
        noise: true,
        metadata: [["gAMA", Buffer.from([0, 1, 134, 160])]],
      }),
    ];
    for (const bytes of samples) {
      const result = await prepareVideoReferenceJpeg(bytes);
      expect(result?.status).toBe("skipped");
      expect(result?.bytes === bytes).toBe(true);
    }
  });
  it("bounds malformed input and cancellation without releasing an active native slot early", async () => {
    expect(
      await prepareVideoReferenceJpeg(Buffer.from("invalid")),
    ).toBeUndefined();
    const bytes = opaque(),
      controller = new AbortController(),
      pending = prepareVideoReferenceJpeg(bytes, controller.signal);
    expect((await prepareVideoReferenceJpeg(bytes))?.status).toBe("limited");
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(async () =>
      expect((await prepareVideoReferenceJpeg(bytes))?.status).toBe(
        "converted",
      ),
    );
    const timed = await prepareVideoReferenceJpeg(bytes, undefined, 1);
    expect(timed?.status).toBe("limited");
    await vi.waitFor(async () =>
      expect((await prepareVideoReferenceJpeg(bytes))?.status).toBe(
        "converted",
      ),
    );
  });
});
