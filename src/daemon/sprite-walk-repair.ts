import { inspectSpriteWalkSeams } from "./sprite-walk-alpha.js";
import { inspectSpriteWalkTopology } from "./sprite-walk-topology.js";
import type { CharacterViewDirection } from "../shared/character-views.js";
import {
  trackSpriteWalkLandmark,
  inspectSpriteWalkGait,
  type SpriteWalkLandmarks,
  type SpriteWalkRaster,
  type SpriteWalkRect,
} from "./sprite-walk-gait.js";
import { RASTER_PIXELS } from "./raster-policy.js";

type Rgb = readonly [number, number, number];
type Side = NonNullable<SpriteWalkLandmarks["left"]>;

function palette(source: SpriteWalkRaster, box: SpriteWalkRect) {
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) ||
    box.x < 0 ||
    box.y < 0 ||
    box.width < 2 ||
    box.height < 2 ||
    box.x + box.width > source.width ||
    box.y + box.height > source.height
  )
    throw new Error("Choose a visible landmark inside the standing reference.");
  const colors: Rgb[] = [];
  for (let y = box.y; y < box.y + box.height; y += Math.ceil(box.height / 6)) {
    for (let x = box.x; x < box.x + box.width; x += Math.ceil(box.width / 6)) {
      const p = 4 * (y * source.width + x);
      if (source.data[p + 3] >= 160) colors.push([source.data[p], source.data[p + 1], source.data[p + 2]]);
    }
  }
  if (colors.length < 3) throw new Error("The landmark does not expose enough original texture.");
  return colors;
}

function chroma(rgb: ArrayLike<number>) {
  const sum = Math.max(1, rgb[0] + rgb[1] + rgb[2]);
  return [rgb[0] / sum, rgb[1] / sum];
}

function medianColor(points: Rgb[]) {
  if (!points.length) throw new Error("The landmarks do not identify visible painted fabric.");
  return [0, 1, 2].map((i) => points.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(points.length / 2)]);
}

function dimensions(side: Side) {
  const center = (r: SpriteWalkRect) => ({ x: r.x + (r.width - 1) / 2, y: r.y + (r.height - 1) / 2 });
  const hand = center(side.hand),
    foot = center(side.foot);
  return { hand, foot, reach: foot.y - hand.y };
}

function legMask(sprite: SpriteWalkRaster, leg: number[], glove: number[], yHand: number, reach: number) {
  const { width, height, data } = sprite;
  const labels = new Int8Array(width * height),
    distance = new Int32Array(width * height).fill(0x7fffffff),
    queue: number[][] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = y * width + x,
        p = k * 4;
      if (data[p + 3] < 8) continue;
      let label = 0,
        strength = 0;
      if (y > yHand + reach * 0.36) label = 1;
      else if (y < yHand - reach * 0.47) label = -1;
      else {
        const [r, g] = chroma(data.subarray(p, p + 3)),
          dl = Math.hypot(r - leg[0], g - leg[1]),
          da = Math.hypot(r - glove[0], g - glove[1]);
        const sum = data[p] + data[p + 1] + data[p + 2];
        if (sum > 60 && Math.abs(dl - da) > 0.011) {
          label = dl < da ? 1 : -1;
          strength = sum < 110 ? 4 : 0;
        }
      }
      if (label) {
        labels[k] = label;
        distance[k] = strength;
        (queue[strength] ??= []).push(k);
      }
    }
  for (let d = 0; d < queue.length; d++)
    for (const k of queue[d] ?? []) {
      if (distance[k] !== d) continue;
      for (const shift of [-1, 1, -width, width]) {
        const j = k + shift;
        if (
          j < 0 ||
          j >= labels.length ||
          (shift === -1 && k % width === 0) ||
          (shift === 1 && j % width === 0) ||
          data[4 * j + 3] < 2
        )
          continue;
        const e = d + 1 + (data[4 * j + 3] < 80 ? 1 : 0);
        if (distance[j] <= e) continue;
        distance[j] = e;
        labels[j] = labels[k];
        (queue[e] ??= []).push(j);
      }
    }
  return labels;
}

// Retain the natural contour. Only bridge a measured interior break where the reference
// and the visible banks on both sides give coverage evidence.
function bridgeInterior(standing: SpriteWalkRaster, frames: SpriteWalkRaster[]) {
  const { width, height } = standing;
  const limit = Math.max(2, Math.min(5, Math.ceil(height / 50)));
  for (const seam of inspectSpriteWalkSeams(standing, frames)) {
    const out = frames[seam.frame].data;
    const dx = seam.axis === "vertical" ? 0 : 1,
      dy = seam.axis === "horizontal" ? 0 : seam.axis === "up-right" ? -1 : 1;
    for (let i = 0; i < seam.length; i++) {
      const x = seam.x + i * dx,
        y = seam.y + i * dy,
        p = 4 * (y * width + x);
      if (standing.data[p + 3] < 128 || out[p + 3] > 64) continue;
      const bank = (side: number) => {
        for (let n = 1; n <= limit; n++) {
          const xx = x - side * n * dy,
            yy = y + side * n * dx;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) break;
          const at = 4 * (yy * width + xx);
          if (out[at + 3] >= 160) return { at, n };
        }
      };
      const a = bank(-1),
        b = bank(1);
      if (!a || !b) continue;
      const t = a.n / (a.n + b.n);
      for (let c = 0; c < 4; c++) out[p + c] = Math.round(out[a.at + c] * (1 - t) + out[b.at + c] * t);
    }
  }
}

// A moving glove may have occupied the same scanlines as the opposite thigh. Remove only
// detached remnants that still use old-frame pixels and were connected to that original glove.
function clearFormerWrist(
  frame: SpriteWalkRaster,
  pixels: Uint8Array,
  painted: Uint8Array,
  rect: SpriteWalkRect,
  shift: { x: number; y: number } | null,
  reach: number,
) {
  if (!shift) return;
  const { width, height, data } = frame;
  const hx = rect.x + shift.x + (rect.width - 1) / 2,
    hy = rect.y + shift.y + (rect.height - 1) / 2;
  const margin = Math.ceil(reach * 0.63);
  const left = Math.max(0, Math.floor(hx - margin)),
    right = Math.min(width - 1, Math.ceil(hx + margin));
  const top = Math.max(0, Math.floor(hy - margin)),
    bottom = Math.min(height - 1, Math.ceil(hy + margin));
  const span = right - left + 1,
    size = span * (bottom - top + 1);
  const oldGlove = new Uint8Array(size),
    seen = new Uint8Array(size);
  const pixel = (q: number) => (top + Math.floor(q / span)) * width + left + (q % span);
  function neighbors(q: number, visit: (next: number) => void) {
    const x = q % span,
      y = Math.floor(q / span);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if ((dx || dy) && xx >= 0 && xx < span && yy >= 0 && q + (dy * span + dx) < size) visit(q + dy * span + dx);
      }
  }
  const attached: number[] = [];
  for (let y = rect.y + shift.y; y < rect.y + shift.y + rect.height; y++)
    for (let x = rect.x + shift.x; x < rect.x + shift.x + rect.width; x++) {
      if (x < left || x > right || y < top || y > bottom) continue;
      const q = (y - top) * span + x - left;
      if (data[pixel(q) * 4 + 3] >= 80) {
        oldGlove[q] = 1;
        attached.push(q);
      }
    }
  for (let i = 0; i < attached.length; i++)
    neighbors(attached[i], (q) => {
      if (!oldGlove[q] && data[4 * pixel(q) + 3] >= 64) {
        oldGlove[q] = 1;
        attached.push(q);
      }
    });
  for (let seed = 0; seed < size; seed++) {
    if (seen[seed] || pixels[4 * pixel(seed) + 3] < 80) continue;
    const group = [seed];
    seen[seed] = 1;
    let orphan = true;
    for (let i = 0; i < group.length; i++) {
      const q = group[i],
        k = pixel(q),
        x = q % span,
        y = Math.floor(q / span);
      if (
        !x ||
        x === span - 1 ||
        !y ||
        y === bottom - top ||
        !oldGlove[q] ||
        painted[k] >= 64 ||
        data[4 * k + 3] < 64 ||
        [0, 1, 2].some((channel) => Math.abs(data[4 * k + channel] - pixels[4 * k + channel]) > 6)
      )
        orphan = false;
      neighbors(q, (n) => {
        if (!seen[n] && pixels[4 * pixel(n) + 3] >= 80) {
          seen[n] = 1;
          group.push(n);
        }
      });
    }
    if (!orphan || group.length > Math.max(5, rect.width * rect.height)) continue;
    for (const q of group) {
      const k = pixel(q);
      pixels.fill(0, k * 4, k * 4 + 4);
      neighbors(q, (n) => {
        const near = pixel(n);
        if (pixels[4 * near + 3] < 80 && painted[near] < 12) pixels.fill(0, 4 * near, 4 * near + 4);
      });
    }
  }
}

function ease(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function samplePaint(
  source: SpriteWalkRaster,
  x: number,
  y: number,
  mask: Int8Array,
  pelvis: (x: number, y: number) => boolean,
  rgba: Uint8Array,
) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  let a = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i,
        yy = y0 + j;
      if (xx < 0 || yy < 0 || xx >= source.width || yy >= source.height) continue;
      const k = yy * source.width + xx,
        p = 4 * k;
      if (mask[k] === 1 && !pelvis(xx, yy)) continue;
      const w = (i ? x - x0 : 1 - (x - x0)) * (j ? y - y0 : 1 - (y - y0)) * source.data[p + 3];
      a += w;
      r += w * source.data[p];
      g += w * source.data[p + 1];
      b += w * source.data[p + 2];
    }
  rgba[0] = a ? Math.round(r / a) : 0;
  rgba[1] = a ? Math.round(g / a) : 0;
  rgba[2] = a ? Math.round(b / a) : 0;
  rgba[3] = Math.round(a);
}

function over(target: Uint8Array, p: number, src: Uint8Array) {
  if (!src[3]) return;
  if (src[3] === 255 || !target[p + 3]) {
    target.set(src, p);
    return;
  }
  const behind = (1 - src[3] / 255) * target[p + 3],
    alpha = src[3] + behind;
  for (let i = 0; i < 3; i++) target[p + i] = Math.round((src[i] * src[3] + target[p + i] * behind) / alpha);
  target[p + 3] = Math.round(alpha);
}

type WalkRepairInput = {
  standing: SpriteWalkRaster;
  direction: CharacterViewDirection;
  landmarks: SpriteWalkLandmarks;
  frames: readonly SpriteWalkRaster[];
  contacts?: readonly [number, number];
  signal?: AbortSignal;
};

function rebuildDirection(input: WalkRepairInput) {
  const { standing, direction, landmarks, frames } = input;
  const { width, height } = standing;
  if (
    ![width, height].every((v) => Number.isSafeInteger(v) && v > 0) ||
    frames.length < 4 ||
    frames.length > 128 ||
    frames.length * width * height > RASTER_PIXELS ||
    width * height * 4 !== standing.data.length ||
    frames.some((f) => f.width !== width || f.height !== height || f.data.length !== standing.data.length)
  )
    throw new Error("Use aligned, bounded RGBA standing and movement frames.");
  const gait = inspectSpriteWalkGait(input);
  if (!landmarks.left || !landmarks.right)
    throw new Error(
      "Locate both visible hands and boots to reconstruct their overlap. Occluded geometry needs redrawing.",
    );
  const left = dimensions(landmarks.left),
    right = dimensions(landmarks.right);
  const reach = Math.min(left.reach, right.reach),
    yHand = (left.hand.y + right.hand.y) / 2;
  const center = (left.foot.x + right.foot.x) / 2,
    widthHips = Math.abs(left.foot.x - right.foot.x);
  if (reach < 6 || widthHips < reach * 0.45)
    throw new Error("The standing legs overlap too much for a two-sided cutout repair.");
  const gloveColor = chroma(
    medianColor([...palette(standing, landmarks.left.hand), ...palette(standing, landmarks.right.hand)]),
  );
  const fabric: Rgb[] = [];
  for (const side of [left, right]) {
    const x = Math.round(center * 0.3 + side.foot.x * 0.7),
      y = Math.round(side.hand.y + 0.4 * side.reach);
    fabric.push(...palette(standing, { x: x - 2, y: y - 2, width: 5, height: 5 }));
  }
  const leg = chroma(medianColor(fabric));
  if (Math.hypot(leg[0] - gloveColor[0], leg[1] - gloveColor[1]) < 0.038)
    throw new Error(
      "The glove and trousers cannot be separated by their painted materials. Redraw using occlusion layers.",
    );
  const boots = (["left", "right"] as const)
    .map((name) => {
      const pair = landmarks[name]!,
        foot = name === "left" ? left.foot : right.foot;
      const color = chroma(medianColor(palette(standing, pair.foot)));
      const top = Math.max(0, Math.floor(foot.y - reach * 0.47)),
        first = Math.max(0, Math.floor(foot.x - reach * 0.49));
      let soleTop = foot.y;
      for (let y = top; y <= foot.y; y++) {
        let run = 0;
        for (let x = first; x <= Math.min(width - 1, foot.x + reach * 0.49); x++) {
          const p = 4 * (y * width + x),
            [r, g] = chroma(standing.data.subarray(p, p + 3));
          const ink =
            standing.data[p + 3] >= 150 &&
            Math.hypot(r - color[0], g - color[1]) < Math.hypot(r - leg[0], g - leg[1]) * 0.7;
          run = ink ? run + 1 : 0;
          if (run >= Math.max(3, reach * 0.15)) {
            soleTop = y;
            break;
          }
        }
        if (soleTop === y) break;
      }
      return {
        name,
        foot,
        top: soleTop,
        hand: pair.hand,
        handTrack: trackSpriteWalkLandmark(standing, frames, pair.hand, Math.ceil(Math.min(64, reach * 0.66))),
        track: trackSpriteWalkLandmark(standing, frames, pair.foot, Math.ceil(Math.min(64, reach * 0.84))),
      };
    })
    .sort((a, b) => a.foot.x - b.foot.x);
  const refMask = legMask(standing, leg, gloveColor, yHand, reach);
  const upperLimit = Math.max(0, Math.floor(yHand - 1.25 * reach));
  const lowerLimit = Math.min(height - 1, Math.ceil(Math.max(left.hand.y, right.hand.y) + 0.9 * reach));
  const pelvis = (x: number, y: number) => {
    const limit = widthHips * 0.9 * (1 - ease(yHand + reach * 0.05, yHand + reach * 0.45, y));
    return y < yHand + reach * 0.45 && Math.abs(x - center) < limit;
  };
  const dx = Number(direction.includes("E")) - Number(direction.includes("W")),
    dy = Number(direction.includes("S")) - Number(direction.includes("N"));
  const norm = Math.hypot(dx, dy);
  const contact = gait.contacts[0],
    range = frames.length;
  const footLead = (side: "left" | "right") => {
    const a = gait.sides[side]?.foot[contact];
    const b = gait.sides[side]?.foot[gait.contacts[1]];
    return a == null || b == null ? undefined : a > b;
  };
  const halfCycle = (gait.contacts[1] - contact + range) % range;
  if (Math.abs(halfCycle - range / 2) > 0.5)
    throw new Error("For unequal steps redraw the arm poses using their actual contact times.");
  const leftLeads = footLead("left"),
    rightLeads = footLead("right");
  if (leftLeads !== undefined && leftLeads === rightLeads)
    throw new Error("The two feet move together. Redraw the leg poses before repairing the arms.");
  const leads = leftLeads ?? (rightLeads === undefined ? undefined : !rightLeads);
  if (leads === undefined)
    throw new Error("Neither supporting foot can be identified from the original contact pixels.");
  const ext = Object.values(gait.sides).flatMap((s) => s?.foot.filter((v): v is number => v !== null) ?? []);
  const amplitude = Math.min(reach * 0.18, (Math.max(...ext) - Math.min(...ext)) * 0.2);
  const stamp = new Uint8Array(4);
  const repaired = frames.map((frame, i) => {
    input.signal?.throwIfAborted();
    const data = new Uint8Array(frame.data),
      painted = new Uint8Array(width * height),
      chosen = legMask(frame, leg, gloveColor, yHand, reach);
    const u = ((i - contact + range) % range) / range;
    const swing = Math.cos(2 * Math.PI * u) * amplitude * (leads ? -1 : 1);
    // Use the actual frame's crown position to preserve the body bounce and exact atlas timing.
    const top = (r: SpriteWalkRaster) => {
      for (let k = 0; k < width * height; k++) if (r.data[4 * k + 3] >= 190) return Math.floor(k / width);
      return 0;
    };
    const bob = top(frame) - top(standing);
    // Reconstruct the outer trouser overlap between the stable waistband and the intact
    // moving thigh. Formerly occluded edge ink is sampled from the corresponding standing hip.
    const start = Math.round(yHand),
      end = Math.min(height - 1, Math.round(yHand + reach * 0.88));
    const spanAt = (labels: Int8Array, sprite: SpriteWalkRaster, y: number) => {
      let lo = width,
        hi = -1;
      for (let x = 0; x < width; x++)
        if (labels[y * width + x] === 1 && sprite.data[(y * width + x) * 4 + 3] >= 128) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      return [lo, hi];
    };
    const hips = spanAt(refMask, standing, start - bob);
    const ends = boots.map((boot) => {
      const tracked = boot.track[i];
      // Without a reliable two-dimensional track, stay above the largest plausible rise of
      // that shoe. Never interpolate the outline to a row that shows only the other leg.
      const shoeTop = boot.top + (tracked?.y ?? -reach * 0.5);
      return Math.min(end, Math.floor(shoeTop) - 2);
    });
    const thighs = ends.map((at, side) => spanAt(chosen, frame, Math.max(0, at))[side]);
    for (let y = upperLimit; y <= lowerLimit; y++) {
      const edge = spanAt(refMask, standing, Math.max(0, y - bob));
      // A hand can brush the trouser seam. A small gap here has a known continuation at each end.
      const outline = hips.map((hip, side) => {
        const t = Math.max(0, Math.min(1, (y - start) / Math.max(1, ends[side] - start)));
        return hip + t * (thighs[side] - hip);
      });
      for (let x = 0; x < width; x++) {
        const k = y * width + x,
          p = k * 4;
        if (chosen[k] !== 1 || y < yHand - reach * 0.37) data.fill(0, p, p + 4);
        if (
          dx !== 0 &&
          y >= start &&
          y < ends[x < center ? 0 : 1] &&
          hips[0] < hips[1] &&
          thighs[0] < thighs[1] &&
          edge[0] < edge[1]
        ) {
          const outside = x < Math.floor(outline[0]) || x > Math.ceil(outline[1]);
          if (outside) data.fill(0, p, p + 4);
          else {
            const side = x < center ? 0 : 1,
              away = side ? outline[1] - x : x - outline[0];
            if (away <= reach * 0.32 && (!data[p + 3] || away < 2.5)) {
              const xx = Math.max(0, Math.min(width - 1, Math.round(edge[side] + (side ? -1 : 1) * away)));
              const kk = Math.max(0, y - bob) * width + xx;
              if (refMask[kk] === 1) data.set(standing.data.subarray(4 * kk, 4 * kk + 4), p);
            }
          }
        }
        let xx = x,
          yy = y - bob;
        // Invert only the small arm sway. Distal legs and boots are never warped or resampled.
        for (let step = 0; step < 3; step++) {
          const weight = (side: typeof left) =>
            (1 - ease(reach * 0.19, reach * 0.73, Math.abs(xx - side.hand.x))) *
            ease(side.hand.y - reach * 0.95, side.hand.y - reach * 0.23, yy);
          const offset = swing * (weight(left) - weight(right));
          xx = x - (dx / norm) * offset;
          yy = y - bob - (dy / norm) * offset;
        }
        samplePaint(standing, xx, yy, refMask, pelvis, stamp);
        painted[k] = stamp[3];
        over(data, p, stamp);
      }
    }
    for (const arm of boots) clearFormerWrist(frame, data, painted, arm.hand, arm.handTrack[i], reach);
    return { ...frame, data };
  });
  bridgeInterior(standing, repaired);
  return repaired;
}

// A tracked patch may sit at the very top of a glove. If that splits the wrist from its
// moving trousers, sample the same painted glove a little nearer its fingers.
// Compare candidate pixels against the fixed, independently measured input landmarks.
export function repairSpriteWalkDirection(input: WalkRepairInput) {
  const original = rebuildDirection(input);
  const sound = (frames: SpriteWalkRaster[]) =>
    !inspectSpriteWalkSeams(input.standing, frames).length &&
    !inspectSpriteWalkTopology(input.standing, frames, input.frames).length &&
    inspectSpriteWalkGait({ ...input, frames }).status === "pass";
  if (sound(original)) return original;
  const { standing, landmarks, frames } = input;
  const samples = [0, 1, 2, 3].map(phase => frames[Math.floor(phase * frames.length / 4)]);
  const distal = (side: Side, fraction: number) => {
    const rect = side.hand;
    const reach = dimensions(side).reach;
    const shift = Math.max(1, Math.round(Math.min(reach * fraction, rect.height * 0.75)));
    const next = { ...rect, y: rect.y + shift };
    if (next.y + rect.height > standing.height) return;
    const radius = Math.min(64, Math.ceil(reach * 0.66));
    const originalTrack = trackSpriteWalkLandmark(standing, samples, rect, radius);
    const newTrack = trackSpriteWalkLandmark(standing, samples, next, radius);
    // A cuff can hide part of the glove at one contact. Require consistent motion in at least two visible poses.
    const matches = newTrack.flatMap((point, i) => point && originalTrack[i] ? [{ point, prior: originalTrack[i]! }] : []);
    if (matches.length < 2 || matches.some(({ point, prior }) =>
      Math.hypot(point.x - prior.x, point.y - prior.y) > Math.max(2, shift * 0.5))) return;
    return { ...side, hand: next };
  };
  for (const fraction of [0.14, 0.08]) {
    input.signal?.throwIfAborted();
    const left = distal(landmarks.left!, fraction), right = distal(landmarks.right!, fraction);
    if (!left && !right) continue;
    const refined = { ...landmarks, left: left ?? landmarks.left, right: right ?? landmarks.right };
    let candidate;
    try {
      candidate = rebuildDirection({ ...input, landmarks: refined });
    } catch {
      input.signal?.throwIfAborted();
      continue;
    }
    if (sound(candidate)) return candidate;
  }
  return original;
}
