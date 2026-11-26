import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { CHARACTER_VIEW_DIRECTIONS } from "../src/shared/character-views.js";
import { repairPublishedSpriteWalk } from "../src/daemon/sprite-walk-publish.js";
import { inspectPublishedSpriteWalk, readPublishedSpriteWalkIdentity } from "../src/daemon/sprite-walk-review.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function example() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sprite-walk-review-"));
  roots.push(root);
  const base = path.join(root, "game/public/characters/test");
  await mkdir(path.join(base, "images"), { recursive: true });
  const width = 48,
    height = 48,
    pixels = Buffer.alloc(width * height * 4);
  for (let y = 5; y < 42; y++) for (let x = 12; x < 36; x++) pixels.fill(235, (y * width + x) * 4, (y * width + x + 1) * 4);
  const raw = { width, height, channels: 4 as const };
  const standing = await sharp(pixels, { raw }).png().toBuffer();
  const sha256 = createHash("sha256").update(standing).digest("hex");
  const views: Record<string, object> = {};
  for (const direction of CHARACTER_VIEW_DIRECTIONS) {
    const file = `images/${direction}-r1-${sha256}.png`;
    views[direction] = { file, sha256, viewRevision: "r1", width, height };
    await writeFile(path.join(base, file), standing);
  }
  await writeFile(
    path.join(base, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      setId: "test",
      setRevision: "one",
      designRevision: "one",
      complete: true,
      coordinates: "top-left-pixel-edges-x-right-y-down",
      directionOrder: CHARACTER_VIEW_DIRECTIONS,
      canvas: { width, height },
      pivot: { x: 24, y: 42 },
      headToGround: 37,
      views,
    }),
  );
  pixels.fill(0, (25 * width + 12) * 4, (25 * width + 27) * 4);
  const torn = await sharp(pixels, { raw }).png().toBuffer();
  const frames = Array.from({ length: 4 }, (_, i) => ({ x: i * width, y: 0 }));
  const sheet = await sharp({ create: { width: 4 * width, height, channels: 4, background: "#0000" } })
    .composite(frames.map((f, i) => ({ input: i === 2 ? torn : standing, left: f.x, top: f.y })))
    .png()
    .toBuffer();
  const walk = {
    gait: "biped",
    image: "walk.png",
    stridePx: 12,
    frameSize: { width, height },
    animations: { S: { frames } },
  };
  await writeFile(path.join(base, "walk.png"), sheet);
  await writeFile(path.join(base, "walk.json"), JSON.stringify(walk));
  return { project: { workspacePath: root, startupDirectory: "game" }, base, walk, sheet };
}

it("reviews runtime-selected rectangles, returns the actual phase pixels and invalidates a stale review", async () => {
  const { project, base, walk, sheet } = await example();
  const result = await inspectPublishedSpriteWalk(project, "test", "S", undefined, undefined, undefined, true);
  expect(result.seams).toContainEqual({ frame: 2, axis: "horizontal", x: 12, y: 25, length: 15 });
  expect(result.status).toBe("fail");
  expect((await sharp(result.preview!).metadata()).format).toBe("png");
  walk.animations.S.frames.reverse();
  await writeFile(path.join(base, "walk.json"), JSON.stringify(walk));
  expect((await readPublishedSpriteWalkIdentity(project, "test")).revision).not.toBe(result.revision);
  await expect(
    repairPublishedSpriteWalk(project, {
      setId: "test",
      directions: [{ direction: "S", landmarks: {} }],
      expectedRevision: result.revision,
    }),
  ).rejects.toThrow("changed");
  expect(await readFile(path.join(base, "walk.png"))).toEqual(sheet);
});

it("refuses escaped sheet paths and overlapping poses without altering the sheet", async () => {
  const { project, base, walk, sheet } = await example();
  await writeFile(path.join(base, "walk.json"), JSON.stringify({ ...walk, image: "../walk.png" }));
  await expect(readPublishedSpriteWalkIdentity(project, "test")).rejects.toThrow("package-relative");
  walk.animations.S.frames[1].x = 1;
  await writeFile(path.join(base, "walk.json"), JSON.stringify(walk));
  const { revision } = await readPublishedSpriteWalkIdentity(project, "test");
  await expect(
    repairPublishedSpriteWalk(project, {
      setId: "test",
      expectedRevision: revision,
      directions: [{ direction: "S", landmarks: {} }],
    }),
  ).rejects.toThrow("overlapping");
  expect(await readFile(path.join(base, "walk.png"))).toEqual(sheet);
});
