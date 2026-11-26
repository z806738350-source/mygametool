import { describe, expect, it } from "vitest";
import type { SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";
import { inspectSpriteWalkTopology } from "../src/daemon/sprite-walk-topology.js";

function paint(r: SpriteWalkRaster, x: number, y: number, w: number, h: number, alpha: number) {
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
    r.data.set([65, 38, 20, alpha], 4 * (row * r.width + col));
  }
}
function sprite() {
  const r = { width: 52, height: 52, data: new Uint8Array(52 * 52 * 4) };
  paint(r, 15, 2, 20, 42, 255);
  paint(r, 20, 44, 8, 3, 255);
  paint(r, 38, 5, 3, 3, 255); // A separately painted nail.
  return r;
}

describe("sprite walk silhouette continuity", () => {
  it("locates a transient detached cuff, including at the cycle boundary, while keeping a moving accessory", () => {
    const frames = Array.from({ length: 6 }, sprite);
    paint(frames[0], 20, 44, 8, 1, 0);
    paint(frames[2], 38, 5, 3, 3, 0);
    paint(frames[2], 40, 6, 3, 3, 255);
    paint(frames[0], 11, 40, 1, 1, 255);
    paint(frames[0], 10, 32, 3, 3, 100);
    expect(inspectSpriteWalkTopology(sprite(), frames)).toEqual([
      { frame: 0, kind: "detached-fragment", x: 20, y: 45, width: 8, height: 2, pixels: 16 },
    ]);
  });

  it("finds a wide one-phase break open to the outer contour, with or without pre-repair frames", () => {
    const before = Array.from({ length: 6 }, sprite), after = Array.from({ length: 6 }, sprite);
    paint(after[2], 15, 30, 13, 4, 0);
    for (const basis of [undefined, before, after]) {
      expect(inspectSpriteWalkTopology(sprite(), after, basis)).toContainEqual({
        frame: 2, kind: "opened-joint", x: 15, y: 30, width: 13, height: 4, pixels: 52,
      });
    }
  });

  it("keeps a persistent open pose and a small translucent transition", () => {
    const frames = Array.from({ length: 6 }, sprite);
    for (const f of frames) paint(f, 15, 30, 13, 4, 0);
    paint(frames[2], 19, 23, 6, 4, 88);
    expect(inspectSpriteWalkTopology(sprite(), frames)).toEqual([]);
  });
});
