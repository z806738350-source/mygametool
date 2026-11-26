import { describe, expect, it } from "vitest";
import { inspectSpriteWalkGait, type SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";
import { suggestSpriteWalkLandmarks } from "../src/daemon/sprite-walk-landmarks.js";

function figure(hand: number, boot: number, shape: "front" | "side" | "sign" = "front"): SpriteWalkRaster {
  const width = 80, height = 112, data = new Uint8Array(width * height * 4);
  function paint(x: number, y: number, w: number, h: number, ink: number) {
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
      const noise = (u * 17 + v * 33 + u * v * 7) % 67;
      data.set([ink + noise, (31 + ink + u * 7) % 250, (40 + v * 7 + noise) % 240, 255], 4 * ((y + v) * width + x + u));
    }
  }
  if (shape === "sign") paint(14, 4, 51, 98, 32);
  else {
    paint(16, 4, 47, 38, 20); paint(26, 39, 27, 37, 35);
    if (shape === "front") { paint(21, 68, 14, 26, 61); paint(47, 68, 13, 26, 74); }
    else paint(34, 65, 12, 30, 73);
  }
  if (shape === "side") {
    paint(34 + hand, 68, 11, 13, 106); paint(32 + boot, 92, 18, 10, 142);
  } else {
    paint(17, 69 + hand, 11, 13, 106); paint(55, 69 - hand, 11, 13, 115);
    paint(19, 92 + boot, 18, 10, 132); paint(45, 92 - boot, 18, 10, 146);
  }
  return { width, height, data };
}

const phases = [4, 2, 0, -2, -4, -2, 0, 2];

describe("visible walk landmark suggestions", () => {
  it("finds paired moving texture without preferring opposed movement over same-side movement", () => {
    const standing = figure(0, 0);
    for (const sign of [1, -1]) {
      const frames = phases.map(n => figure(n, n * sign));
      const s = suggestSpriteWalkLandmarks(standing, frames, "N");
      expect(s.confidence).toBe("candidate");
      expect(s.landmarks.left).toBeDefined();
      expect(s.landmarks.right).toBeDefined();
      expect(inspectSpriteWalkGait({ standing, frames, direction: "N", landmarks: s.landmarks }).status)
        .toBe(sign === 1 ? "fail" : "pass");
    }
  });
  it("suggests only the visible profile side", () => {
    const standing = figure(0, 0, "side"), frames = phases.map(n => figure(n, -n, "side"));
    const s = suggestSpriteWalkLandmarks(standing, frames, "E");
    expect(s.landmarks.right).toBeDefined();
    expect(s.landmarks.left).toBeUndefined();
  });
  it("rejects static artwork and moving badges on a solid sign with no separate feet", () => {
    const standing = figure(0, 0);
    expect(suggestSpriteWalkLandmarks(standing, Array(8).fill(standing), "N").confidence).toBe("inconclusive");
    const sign = figure(0, 0, "sign"), frames = phases.map(n => figure(n, -n, "sign"));
    expect(suggestSpriteWalkLandmarks(sign, frames, "N")).toMatchObject({ confidence: "inconclusive", landmarks: {} });
  });
});
