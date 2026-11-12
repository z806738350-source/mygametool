import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  imageDigest,
  prepareWorkingImage,
  replaceWorkingImages,
  retainImageOriginal,
  serializeWorkingImages,
} from "../src/daemon/image-working-assets.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { validateRasterReturn } from "../src/daemon/isolated-raster-returns.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { pngChunk, referencePng } from "./video-reference-png-fixture.js";
import { serializeRasterDecoding } from "../src/daemon/raster-policy.js";
import { assertLocalImagePublicationsSettled, releaseRetiredProjectRecoverySpace, reserveRecoverySpace, reserveLocalImageRecoverySpace, restoreLocalImageRecoverySpaces, withRecoverySpaceReservation } from "../src/daemon/recovery-space.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const png = (width = 32) =>
  sharp({
    create: {
      width,
      height: width,
      channels: 4,
      background: { r: 80, g: 40, b: 20, alpha: 0.25 },
    },
  })
    .png()
    .toBuffer();
afterEach(() => vi.restoreAllMocks());
async function fixture(
  run: (
    directory: string,
    manager: ProjectManager,
    project: Awaited<ReturnType<ProjectManager["create"]>>,
  ) => Promise<void>,
) {
  const directory = await fs.realpath(await mkdtemp(
    path.join(tmpdir(), "ohmygame-working-images-"),
  ));
  try {
    const manager = new ProjectManager(directory);
    await manager.load();
    const project = await manager.create("Images");
    await run(directory, manager, project);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("local working image preparation", () => {
  it("preserves each frame and alpha of a 2048px sprite atlas by default", async () => {
    const pixels = Buffer.alloc(2048 * 2048 * 4);
    for (let y = 0; y < 2048; y++) for (let x = 0; x < 2048; x++) {
      const i = (y * 2048 + x) * 4;
      pixels[i] = (x + Math.floor(y / 512) * 31) & 255;
      pixels[i + 1] = (y + Math.floor(x / 512) * 47) & 255;
      pixels[i + 2] = (x ^ y) & 255;
      pixels[i + 3] = [0, 73, 155, 255][(x + y) % 4]!;
    }
    const original = await sharp(pixels, { raw: { width: 2048, height: 2048, channels: 4 } }).png().toBuffer();
    const prepared = await prepareWorkingImage(original);
    expect(prepared.bytes.equals(original)).toBe(true);
    expect([prepared.width, prepared.height, prepared.hasAlpha, prepared.hasTransparency]).toEqual([2048, 2048, true, true]);
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      const region = { left: column * 512, top: row * 512, width: 512, height: 512 };
      const before = await sharp(original).extract(region).ensureAlpha().raw().toBuffer();
      const after = await sharp(prepared.bytes).extract(region).ensureAlpha().raw().toBuffer();
      expect(after.equals(before)).toBe(true);
    }
  }, 30000);
  it("preserves JPEG originals until an explicit size is requested", async () => {
    const original = await sharp(referencePng({ width: 1024, height: 1024, noise: true, level: 0 })).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    const before = Buffer.from(original); expect(original.length).toBeGreaterThan(512 * 1024);
    expect((await prepareWorkingImage(original)).bytes.equals(original)).toBe(true);
    expect(original.equals(before)).toBe(true);
    const working = await prepareWorkingImage(original, 256); expect(working.width).toBe(256);
    expect(original.equals(before)).toBe(true);
  });
  it("refuses implicit EXIF rotation during dimension-preserving preparation", async () => {
    const original = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const before = Buffer.from(original); expect((await sharp(original).metadata()).orientation).toBe(6);
    await expect(prepareWorkingImage(original)).rejects.toThrow("orientation needs explicit preparation");
    await expect(prepareWorkingImage(original, undefined, "preserve-dimensions")).rejects.toThrow("orientation needs explicit preparation");
    const oriented = await prepareWorkingImage(original, 256);
    expect([oriented.width, oriented.height]).toEqual([20, 40]);
    expect(original).toEqual(before); expect((await sharp(original).metadata()).width).toBe(40);
  });
  it("keeps noisy PNG dimensions by default and never silently shrinks an explicit size", async () => {
    const original = referencePng({
      width: 1024,
      height: 1024,
      noise: true,
      level: 0,
    });
    const resource = await prepareWorkingImage(original);
    expect(resource.bytes.equals(original)).toBe(true);
    expect(resource.width).toBe(1024);
    const metadata = await sharp(resource.bytes).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(true);
    expect((await prepareWorkingImage(original, 1024)).width).toBe(1024);
    expect((await prepareWorkingImage(original, 256)).width).toBe(256);
    await expect(prepareWorkingImage(original, 300)).rejects.toThrow("maxEdge");
  });
  it("imports bounded working PNGs into games while keeping Library originals and asset-canvas originals intact", async () =>
    fixture(async (directory) => {
      const library = new AssetLibrary(directory);
      await library.load();
      const manager = new ProjectManager(directory, library);
      await manager.load();
      const game = await manager.create("Game", "web-game");
      const canvas = await manager.create("Art", "asset-canvas");
      const original = referencePng({
        width: 1024,
        height: 1024,
        noise: true,
        level: 0,
      });
      const asset = await library.add("sprite.png", original, {
        origin: "uploaded",
      });
      const file = await manager.materializeLibraryAsset(game.id, asset.id);
      const working = await readFile(path.join(game.workspacePath, file.path));
      expect(file.assetId).toBe(asset.id);
      expect(working.equals(original)).toBe(true);
      expect((await sharp(working).metadata()).hasAlpha).toBe(true);
      expect((await readFile((await library.content(asset.id)).absolutePath)).equals(original)).toBe(true);
      expect(
        (await readFile(
          path.join(
            directory,
            "image-recovery",
            game.id,
            "image-originals",
            imageDigest(original),
          ),
        )).equals(original),
      ).toBe(true);
      expect(await manager.materializeLibraryAsset(game.id, asset.id)).toEqual(
        file,
      );
      const canvasFile = await manager.materializeLibraryAsset(
        canvas.id,
        asset.id,
      );
      expect((await readFile(path.join(canvas.workspacePath, canvasFile.path))).equals(original)).toBe(true);
    }));
  it("rejects imported images before publication when the aggregate source budget is full", async () =>
    fixture(async (directory, _manager, project) => {
      const library = new AssetLibrary(directory);
      await library.load();
      const manager = new ProjectManager(directory, library);
      await manager.load();
      for (let i = 0; i < 5; i++)
        await writeFile(
          path.join(project.workspacePath, `payload-${i}.bin`),
          Buffer.alloc(2 * 1024 * 1024),
        );
      const original = await png();
      const asset = await library.add("sprite.png", original, {
        origin: "uploaded",
      });
      await expect(
        manager.materializeLibraryAsset(project.id, asset.id),
      ).rejects.toThrow("Original retained as");
      await expect(
        readFile(
          path.join(project.workspacePath, "assets/imported/sprite.png"),
        ),
      ).rejects.toThrow();
      expect(
        await readFile((await library.content(asset.id)).absolutePath),
      ).toEqual(original);
    }));
  it("rejects a linked import staging file without rewriting its target", async () =>
    fixture(async (directory, _manager, project) => {
      const library = new AssetLibrary(directory);
      await library.load();
      const manager = new ProjectManager(directory, library);
      await manager.load();
      const original = await png();
      const asset = await library.add("sprite.png", original, {
        origin: "uploaded",
      });
      const target = path.join(project.workspacePath, "target.png");
      await writeFile(target, original);
      vi.spyOn(fs, "copyFile").mockImplementation(
        async (_source, destination) => {
          await symlink(target, destination);
        },
      );
      await expect(
        manager.materializeLibraryAsset(project.id, asset.id),
      ).rejects.toThrow("Linked");
      expect(await readFile(target)).toEqual(original);
    }));
  it("prepares oversized folder-imported images through the same bounded alpha-preserving path", async () =>
    fixture(async (directory, manager, project) => {
      const original = referencePng({
        width: 768,
        height: 768,
        noise: true,
        level: 0,
      });
      expect(original.length).toBeGreaterThan(2 * 1024 * 1024);
      const file = await manager.importWorkspaceFile(
        project.id,
        "sprite.png",
        original,
        "assets/files/Art",
      );
      expect(file).toBe("assets/files/Art/sprite.png");
      const working = await readFile(path.join(project.workspacePath, file));
      expect(working.equals(original)).toBe(true);
      const stats = await sharp(working).stats();
      expect(stats.channels[3]!.min).toBeLessThan(255);
      expect(
        (await readFile(
          path.join(
            directory,
            "image-recovery",
            project.id,
            "image-originals",
            imageDigest(original),
          ),
        )).equals(original),
      ).toBe(true);
    }));
  it("preserves valid PNG alpha and is deterministic, without enlarging", async () => {
    const original = await png();
    const a = await prepareWorkingImage(original),
      b = await prepareWorkingImage(original);
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect([a.width, a.height, a.hasAlpha]).toEqual([32, 32, true]);
    expect(a.hasTransparency).toBe(true);
    expect(await sharp(a.bytes).raw().toBuffer()).toEqual(
      await sharp(original).raw().toBuffer(),
    );
  });
  it("rejects invalid, oversized and animated input", async () => {
    await expect(
      prepareWorkingImage(Buffer.from("not an image")),
    ).rejects.toThrow("verified");
    await expect(
      prepareWorkingImage(Buffer.alloc(32 * 1024 * 1024 + 1)),
    ).rejects.toThrow("32 MiB");
    const original = await png();
    const animation = Buffer.concat([
      original.subarray(0, 33),
      pngChunk("acTL", Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      original.subarray(33),
    ]);
    await expect(prepareWorkingImage(animation)).rejects.toThrow();
  });
  it("accepts the 32 megapixel limit and rejects the next row", async () => {
    const makeImage = (height: number) => sharp({
      create: { width: 8192, height, channels: 4, background: { r: 50, g: 90, b: 20, alpha: 0.5 } },
      limitInputPixels: false,
    }).png().toBuffer();
    const atLimit = await makeImage(4096);
    const result = await prepareWorkingImage(atLimit);
    expect([result.width, result.height, result.hasTransparency]).toEqual([8192, 4096, true]);
    expect(result.bytes.equals(atLimit)).toBe(true);
    await expect(prepareWorkingImage(await makeImage(4097))).rejects.toThrow();
  }, 30000);
  it("enforces the 32 MiB byte limit without truncating a valid image", async () => {
    const source = await png();
    const limit = 32 * 1024 * 1024;
    const padded = Buffer.concat([
      source.subarray(0, -12),
      pngChunk("vpAg", Buffer.alloc(limit - source.length - 12)),
      source.subarray(-12),
    ]);
    expect(padded.length).toBe(limit);
    expect((await prepareWorkingImage(padded)).bytes.equals(padded)).toBe(true);
    await expect(validateRasterReturn("sprite.png", padded, undefined, 2)).resolves.toMatchObject({ width: 32, height: 32 });
    await expect(prepareWorkingImage(Buffer.concat([padded, Buffer.from([0])]))).rejects.toThrow("32 MiB");
  }, 30000);
  it("keeps the legacy raster return limit while policy 2 accepts intact larger images", async () => {
    const original = referencePng({ width: 512, height: 512, noise: true, level: 0 });
    expect(original.length).toBeGreaterThan(512 * 1024);
    await expect(validateRasterReturn("sprite.png", original)).rejects.toMatchObject({ code: "RASTER_RETURN_REVIEW_REQUIRED" });
    await expect(validateRasterReturn("sprite.png", original, original, 2)).resolves.toMatchObject({ width: 512, height: 512, hasAlpha: true });
    await expect(validateRasterReturn("sprite.png", Buffer.alloc(32 * 1024 * 1024 + 1), undefined, 2)).rejects.toMatchObject({ code: "RASTER_RETURN_REVIEW_REQUIRED" });
  });
  it("rejects malformed, animated, wrong-format and alpha-destroying policy 2 returns", async () => {
    const original = await png();
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    const animation = Buffer.concat([
      original.subarray(0, 33),
      pngChunk("acTL", Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      original.subarray(33),
    ]);
    const opaque = await sharp(original).removeAlpha().png().toBuffer();
    const opaqueAlpha = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    const brokenPixels = Buffer.concat([
      original.subarray(0, 33),
      pngChunk("IDAT", Buffer.from("invalid compressed pixels")),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    for (const [name, result, before] of [
      ["sprite.png", corrupted, undefined],
      ["sprite.png", brokenPixels, undefined],
      ["sprite.png", animation, undefined],
      ["sprite.jpg", original, undefined],
      ["sprite.png", opaque, original],
      ["sprite.png", opaqueAlpha, original],
      ["sprite.png", referencePng({ depth: 16 }), undefined],
    ] as const) {
      await expect(validateRasterReturn(name, result, before, 2)).rejects.toMatchObject({ code: "RASTER_RETURN_REVIEW_REQUIRED" });
    }
    await expect(prepareWorkingImage(brokenPixels)).rejects.toThrow();
  });
  it("retains originals outside execution and admits a formerly oversized PNG", async () =>
    fixture(async (directory, manager, project) => {
      const original = referencePng({
        width: 1024,
        height: 1024,
        noise: true,
        level: 0,
      });
      expect(original.length).toBeGreaterThan(2 * 1024 * 1024);
      await writeFile(path.join(project.workspacePath, "old.png"), original);
      const [resource] = await manager.optimizeImageAssets(project.id, {
        paths: ["old.png"],
        maxEdge: 256,
      });
      expect(resource.workingBytes).toBeLessThan(512 * 1024);
      expect(
        (await readFile(
          path.join(
            directory,
            "image-recovery",
            project.id,
            "image-originals",
            resource.originalId,
          ),
        )).equals(original),
      ).toBe(true);
      const second = await manager.optimizeImageAssets(project.id, {
        paths: ["old.png"],
        maxEdge: 256,
      });
      expect(second[0].workingSha256).toBe(resource.workingSha256);
    }));
  it("refuses aggregate overage before changing any source; retained input is recoverable", async () =>
    fixture(async (directory, manager, project) => {
      const original = await png(512);
      await writeFile(path.join(project.workspacePath, "old.png"), original);
      for (let i = 0; i < 5; i++)
        await writeFile(
          path.join(project.workspacePath, `payload-${i}.bin`),
          Buffer.alloc(2 * 1024 * 1024),
        );
      await expect(
        manager.optimizeImageAssets(project.id, { paths: ["old.png"] }),
      ).rejects.toThrow("Projected");
      expect(
        await readFile(path.join(project.workspacePath, "old.png")),
      ).toEqual(original);
      expect(
        await readdir(
          path.join(directory, "image-recovery", project.id, "image-originals"),
        ),
      ).toHaveLength(1);
      const generated = await manager.addGeneratedWorkingImage(
        project.id,
        "new.png",
        original,
      );
      expect(generated.ready).toBe(false);
      await expect(
        readFile(path.join(project.workspacePath, "assets/generated/new.png")),
      ).rejects.toThrow();
    }));
  it("rejects source links, private paths, secret content and storage links", async () =>
    fixture(async (directory, manager, project) => {
      const original = await png();
      await writeFile(path.join(directory, "outside.png"), original);
      await symlink(
        path.join(directory, "outside.png"),
        path.join(project.workspacePath, "linked.png"),
      );
      await expect(
        manager.optimizeImageAssets(project.id, { paths: ["linked.png"] }),
      ).rejects.toThrow("links");
      await expect(
        manager.optimizeImageAssets(project.id, { paths: [".env"] }),
      ).rejects.toThrow("Private");
      const marker = "working-image-secret-fixture-583107";
      registerSensitiveValue(marker);
      await expect(
        prepareWorkingImage(Buffer.concat([original, Buffer.from(marker)])),
      ).rejects.toThrow("credential");
      const storage = path.join(directory, "storage");
      await mkdir(storage);
      await symlink(
        project.workspacePath,
        path.join(storage, "image-originals"),
      );
      await expect(retainImageOriginal(storage, original)).rejects.toThrow(
        "Linked",
      );
    }));
  it("recovers a retained generation result without a model request and protects existing destinations", async () =>
    fixture(async (directory, manager, project) => {
      const original = await png(1536);
      const first = await manager.addGeneratedWorkingImage(
        project.id,
        "first.png",
        original,
      );
      expect(first.ready).toBe(true);
      if (!first.ready) throw new Error(first.error);
      expect(first.width).toBe(1536);
      const [recovered] = await manager.optimizeImageAssets(project.id, {
        originalId: first.originalId,
        destination: "recovered.png",
        maxEdge: 512,
      });
      expect(recovered.width).toBe(512);
      const snapshot = await readFile(
        path.join(project.workspacePath, "recovered.png"),
      );
      await expect(
        manager.optimizeImageAssets(project.id, {
          originalId: first.originalId,
          destination: "recovered.png",
          maxEdge: 256,
        }),
      ).rejects.toThrow("already exists");
      expect(
        await readFile(path.join(project.workspacePath, "recovered.png")),
      ).toEqual(snapshot);
      const receipts = await readdir(
        path.join(
          directory,
          "image-recovery",
          project.id,
          "image-preparations",
        ),
      );
      expect(receipts.length).toBeGreaterThanOrEqual(2);
    }));
  it("serializes concurrent recovery attempts without clobbering the winner", async () =>
    fixture(async (_directory, manager, project) => {
      const original = await png();
      const first = await manager.addGeneratedWorkingImage(
        project.id,
        "first.png",
        original,
      );
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          manager.optimizeImageAssets(project.id, {
            originalId: first.originalId,
            destination: "race.png",
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        (
          await sharp(
            await readFile(path.join(project.workspacePath, "race.png")),
          ).metadata()
        ).hasAlpha,
      ).toBe(true);
    }));
  it("does not replace any file when a concurrent edit invalidates the prepared batch", async () =>
    fixture(async (directory, _manager, project) => {
      const first = Buffer.from("original"),
        changed = Buffer.from("concurrent");
      await writeFile(path.join(project.workspacePath, "first.png"), first);
      await writeFile(path.join(project.workspacePath, "second.png"), changed);
      await expect(
        replaceWorkingImages(
          project.workspacePath,
          [
            { path: "first.png", before: first, bytes: Buffer.from("working") },
            {
              path: "second.png",
              before: first,
              bytes: Buffer.from("working"),
            },
          ],
          path.join(directory, "image-recovery", project.id),
        ),
      ).rejects.toThrow("changed");
      expect(
        await readFile(path.join(project.workspacePath, "first.png")),
      ).toEqual(first);
      expect(
        await readFile(path.join(project.workspacePath, "second.png")),
      ).toEqual(changed);
      expect(
        (await readdir(project.workspacePath)).some((name) =>
          name.endsWith("working-image"),
        ),
      ).toBe(false);
    }));

  it("retains originals and preparation receipts after deleting a project", async () =>
    fixture(async (directory, manager, project) => {
      const original = await png();
      const resource = await manager.addGeneratedWorkingImage(
        project.id,
        "keep.png",
        original,
      );
      await manager.delete(project.id);
      const storage = path.join(directory, "image-recovery", project.id);
      expect(
        await readFile(
          path.join(storage, "image-originals", resource.originalId),
        ),
      ).toEqual(original);
      expect(
        await readdir(path.join(storage, "image-preparations")),
      ).toHaveLength(1);
    }));

  it("refuses originals above 64 MiB without adding a workspace copy", async () =>
    fixture(async (_directory, manager, project) => {
      await expect(
        manager.addGeneratedWorkingImage(
          project.id,
          "large.png",
          Buffer.alloc(64 * 1024 * 1024 + 1),
        ),
      ).rejects.toThrow("64 MiB");
      await expect(
        readFile(
          path.join(project.workspacePath, "assets/generated/large.png"),
        ),
      ).rejects.toThrow();
    }));

  it("blocks deletion of legacy project-scoped originals until independent recovery is arranged", async () =>
    fixture(async (directory, manager, project) => {
      const folder = path.join(
        directory,
        "projects",
        project.id,
        "image-originals",
      );
      await mkdir(folder);
      const original = await png();
      await writeFile(path.join(folder, "legacy.png"), original);
      await expect(manager.delete(project.id)).rejects.toThrow(
        "no project files were removed",
      );
      expect(await readFile(path.join(folder, "legacy.png"))).toEqual(original);
      expect(manager.get(project.id)).toBeDefined();
    }));

  it("preserves a live same-inode edit and original backup after a later publication failure", async () =>
    fixture(async (directory, _manager, project) => {
      const original = Buffer.from("original"),
        working = Buffer.from("working"),
        late = Buffer.from("late external edit");
      for (const name of ["first.png", "second.png"])
        await writeFile(path.join(project.workspacePath, name), original);
      const link = fs.link;
      vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        if (
          String(source).includes(`${path.sep}after${path.sep}`) &&
          String(destination).endsWith("second.png")
        )
          throw new Error("injected publication failure");
        await link(source, destination);
        if (String(source).includes(`${path.sep}after${path.sep}`))
          await writeFile(destination, late);
      });
      await expect(
        replaceWorkingImages(
          project.workspacePath,
          [
            { path: "first.png", before: original, bytes: working },
            { path: "second.png", before: original, bytes: working },
          ],
          path.join(directory, "image-recovery", project.id),
        ),
      ).rejects.toThrow("injected publication failure");
      expect(await readFile(path.join(project.workspacePath, "first.png"))).toEqual(late);
      expect(await readFile(path.join(project.workspacePath, "second.png"))).toEqual(original);
      const [transaction] = await readdir(
        path.join(directory, "image-recovery", project.id, "image-transactions"),
      );
      const recovery = path.join(directory, "image-recovery", project.id, "image-transactions", transaction!);
      expect(await readFile(path.join(recovery, "before", "0"))).toEqual(original);
      expect(await readFile(path.join(recovery, "original-0"))).toEqual(original);
      expect(
        JSON.parse(await readFile(path.join(recovery, "manifest.json"), "utf8"))
          .versions,
      ).toHaveLength(2);
      expect(JSON.parse(await readFile(path.join(recovery, "manifest.json"), "utf8")).state).toBe("needs-review");
    }));

  it("does not clobber a save made between moving the source and publication", async () =>
    fixture(async (directory, _manager, project) => {
      const original = Buffer.from("original"),
        concurrent = Buffer.from("concurrent save");
      const destination = path.join(project.workspacePath, "first.png");
      await writeFile(destination, original);
      const canonicalDestination = await fs.realpath(destination);
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        await rename(source, target);
        if (String(source) === canonicalDestination)
          await writeFile(destination, concurrent);
      });
      await expect(
        replaceWorkingImages(
          project.workspacePath,
          [
            {
              path: "first.png",
              before: original,
              bytes: Buffer.from("working"),
            },
          ],
          path.join(directory, "image-recovery", project.id),
        ),
      ).rejects.toThrow("recovery retained");
      expect(await readFile(destination)).toEqual(concurrent);
      const [transaction] = await readdir(
        path.join(directory, "image-recovery", project.id, "image-transactions"),
      );
      expect(
        await readFile(
          path.join(
            directory,
            "image-recovery", project.id, "image-transactions",
            transaction!,
            "before",
            "0",
          ),
        ),
      ).toEqual(original);
    }));

  it("reuses an immutable original ID and leaves identity preparation inodes untouched without a publication transaction", async () => fixture(async (directory, manager, project) => {
    const original = await png(64), name = path.join(project.workspacePath, "sprite.png"); await writeFile(name, original);
    const initial = await fs.stat(name), [first] = await manager.optimizeImageAssets(project.id, { paths: ["sprite.png"] });
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), stored = path.join(anchor.storage, "image-originals", first.originalId), before = await fs.stat(stored);
    const [again] = await manager.optimizeImageAssets(project.id, { paths: ["sprite.png"] });
    expect(again.originalId).toBe(first.originalId); expect((await fs.stat(name)).ino).toBe(initial.ino);
    expect((await fs.stat(stored)).ino).toBe(before.ino); expect((await fs.stat(stored)).mtimeMs).toBe(before.mtimeMs);
    await expect(fs.stat(path.join(anchor.storage, "image-transactions"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(anchor.storage, "space-reservations"))).toEqual([]);
    expect(await manager.localImageRecoveryAnchors()).toEqual([{ workspace: project.workspacePath, storage: path.join(directory, "image-recovery", project.id), projectId: project.id }]);
  }));

  it.each([0o644, 0o640])("preserves exact image mode %i through a committed local resize", async mode => fixture(async (_directory, manager, project) => {
    const name = path.join(project.workspacePath, "sprite.png"); await writeFile(name, await png(512)); await fs.chmod(name, mode);
    await manager.optimizeImageAssets(project.id, { paths: ["sprite.png"], maxEdge: 256 });
    expect((await fs.stat(name)).mode & 0o777).toBe(mode); expect((await sharp(await readFile(name)).metadata()).width).toBe(256);
    await expect(assertLocalImagePublicationsSettled(await manager.getLocalImageRecoveryAnchor(project.id))).resolves.toBeUndefined();
  }));

  it("rolls back a 0644 publication failure without mistaking its own staged mode for an external edit", async () => fixture(async (_directory, manager, project) => {
    const before = Buffer.from("before"), after = Buffer.from("after"); for (const name of ["a.png", "b.png"]) await writeFile(path.join(project.workspacePath, name), before, { mode: 0o644 });
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), link = fs.link;
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => { if (String(source).includes("/after/") && String(destination).endsWith("b.png")) throw new Error("injected second file"); return link(source, destination); });
    await expect(replaceWorkingImages(project.workspacePath, ["a.png", "b.png"].map(path => ({ path, before, bytes: after })), anchor.storage)).rejects.toThrow("injected second file");
    for (const name of ["a.png", "b.png"]) { const file = path.join(project.workspacePath, name); expect(await readFile(file)).toEqual(before); expect((await fs.stat(file)).mode & 0o777).toBe(0o644); }
    await expect(assertLocalImagePublicationsSettled(anchor)).resolves.toBeUndefined(); expect(await readdir(path.join(anchor.storage, "space-reservations"))).toEqual([]);
  }));

  it("keeps a same-inode chmod after publication live and leaves its original plus promise protected", async () => fixture(async (_directory, manager, project) => {
    const before = Buffer.from("before"), after = Buffer.from("after"), first = path.join(project.workspacePath, "a.png");
    for (const name of ["a.png", "b.png"]) await writeFile(path.join(project.workspacePath, name), before, { mode: 0o644 });
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), link = fs.link;
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => { if (String(source).includes("/after/") && String(destination).endsWith("b.png")) { await fs.chmod(first, 0o600); throw new Error("injected later file"); } return link(source, destination); });
    await expect(replaceWorkingImages(project.workspacePath, ["a.png", "b.png"].map(path => ({ path, before, bytes: after })), anchor.storage)).rejects.toThrow("injected later file");
    expect(await readFile(first)).toEqual(after); expect((await fs.stat(first)).mode & 0o777).toBe(0o600);
    await expect(assertLocalImagePublicationsSettled(anchor)).rejects.toThrow("unconfirmed"); expect(await readdir(path.join(anchor.storage, "space-reservations"))).toHaveLength(1);
    await expect(releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace: "manual", projectId: project.id, imageStorage: anchor.storage, sourceRetired: true })).rejects.toThrow("unconfirmed");
    expect(await readdir(path.join(anchor.storage, "space-reservations"))).toHaveLength(1);
    await rm(project.workspacePath, { recursive: true });
    await expect(assertLocalImagePublicationsSettled({ ...anchor, allowMissingWorkspace: true })).rejects.toThrow("unconfirmed");
    await expect(releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace: "manual", projectId: project.id, imageStorage: anchor.storage, sourceRetired: true, allowMissingWorkspace: true })).rejects.toThrow("unconfirmed");
    expect(await readdir(path.join(anchor.storage, "space-reservations"))).toHaveLength(1);
  }));

  it.each(["optimize", "import"] as const)("rejects a cross-filesystem %s before any project or recovery directory change", async action => fixture(async (_directory, manager, project) => {
    const original = await png(); await writeFile(path.join(project.workspacePath, "sprite.png"), original); const before = await readdir(project.workspacePath), lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => { const value = await lstat(...args as Parameters<typeof lstat>); return String(args[0]) === project.workspacePath ? new Proxy(value, { get(target, key) { if (key === "dev") return typeof value.dev === "bigint" ? value.dev + 1n : value.dev + 1; const item = Reflect.get(target, key, target); return typeof item === "function" ? item.bind(target) : item; } }) : value; });
    await expect(action === "optimize" ? manager.optimizeImageAssets(project.id, { paths: ["sprite.png"] }) : manager.importWorkspaceFile(project.id, "import.png", original)).rejects.toThrow("different filesystems");
    expect(await readdir(project.workspacePath)).toEqual(before);
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id); await expect(fs.stat(anchor.storage)).rejects.toMatchObject({ code: "ENOENT" });
  }));

  it("refuses image import on low disk before writing a project temporary or claiming its original was retained", async () => fixture(async (_directory, manager, project) => {
    const before = await readdir(project.workspacePath), statfs = fs.statfs;
    vi.spyOn(fs, "statfs").mockImplementation(async (...args) => ({ ...await statfs(...args as Parameters<typeof statfs>), bsize: 1n, bavail: 0n }) as any);
    await expect(manager.importWorkspaceFile(project.id, "image.png", await png())).rejects.toThrow("unreserved disk");
    expect(await readdir(project.workspacePath)).toEqual(before); await expect(fs.stat((await manager.getLocalImageRecoveryAnchor(project.id)).storage)).rejects.toMatchObject({ code: "ENOENT" });
  }));

  it("counts existing image-recovery history before optimizing another image", async () => fixture(async (_directory, manager, project) => {
    const original = await png(); await writeFile(path.join(project.workspacePath, "image.png"), original);
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), folder = path.join(anchor.storage, "image-originals"); await mkdir(folder, { recursive: true });
    for (let i = 0; i < 8; i++) { const handle = await fs.open(path.join(folder, String(i)), "wx"); try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); } }
    await expect(manager.optimizeImageAssets(project.id, { paths: ["image.png"], maxEdge: 256 })).rejects.toThrow("capacity");
    expect(await readFile(path.join(project.workspacePath, "image.png"))).toEqual(original);
  }));

  it("loads local promises from the independent store and does not recreate deleted-project payload-only orphans", async () => fixture(async (directory, manager, project) => {
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), lease = await reserveLocalImageRecoverySpace(anchor, { rawBytes: 100, workingBytes: 0, beforeBytes: 0, afterBytes: 100, manifestBytes: 1024, additionalEntries: 32 }, { ownerKey: "c".repeat(32) });
    await restoreLocalImageRecoverySpaces(() => manager.localImageRecoveryAnchors());
    const local = await manager.localImageRecoveryAnchors(); expect(local).toEqual([anchor]); await lease.release();
    await writeFile(path.join(anchor.storage, "preserved-original"), "retained"); await manager.delete(project.id);
    expect(await manager.localImageRecoveryAnchors()).toEqual([]); expect(await readFile(path.join(anchor.storage, "preserved-original"), "utf8")).toBe("retained");
    await expect(fs.stat(path.join(directory, "projects", project.id))).rejects.toMatchObject({ code: "ENOENT" });
  }));

  it("does not ignore a local promise when project metadata is broken", async () => fixture(async (directory, manager, project) => {
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), lease = await reserveLocalImageRecoverySpace(anchor, { rawBytes: 100, workingBytes: 0, beforeBytes: 0, afterBytes: 100, manifestBytes: 1024, additionalEntries: 32 }, { ownerKey: "d".repeat(32) });
    await writeFile(path.join(directory, "projects", project.id, "project.json"), "not json");
    const restarted = new ProjectManager(directory); await restarted.load();
    await expect(restarted.localImageRecoveryAnchors()).rejects.toThrow("unavailable project"); await lease.release();
  }));

  it("releases only explicitly retired source promises and keeps local originals after deleting a project", async () => fixture(async (_directory, manager, project) => {
    const anchor = await manager.getLocalImageRecoveryAnchor(project.id), namespace = "manual" as const;
    const source = await reserveRecoverySpace(project.workspacePath, { rawBytes: 0, workingBytes: 0, beforeBytes: 0, afterBytes: 0, manifestBytes: 1024, additionalEntries: 16 }, { ownerKey: "e".repeat(32), namespace, projectId: project.id });
    await expect(releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace: "test", projectId: project.id, imageStorage: anchor.storage, sourceRetired: true })).rejects.toThrow("ownership differ");
    await expect(withRecoverySpaceReservation(source, () => releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace, projectId: project.id, imageStorage: anchor.storage, sourceRetired: true }))).rejects.toThrow("still finishing");
    await expect(releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace, projectId: project.id, imageStorage: anchor.storage, sourceRetired: false })).rejects.toThrow("retirement was not verified");
    await releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace, projectId: project.id, imageStorage: anchor.storage, sourceRetired: true });
    const local = await reserveLocalImageRecoverySpace(anchor, { rawBytes: 10, workingBytes: 0, beforeBytes: 0, afterBytes: 10, manifestBytes: 1024, additionalEntries: 16 }, { ownerKey: "f".repeat(32) });
    await expect(withRecoverySpaceReservation(local, () => releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace, projectId: project.id, imageStorage: anchor.storage, sourceRetired: false }))).rejects.toThrow("still finishing");
    await releaseRetiredProjectRecoverySpace(project.workspacePath, { namespace, projectId: project.id, imageStorage: anchor.storage, sourceRetired: false });
    expect(await readdir(path.join(anchor.storage, "space-reservations"))).toEqual([]); await source.release();
  }));

  it("rejects already-cancelled and queued-cancelled raster preparation without poisoning the decode queue", async () => {
    const bytes = await png(), first = new AbortController(); first.abort(new Error("cancelled before decode"));
    await expect(prepareWorkingImage(bytes, undefined, undefined, first.signal)).rejects.toThrow("cancelled before decode");
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = serializeRasterDecoding(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready; const queued = new AbortController(), waiting = prepareWorkingImage(bytes, 256, undefined, queued.signal); queued.abort(new Error("cancelled while queued"));
    const rejected = expect(waiting).rejects.toThrow("cancelled while queued"); release(); await gate; await rejected;
    expect((await prepareWorkingImage(bytes)).workingSha256).toBe(imageDigest(bytes));
  });

  it("cancels a queued generated working-image fill before any project publication", async () => fixture(async (_directory, manager, project) => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = serializeWorkingImages(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready; const before = await readdir(project.workspacePath), cancelled = new AbortController();
    const waiting = manager.addGeneratedWorkingImage(project.id, "generated.png", await png(), {}, cancelled.signal); cancelled.abort(new Error("cancelled generated fill"));
    const rejected = expect(waiting).rejects.toThrow("cancelled generated fill"); release(); await gate; await rejected;
    expect(await readdir(project.workspacePath)).toEqual(before); await expect(fs.stat((await manager.getLocalImageRecoveryAnchor(project.id)).storage)).rejects.toMatchObject({ code: "ENOENT" });
  }));
});


it("uses an explicit current medium profile for host image preparation while preserving the legacy default and original", async () => {
  await fixture(async (directory, legacy, project) => {
    const media = path.join(project.workspacePath, "public"); await mkdir(media, { recursive: true });
    for (const name of ["a.wav", "b.wav"]) {
      const file = path.join(media, name), handle = await fs.open(file, "wx");
      try { await handle.write(Buffer.from("RIFF0000WAVEfmt ")); await handle.truncate(32 * 1024 * 1024); } finally { await handle.close(); }
    }
    const original = await png(), before = Buffer.from(original);
    const denied = await legacy.addGeneratedWorkingImage(project.id, "denied.png", original);
    expect(denied.ready).toBe(false);
    const selected = new ProjectManager(directory, undefined, [], async () => "capacity-128-v2"); await selected.load();
    const accepted = await selected.addGeneratedWorkingImage(project.id, "accepted.png", original);
    expect(accepted.ready, accepted.ready ? undefined : accepted.error).toBe(true);
    if (!accepted.ready) throw new Error(accepted.error);
    expect((await readFile(path.join(project.workspacePath, accepted.path))).equals(before)).toBe(true);
    expect(original.equals(before)).toBe(true);
    const anchor = await selected.getLocalImageRecoveryAnchor(project.id);
    expect((await readFile(path.join(anchor.storage, "image-originals", accepted.originalId))).equals(before)).toBe(true);
  });
});
