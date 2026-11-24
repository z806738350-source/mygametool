# Bundled browser API

The runtime contains a compact bake toolkit and a WebGL 2 renderer. This profile supports procedural JavaScript scenes. Use data objects for your own tuning or level parameters. The full authoring APIs, including `KIT.diorama` and its upstream scene JSON format, are outside this profile.

## Scene and render

After `ensure_ink_runtime`, adapt the imports below to the actual paths it returned. Use a browser module loaded from HTML with `<script type="module" src="./game.mjs"></script>`. Read the runtime manifest to identify the version, not the generated bundle.

```js
import { KIT, makeBuilder, makeSculpt, PixelLook } from "./relative/path/to/toolkit.mjs";
import { createRenderer } from "./relative/path/to/renderer.mjs";

const builder = makeBuilder(42, [0x0b1720, 0x31505a, 0x639995, 0xffeeaa]);
const sculpt = KIT.sculpt(makeSculpt(builder));
const rig = KIT.rig(builder, sculpt);
sculpt.box([0, -0.3, 0], [3, 0.25, 3], { r: [0, 1, 2] }, { res: 0.23 });
sculpt.ball([0, 0.3, 0], 0.24, { r: [1, 2, 3] }, { res: 0.06, tag: "player" });
sculpt.bake();
const world = builder.finish({
  cam: { target: [0, 0, 0], dist: 11, pitch: 0.82, yaw: 0.18, fov: 0.72, sway: 0 },
  dither: 0,
});
const stage = KIT.stage(world);
rig.bind(stage);
stage.update(0, 0);
const renderer = createRenderer(canvas, { toolkit: { KIT, PixelLook }, resolve: "simple" });

function draw(playerX, playerZ, seconds) {
  rig.set("player", KIT.M.id(), [0, 0, 0], [playerX, 0, playerZ]);
  rig.apply();
  renderer.render(world, { time: seconds, raw: true, tone: false, water: false });
}
```

- Coordinates are `[x, y, z]`, with Y up. Box sizes are half-extents and camera angles are radians. Material `r` values index the supplied palette. Coarser `res` values use fewer splats. Validate finite positions and sizes before baking; use the part name in errors.
- Register the rig before baking, tag the geometry you want to move, and bind it after `builder.finish`. Keep one world and move tagged parts, rather than baking the scene every frame. Use one animation loop. These render calls use the canvas backing dimensions, so set `canvas.width` and `canvas.height` for the intended display size and frame budget.
- Omit `changedRows` while validating movement. Passing an empty array asserts that the data stayed unchanged, so the renderer may show a stale pose.
- Handle missing WebGL 2 or renderer setup errors visibly. Prevent default scrolling on control keys while playing, clear held keys when focus is lost, and clean up listeners, animation requests, and `renderer.dispose()` when releasing the game.

## Compare splat detail

Start here on the first playable asset of a new scene. Compare at its actual gameplay size before building the rest of the scene. For each comparison, hold the camera, lighting, pose, device, and other render settings fixed.

1. Bake the same asset with a finer sculpt `res` to get smaller, denser splats. For the player sphere above, compare `0.06` with `0.09`. Keep the geometry and materials fixed and compare silhouette, fine features, and surface coverage. Choose `res` per asset, prioritizing the player and other gameplay-critical shapes.
2. Start with pixelation off. For baked splats, `raw: true` bypasses Ink's pixel stylization pass and palette resolve. Leave low-resolution compositing off, use CSS `image-rendering: auto`, and size the canvas backing buffer for the displayed gameplay area and target device. If the game needs palette resolve, keep `look.pixel` off while tuning that look. If a coarse pixel style is requested, compare it on the same baked asset at the same display size.
3. Play the same short sequence at the intended display size. Check silhouettes and fine details in motion and compare frame timing. Apply the finer bake where it improves readability within the frame budget.

## Dynamic scene and material checks

A material `r` is a nonempty, one-dimensional array of integer indices into the current palette. One or two colors are valid; three Boss parts do not imply a three-color ramp. Check every actual selection, including callback results and sparse array holes, before baking. Do not clamp an invalid index or silently substitute a default. For example:

```js
function checkedRamp(label, ramp, palette) {
  if (!Array.isArray(ramp) || !ramp.length) throw new TypeError(`${label}: empty material.r`);
  for (let i = 0; i < ramp.length; i++) {
    if (!Object.hasOwn(ramp, i) || !Number.isInteger(ramp[i]) || ramp[i] < 0 || ramp[i] >= palette.length) {
      throw new RangeError(`${label}: invalid material.r[${i}]: ${String(ramp[i])}`);
    }
  }
  return ramp;
}
```

Bake static terrain first. Install the rig before baking dynamic geometry, give the player and each independently moving Boss part a distinct tag, and bake each entity in a clean batch. Allocate a bounded projectile pool before `builder.finish()`. Finish the accumulated builder only once, then create the stage, bind the rig and call `stage.update(0, 0)`. Transform tagged parts and reuse or hide pool entries rather than rebuilding every frame. The repository's [dynamic scene fixture](../../../../../test/fixtures/ink-studio/dynamic-scene.mjs), its [browser page](../../../../../test/fixtures/ink-studio/dynamic.html), and [regression test](../../../../../test/ink-studio-scene.test.ts) exercise this sequence with the bundled toolkit. To run the page, copy these dynamic fixture files into an isolated static project and install the runtime at the relative paths used by `dynamic-page.mjs`. Dispose the renderer and stop the animation loop and listeners when the page is released.

A minimal dynamic setup (using the imports and `checkedRamp` above):

```js
const palette = [0x102431, 0x477a78, 0x9dd1bd, 0xf5b65c];
const builder = makeBuilder(42, palette);
const sculpt = KIT.sculpt(makeSculpt(builder));
sculpt.box([0, -0.5, 0], [2, 0.2, 2], { r: checkedRamp("ground", [0, 1], palette) }, { res: 0.3 });
sculpt.bake();
const rig = KIT.rig(builder, sculpt);
for (const [tag, x, ramp] of [
  ["player", -1, [2]], ["boss-left", 0, [1, 2]],
  ["boss-center", 1, [2, 3]], ["boss-right", 2, [3]],
]) {
  sculpt.ball([x, 0, 0], 0.3, { r: checkedRamp(tag, ramp, palette) }, { res: 0.2, tag });
  sculpt.bake();
}
const pool = KIT.pool(builder, 2);
const world = builder.finish({ cam: { target: [0, 0, 0], dist: 11, pitch: 0.82, yaw: 0.18, fov: 0.72, sway: 0 }, dither: 0 });
const stage = KIT.stage(world);
rig.bind(stage);
stage.update(0, 0);
const bullet = pool.take();
const [r, g, b] = builder.P[3];
const renderer = createRenderer(canvas, { toolkit: { KIT, PixelLook }, resolve: "simple" });
function draw(playerX, bulletX, bossZ, seconds) {
  rig.set("player", KIT.M.id(), [0, 0, 0], [playerX, 0, 0]);
  rig.set("boss-right", KIT.M.id(), [0, 0, 0], [0, 0, bossZ]);
  rig.apply();
  pool.put(stage, bullet, bulletX, 0.7, -1, 0.15, r + 256 * g + 65536 * b, 1);
  renderer.render(world, { time: seconds, raw: true, tone: false, water: false });
}
// On release: pool.hide(stage, bullet); renderer.dispose(); cancel the loop and listeners.
```

For this pinned `KIT.pool(builder, capacity)` API, `pool.put(stage, index, x, y, z, radius, color, opacity)` expects a packed color, not the `builder.P[i]` RGB array or an unconverted `0xRRGGBB` literal. Given `[r, g, b] = builder.P[i]`, pass `r + 256 * g + 65536 * b`. Other APIs can accept RGB arrays; do not apply this rule indiscriminately.

Separate bake batches reduce unwanted baked occlusion but do not guarantee visibility. `whole: true` preserves surface geometry; it does not disable shadows or ambient occlusion, and disabling shadow marching does not disable AO. Inspect projectiles over different backgrounds and Boss parts in the real Electron image. If separate chunks are needed, use supported `SplatProvenance.join` before rig/animation binding, with identical palettes including order and values; rebuild groups using joined offsets. Never concatenate data arrays while dropping associated metadata. Start with full uploads by omitting `changedRows`; `changedRows: []` means nothing changed.

## Diagnose and probe

Distinguish module loading, scene construction/baking, actual `getContext("webgl2")` failure, shader/GPU setup, and runtime context loss. Keep the original exception and cause in diagnostic logs, identify the failed part, and show a concise actionable message without unnecessary host paths or credentials. A game-logic, collision, or input mismatch is a separate failure. Do not weaken Electron isolation to make a test pass.

For pure modules, run a Node probe inline or from a temporary directory confirmed outside source synchronization. Use `pathToFileURL` for absolute module paths; their own relative imports still resolve from the module. Browser rendering must be checked in a real browser or Electron. If a probe truly must be beside source, create a unique owned file and clean only it in a `finally`/trap in the same controlled command; interruption or concurrent synchronization can still leave or capture it. Inspect the outcome on failure. Once synchronized, removing it is a protected source change: use the normal review flow, never bypass a pending deletion.
