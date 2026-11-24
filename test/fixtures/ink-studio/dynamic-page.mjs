import { buildDynamicScene } from "./dynamic-scene.mjs";

const canvas = document.querySelector("#arena");
const status = document.querySelector("#status");
const params = new URL(location.href).searchParams;
const test = params.get("ohmygamePlaytest") === "1";
const failure = test ? params.get("fixtureFailure") : null;
const state = {
  playerX: 0,
  bulletX: 0,
  bossZ: 0,
  frames: 0,
  inputs: 0,
  failure: null,
};
const keys = new Set();
const listeners = new AbortController();
let renderer,
  scene,
  raf = 0,
  lost = false;

function fail(stage, error) {
  state.failure = stage;
  status.textContent = `${stage} failed. See console for details.`;
  console.error(`${stage} failed`, error, error?.cause?.stack ?? "");
}

try {
  const [toolkit, renderModule] = await Promise.all([
    import("./vendor/ink-studio/f4b5644a-bake-r1/ink-toolkit.min.mjs"),
    import("./vendor/ink-studio/f4b5644a-bake-r1/ink-renderer.min.mjs"),
  ]);
  try {
    scene = buildDynamicScene(
      toolkit,
      failure === "scene" ? { rightRamp: [undefined] } : {},
    );
  } catch (error) {
    fail("Scene construction", error);
  }
  if (scene) {
    try {
      if (failure === "context" || !canvas.getContext("webgl2"))
        throw new Error("WebGL 2 context unavailable");
    } catch (error) {
      fail("WebGL 2 context", error);
    }
    if (!state.failure) {
      try {
        renderer = renderModule.createRenderer(canvas, {
          toolkit: { KIT: toolkit.KIT, PixelLook: toolkit.PixelLook },
          resolve: "simple",
        });
      } catch (error) {
        fail("Renderer initialization", error);
      }
    }
    if (renderer) {
      const bullet = scene.pool.take();
      function draw(now) {
        if (lost) return;
        if (keys.has("ArrowRight"))
          state.playerX = Math.min(2, state.playerX + 0.025);
        if (keys.has("ArrowLeft"))
          state.playerX = Math.max(-2, state.playerX - 0.025);
        state.bulletX = Math.sin(now / 600) * 1.8;
        scene.move("player", [state.playerX, 0, 0]);
        state.bossZ = Math.sin(now / 1000) * 0.3;
        scene.move("boss-right", [0, 0, state.bossZ]);
        scene.putBullet(bullet, [state.bulletX, 0.7, -1]);
        try {
          renderer.render(scene.world, {
            width: 320,
            height: 200,
            time: now / 1000,
            raw: true,
            tone: false,
            water: false,
          });
          state.frames++;
          if (failure === "context-loss" && state.frames === 1) {
            canvas.dispatchEvent(
              new Event("webglcontextlost", { cancelable: true }),
            );
            return;
          }
          raf = requestAnimationFrame(draw);
        } catch (error) {
          fail("Rendering", error);
        }
      }
      canvas.addEventListener(
        "webglcontextlost",
        (event) => {
          event.preventDefault();
          lost = true;
          keys.clear();
          cancelAnimationFrame(raf);
          fail("Graphics context lost", new Error("WebGL context lost"));
        },
        { signal: listeners.signal },
      );
      canvas.addEventListener(
        "keydown",
        (event) => {
          if (!event.key.startsWith("Arrow")) return;
          event.preventDefault();
          state.inputs++;
          keys.add(event.key);
        },
        { signal: listeners.signal },
      );
      window.addEventListener("keyup", (event) => keys.delete(event.key), {
        signal: listeners.signal,
      });
      canvas.addEventListener("blur", () => keys.clear(), {
        signal: listeners.signal,
      });
      window.addEventListener("blur", () => keys.clear(), {
        signal: listeners.signal,
      });
      document.querySelector('[data-testid="start"]').addEventListener(
        "click",
        () => {
          state.playerX = 0;
          keys.clear();
          canvas.focus();
        },
        { signal: listeners.signal },
      );
      window.addEventListener(
        "pagehide",
        (event) => {
          if (event.persisted) return;
          cancelAnimationFrame(raf);
          listeners.abort();
          renderer.dispose();
        },
        { signal: listeners.signal },
      );
      status.textContent = "Ready.";
      raf = requestAnimationFrame(draw);
    }
  }
} catch (error) {
  fail("Module loading", error);
}
if (test) globalThis.__OHMYGAME_PLAYTEST__ = { snapshot: () => ({ ...state }) };
