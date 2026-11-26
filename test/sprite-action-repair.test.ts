import { expect, it } from "vitest";
import {
  inspectSpriteActionDamage,
  repairSpriteActionDamage,
} from "../src/daemon/sprite-action-repair.js";
import type { SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";

const width = 72,
  height = 72;
const clear = () => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});
function paint(
  r: SpriteWalkRaster,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
  color = 70,
) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      r.data.set(
        [color + ((xx + yy) % 8), 94, 56, alpha],
        (yy * width + xx) * 4,
      );
    }
}
function sprite() {
  const r = clear();
  paint(r, 22, 12, 28, 12, 255);
  paint(r, 20, 24, 32, 15, 255, 110);
  paint(r, 25, 39, 9, 15, 255, 44);
  paint(r, 39, 39, 9, 15, 255, 44);
  return r;
}
function translated(r: SpriteWalkRaster, dy: number) {
  const result = clear();
  for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++)
    result.data.set(
      r.data.subarray(4 * y * width, 4 * (y + 1) * width),
      4 * (y + dy) * width,
    );
  return result;
}

it("finds a tear during jump travel and restores the exact translated paint without changing other phases", () => {
  const idle = sprite(),
    clean = [0, -3, -8, -5, 0].map((dy) => translated(idle, dy));
  const damaged = clean.map((r) => ({ ...r, data: r.data.slice() }));
  paint(damaged[2], 22, 22, 17, 1, 0);
  const repair = repairSpriteActionDamage(idle, damaged, false);
  expect(repair.findings).toContainEqual(
    expect.objectContaining({
      frame: 2,
      kind: "seam",
      certainty: "confirmed",
      x: 22,
      y: 22,
    }),
  );
  expect(repair.changedFrames).toEqual([2]);
  expect(repair.remaining).toEqual([]);
  expect(repair.frames[2].data).toEqual(clean[2].data);
  expect(repair.frames[1]).toBe(damaged[1]);
  expect(damaged[2].data).not.toEqual(clean[2].data);
});

it("reconstructs an open broad joint from its supported texture without filling the natural space between boots", () => {
  const idle = sprite(),
    frames = Array.from({ length: 5 }, sprite);
  paint(frames[2], 20, 30, 15, 4, 0);
  const repair = repairSpriteActionDamage(idle, frames, false);
  expect(repair.findings).toContainEqual(
    expect.objectContaining({
      frame: 2,
      kind: "opened-joint",
      certainty: "confirmed",
    }),
  );
  expect(repair.changedFrames).toEqual([2]);
  expect(repair.frames[2].data).toEqual(idle.data);
  expect(repair.remaining).toEqual([]);
});

it("does not invent non-looping endpoint evidence or treat a persistent occlusion as missing paint", () => {
  const idle = sprite(),
    frames = Array.from({ length: 5 }, sprite);
  paint(frames[0], 23, 33, 12, 1, 0);
  const open = repairSpriteActionDamage(idle, frames, false);
  expect(open.changedFrames).toEqual([]);
  expect(open.remaining).toContainEqual(
    expect.objectContaining({ frame: 0, certainty: "suspect" }),
  );
  expect(repairSpriteActionDamage(idle, frames, true).frames[0].data).toEqual(
    idle.data,
  );
  for (const f of frames) paint(f, 23, 33, 12, 1, 0);
  expect(inspectSpriteActionDamage(idle, frames, true)).toEqual([]);
});

it("removes a duplicate detached textured cuff and keeps a separate painted accessory and a transient sparkle", () => {
  const idle = sprite();
  // A distinctive striped cuff on the left edge of the body plus a free-standing antenna.
  paint(idle, 20, 29, 2, 7, 255, 180);
  paint(idle, 20, 29, 2, 3, 255, 25);
  paint(idle, 14, 15, 2, 3, 255, 200);
  const frames = Array.from({ length: 5 }, () => ({
    ...idle,
    data: idle.data.slice(),
  }));
  for (let y = 29; y < 36; y++) {
    frames[1].data.set(
      idle.data.subarray(4 * (y * width + 20), 4 * (y * width + 21)),
      4 * (y * width + 18),
    );
  }
  paint(frames[2], 16, 38, 3, 2, 255, 218);
  const repair = repairSpriteActionDamage(idle, frames, true);
  expect(repair.changedFrames).toEqual([1]);
  expect(repair.findings).toContainEqual(
    expect.objectContaining({ frame: 1, kind: "detached-fragment" }),
  );
  expect(repair.frames[1].data).toEqual(idle.data);
  expect(repair.frames[2]).toBe(frames[2]);
});

it("locates a missing pose, color flash and truncated contour for redraw without copying an entire phase", () => {
  const idle = sprite(),
    blank = [sprite(), clear(), sprite()];
  const missing = repairSpriteActionDamage(idle, blank, false);
  expect(missing.changedFrames).toEqual([]);
  expect(missing.remaining).toContainEqual(
    expect.objectContaining({
      frame: 1,
      kind: "empty-frame",
      certainty: "confirmed",
    }),
  );
  const flash = sprite();
  for (let p = 0; p < flash.data.length; p += 4)
    if (flash.data[p + 3]) flash.data[p] = 255;
  expect(
    inspectSpriteActionDamage(idle, [idle, flash, idle], false),
  ).toContainEqual(
    expect.objectContaining({ kind: "color-flash", certainty: "suspect" }),
  );
  expect(
    inspectSpriteActionDamage(idle, [idle, translated(idle, -16), idle], false),
  ).toContainEqual(
    expect.objectContaining({
      kind: "edge-clipping",
      certainty: "suspect",
      y: 0,
    }),
  );
});

it("retains an evidenced break for redraw when donors disagree on its hidden texture", () => {
  const idle = sprite(),
    frames = Array.from({ length: 5 }, sprite);
  paint(frames[1], 23, 30, 15, 1, 255, 205);
  paint(frames[2], 23, 30, 15, 1, 0);
  const repair = repairSpriteActionDamage(idle, frames, false);
  expect(repair.changedFrames).toEqual([]);
  expect(repair.remaining).toContainEqual(
    expect.objectContaining({
      frame: 2,
      certainty: "confirmed",
      reason: expect.stringContaining("Redraw"),
    }),
  );
});

it("handles a translucent character without mistaking painted pixels for an empty pose", () => {
  const idle = sprite();
  for (let p = 3; p < idle.data.length; p += 4)
    if (idle.data[p]) idle.data[p] = 72;
  const repair = repairSpriteActionDamage(idle, [idle, idle, idle], false);
  expect(repair.changedFrames).toEqual([]);
  expect(repair.findings.map((f) => [f.kind, f.certainty])).toEqual([
    ["low-opacity", "suspect"],
  ]);
});

it("repairs multiple independent tears on the same axis in one candidate", () => {
  const idle = sprite(),
    frames = Array.from({ length: 5 }, sprite);
  paint(frames[2], 23, 17, 16, 1, 0);
  paint(frames[2], 26, 32, 12, 1, 0);
  const repaired = repairSpriteActionDamage(idle, frames, false);
  expect(repaired.remaining).toEqual([]);
  expect(repaired.frames[2].data).toEqual(idle.data);
});
