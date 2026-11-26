import { expect, it } from "vitest";
import { repairSpriteWalkDirection } from "../src/daemon/sprite-walk-repair.js";
import { inspectSpriteWalkGait, type SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";
import { inspectSpriteWalkSeams } from "../src/daemon/sprite-walk-alpha.js";

const width = 96, height = 108;
const region = (x: number, y: number) => ({ x, y, width: 6, height: 6 });
const landmarks = {
  body: region(42, 20),
  left: { hand: region(26, 53), foot: region(31, 86) },
  right: { hand: region(65, 53), foot: region(59, 86) },
};

function pose(shift: number, torn = false, gloveHeight = 12): SpriteWalkRaster {
  const data = new Uint8Array(width * height * 4);
  function box(x: number, y: number, w: number, h: number, rgb: number[], seed: number) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const ink = (7 * i + 13 * j + i * j * 3 + seed) % 43;
        data.set([rgb[0] + ink, rgb[1] + ink, rgb[2] + ink, 255], ((y + j) * width + x + i) * 4);
      }
    }
  }
  const trousers = [135, 61, 23], gloves = [54, 61, 36];
  box(36, 12, 26, 24, [54, 95, 105], 1);
  box(32, 36, 34, 20, [160, 162, 112], 2);
  box(32, 54, 34, 14, trousers, 3);
  box(30, 65, 17, 26, trousers, 0);
  box(53, 65, 17, 26, trousers, 7);
  box(28, 83 + shift, 18, 12, [65, 74, 44], 8);
  box(56, 83 - shift, 18, 12, [37, 41, 24], 23);
  box(23, 50 + shift, 11, gloveHeight, gloves, 4);
  box(23, 62 + shift, 4, 3, gloves, 10);
  box(17, 18, 2, 2, [130, 124, 98], 5);
  box(63, 50 - shift, 11, gloveHeight, [34, 55, 24], 18);
  if (torn) data.fill(0, 4 * (57 * width + 36), 4 * (57 * width + 54));
  return { width, height, data };
}

it("repairs a connected waist and pairs the opposite hand without repainting the moving boots", () => {
  const standing = pose(0);
  const frames = [5, 3, 0, -3, -5, -3, 0, 3].map(n => pose(n, true));
  const task = { standing, frames, direction: "N" as const, landmarks };
  expect(inspectSpriteWalkGait(task).status).toBe("fail");
  expect(inspectSpriteWalkSeams(standing, frames).length).toBeGreaterThan(0);
  const fixed = repairSpriteWalkDirection(task);
  expect(inspectSpriteWalkGait({ ...task, frames: fixed }).status).toBe("pass");
  expect(inspectSpriteWalkSeams(standing, fixed)).toEqual([]);
  for (const [i, f] of fixed.entries()) {
    expect(f.data.subarray(4 * width * 81)).toEqual(frames[i].data.subarray(4 * width * 81));
    expect(f.data[4 * (90 * width + 48) + 3]).toBe(0);
  }
  // The old glove tip was attached to the hand. It must not survive in the air when the hand swings back.
  expect(frames[0].data[4 * (69 * width + 25) + 3]).toBe(255);
  expect(fixed[0].data[4 * (69 * width + 25) + 3]).toBe(0);
  // A genuinely separate head accessory is outside the wrist repair.
  expect(fixed[0].data[4 * (18 * width + 17) + 3]).toBe(255);
  expect(frames[0].data[4 * (57 * width + 46) + 3]).toBe(0);
});

it("repairs a wrist sampled near the cuff and checks the finished motion at the original landmarks", () => {
  const standing = pose(0, false, 15);
  const frames = [5, 3, 0, -3, -5, -3, 0, 3].map(n => pose(n, true, 15));
  const cuffs = {
    ...landmarks,
    left: { ...landmarks.left, hand: region(26, 50) },
    right: { ...landmarks.right, hand: region(65, 50) },
  };
  const input = { standing, frames, direction: "N" as const, landmarks: cuffs };
  expect(inspectSpriteWalkGait(input).status).toBe("fail");
  const fixed = repairSpriteWalkDirection(input);
  expect(inspectSpriteWalkSeams(standing, fixed)).toEqual([]);
  expect(inspectSpriteWalkGait({ ...input, frames: fixed }).status).toBe("pass");
});

it("declines an occluded second limb instead of inventing a replacement boot", () => {
  const standing = pose(0);
  expect(() => repairSpriteWalkDirection({
    standing, direction: "N", frames: [standing, standing, standing, standing], landmarks: { left: landmarks.left },
  })).toThrow(/both visible/);
});
