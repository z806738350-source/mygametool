import { expect, it } from "vitest";
import { observeSpriteActionParts } from "../src/daemon/sprite-action-parts.js";
import type { SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";

const body = { x: 32, y: 26, width: 7, height: 7 },
  wing = { x: 65, y: 23, width: 6, height: 6 },
  tail = { x: 12, y: 37, width: 6, height: 6 };
function frame(
  dx: number,
  wingDx: number,
  tailDy: number,
  hideWing = false,
): SpriteWalkRaster {
  const width = 88,
    height = 62,
    data = new Uint8Array(width * height * 4);
  const paint = (x: number, y: number, w: number, h: number, ink: number) => {
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const k = 4 * ((yy + y) * width + xx + x + dx);
        data.set(
          [
            ink + ((xx * 3 + yy * 7 + xx * yy) % 51),
            (xx * 11 + yy * 13 + 3 * ink) % 169,
            (99 + xx * yy + ink) % 207,
            255,
          ],
          k,
        );
      }
  };
  paint(24, 21, 35, 23, 127);
  paint(body.x, body.y, body.width, body.height, 66);
  if (!hideWing) paint(wing.x + wingDx, wing.y, wing.width, wing.height, 24);
  paint(tail.x, tail.y + tailDy, tail.width, tail.height, 188);
  return { width, height, data };
}
const reference = frame(0, 0, 0),
  camera = [0, 1, 2, 4, 3, 2, 1, 0],
  remote = [0, 3, 7, 4, 1, -3, -5, -1],
  flex = [0, 0, -4, -6, -1, 3, 7, 2];
it("selects actual extension and return from observed wing or tail travel under a moving camera", () => {
  const frames = camera.map((dx, i) => frame(dx, remote[i], flex[i]));
  const [feather, tip] = observeSpriteActionParts(reference, frames, [
    { name: "outer primary feather", region: wing, anchor: body },
    { name: "尾尖", region: tail, anchor: body },
  ]);
  expect(feather).toMatchObject({
    status: "tracked",
    keyframes: expect.arrayContaining([
      { phase: "extended", frame: 2 },
      { phase: "retracted", frame: 6 },
      { phase: "return from extended", frame: 2 },
    ]),
  });
  expect(tip.status).toBe("tracked");
  expect(tip.keyframes.map((p) => p.frame)).toEqual(
    expect.arrayContaining([3, 6]),
  );
  const [inferred] = observeSpriteActionParts(reference, frames, [
    { name: "unlabelled appendage", region: wing },
  ]);
  expect(inferred).toMatchObject({
    status: "tracked",
    anchor: expect.any(Object),
    keyframes: expect.arrayContaining([{ phase: "extended", frame: 2 }]),
  });
});
it("does not call camera travel a limb phase; genuinely hidden or repeated textures remain inconclusive", () => {
  const [global] = observeSpriteActionParts(
    reference,
    camera.map((dx) => frame(dx, 0, 0)),
    [{ name: "翼根", region: wing }],
  );
  expect(global).toMatchObject({ status: "inconclusive", keyframes: [] });
  const [hidden] = observeSpriteActionParts(
    reference,
    camera.map((dx, i) => frame(dx, remote[i], 0, i === 2)),
    [{ name: "wingtip", region: wing, anchor: body }],
  );
  expect(hidden.status).toBe("inconclusive");
  expect(hidden.keyframes.some((k) => k.frame === 2)).toBe(false);
  const [same] = observeSpriteActionParts(
    reference,
    camera.map((dx) => frame(dx, 0, 0)),
    [{ name: "root", region: body, anchor: body }],
  );
  expect(same.status).toBe("inconclusive");
});
