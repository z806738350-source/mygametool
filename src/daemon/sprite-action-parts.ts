import {
  trackSpriteWalkLandmark,
  type SpriteWalkRaster,
  type SpriteWalkRect,
} from "./sprite-walk-gait.js";
import { RASTER_PIXELS } from "./raster-policy.js";

export function observeSpriteSilhouette(r: SpriteWalkRaster) {
  const soles = new Int32Array(r.width).fill(-1);
  let x0 = r.width,
    y0 = r.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      if (r.data[4 * (y * r.width + x) + 3] < 152) continue;
      soles[x] = y;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { soles, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// Phase-independent selection: among spatially separated textured patches, prefer one that
// relocates uniquely in the original reference and across sampled poses. Repeated stripes fail.
export function selectSpriteActionPatch(
  reference: SpriteWalkRaster,
  area: SpriteWalkRect,
  samples: readonly SpriteWalkRaster[],
  radius: number,
) {
  const base = Math.max(
    3,
    Math.round(Math.min(reference.width, reference.height) / 18),
  );
  const cell = Math.max(3, Math.ceil(Math.max(area.width, area.height) / 4));
  const step = Math.max(1, Math.ceil(Math.max(area.width, area.height) / 22));
  const candidates = [];
  for (const size of new Set([
    Math.min(7, base, area.width, area.height),
    Math.min(11, base + 4, area.width, area.height),
  ])) {
    const byLocation = new Map<
      number,
      { rect: SpriteWalkRect; score: number }
    >();
    for (let y = area.y; y <= area.y + area.height - size; y += step)
      for (let x = area.x; x <= area.x + area.width - size; x += step) {
        let count = 0,
          low = 765,
          high = 0;
        for (let yy = y; yy < y + size; yy++)
          for (let xx = x; xx < x + size; xx++) {
            const k = 4 * (yy * reference.width + xx);
            if (reference.data[k + 3] < 160) continue;
            count++;
            const light =
              reference.data[k] + reference.data[k + 1] + reference.data[k + 2];
            low = Math.min(low, light);
            high = Math.max(high, light);
          }
        if (count < Math.max(6, 0.75 * size * size) || high - low < 9) continue;
        const score = ((high - low) * count) / (size * size),
          bucket =
            Math.floor((x - area.x) / cell) +
            8 * Math.floor((y - area.y) / cell);
        if (score > (byLocation.get(bucket)?.score ?? 0))
          byLocation.set(bucket, {
            rect: { x, y, width: size, height: size },
            score,
          });
      }
    candidates.push(...byLocation.values());
  }
  candidates.sort((a, b) => b.score - a.score);
  let best: SpriteWalkRect | undefined,
    coverage = 0;
  for (const { rect } of candidates) {
    const [identity] = trackSpriteWalkLandmark(
      reference,
      [reference],
      rect,
      radius,
    );
    if (!identity || identity.x !== 0 || identity.y !== 0) continue;
    const found = trackSpriteWalkLandmark(
      reference,
      samples,
      rect,
      radius,
    ).filter(Boolean).length;
    if (found > coverage) {
      best = rect;
      coverage = found;
    }
    if (found === samples.length) break;
  }
  return best;
}

export interface SpriteActionPart {
  name: string;
  region: SpriteWalkRect;
  anchor?: SpriteWalkRect;
}

export interface SpriteActionPartObservation extends SpriteActionPart {
  status: "tracked" | "inconclusive";
  reason: string;
  keyframes: { phase: string; frame: number }[];
}

function intersects(a: SpriteWalkRect, b: SpriteWalkRect) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

type Observed = { frame: number; x: number; y: number };
function phaseExtrema(points: Observed[], reach: number) {
  const radial = points.map((p) => Math.hypot(p.x, p.y)),
    xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const span = (a: number[]) => Math.max(...a) - Math.min(...a);
  const travel = Math.max(span(xs), span(ys));
  if (travel < reach) return [];
  const radiusMatters = span(radial) >= Math.max(reach, travel * 0.5);
  const horizontal = span(xs) >= span(ys);
  const signal = radiusMatters ? radial : horizontal ? xs : ys;
  const [low, high] = radiusMatters
    ? ["retracted", "extended"]
    : horizontal
      ? ["leftmost", "rightmost"]
      : ["highest", "lowest"];
  const keyframes = [
    { phase: low, frame: points[signal.indexOf(Math.min(...signal))].frame },
    { phase: high, frame: points[signal.indexOf(Math.max(...signal))].frame },
  ];
  // A reversal needs a measured change on both sides. Never join across an occlusion.
  let extreme = 0,
    trend = 0;
  const reversal = Math.max(1.5, span(signal) * 0.1);
  for (let i = 1; i < points.length; i++) {
    if (points[i].frame !== points[i - 1].frame + 1) {
      extreme = i;
      trend = 0;
      continue;
    }
    const delta = signal[i] - signal[extreme];
    if (trend === 0) {
      if (Math.abs(delta) >= reversal) {
        trend = Math.sign(delta);
        extreme = i;
      }
    } else if (trend * delta >= 0) extreme = i;
    else if (Math.abs(delta) >= reversal) {
      keyframes.push({
        phase: trend > 0 ? "return from " + high : "return from " + low,
        frame: points[extreme].frame,
      });
      trend = -trend;
      extreme = i;
    }
  }
  return keyframes.sort((a, b) => a.frame - b.frame);
}

export function observeSpriteActionParts(
  standing: SpriteWalkRaster,
  frames: readonly SpriteWalkRaster[],
  parts: readonly SpriteActionPart[],
): SpriteActionPartObservation[] {
  if (!parts.length) return [];
  if (parts.length > 6)
    throw new Error("Inspect up to six named anatomical regions at a time.");
  const bounds = (r: SpriteWalkRect) =>
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    r.width >= 2 &&
    r.height >= 2 &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.width <= standing.width &&
    r.y + r.height <= standing.height;
  const inconclusive = (
    part: SpriteActionPart,
    reason: string,
  ): SpriteActionPartObservation => ({
    ...part,
    status: "inconclusive",
    reason,
    keyframes: [],
  });
  if (
    frames.length < 3 ||
    frames.length > 128 ||
    standing.width * standing.height * frames.length > RASTER_PIXELS ||
    ![standing, ...frames].every(
      (r) =>
        r.width === standing.width &&
        r.height === standing.height &&
        Number.isSafeInteger(r.width) &&
        r.width > 0 &&
        Number.isSafeInteger(r.height) &&
        r.height > 0 &&
        r.data.length === 4 * r.width * r.height,
    )
  ) {
    return parts.map((part) =>
      inconclusive(
        part,
        "Use at least three aligned, bounded RGBA poses with their reference.",
      ),
    );
  }
  const box = observeSpriteSilhouette(standing);
  if (box.width < 3 || box.height < 3)
    return parts.map((part) =>
      inconclusive(part, "The reference exposes insufficient painted anatomy."),
    );
  const radius = Math.min(
    40,
    Math.max(5, Math.ceil(Math.max(box.width, box.height) / 3)),
  );
  const samples = [0, 1, 2, 3].map(
    (i) => frames[Math.floor((i * frames.length) / 4)],
  );
  type Trace = {
    rect: SpriteWalkRect;
    positions: ReturnType<typeof trackSpriteWalkLandmark>;
  };
  const cached = new Map<string, Trace>();
  function trace(r: SpriteWalkRect): Trace {
    const key = [r.x, r.y, r.width, r.height].join(",");
    const got = cached.get(key);
    if (got) return got;
    const positions = trackSpriteWalkLandmark(standing, frames, r, radius);
    const result = { rect: r, positions };
    cached.set(key, result);
    return result;
  }
  const automatic: Trace[] = [];
  if (parts.some((p) => !p.anchor)) {
    // Two distinct core regions must exhibit the same translation before one can serve as an unlabelled anchor.
    for (const fx of [0.18, 0.48])
      for (const fy of [0.18, 0.47]) {
        const area = {
          x: box.x + Math.floor(box.width * fx),
          y: box.y + Math.floor(box.height * fy),
          width: Math.floor(box.width * 0.3),
          height: Math.floor(box.height * 0.29),
        };
        if (!bounds(area)) continue;
        const rect = selectSpriteActionPatch(standing, area, samples, radius);
        if (rect) automatic.push(trace(rect));
      }
  }
  return parts.map((part) => {
    if (!bounds(part.region) || (part.anchor && !bounds(part.anchor)))
      return inconclusive(
        part,
        "The named region or anchor is outside the standing reference.",
      );
    let tagged = trace(part.region);
    if (tagged.positions.some((p) => !p)) {
      const inner = selectSpriteActionPatch(
        standing,
        part.region,
        samples,
        radius,
      );
      if (inner) {
        const finer = trace(inner);
        if (
          finer.positions.filter(Boolean).length >
          tagged.positions.filter(Boolean).length
        )
          tagged = finer;
      }
    }
    let base = part.anchor ? trace(part.anchor) : undefined;
    if (!base) {
      base = automatic.find(
        (a) =>
          !intersects(part.region, a.rect) &&
          automatic.some((b) => {
            if (
              a === b ||
              intersects(part.region, b.rect) ||
              intersects(a.rect, b.rect)
            )
              return false;
            let matches = 0;
            for (const [i, v] of a.positions.entries()) {
              const w = b.positions[i];
              if (!v || !w) continue;
              if (Math.hypot(v.x - w.x, v.y - w.y) > 1.5) return false;
              matches++;
            }
            return matches >= Math.ceil(frames.length * 0.8);
          }),
      );
    }
    if (!base || intersects(tagged.rect, base.rect))
      return inconclusive(
        part,
        "A distinct, stable anatomical anchor is needed to separate this part from whole-character or camera motion.",
      );
    const result = { name: part.name, region: tagged.rect, anchor: base.rect };
    const dx =
      tagged.rect.x + tagged.rect.width / 2 - base.rect.x - base.rect.width / 2;
    const dy =
      tagged.rect.y +
      tagged.rect.height / 2 -
      base.rect.y -
      base.rect.height / 2;
    const points = tagged.positions.flatMap((tip, i) => {
      const root = base.positions[i];
      return tip && root
        ? [{ frame: i, x: dx + tip.x - root.x, y: dy + tip.y - root.y }]
        : [];
    });
    if (points.length < Math.max(3, frames.length * 0.6))
      return inconclusive(
        result,
        "Too few unambiguous relative positions; this part may be occluded, rotating or redrawn.",
      );
    const keyframes = phaseExtrema(
      points,
      Math.max(2, 0.017 * Math.max(box.width, box.height)),
    );
    if (!keyframes.length)
      return inconclusive(
        result,
        "The tracked relative position is stationary or below measurable excursion; shared translation does not establish an action phase.",
      );
    const complete = points.length === frames.length;
    return {
      ...result,
      keyframes,
      status: complete ? "tracked" : "inconclusive",
      reason: complete
        ? "Observed extrema and reversals in the part's motion relative to its anchor. Inspect these poses for the intended action."
        : "The marked poses are observed extrema of visible samples. Occluded or redrawn phases remain unresolved.",
    };
  });
}
