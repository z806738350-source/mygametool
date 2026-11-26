import { describe, expect, it } from "vitest";
import { inspectSpriteWalkGait, type SpriteWalkRaster, type SpriteWalkRect } from "../src/daemon/sprite-walk-gait.js";

const box = (x: number, y: number): SpriteWalkRect => ({ x, y, width: 4, height: 4 });
const body = box(21, 5), hand = box(14, 19), foot = box(14, 34);
const landmarks = { body, left: { hand, foot } };
const right = { hand: box(32, 19), foot: box(32, 34) };
const motion = [3, 1, 0, -1, -3, -1, 0, 1];

function frame(handShift: number, footShift: number, options: {
  bodyShift?: number; invisibleHand?: boolean; duplicateHand?: boolean; rightShifts?: [number, number];
} = {}): SpriteWalkRaster {
  const width = 48, height = 48, data = new Uint8Array(width * height * 4);
  function paint(rect: SpriteWalkRect, shift: number, color: number) {
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      data.set([color + 4 * x, 15 + 11 * y, 22 + 3 * x * y, 255],
        4 * ((rect.y + y) * width + rect.x + x + shift + (options.bodyShift ?? 0)));
    }
  }
  paint(body, 0, 61); paint(foot, footShift, 169);
  if (!options.invisibleHand) paint(hand, handShift, 12);
  if (options.duplicateHand) paint(hand, handShift + 6, 12);
  if (options.rightShifts) {
    paint(right.hand, options.rightShifts[0], 94);
    paint(right.foot, options.rightShifts[1], 188);
  }
  return { width, height, data };
}

const standing = frame(0, 0);
function check(frames: SpriteWalkRaster[], contacts?: readonly [number, number]) {
  return inspectSpriteWalkGait({ standing, frames, direction: "E", landmarks, contacts });
}

describe("registered standing landmarks in a biped walk", () => {
  it("distinguishes opposite from same-anatomical-side swings, including wrapped contact phases", () => {
    const good = check(motion.map(n => frame(n, -n)), [4, 0]);
    expect(good.status).toBe("pass");
    expect(good.sides.left?.passingFrames).toEqual([6, 2]);
    const bad = check(motion.map(n => frame(n, n)));
    expect(bad).toMatchObject({ status: "fail", sides: { left: { status: "fail", passingFrames: [2, 6] } } });
  });

  it("does not mistake a translated body, a contact-only swap or perpendicular motion for a confirmed walk", () => {
    expect(check(motion.map(n => frame(0, 0, { bodyShift: n }))).status).toBe("inconclusive");
    expect(check(motion.map(n => frame(n > 0 ? 3 : -3, n > 0 ? -3 : 3))).status).toBe("inconclusive");
    const frames = motion.map(n => frame(n, -n));
    expect(inspectSpriteWalkGait({ standing, frames, direction: "N", landmarks }).status).toBe("inconclusive");
  });

  it("reports an occluded or visually ambiguous contact and rejects overlapping or out-of-frame evidence", () => {
    expect(check(motion.map((n, i) => frame(n, -n, { invisibleHand: i === 0 }))).status).toBe("inconclusive");
    expect(check(motion.map(n => frame(n, -n, { duplicateHand: true }))).status).toBe("inconclusive");
    const frames = motion.map(n => frame(n, -n));
    for (const region of [foot, box(-1, 10)]) {
      expect(inspectSpriteWalkGait({ standing, frames, direction: "E",
        landmarks: { body, right: { hand: region, foot } } }).status).toBe("inconclusive");
    }
  });

  it("checks both visible sides and catches two boots swinging together", () => {
    const base = frame(0, 0, { rightShifts: [0, 0] });
    const inspect = (sign: number) => inspectSpriteWalkGait({ standing: base, direction: "E",
      landmarks: { ...landmarks, right }, frames: motion.map(n => frame(n, -n, { rightShifts: [n * sign, -n * sign] })) });
    expect(inspect(-1).status).toBe("pass");
    expect(inspect(1)).toMatchObject({ status: "fail", reasons: [expect.stringContaining("Both boots")] });
    expect(inspectSpriteWalkGait({ standing: base, frames: motion.map(n => frame(n, -n)), direction: "E",
      landmarks: { ...landmarks, right: landmarks.left } }).status).toBe("inconclusive");
  });

  it("does not certify crossed landmark assignments in a separated standing pose", () => {
    const base = frame(0, 0, { rightShifts: [0, 0] });
    const frames = motion.map(n => frame(n, n, { rightShifts: [-n, -n] }));
    const wrong = { hand, foot: right.foot };
    expect(inspectSpriteWalkGait({ standing: base, frames, direction: "E", landmarks: {
      body, left: wrong, right: { hand: right.hand, foot } } })).toMatchObject({
      status: "inconclusive", reasons: [expect.stringContaining("conflicting anatomical pairings")],
    });
    const front = { ...base, data: base.data.slice() };
    function fillSolid(rect: SpriteWalkRect) {
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++)
        front.data.set([45, 60, 30, 255], 4 * (y * front.width + x));
    }
    fillSolid({ x: 20, y: 18, width: 10, height: 7 }); // Torso between the two visible hands.
    fillSolid(box(14, 27)); fillSolid(box(32, 27)); // Separate shins above both boots.
    for (const direction of ["N", "S"] as const) {
      expect(inspectSpriteWalkGait({ standing: front, frames, direction, landmarks: { body, left: wrong } }))
        .toMatchObject({ status: "inconclusive", reasons: [expect.stringContaining("opposite sides")] });
    }
    // Without the frontal silhouette evidence, a horizontal/rolled pose gets no assumed image-side rule.
    expect(inspectSpriteWalkGait({ standing: base, frames, direction: "N", landmarks: { body, left: wrong } })
      .reasons[0]).not.toContain("opposite sides");
  });
});
