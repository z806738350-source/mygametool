import type { SpriteWalkRaster } from "./sprite-walk-gait.js";

export interface SpriteWalkSeam {
  axis: "horizontal" | "vertical" | "down-right" | "up-right";
  x: number;
  y: number;
  length: number;
}

/** Inspect missing coverage in what was solid character art. Never paint across negative space. */
export function inspectSpriteWalkSeams(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[]) {
  const { width, height } = standing;
  if (
    standing.data.length !== width * height * 4 ||
    frames.some((f) => f.width !== width || f.height !== height || f.data.length !== standing.data.length)
  ) {
    throw new Error("Align the standing reference and every walk frame on the same RGBA canvas.");
  }
  let top = height,
    bottom = 0;
  for (let p = 0; p < width * height; p++) {
    if (standing.data[4 * p + 3] < 160) continue;
    top = Math.min(top, Math.floor(p / width));
    bottom = Math.max(bottom, Math.floor(p / width));
  }
  if (top > bottom) throw new Error("The standing reference has no visible body.");
  const bodyHeight = bottom - top + 1;
  const reach = Math.max(1, Math.min(4, Math.ceil(bodyHeight / 64)));
  const minRun = Math.max(4, Math.ceil(bodyHeight / 18));
  const results: (SpriteWalkSeam & { frame: number })[] = [];
  const scans = [
    { axis: "horizontal", dx: 1, dy: 0 },
    { axis: "vertical", dx: 0, dy: 1 },
    { axis: "down-right", dx: 1, dy: 1 },
    { axis: "up-right", dx: 1, dy: -1 },
  ] as const;
  for (const [frame, sprite] of frames.entries()) {
    for (const { axis, dx, dy } of scans) {
      const stride = (width * dx - dy) * 4;
      let longest: SpriteWalkSeam | undefined;
      function scanLine(x: number, y: number) {
        let length = 0,
          originallySolid = 0;
        for (;;) {
          const inside = x >= 0 && y >= 0 && x < width && y < height;
          const index = (y * width + x) * 4 + 3;
          // Sample each bank independently: an antialiased line may sit off centre in the gap.
          let before = false,
            after = false;
          if (
            inside &&
            sprite.data[index] <= 48 &&
            x >= Math.abs(dy) * reach &&
            x < width - Math.abs(dy) * reach &&
            y >= dx * reach &&
            y < height - dx * reach
          ) {
            for (let step = 1; step <= reach; step++) {
              before ||= sprite.data[index - stride * step] >= 160;
              after ||= sprite.data[index + stride * step] >= 160;
            }
          }
          if (before && after) {
            if (standing.data[index] >= 160) originallySolid++;
            length++;
          } else {
            if (length >= minRun && originallySolid >= length * 0.7 && length > (longest?.length ?? 0))
              longest = { axis, x: x - dx * length, y: y - dy * length, length };
            length = originallySolid = 0;
          }
          if (!inside) break;
          x += dx;
          y += dy;
        }
      }
      if (dx) for (let y = 0; y < height; y++) scanLine(0, y);
      if (dy) for (let x = dx; x < width; x++) scanLine(x, dy === 1 ? 0 : height - 1);
      if (longest) results.push({ frame, ...longest });
    }
  }
  return results;
}
