import {
  observeSpriteSilhouette,
  selectSpriteActionPatch,
} from "./sprite-action-parts.js";
import type { CharacterViewDirection } from "../shared/character-views.js";
import { RASTER_PIXELS } from "./raster-policy.js";
import {
  trackSpriteWalkLandmark,
  type SpriteWalkRaster,
  type SpriteWalkRect,
} from "./sprite-walk-gait.js";

type Paw = "frontNear" | "frontFar" | "hindNear" | "hindFar";
type Foot = "leftFoot" | "rightFoot";
export type SpriteActionLandmarks = Partial<
  Record<Paw | Foot | "body", SpriteWalkRect>
>;
type Tracks = Partial<
  Record<
    keyof SpriteActionLandmarks,
    ReturnType<typeof trackSpriteWalkLandmark>
  >
>;
type Status = "pass" | "fail" | "inconclusive";
export type SpriteActionMotionRepair =
  | { kind: "swap-adjacent"; frames: [number, number] }
  | { kind: "retime-hindlegs"; region: SpriteWalkRect; sourceFrames: number[] };

export interface SpriteActionMotionReview {
  status: Status;
  checks: { name: string; status: Status; reason: string; frames: number[] }[];
  keyframes: { phase: string; frame: number }[];
  landmarks: SpriteActionLandmarks;
  repair?: SpriteActionMotionRepair;
}
interface Input {
  standing: SpriteWalkRaster;
  frames: readonly SpriteWalkRaster[];
  direction: CharacterViewDirection;
  bodyPlan: string;
  action: string;
  landmarks?: SpriteActionLandmarks;
}

function footprints(
  shape: ReturnType<typeof observeSpriteSilhouette>,
  count: number,
) {
  for (const fraction of [0.82, 0.76, 0.88, 0.7, 0.94]) {
    const top = Math.round(shape.y + (shape.height - 1) * fraction);
    const runs: SpriteWalkRect[] = [];
    let start = shape.x,
      bottom = -1;
    for (let x = shape.x; x <= shape.x + shape.width; x++) {
      if (x < shape.x + shape.width && shape.soles[x] >= top) {
        bottom = Math.max(bottom, shape.soles[x]);
        continue;
      }
      if (x - start >= 3 && bottom - top >= 2)
        runs.push({
          x: start,
          y: top,
          width: x - start,
          height: bottom - top + 1,
        });
      start = x + 1;
      bottom = -1;
    }
    if (runs.length === count) return runs;
  }
  return [];
}

function trackingRadius(height: number, jump: boolean) {
  return Math.min(40, Math.max(6, Math.ceil(height * (jump ? 0.65 : 0.27))));
}

function propose(
  input: Input,
  shape: ReturnType<typeof observeSpriteSilhouette>,
  trot: boolean,
) {
  const { standing, direction } = input;
  const found: SpriteActionLandmarks = {};
  const radius = trackingRadius(shape.height, !trot),
    samples = [0, 1, 2, 3].map(
      (i) => input.frames[Math.floor((input.frames.length * i) / 4)],
    );
  const visiblePatch = (area: SpriteWalkRect) =>
    selectSpriteActionPatch(standing, area, samples, radius);
  const partial = (x: number, y: number, w: number, h: number) => ({
    x: shape.x + Math.floor(shape.width * x),
    y: shape.y + Math.floor(shape.height * y),
    width: Math.max(1, Math.floor(shape.width * w)),
    height: Math.max(1, Math.floor(shape.height * h)),
  });
  found.body = visiblePatch(partial(0.16, 0.1, 0.68, 0.45));
  const side = direction === "E" || direction === "W";
  const feet = footprints(shape, trot ? 4 : 2);
  if (
    trot &&
    feet.length &&
    (direction.includes("E") || direction.includes("W"))
  ) {
    const split = feet[2].x - (feet[1].x + feet[1].width);
    const within = Math.max(
      feet[1].x - feet[0].x - feet[0].width,
      feet[3].x - feet[2].x - feet[2].width,
    );
    // Near/far identity needs a depth cue in the standing image; phase agreement cannot supply it.
    if (split >= Math.max(2, within))
      for (const [group, pair] of [feet.slice(0, 2), feet.slice(2)].entries()) {
        const [far, near] = pair.sort(
          (a, b) => a.y + a.height - (b.y + b.height),
        );
        if (
          near.y + near.height - far.y - far.height <
          Math.max(2, shape.height * 0.026)
        )
          continue;
        const fore = (group === 1) === direction.includes("E");
        found[fore ? "frontNear" : "hindNear"] = visiblePatch(near);
        found[fore ? "frontFar" : "hindFar"] = visiblePatch(far);
      }
  } else if (!trot) {
    if (feet.length) {
      const anatomicalLeft = direction.includes("S") ? 1 : 0;
      found.leftFoot = visiblePatch(feet[anatomicalLeft]);
      found.rightFoot = visiblePatch(feet[1 - anatomicalLeft]);
    } else if (side) {
      const [near] = footprints(shape, 1);
      if (near)
        found[direction === "E" ? "rightFoot" : "leftFoot"] =
          visiblePatch(near);
    }
  }
  return Object.fromEntries(
    Object.entries({ ...found, ...input.landmarks }).filter(([, r]) => r),
  ) as SpriteActionLandmarks;
}

const paws: readonly Paw[] = ["frontNear", "frontFar", "hindNear", "hindFar"];
// Transfer only an existing rear stride from this exact loop. Require a uniquely measured
// phase offset, four visible foot tracks, an attached stable hip and identical join pixels.
function hindlegRepair(
  input: Input,
  out: SpriteActionMotionReview,
  tracks: Tracks,
  phases: ({ front: number; hind: number } | null)[],
  shape: ReturnType<typeof observeSpriteSilhouette>,
): SpriteActionMotionRepair | undefined {
  if (
    (!input.direction.includes("W") && !input.direction.includes("E")) ||
    phases.some((p) => !p)
  )
    return;
  const n = phases.length;
  const candidates = Array.from({ length: n - 1 }, (_, j) => {
    const shift = j + 1,
      errors = phases.map((p, i) =>
        Math.abs(p!.front - phases[(i + shift) % n]!.hind),
      );
    return {
      shift,
      worst: Math.max(...errors),
      mean: errors.reduce((a, b) => a + b, 0) / n,
    };
  }).sort((a, b) => a.mean - b.mean);
  const strongest = candidates[0];
  if (
    strongest.worst > 0.35 ||
    strongest.mean > 0.17 ||
    candidates[1].mean - strongest.mean < 0.035
  )
    return;
  const bounds = (names: Paw[]) => {
    const regions = names.flatMap((name) =>
      tracks[name]!.map((p) => ({
        x: out.landmarks[name]!.x + p!.x,
        width: out.landmarks[name]!.width,
      })),
    );
    return {
      lo: Math.min(...regions.map((r) => r.x)),
      hi: Math.max(...regions.map((r) => r.x + r.width - 1)),
    };
  };
  const hind = bounds(["hindNear", "hindFar"]),
    fore = bounds(["frontNear", "frontFar"]);
  const backOnLeft = input.direction.includes("E"),
    gap = backOnLeft ? fore.lo - hind.hi : hind.lo - fore.hi;
  if (gap < Math.max(4, shape.height * 0.1)) return;
  const { width, height } = input.standing,
    margin = Math.max(3, Math.round(shape.height * 0.17));
  const mid = Math.round(
    backOnLeft ? (hind.hi + fore.lo) / 2 : (fore.hi + hind.lo) / 2,
  );
  const x = Math.max(
    0,
    backOnLeft ? hind.lo - margin : Math.max(mid, hind.lo - margin),
  );
  const right = Math.min(
    width - 1,
    backOnLeft ? Math.min(mid, hind.hi + margin) : hind.hi + margin,
  );
  const sourceFrames = phases.map((_, i) => (i + strongest.shift) % n);
  const lo = Math.ceil(shape.y + shape.height * 0.28),
    hi = Math.floor(shape.y + shape.height * 0.56);
  const rowChanged = new Uint8Array(height);
  let lastEdge = -1;
  const changed = (f: SpriteWalkRaster, g: SpriteWalkRaster, p: number) =>
    f.data[p + 3] !== g.data[p + 3] ||
    (f.data[p + 3] !== 0 &&
      (f.data[p] !== g.data[p] ||
        f.data[p + 1] !== g.data[p + 1] ||
        f.data[p + 2] !== g.data[p + 2]));
  for (let i = 0; i < n; i++) {
    const f = input.frames[i],
      g = input.frames[sourceFrames[i]];
    for (let yy = lo; yy < height; yy++)
      for (let xx = x; xx <= right; xx++) {
        if (!changed(f, g, 4 * (yy * width + xx))) continue;
        rowChanged[yy] = 1;
        if ((x > 0 && xx - x < 2) || (right < width - 1 && right - xx < 2))
          lastEdge = Math.max(lastEdge, yy);
      }
  }
  if (rowChanged[height - 1]) return;
  let y = hi;
  for (; y >= lo && y > lastEdge; y--) {
    if (rowChanged[y] || rowChanged[y + 1]) continue;
    const attached = input.frames.every((f) => {
      for (let xx = x; xx <= right; xx++) {
        const p = 4 * (y * width + xx);
        if (f.data[p + 3] >= 160 && y > 0 && f.data[p - 4 * width + 3] >= 160)
          return true;
      }
      return false;
    });
    if (attached) break;
  }
  if (y < lo || y <= lastEdge) return;
  const region = { x, y, width: right - x + 1, height: height - y };
  // Every changing painted fragment must connect to an observed hind paw in either pose.
  // A separately moving tail, particle or prop inside this region makes the transfer ambiguous.
  const mask = new Uint8Array(region.width * region.height),
    queue = new Int32Array(mask.length);
  for (let i = 0; i < n; i++) {
    const source = sourceFrames[i];
    let total = 0,
      head = 0,
      tail = 0;
    for (let yy = y; yy < height; yy++)
      for (let xx = x; xx <= right; xx++) {
        const k = (yy - y) * region.width + xx - x;
        mask[k] = Number(
          changed(input.frames[i], input.frames[source], 4 * (yy * width + xx)),
        );
        total += mask[k];
      }
    const enqueue = (k: number) => {
      if (mask[k]) {
        mask[k] = 0;
        queue[tail++] = k;
      }
    };
    for (const name of ["hindNear", "hindFar"] as const)
      for (const frame of [i, source]) {
        const r = out.landmarks[name]!,
          p = tracks[name]![frame]!;
        for (
          let yy = Math.max(y, r.y + p.y - 1);
          yy < Math.min(height, r.y + r.height + p.y + 1);
          yy++
        )
          for (
            let xx = Math.max(x, r.x + p.x - 1);
            xx < Math.min(right + 1, r.x + r.width + p.x + 1);
            xx++
          )
            enqueue((yy - y) * region.width + xx - x);
      }
    while (head < tail) {
      const k = queue[head++],
        cx = k % region.width,
        cy = Math.floor(k / region.width);
      for (
        let yy = Math.max(0, cy - 1);
        yy <= Math.min(region.height - 1, cy + 1);
        yy++
      )
        for (
          let xx = Math.max(0, cx - 1);
          xx <= Math.min(region.width - 1, cx + 1);
          xx++
        )
          enqueue(yy * region.width + xx);
    }
    if (tail !== total) return;
  }
  return { kind: "retime-hindlegs", region, sourceFrames };
}

export function applySpriteActionMotionRepair(
  frames: readonly SpriteWalkRaster[],
  repair: SpriteActionMotionRepair,
): SpriteWalkRaster[] {
  const next = frames.slice();
  if (repair.kind === "swap-adjacent") {
    const [a, b] = repair.frames;
    if (!Number.isInteger(a) || b !== a + 1 || a < 0 || b >= frames.length)
      throw new Error("Invalid measured jump swap.");
    [next[a], next[b]] = [frames[b], frames[a]];
    return next;
  }
  const { region, sourceFrames } = repair,
    { x, y, width, height } = region;
  if (
    !frames.length ||
    sourceFrames.length !== frames.length ||
    new Set(sourceFrames).size !== frames.length ||
    !sourceFrames.every(
      (i) => Number.isSafeInteger(i) && i >= 0 && i < frames.length,
    ) ||
    ![x, y, width, height].every(Number.isSafeInteger) ||
    width <= 0 ||
    height <= 0 ||
    x < 0 ||
    y < 0 ||
    !frames.every(
      (f) =>
        f.width === frames[0].width &&
        f.height === frames[0].height &&
        x + width <= f.width &&
        y + height <= f.height &&
        f.data.length === f.width * f.height * 4,
    )
  )
    throw new Error("Invalid measured hindleg interval.");
  return next.map((f, i) => {
    const data = Uint8Array.from(f.data),
      source = frames[sourceFrames[i]].data;
    for (let yy = y; yy < y + height; yy++) {
      for (let xx = x; xx < x + width; xx++) {
        const at = 4 * (yy * f.width + xx);
        if (data[at + 3] || source[at + 3])
          data.set(source.subarray(at, at + 4), at);
      }
    }
    return { ...f, data };
  });
}

function trotReview(
  input: Input,
  out: SpriteActionMotionReview,
  tracks: Tracks,
  shape: ReturnType<typeof observeSpriteSilhouette>,
  n: number,
) {
  const height = shape.height;
  const add = (
    name: string,
    status: Status,
    reason: string,
    frames: number[] = [],
  ) => out.checks.push({ name, status, reason, frames });
  const values = paws.map((name) => tracks[name]?.map((p) => p?.y));
  if (
    values.some((a) => !a || a.filter((y) => y !== undefined).length < n * 0.7)
  ) {
    add(
      "diagonal support",
      "inconclusive",
      "Trace four distinct paws in the standing reference. An overlapping, hidden or untrackable paw cannot establish diagonal support.",
    );
    return;
  }
  const normalized = values.map((track) => {
    const ys = track!.filter((v): v is number => v !== undefined),
      min = Math.min(...ys),
      range = Math.max(...ys) - min;
    return range >= Math.max(2, height * 0.04)
      ? track!.map((y) => (y === undefined ? null : (y - min) / range))
      : [];
  });
  if (normalized.some((a) => !a.length)) {
    add(
      "diagonal support",
      "inconclusive",
      "The paw trajectories have insufficient distinct lift and support. Check the planted paw in gameplay.",
    );
    return;
  }
  const phases = Array.from({ length: n }, (_, i) => {
    const [fn, ff, hn, hf] = normalized.map((a) => a[i]);
    if (fn === null || ff === null || hn === null || hf === null) return null;
    return { front: fn - ff, hind: hf - hn };
  });
  const first = phases.flatMap((v, i) =>
    v && v.front > 0.55 && v.hind > 0.55 ? [i] : [],
  );
  const second = phases.flatMap((v, i) =>
    v && v.front < -0.55 && v.hind < -0.55 ? [i] : [],
  );
  const conflict = phases.flatMap((v, i) =>
    v &&
    Math.abs(v.front) > 0.65 &&
    Math.abs(v.hind) > 0.65 &&
    v.front * v.hind < 0
      ? [i]
      : [],
  );
  if (conflict.length) {
    if (
      !first.length &&
      !second.length &&
      conflict.some((i) => phases[i]!.front > 0) &&
      conflict.some((i) => phases[i]!.front < 0)
    ) {
      out.repair = hindlegRepair(input, out, tracks, phases, shape);
    }
    add(
      "diagonal support",
      conflict.length >= 2 ? "fail" : "inconclusive",
      "Fore and hind support disagree at the indicated contacts. Inspect the near foreleg against the far hindleg, and the other diagonal pair.",
      conflict,
    );
    return;
  }
  if (!first.length || !second.length) {
    add(
      "diagonal support",
      "inconclusive",
      "The visible paws do not show both opposite diagonal supports.",
    );
    return;
  }
  const strongest = (indices: number[]) =>
    indices.reduce((a, b) =>
      Math.abs(phases[b]!.front + phases[b]!.hind) >
      Math.abs(phases[a]!.front + phases[a]!.hind)
        ? b
        : a,
    );
  const a = strongest(first),
    b = strongest(second);
  out.keyframes.push(
    { phase: "near fore / far hind support", frame: a },
    { phase: "far fore / near hind support", frame: b },
  );
  for (const [start, end] of [
    [a, b],
    [b, a],
  ]) {
    const between: number[] = [];
    for (let i = (start + 1) % n; i !== end; i = (i + 1) % n)
      if (
        phases[i] &&
        Math.abs(phases[i]!.front) < 0.65 &&
        Math.abs(phases[i]!.hind) < 0.65
      )
        between.push(i);
    if (!between.length) {
      add(
        "weight transfer",
        "inconclusive",
        "The transfer between diagonal contacts is occluded or lacks an observed passing pose.",
        [start, end],
      );
      return;
    }
    out.keyframes.push({
      phase: "weight transfer",
      frame: between[Math.floor(between.length / 2)],
    });
  }
  add(
    "diagonal support",
    "pass",
    "The two visible diagonal pairs alternate through both support and transfer poses.",
    [a, b],
  );
  if (input.direction.includes("E") || input.direction.includes("W")) {
    const moving = paws.every((name) => {
      const xs = tracks[name]!.flatMap((p, i) =>
        p && tracks.body?.[i] ? [p.x - tracks.body[i]!.x] : [],
      );
      return (
        xs.length >= n * 0.7 &&
        Math.max(...xs) - Math.min(...xs) >= Math.max(2, height * 0.035)
      );
    });
    add(
      "paw travel",
      moving ? "pass" : "inconclusive",
      moving
        ? "Each visible paw also travels fore and aft relative to the trunk. Confirm planted-paw slip against world motion in gameplay."
        : "A sustained body-relative fore/aft stride is not measurable on all four visible paws.",
      [a, b],
    );
  }
}

function jumpReview(
  out: SpriteActionMotionReview,
  tracks: Tracks,
  height: number,
  n: number,
  profile: boolean,
) {
  const add = (
    name: string,
    status: Status,
    reason: string,
    frames: number[] = [],
  ) => out.checks.push({ name, status, reason, frames });
  const feet = [tracks.leftFoot, tracks.rightFoot].filter(
    (p): p is NonNullable<typeof p> => !!p,
  );
  if (!tracks.body || feet.length < (profile ? 1 : 2)) {
    add(
      "jump contacts",
      "inconclusive",
      "Locate the torso and visible soles. Occluded soles require a visual inspection.",
    );
    return;
  }
  const points = Array.from({ length: n }, (_, i) => {
    const body = tracks.body![i],
      ys = feet.map((t) => t[i]?.y);
    if (!body || ys.some((y) => y === undefined)) return null;
    const sole = ys as number[];
    return {
      body: body.y,
      low: Math.max(...sole),
      high: Math.min(...sole),
      separated: body.y - Math.max(...sole),
    };
  });
  const tol = Math.max(1, Math.round(height * 0.025)),
    gap = Math.max(3, Math.round(height * 0.06));
  const ground = (i: number) => !!points[i] && Math.abs(points[i]!.low) <= tol;
  const airborne = (i: number) =>
    !!points[i] && points[i]!.low <= -gap && points[i]!.body <= -gap;
  const flight = points.flatMap((_, i) => (airborne(i) ? [i] : []));
  if (!flight.length) {
    add(
      "jump contacts",
      "inconclusive",
      "No airborne torso and sole clearance are measurable in these sprite coordinates. Verify engine-applied elevation in gameplay.",
    );
    return;
  }
  const takeoff = flight[0],
    apex = flight.reduce((a, b) =>
      points[a]!.body <= points[b]!.body ? a : b,
    );
  if (points.some((_, i) => i > takeoff && i < flight.at(-1)! && ground(i))) {
    add(
      "jump contacts",
      "inconclusive",
      "The clip shows multiple flights separated by a planted pose. Inspect each jump and rebound separately.",
      flight,
    );
    return;
  }
  const launch = points.findLastIndex((_, i) => i < takeoff && ground(i)),
    land = points.findIndex((_, i) => i > apex && ground(i));
  out.keyframes.push(
    { phase: "first airborne", frame: takeoff },
    { phase: "apex", frame: apex },
  );
  if (launch < 0 || land < 0) {
    add(
      "jump contacts",
      "inconclusive",
      "The clip does not show both an observed ground contact before takeoff and one after the apex.",
      flight,
    );
    return;
  }
  out.keyframes.push(
    { phase: "last contact before takeoff", frame: launch },
    { phase: "first landing", frame: land },
  );
  add(
    "jump contacts",
    "pass",
    "Measured grounded takeoff, airborne clearance and return to a supporting sole.",
    [launch, takeoff, apex, land],
  );
  const grounded = points.flatMap((p, i) => (p && ground(i) ? [i] : []));
  const compressed = (indices: number[]) =>
    indices.reduce((a, b) =>
      points[b]!.separated > points[a]!.separated ? b : a,
    );
  const crouch = compressed(grounded.filter((i) => i <= launch)),
    landingCompression = compressed(grounded.filter((i) => i >= land));
  const settled = points.findLastIndex(
    (p, i) =>
      i >= landingCompression &&
      ground(i) &&
      p !== null &&
      Math.abs(p.high) <= tol &&
      Math.abs(p.separated) <= tol,
  );
  if (points[crouch]!.separated >= tol + 1)
    out.keyframes.push({ phase: "anticipation", frame: crouch });
  if (points[landingCompression]!.separated >= tol + 1)
    out.keyframes.push({
      phase: "landing compression",
      frame: landingCompression,
    });
  if (settled >= 0) out.keyframes.push({ phase: "settled", frame: settled });
  const cushions =
    points[crouch]!.separated >= tol + 1 &&
    points[landingCompression]!.separated >= tol + 1 &&
    settled > landingCompression;
  add(
    "crouch and recovery",
    cushions ? "pass" : "inconclusive",
    cushions
      ? "The torso lowers over a supporting sole before takeoff and settles after landing."
      : "The sprite does not establish both anticipation and landing recovery. Inspect the joint poses and runtime elevation.",
    [crouch, landingCompression],
  );
  const signals = [tracks.body, ...feet];
  const reversals: number[] = [];
  for (let i = takeoff + 1; i + 1 < land; i++) {
    if (!points[i] || !points[i - 1]) continue;
    if (
      signals.every((t) => {
        const a = t[i - 1],
          b = t[i];
        return a && b && (i <= apex ? 1 : -1) * (b.y - a.y) > Math.min(2, tol);
      })
    )
      reversals.push(i);
  }
  if (reversals.length === 1) {
    const i = reversals[0] - 1;
    // Only swap an isolated reversed interval, bracketed on both sides by the same measured
    // direction of travel in every independent landmark. Never re-time an apex or a landing.
    if (
      i - 2 >= 0 &&
      i + 3 < n &&
      [i - 1, i, i + 1, i + 2].every(airborne) &&
      (i + 2 < apex || i - 1 > apex) &&
      signals.every((track) => {
        const samples = track.slice(i - 2, i + 4);
        if (samples.some((p) => !p)) return false;
        const ascending = i < apex,
          [a, b, c, d, e, f] = samples.map((p) => p!.y * (ascending ? -1 : 1));
        return a < b && b < d && d < c && c < e && e < f;
      })
    )
      out.repair = { kind: "swap-adjacent", frames: [i, i + 1] };
  }
  if (reversals.length)
    add(
      "flight order",
      "fail",
      "The tracked torso and soles reverse vertical travel inside a single flight before reaching its turn. Review the neighbouring poses.",
      reversals,
    );
  else if (points.slice(launch, land + 1).some((p) => !p))
    add(
      "flight order",
      "inconclusive",
      "Some flight poses are occluded or cannot be matched to the reference.",
    );
  else
    add(
      "flight order",
      "pass",
      "The tracked body and feet progress into the apex and return to contact.",
      [takeoff, apex, land],
    );
}

export function inspectSpriteActionMotion(
  input: Input,
): SpriteActionMotionReview {
  const { standing, frames, bodyPlan, action } = input;
  const out: SpriteActionMotionReview = {
    status: "inconclusive",
    checks: [],
    keyframes: [],
    landmarks: {},
  };
  const trot = bodyPlan === "quadruped" && action === "trot",
    jump = bodyPlan === "biped" && action === "jump";
  if (!trot && !jump) {
    out.checks.push({
      name: "action evidence",
      status: "inconclusive",
      reason:
        "Inspect the visible anatomy at the action-specific contacts and extrema. This action has no calibrated motion measurement.",
      frames: [],
    });
    return out;
  }
  if (
    frames.length < 4 ||
    frames.length > 128 ||
    standing.width * standing.height * frames.length > RASTER_PIXELS ||
    ![standing, ...frames].every(
      (r) =>
        Number.isSafeInteger(r.width) &&
        r.width > 0 &&
        Number.isSafeInteger(r.height) &&
        r.height > 0 &&
        r.width === standing.width &&
        r.height === standing.height &&
        r.data.length === 4 * r.width * r.height,
    )
  ) {
    out.checks.push({
      name: "frame evidence",
      status: "inconclusive",
      reason: "Use aligned bounded RGBA frames and a standing reference.",
      frames: [],
    });
    return out;
  }
  const shape = observeSpriteSilhouette(standing);
  if (shape.width < 3 || shape.height < 3) {
    out.checks.push({
      name: "standing evidence",
      status: "inconclusive",
      reason: "The reference contains insufficient visible anatomy.",
      frames: [],
    });
    return out;
  }
  out.landmarks = propose(input, shape, trot);
  const regions = Object.entries(out.landmarks) as [
    keyof SpriteActionLandmarks,
    SpriteWalkRect,
  ][];
  const overlap = regions.some(([name, a], i) =>
    regions
      .slice(i + 1)
      .some(
        ([other, b]) =>
          name !== other &&
          Math.max(
            0,
            Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
          ) *
            Math.max(
              0,
              Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
            ) >
            0,
      ),
  );
  if (overlap) {
    out.checks.push({
      name: "standing evidence",
      status: "inconclusive",
      reason: "Separate overlapping anatomical landmark rectangles.",
      frames: [],
    });
    return out;
  }
  const tracks: Tracks = {};
  const radius = trackingRadius(shape.height, jump);
  for (const [name, area] of regions)
    tracks[name] = trackSpriteWalkLandmark(standing, frames, area, radius);
  if (trot) trotReview(input, out, tracks, shape, frames.length);
  else
    jumpReview(
      out,
      tracks,
      shape.height,
      frames.length,
      input.direction === "E" || input.direction === "W",
    );
  out.status = out.checks.some((c) => c.status === "fail")
    ? "fail"
    : out.checks.every((c) => c.status === "pass")
      ? "pass"
      : "inconclusive";
  return out;
}
