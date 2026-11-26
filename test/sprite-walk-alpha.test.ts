import { describe, expect, it } from "vitest";
import { inspectSpriteWalkSeams } from "../src/daemon/sprite-walk-alpha.js";

const width = 48,
  height = 48;
const painted = () => ({ width, height, data: new Uint8Array(width * height * 4) });
function rectangle(image: ReturnType<typeof painted>, x: number, y: number, w: number, h: number, alpha: number) {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) image.data[(row * image.width + col) * 4 + 3] = alpha;
}

describe("walking sprite alpha coverage", () => {
  it("locates both horizontal and vertical tears opened by moving cutout layers", () => {
    const standing = painted();
    rectangle(standing, 8, 7, 28, 34, 255);
    const step = structuredClone(standing);
    rectangle(step, 8, 25, 17, 1, 0);
    rectangle(step, 31, 10, 1, 10, 20);
    expect(inspectSpriteWalkSeams(standing, [standing, step])).toEqual([
      { frame: 1, axis: "horizontal", x: 8, y: 25, length: 17 },
      { frame: 1, axis: "vertical", x: 31, y: 10, length: 10 },
    ]);
  });

  it("preserves natural limb separations and translucent contours from the reference", () => {
    const standing = painted();
    rectangle(standing, 10, 8, 26, 31, 230);
    rectangle(standing, 22, 25, 2, 14, 0);
    rectangle(standing, 12, 16, 1, 12, 10);
    const step = structuredClone(standing);
    rectangle(step, 24, 28, 2, 11, 0);
    rectangle(step, 10, 11, 1, 5, 55);
    expect(inspectSpriteWalkSeams(standing, [standing, step])).toEqual([]);
  });

  it("finds a joint exposed along a diagonal cut", () => {
    const standing = painted();
    rectangle(standing, 8, 7, 30, 34, 255);
    const step = structuredClone(standing);
    for (let i = 0; i < 12; i++) rectangle(step, 15 + i, 30 - i, 1, 1, 0);
    expect(inspectSpriteWalkSeams(standing, [step])).toEqual([{ frame: 0, axis: "up-right", x: 15, y: 30, length: 12 }]);
  });
});
