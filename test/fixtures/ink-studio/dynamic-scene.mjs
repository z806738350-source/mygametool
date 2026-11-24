// A small reusable scene for testing the bundled bake profile before WebGL.
export const palette = [0x102431, 0x477a78, 0x9dd1bd, 0xf5b65c];

export function checkedRamp(label, ramp) {
  if (!Array.isArray(ramp) || !ramp.length)
    throw new TypeError(`${label}: material.r must be a nonempty array`);
  for (let i = 0; i < ramp.length; i++) {
    if (
      !Object.hasOwn(ramp, i) ||
      !Number.isInteger(ramp[i]) ||
      ramp[i] < 0 ||
      ramp[i] >= palette.length
    ) {
      throw new RangeError(
        `${label}: invalid material.r[${i}]: ${String(ramp[i])}`,
      );
    }
  }
  return ramp;
}

function vector(label, value) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    [0, 1, 2].some(
      (i) => !Object.hasOwn(value, i) || !Number.isFinite(value[i]),
    )
  ) {
    throw new TypeError(`${label}: expected three finite coordinates`);
  }
  return value;
}

export function buildDynamicScene(
  { KIT, makeBuilder, makeSculpt },
  options = {},
) {
  try {
    const builder = makeBuilder(42, palette);
    const sculpt = KIT.sculpt(makeSculpt(builder));
    sculpt.box(
      [0, -0.5, 0],
      [2, 0.2, 2],
      { r: checkedRamp("ground", [0, 1]) },
      { res: 0.3 },
    );
    sculpt.bake();
    const groundCount = builder.count();
    const rig = KIT.rig(builder, sculpt);
    const parts = [
      ["player", [-1, 0, 0], [2]],
      ["boss-left", [0, 0, 0], [1, 2]],
      ["boss-center", [1, 0, 0], [2, 3]],
      [
        "boss-right",
        [2, 0, 0],
        options.rightRamp === undefined ? [3] : options.rightRamp,
      ],
    ];
    for (const [label, position, ramp] of parts) {
      const center =
        label === "boss-right" && "rightPosition" in options
          ? options.rightPosition
          : position;
      sculpt.ball(
        vector(label, center),
        0.3,
        { r: checkedRamp(label, ramp) },
        { res: 0.2, tag: label },
      );
      sculpt.bake();
    }
    const pool = KIT.pool(builder, 2);
    const world = builder.finish({
      cam: {
        target: [0, 0, 0],
        dist: 11,
        pitch: 0.82,
        yaw: 0.18,
        fov: 0.72,
        sway: 0,
      },
      dither: 0,
    });
    const stage = KIT.stage(world);
    rig.bind(stage);
    stage.update(0, 0);
    if (!world.data.every(Number.isFinite))
      throw new TypeError("scene contains non-finite splat data");
    const identity = KIT.M.id();
    return {
      world,
      stage,
      rig,
      pool,
      groundCount,
      move(label, offset) {
        rig.set(label, identity, [0, 0, 0], vector(label, offset));
        rig.apply();
      },
      putBullet(index, position) {
        const [x, y, z] = vector("bullet", position);
        const [r, g, b] = builder.P[3];
        pool.put(stage, index, x, y, z, 0.15, r + 256 * g + 65536 * b, 1);
      },
    };
  } catch (cause) {
    throw new Error("Ink scene construction failed", { cause });
  }
}
