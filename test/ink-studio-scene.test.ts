import { describe, expect, it } from "vitest";
// @ts-expect-error Bundled browser module has no type declarations.
import * as toolkit from "../plugins/ink-studio/runtime/ink-toolkit.min.mjs";
// @ts-expect-error The executable fixture is shared with browser checks.
import * as dynamicScene from "./fixtures/ink-studio/dynamic-scene.mjs";
const { buildDynamicScene, checkedRamp } = dynamicScene;

describe("Ink Studio dynamic scene", () => {
  it("validates each actual palette index, including sparse arrays, before rendering", () => {
    expect(checkedRamp("single", [2])).toEqual([2]);
    expect(checkedRamp("two colors", [1, 2])).toEqual([1, 2]);
    for (const ramp of [
      [],
      [undefined],
      [4],
      [-1],
      [1.5],
      Array(1),
      [[1, 2]],
    ]) {
      expect(() => checkedRamp("boss-right", ramp)).toThrow(/boss-right/);
    }
    for (const options of [
      { rightRamp: [undefined] },
      { rightRamp: [4] },
      { rightRamp: Array(1) },
      { rightPosition: [0, NaN, 0] },
      { rightPosition: Array(3) },
    ]) {
      try {
        buildDynamicScene(toolkit, options);
        throw new Error("Expected scene construction to fail");
      } catch (cause) {
        const error = cause as Error & { cause: Error };
        expect(error.message).toBe("Ink scene construction failed");
        expect(error.cause.message).toContain("boss-right");
      }
    }
  });

  it("bakes static ground and independent parts, then reuses a correctly colored bullet", () => {
    const scene = buildDynamicScene(toolkit);
    const { world, stage, rig, pool, groundCount } = scene;
    expect(world.data.every(Number.isFinite)).toBe(true);
    const ground = Array.from(stage.D.slice(0, groundCount * 16));
    const positions = (name: string): number[] =>
      Array.from(
        rig.list[rig.names.indexOf(name)] as Int32Array,
        (index) => stage.D[index * 16],
      );
    const before = Object.fromEntries(
      ["player", "boss-left", "boss-center", "boss-right"].map((name) => [
        name,
        positions(name),
      ]),
    );
    expect(Object.values(before).every((group) => group.length > 0)).toBe(true);
    scene.move("boss-right", [2, 0, 0]);
    expect(positions("boss-right")).toEqual(
      before["boss-right"].map((x) => Math.fround(x + 2)),
    );
    for (const name of ["player", "boss-left", "boss-center"])
      expect(positions(name)).toEqual(before[name]);
    expect(Array.from(stage.D.slice(0, groundCount * 16))).toEqual(ground);
    const bullet = pool.take();
    scene.putBullet(bullet, [0, 1, 0]);
    expect(Array.from(stage.D.slice(bullet * 16, bullet * 16 + 3))).toEqual([
      0, 1, 0,
    ]);
    const [r, g, b] = toolkit.makeBuilder(
      42,
      [0x102431, 0x477a78, 0x9dd1bd, 0xf5b65c],
    ).P[3];
    expect(stage.D[bullet * 16 + 7]).toBe(r + 256 * g + 65536 * b);
    scene.putBullet(bullet, [1, 1, 0]);
    expect(stage.D[bullet * 16]).toBe(1);
    pool.hide(stage, bullet);
    expect(stage.D[bullet * 16 + 3]).toBe(0);
    expect(stage.D.every(Number.isFinite)).toBe(true);
  });
});
