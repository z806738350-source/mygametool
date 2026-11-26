import { expect, it } from "vitest";
import type { SpriteWalkRaster } from "../src/daemon/sprite-walk-gait.js";
import {
  applySpriteActionMotionRepair,
  inspectSpriteActionMotion,
} from "../src/daemon/sprite-action-motion.js";

function canvas(width: number, height: number) {
  const r: SpriteWalkRaster = {
    width,
    height,
    data: new Uint8Array(width * height * 4),
  };
  const paint = (
    x: number,
    y: number,
    w: number,
    h: number,
    ink: number,
    texture = false,
  ) => {
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        if (x + xx < 0 || y + yy < 0 || x + xx >= width || y + yy >= height)
          continue;
        const grain = texture ? (xx * 17 + yy * 31 + xx * yy * 3) % 49 : 0;
        r.data.set(
          [
            ink + grain,
            Math.floor(ink / 2) + grain * 2,
            125 - ink / 3 + grain,
            255,
          ],
          4 * ((y + yy) * width + x + xx),
        );
      }
  };
  return { r, paint };
}

function wolf(lift: number[], foreAndHind: number[], hideFar = false) {
  const { r, paint } = canvas(88, 64);
  paint(10, 17, 55, 18, 71, true);
  paint(59, 12, 15, 19, 83, true);
  const xs = [18, 29, 57, 68],
    y = [45, 41, 45, 41];
  xs.forEach((x, k) => {
    if (hideFar && (k === 1 || k === 3)) return;
    const dy = lift[k],
      dx = foreAndHind[k],
      ink = 35 + k * 49;
    paint(x + dx + 1, 29, 3, y[k] + dy - 27, ink);
    paint(x + dx, y[k] + dy, 7, 6, ink, true);
  });
  return r;
}
const wave = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25];
function trot(pace: boolean, hide = false) {
  // First and third paws are near side, second and fourth are far side. A pace uses ipsilateral support.
  return wave.map((t) => {
    const phases = pace ? [t, 1 - t, t, 1 - t] : [t, 1 - t, 1 - t, t];
    return wolf(
      phases.map((u) => Math.round(-8 * u)),
      phases.map((u) => Math.round((u - 0.5) * 8)),
      hide,
    );
  });
}
const neutralWolf = wolf([0, 0, 0, 0], [0, 0, 0, 0]);
it("discovers both diagonal supports and passing poses; identifies a pace in the same artwork", () => {
  const input = {
    bodyPlan: "quadruped",
    action: "trot",
    direction: "E" as const,
    standing: neutralWolf,
  };
  const healthy = inspectSpriteActionMotion({ ...input, frames: trot(false) });
  expect(healthy, JSON.stringify(healthy)).toMatchObject({ status: "pass" });
  expect(healthy.keyframes.map((f) => f.frame)).toEqual([4, 0, 6, 2]);
  const fault = inspectSpriteActionMotion({ ...input, frames: trot(true) });
  expect(fault).toMatchObject({
    status: "fail",
    checks: [
      { name: "diagonal support", frames: expect.arrayContaining([0, 4]) },
    ],
  });
  expect(fault.repair, JSON.stringify(fault)).toMatchObject({
    kind: "retime-hindlegs",
  });
  const source = trot(true),
    corrected = applySpriteActionMotionRepair(source, fault.repair!);
  expect(
    inspectSpriteActionMotion({ ...input, frames: corrected }),
    JSON.stringify(fault),
  ).toMatchObject({ status: "pass" });
  for (const [i, f] of corrected.entries()) {
    expect(
      Buffer.from(f.data).equals(Buffer.from(trot(false)[(i + 4) % 8].data)),
    ).toBe(true);
    expect(
      Buffer.from(source[i].data).equals(Buffer.from(trot(true)[i].data)),
    ).toBe(true);
  }
});
it("leaves naturally overlapping far paws unconfirmed, and never certifies the same paw twice", () => {
  const input = {
    bodyPlan: "quadruped",
    action: "trot",
    direction: "E" as const,
    standing: neutralWolf,
  };
  const occluded = inspectSpriteActionMotion({
    ...input,
    standing: wolf([0, 0, 0, 0], [0, 0, 0, 0], true),
    frames: trot(false, true),
  });
  expect(occluded.status).toBe("inconclusive");
  expect(
    inspectSpriteActionMotion({
      ...input,
      frames: trot(false),
      landmarks: {
        hindNear: { x: 12, y: 40, width: 6, height: 6 },
        hindFar: { x: 12, y: 40, width: 6, height: 6 },
      },
    }).status,
  ).toBe("inconclusive");
});

function robot(body: number, sole: number, hide = false) {
  const { r, paint } = canvas(68, 84);
  paint(23, 25 + body, 22, 15, 75, true);
  paint(26, 38 + body, 17, 16, 89, true);
  for (const [i, x] of [22, 38].entries()) {
    if (i === 0 && hide) continue;
    paint(x + 2, 50 + body, 4, 17 + sole - body, 60 + i * 90);
    paint(x, 65 + sole, 8, 6, 45 + i * 120, true);
  }
  return r;
}
const flight = [
  0, 0, -2, -5, -7, -10, -13, -16, -19, -21, -17, -12, -6, -2, 0, 0, 0,
];
const jumpFrames = () =>
  flight.map((v, i) => robot(i === 1 || i === 15 ? 4 : v, v));
const jump = {
  standing: robot(0, 0),
  bodyPlan: "biped",
  action: "jump",
  direction: "S" as const,
};
it("locates crouch, apex, first contact and recovery from the actual painted poses", () => {
  const result = inspectSpriteActionMotion({ ...jump, frames: jumpFrames() });
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "pass",
    keyframes: expect.arrayContaining([
      { phase: "anticipation", frame: 1 },
      { phase: "apex", frame: 9 },
      { phase: "first landing", frame: 14 },
      { phase: "settled", frame: 16 },
    ]),
  });
});
it("locates an adjacent ordering error inside flight and verifies the restored order; a rigid translation cannot prove articulation", () => {
  const frames = jumpFrames();
  [frames[5], frames[6]] = [frames[6], frames[5]];
  const bad = inspectSpriteActionMotion({ ...jump, frames });
  expect(bad, JSON.stringify(bad)).toMatchObject({
    status: "fail",
    repair: { kind: "swap-adjacent", frames: [5, 6] },
  });
  const restored = applySpriteActionMotionRepair(frames, bad.repair!);
  expect(inspectSpriteActionMotion({ ...jump, frames: restored }).status).toBe(
    "pass",
  );
  expect(
    inspectSpriteActionMotion({
      ...jump,
      frames: flight.map((v) => robot(v, v)),
    }).status,
  ).toBe("inconclusive");
});
it("refuses a false landing from a missing boot and does not apply biped rules to other actions", () => {
  const frames = jumpFrames();
  frames[9] = robot(-21, -21, true);
  expect(inspectSpriteActionMotion({ ...jump, frames }).status).toBe(
    "inconclusive",
  );
  expect(
    inspectSpriteActionMotion({ ...jump, action: "flap", frames }).status,
  ).toBe("inconclusive");
});

it("does not borrow an independent moving decoration or a stride with no fore/aft travel", () => {
  const input = {
    bodyPlan: "quadruped",
    action: "trot",
    direction: "E" as const,
    standing: neutralWolf,
  };
  const frames = trot(true);
  frames.forEach((f, i) => {
    // A detached tail tip/particle under the haunch is unrelated to these paws.
    f.data.set([70 + i * 9, 50, 30, 255], 4 * (55 * f.width + 24));
  });
  const paced = inspectSpriteActionMotion({ ...input, frames });
  expect(paced.status).toBe("fail");
  expect(paced.repair).toBeUndefined();
  const liftOnly = wave.map((t) =>
    wolf(
      [t, 1 - t, 1 - t, t].map((v) => Math.round(-8 * v)),
      [0, 0, 0, 0],
    ),
  );
  const pump = inspectSpriteActionMotion({ ...input, frames: liftOnly });
  expect(pump.status).toBe("inconclusive");
  expect(pump.checks.find((c) => c.name === "paw travel")?.status).toBe(
    "inconclusive",
  );
});

it("keeps a genuine second jump out of the isolated swapped-frame repair", () => {
  const result = inspectSpriteActionMotion({
    ...jump,
    frames: [...jumpFrames(), ...jumpFrames()],
  });
  expect(result.status).toBe("inconclusive");
  expect(result.repair).toBeUndefined();
});

it("chooses a uniquely trackable body texture over stronger repeating paint without a supplied landmark", () => {
  const striped = (dy: number, foot: number) => {
    const sprite = robot(dy, foot);
    // Repeated slats are higher contrast than the device on the left side of the head.
    for (let y = 25; y < 50; y++)
      for (let x = 20; x < 50; x++) {
        const at = 4 * ((y + dy) * sprite.width + x);
        if (!sprite.data[at + 3]) continue;
        const shade = y % 3 === 0 ? 220 : 22;
        sprite.data.set([shade, shade, shade, 255], at);
        if (x >= 27 && x < 31 && y >= 29 && y < 32)
          sprite.data.set([60 + 3 * x - y, 120 + y - x, 20 + y, 255], at);
      }
    return sprite;
  };
  const standing = striped(0, 0),
    frames = flight.map((v, i) => striped(i === 1 || i === 15 ? 4 : v, v));
  expect(inspectSpriteActionMotion({ ...jump, standing, frames }).status).toBe(
    "pass",
  );
  [frames[5], frames[6]] = [frames[6], frames[5]];
  expect(
    inspectSpriteActionMotion({ ...jump, standing, frames }),
  ).toMatchObject({
    status: "fail",
    repair: { kind: "swap-adjacent", frames: [5, 6] },
  });
});
