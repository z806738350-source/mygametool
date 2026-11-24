const arena = document.getElementById("arena");
const start = document.getElementById("start");
const time = document.getElementById("time");
const status = document.getElementById("status");

const HZ = 60;
const STEP_MS = 1000 / HZ;
const CONFIG = Object.freeze({
  roundSeconds: 30,
  telegraphSeconds: 1.0,
  firstHazardSeconds: 2,
  hazardIntervalSeconds: 3,
  waveSeconds: 0.5,
  playerSpeed: 3.6,
  playerRadius: 0.2,
  arenaLimit: 2.95,
  waveEndRadius: 1.65,
});
const toTicks = seconds => Math.round(seconds * HZ);
const roundTicks = toTicks(CONFIG.roundSeconds);
const telegraphTicks = toTicks(CONFIG.telegraphSeconds);
const waveTicks = toTicks(CONFIG.waveSeconds);
const moves = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
};
const keys = new Set();
const state = {
  phase: "ready",
  tick: 0,
  player: { x: 0, z: 0 },
  nextHazardTick: toTicks(CONFIG.firstHazardSeconds),
  hazard: null,
  telegraphBeganTick: null,
  impactBeganTick: null,
};
let renderedFrames = 0;

function reset() {
  state.phase = "playing";
  state.tick = 0;
  state.player.x = 0;
  state.player.z = 0;
  state.nextHazardTick = toTicks(CONFIG.firstHazardSeconds);
  state.hazard = null;
  state.telegraphBeganTick = null;
  state.impactBeganTick = null;
  keys.clear();
  start.textContent = "Restart";
  status.textContent = "Survey the platform.";
  arena.focus({ preventScroll: true });
}

function update() {
  if (state.phase !== "playing") return;
  state.tick += 1;
  const player = state.player;
  let dx = 0, dz = 0;
  for (const code of keys) {
    const [x, z] = moves[code];
    dx += x;
    dz += z;
  }
  const speed = CONFIG.playerSpeed / (HZ * Math.max(1, Math.hypot(dx, dz)));
  const clamp = value => Math.max(-CONFIG.arenaLimit, Math.min(CONFIG.arenaLimit, value));
  player.x = clamp(player.x + dx * speed);
  player.z = clamp(player.z + dz * speed);

  if (!state.hazard && state.tick >= state.nextHazardTick) {
    state.hazard = { x: player.x, z: player.z, beginTick: state.tick, impactTick: state.tick + telegraphTicks, radius: 0 };
    state.telegraphBeganTick = state.tick;
    state.impactBeganTick = null;
    state.nextHazardTick += toTicks(CONFIG.hazardIntervalSeconds);
    status.textContent = "Amber warning. Move away.";
  }

  const hazard = state.hazard;
  if (hazard && state.tick >= hazard.impactTick) {
    if (state.tick === hazard.impactTick) {
      state.impactBeganTick = state.tick;
      status.textContent = "Wave active.";
    }
    const progress = Math.min(1, (state.tick - hazard.impactTick) / waveTicks);
    hazard.radius = 0.4 + progress * (CONFIG.waveEndRadius - 0.4);
    if (Math.hypot(player.x - hazard.x, player.z - hazard.z) <= hazard.radius + CONFIG.playerRadius) {
      state.phase = "lost";
      status.textContent = "The tide caught you. Try again.";
    } else if (progress >= 1) {
      state.hazard = null;
      status.textContent = "Wave cleared.";
    }
  }
  if (state.phase === "playing" && state.tick >= roundTicks) {
    state.phase = "won";
    status.textContent = "Signal recovered. You crossed the tide.";
  }
}

function makeScene({ KIT, makeBuilder, makeSculpt, PixelLook }, { createRenderer }) {
  const palette = [
    0x0b1720, 0x102431, 0x1f3843, 0x2d5860, 0x477a78, 0x83ab98,
    0x385766, 0x57878f, 0x9dd1bd, 0xe8f1ce,
    0x774c3b, 0xcc7c49, 0xf5b65c, 0xffe2a2,
    0x964744, 0xe57059, 0xffad88,
  ];
  const builder = makeBuilder(4317, palette);
  const sculpt = KIT.sculpt(makeSculpt(builder));
  const rig = KIT.rig(builder, sculpt);
  const stone = { r: [1, 2, 3, 4] };
  const deck = { r: [2, 3, 4, 5] };
  const edge = { r: [3, 4, 5, 8] };
  const body = { r: [2, 6, 7, 8] };
  const lamp = { r: [7, 8, 9], em: true };
  const amber = { r: [10, 11, 12, 13], em: true };
  const coral = { r: [14, 15, 16], em: true };

  sculpt.box([0, -0.46, 0], [3.5, 0.4, 3.5], stone, { res: 0.28, rd: 0.24 });
  sculpt.box([0, -0.07, 0], [3.24, 0.08, 3.24], deck, { res: 0.2, rd: 0.08 });
  for (const side of [-1, 1]) {
    sculpt.box([side * 3.27, 0.025, 0], [0.035, 0.035, 3.19], edge, { res: 0.1 });
    sculpt.box([0, 0.025, side * 3.27], [3.19, 0.035, 0.035], edge, { res: 0.1 });
    for (const corner of [-1, 1]) {
      sculpt.box([side * 3.41, 0.12, corner * 3.41], [0.12, 0.19, 0.12], body, { res: 0.1 });
      sculpt.ball([side * 3.41, 0.36, corner * 3.41], 0.09, lamp, { res: 0.06 });
    }
  }
  sculpt.box([0, 0.28, 0], [0.24, 0.22, 0.21], body, { res: 0.095, rd: 0.09, tag: "player" });
  sculpt.ball([0, 0.64, 0], 0.25, lamp, { res: 0.085, tag: "player" });
  sculpt.torus([0, 0.1, 0], 1, 0.065, amber, { res: 0.105, tag: "warning" });
  sculpt.torus([0, 0.1, 0], 1, 0.09, coral, { res: 0.105, tag: "wave" });
  sculpt.bake();
  const world = builder.finish({
    cam: { target: [0, -0.15, 0], dist: 12.8, pitch: 0.84, yaw: 0.17, fov: 0.72, sway: 0 },
    bg: [0.042, 0.085, 0.12],
    dither: 0,
  });
  const stage = KIT.stage(world);
  rig.bind(stage);
  stage.update(0, 0);

  const renderer = createRenderer(arena, { toolkit: { KIT, PixelLook }, resolve: "simple" });
  const identity = KIT.M.id();
  const origin = [0, 0, 0];
  const hidden = [0, -20, 0];
  function ring(tag, hazard, radius) {
    if (!hazard) {
      rig.set(tag, identity, origin, hidden);
      return;
    }
    rig.set(tag, [radius, 0, 0, 0, 1, 0, 0, 0, radius], origin, [hazard.x, 0, hazard.z]);
  }

  return {
    splatCount: world.count,
    draw() {
      const hazard = state.hazard;
      rig.set("player", identity, origin, [state.player.x, 0, state.player.z]);
      ring("warning", hazard?.radius === 0 ? hazard : null, CONFIG.waveEndRadius);
      ring("wave", hazard?.radius > 0 ? hazard : null, hazard?.radius ?? 0);
      rig.apply();
      renderer.render(world, { width: 320, height: 200, time: state.tick / HZ, raw: true, tone: false, water: false });
    },
    dispose() { renderer.dispose(); },
  };
}

async function launch() {
  const [toolkit, renderer] = await Promise.all([
    import("./vendor/ink-studio/f4b5644a-bake-r1/ink-toolkit.min.mjs"),
    import("./vendor/ink-studio/f4b5644a-bake-r1/ink-renderer.min.mjs"),
  ]);
  const scene = makeScene(toolkit, renderer);
  const playtest = new URL(location.href).searchParams.get("ohmygamePlaytest") === "1";
  const frameIntervals = [];
  const inputs = new AbortController();
  const listenerOptions = { signal: inputs.signal };
  let raf = 0;
  let lastTime;
  let accumulator = 0;
  let contextLost = false;

  function resetClock() {
    lastTime = undefined;
    accumulator = 0;
    keys.clear();
  }

  function draw() {
    scene.draw();
    renderedFrames += 1;
  }

  function frame(now) {
    if (contextLost || document.hidden) {
      resetClock();
      raf = requestAnimationFrame(frame);
      return;
    }
    if (lastTime !== undefined && state.phase === "playing") {
      if (playtest && frameIntervals.length < 3600) frameIntervals.push(now - lastTime);
      accumulator += Math.min(100, now - lastTime);
      while (accumulator + 0.00001 >= STEP_MS && state.phase === "playing") {
        accumulator -= STEP_MS;
        update();
      }
      time.textContent = Math.max(0, (roundTicks - state.tick) / HZ).toFixed(1);
    }
    lastTime = now;
    try {
      draw();
      raf = requestAnimationFrame(frame);
    } catch (error) {
      status.textContent = "Rendering failed. " + error.message;
      console.error(error);
    }
  }

  function begin() {
    resetClock();
    frameIntervals.length = 0;
    reset();
    time.textContent = CONFIG.roundSeconds.toFixed(1);
  }

  start.addEventListener("click", begin, listenerOptions);
  arena.addEventListener("keydown", event => {
    if (state.phase !== "playing" || !Object.hasOwn(moves, event.code)) return;
    event.preventDefault();
    keys.add(event.code);
  }, listenerOptions);
  window.addEventListener("keyup", event => keys.delete(event.code), listenerOptions);
  arena.addEventListener("blur", () => keys.clear(), listenerOptions);
  window.addEventListener("blur", () => keys.clear(), listenerOptions);
  document.addEventListener("visibilitychange", resetClock, listenerOptions);
  arena.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    contextLost = true;
    resetClock();
    status.textContent = "Graphics context lost.";
  }, listenerOptions);
  arena.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    resetClock();
    status.textContent = "Graphics restored.";
  }, listenerOptions);
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    cancelAnimationFrame(raf);
    inputs.abort();
    scene.dispose();
  }, listenerOptions);

  draw();
  start.disabled = false;
  status.textContent = "Ready.";
  if (playtest) {
    globalThis.__OHMYGAME_PLAYTEST__ = {
      snapshot() {
        const ordered = [...frameIntervals].sort((a, b) => a - b);
        return {
          phase: state.phase,
          tick: state.tick,
          elapsedSeconds: state.tick / HZ,
          player: { ...state.player },
          hazard: state.hazard ? { ...state.hazard } : null,
          telegraphBeganTick: state.telegraphBeganTick,
          impactBeganTick: state.impactBeganTick,
          telegraphSeconds: CONFIG.telegraphSeconds,
          stepsPerSecond: HZ,
          renderedFrames,
          splatCount: scene.splatCount,
          frameTiming: {
            samples: ordered.length,
            p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null,
            longestMs: ordered.at(-1) ?? null,
          },
        };
      },
      reset: begin,
    };
  }
  raf = requestAnimationFrame(frame);
}

launch().catch(error => {
  status.textContent = "Game could not start. " + error.message;
  console.error(error);
});
