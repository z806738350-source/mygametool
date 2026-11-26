import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import {
  inspectPublishedSpriteAction,
  readPublishedSpriteActionIdentity,
  repairPublishedSpriteAction,
} from "../src/daemon/sprite-action-package.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function sample() {
  const root = await mkdtemp(path.join(os.tmpdir(), "action-package-"));
  roots.push(root);
  const dir = path.join(root, "game/public/characters/heron");
  await mkdir(dir, { recursive: true });
  const raw = { width: 48, height: 48, channels: 4 as const };
  const pixels = Buffer.alloc(48 * 48 * 4);
  for (let y = 8; y < 40; y++)
    for (let x = 11; x < 36; x++) {
      pixels.set([80 + x, 110 + y, 125, 255], 4 * (y * 48 + x));
    }
  const stand = await sharp(pixels, { raw }).png().toBuffer();
  await writeFile(path.join(dir, "perch.png"), stand);
  const damaged = Buffer.from(pixels);
  for (let x = 12; x < 30; x++)
    damaged.fill(0, 4 * (23 * 48 + x), 4 * (23 * 48 + x + 1));
  const broken = await sharp(damaged, { raw }).png().toBuffer();
  const pose = Buffer.from(pixels);
  pose.set([230, 180, 50, 255], 4 * (35 * 48 + 11));
  const other = await sharp(pose, { raw }).png().toBuffer();
  const frames = Array.from({ length: 16 }, (_, i) => ({
    x: i * 48,
    y: 0,
    durationMs: 65,
  }));
  const src = frames.map((f, i) => ({
    input: i === 5 ? broken : i === 13 ? other : stand,
    left: f.x,
    top: 0,
  }));
  await sharp({
    create: { width: 48 * 16, height: 48, channels: 4, background: "#0000" },
  })
    .composite(src)
    .png()
    .toFile(path.join(dir, "flap.png"));
  const plan = {
    bodyPlan: "bird",
    motion: "flap",
    image: "flap.png",
    frameSize: { width: 48, height: 48 },
    animations: { E: { reference: "perch.png", loop: true, frames } },
  };
  const name = path.join(dir, "flap.json");
  await writeFile(name, JSON.stringify(plan));
  return {
    project: { workspacePath: root, startupDirectory: "game" },
    dir,
    plan,
    name,
    stand,
    other,
    input: { setId: "heron", actionId: "flap", direction: "E" as const },
  };
}

it("uses a single facing, shows the defective phase, safely repairs the published pixels and keeps unsupported motion open", async () => {
  const { project, dir, name, input, stand, other } = await sample();
  const file = path.join(dir, "flap.png");
  const original = await readFile(file),
    metadata = await readFile(name);
  const before = await inspectPublishedSpriteAction(
    project,
    input,
    undefined,
    true,
  );
  expect(before).toMatchObject({
    status: "fail",
    damage: expect.arrayContaining([
      expect.objectContaining({ frame: 5, certainty: "confirmed" }),
    ]),
  });
  expect(before.previewFrames).toContain(5);
  const part = {
    name: "wing base",
    region: { x: 16, y: 19, width: 4, height: 4 },
  };
  const args = {
    setId: input.setId,
    actionId: input.actionId,
    expectedRevision: before.revision,
    directions: [{ direction: input.direction, parts: [part] }],
  };
  const candidate = await repairPublishedSpriteAction(project, args);
  expect(candidate.status).toBe("inconclusive");
  expect(candidate.candidateDigest).toBeTruthy();
  expect(candidate.reviews[0].markedParts).toContainEqual(part);
  expect(candidate.reviews[0].parts[0]).toMatchObject(part);
  expect(await readFile(file)).toEqual(original);
  await expect(
    repairPublishedSpriteAction(project, {
      ...args,
      candidateDigest: "f".repeat(64),
    }),
  ).rejects.toThrow(/preview/);
  const applied = await repairPublishedSpriteAction(project, {
    ...args,
    candidateDigest: candidate.candidateDigest,
  });
  expect(applied.changed).toEqual(["game/public/characters/heron/flap.png"]);
  const source = await readFile(file);
  for (let i = 0; i < 16; i++) {
    const actual = await sharp(source)
      .extract({ left: 48 * i, top: 0, width: 48, height: 48 })
      .raw()
      .toBuffer();
    expect(actual).toEqual(
      await sharp(i === 13 ? other : stand)
        .raw()
        .toBuffer(),
    );
  }
  const checked = await inspectPublishedSpriteAction(
    project,
    { ...input, frames: [4, 5, 6] },
    undefined,
    true,
  );
  expect(checked).toMatchObject({
    status: "inconclusive",
    hasVisibleMotion: true,
    damage: [],
    previewFrames: [4, 5, 6],
  });
  expect(checked.revision).toBe(applied.revision);
  expect(await readFile(name)).toEqual(metadata);
  await expect(repairPublishedSpriteAction(project, args)).rejects.toThrow(
    /changed/,
  );
});

it("protects a sibling's shared source rectangles and invalidates review when the reference changes", async () => {
  const { project, dir, plan, input, other } = await sample();
  const before = await readPublishedSpriteActionIdentity(
    project,
    input.setId,
    input.actionId,
  );
  const original = await readFile(path.join(dir, "flap.png"));
  await writeFile(
    path.join(dir, "turn.json"),
    JSON.stringify({ ...plan, motion: "turn" }),
  );
  await expect(
    repairPublishedSpriteAction(project, {
      ...input,
      directions: [input],
      expectedRevision: before.revision,
    }),
  ).rejects.toThrow(/shares/);
  expect(await readFile(path.join(dir, "flap.png"))).toEqual(original);
  await writeFile(path.join(dir, "perch.png"), other);
  expect(
    (
      await readPublishedSpriteActionIdentity(
        project,
        input.setId,
        input.actionId,
      )
    ).revision,
  ).not.toEqual(before.revision);
});
