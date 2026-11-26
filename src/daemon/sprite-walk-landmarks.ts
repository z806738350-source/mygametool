import type { CharacterViewDirection } from "../shared/character-views.js";
import { trackSpriteWalkLandmark, type SpriteWalkLandmarks, type SpriteWalkRaster, type SpriteWalkRect } from "./sprite-walk-gait.js";

export interface SpriteWalkLandmarkSuggestion {
  landmarks: SpriteWalkLandmarks;
  confidence: "candidate" | "inconclusive";
  reason: string;
}

function silhouette(r: SpriteWalkRaster) {
  let left = r.width, top = r.height, right = -1, bottom = -1;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    if (r.data[(y * r.width + x) * 4 + 3] < 160) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function lowerOutline(r: SpriteWalkRaster, box: SpriteWalkRect) {
  let split = 0, longest = 0;
  const widths: number[] = [];
  for (let y = Math.ceil(box.y + box.height * 0.82); y <= box.y + box.height * 0.97; y++) {
    const spans: { start: number; end: number }[] = [];
    let start = box.x;
    for (let x = box.x; x <= box.x + box.width; x++) {
      if (x < box.x + box.width && r.data[4 * (y * r.width + x) + 3] >= 160) continue;
      if (x - start >= Math.max(3, box.height * 0.025)) spans.push({ start, end: x - 1 });
      start = x + 1;
    }
    if (spans.length) widths.push(spans.at(-1)!.end - spans[0].start + 1);
    split = spans.length === 2 && spans[1].start - spans[0].end >= 3 ? split + 1 : 0;
    longest = Math.max(longest, split);
  }
  widths.sort((a, b) => a - b);
  return { split: longest >= Math.max(2, Math.round(box.height * 0.025)), width: widths[Math.floor(widths.length / 2)] };
}

// Rank standing-image patches by visible coverage, texture and location. No swing sign or review outcome participates.
function patchScore(r: SpriteWalkRaster, box: SpriteWalkRect, x: number, y: number, size: number, foot: boolean, side: number) {
  const pixel = 4 * (y * r.width + x);
  if (r.data[pixel + 3] < 190) return;
  const rect = { x: x - (size >> 1), y: y - (size >> 1), width: size, height: size };
  if (rect.x < 0 || rect.y < 0 || rect.x + size > r.width || rect.y + size > r.height) return;
  let count = 0, total = 0, contrast = 0;
  const step = Math.ceil(size / 7);
  for (let yy = rect.y; yy < rect.y + size; yy += step) for (let xx = rect.x; xx < rect.x + size; xx += step) {
    const n = 4 * (yy * r.width + xx);
    total++;
    if (r.data[n + 3] < 160) continue;
    count++;
    contrast += Math.hypot(r.data[pixel] - r.data[n], r.data[pixel + 1] - r.data[n + 1], r.data[pixel + 2] - r.data[n + 2]);
  }
  if (count < total * 0.65 || contrast / count < 5) return;
  const lateral = (x - box.x - (box.width - 1) / 2) / box.width, vertical = (y - box.y) / box.height;
  const region = foot ? Math.abs(vertical - 0.94) * 10 : Math.abs(vertical - 0.72) * 7;
  const cross = side ? Math.abs(Math.abs(lateral) - (foot ? 0.27 : 0.37)) : Math.abs(lateral) * 0.6;
  return { rect, score: region + cross + Math.max(0, 0.88 - count / total) * 0.6 - Math.min(contrast / count, 45) / 140 };
}

/** Propose regions for a standing, approximately upright biped; the caller still checks their anatomical identities. */
export function suggestSpriteWalkLandmarks(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[],
  direction: CharacterViewDirection): SpriteWalkLandmarkSuggestion {
  const none = (reason: string): SpriteWalkLandmarkSuggestion => ({ landmarks: {}, confidence: "inconclusive", reason });
  if (frames.length < 4 || !/^(?:[NS][EW]?|[EW])$/.test(direction) ||
      ![standing, ...frames].every(r => Number.isSafeInteger(r.width) && r.width > 0 && Number.isSafeInteger(r.height) &&
        r.height > 0 && r.width === standing.width && r.height === standing.height && r.data.length === r.width * r.height * 4))
    return none("Supply at least four aligned RGBA frames and their standing direction.");
  const box = silhouette(standing), profile = direction === "E" || direction === "W";
  if (box.height < 18 || box.width < 6 || box.height < box.width) return none("The standing silhouette is too small or is not an upright figure.");
  const outline = lowerOutline(standing, box);
  if (profile ? !outline.width || outline.width >= box.width * 0.90 : !outline.split)
    return none("The lower silhouette does not expose distinct boot landmarks for this view. Inspect the artwork.");
  const poses = [0, 1, 2, 3].map(i => frames[Math.floor(frames.length * i / 4)]);
  const radius = Math.min(40, Math.max(5, Math.ceil(box.height * 0.22)));
  const size = Math.max(5, Math.min(17, Math.round(box.height * 0.05) | 1)), step = Math.max(2, Math.ceil(box.height / 55));
  const mid = box.x + (box.width - 1) / 2;
  let bodyMotion: ReturnType<typeof trackSpriteWalkLandmark> | undefined;
  for (const [x, y] of [[0.5, 0.25], [0.35, 0.28], [0.62, 0.36], [0.5, 0.45]]) {
    const rect = { x: Math.round(box.x + x * (box.width - 1)) - (size >> 1),
      y: Math.round(box.y + y * (box.height - 1)) - (size >> 1), width: size, height: size };
    const motion = trackSpriteWalkLandmark(standing, poses, rect, radius);
    if (motion.every(Boolean)) { bodyMotion = motion; break; }
  }
  if (!bodyMotion) return none("No distinctive upper-body texture could anchor the standing reference across the cycle.");
  const region = (side: number, foot: boolean) => {
    const candidates = [];
    for (let y = Math.floor(box.y + box.height * (foot ? 0.865 : 0.62)); y <= box.y + box.height * (foot ? 0.985 : 0.845); y += step) {
      for (let x = Math.floor(box.x + box.width * 0.06); x < box.x + box.width * 0.96; x += step) {
        const lateral = (x - mid) / box.width;
        if (side ? side * lateral < (foot ? 0.065 : 0.17) : Math.abs(lateral) > (foot ? 0.39 : 0.30)) continue;
        const candidate = patchScore(standing, box, x, y, size, foot, side);
        if (candidate) candidates.push(candidate);
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    // A short ranked search keeps high-resolution atlases bounded; painted-over or tiny features need a visual cue.
    for (const { rect } of candidates.slice(0, 24)) {
      const motion = trackSpriteWalkLandmark(standing, poses, rect, radius);
      if (!motion.every(Boolean)) continue;
      const local = motion.map((p, i) => ({ x: p!.x - bodyMotion![i]!.x, y: p!.y - bodyMotion![i]!.y }));
      const spread = Math.hypot(Math.max(...local.map(p => p.x)) - Math.min(...local.map(p => p.x)),
        Math.max(...local.map(p => p.y)) - Math.min(...local.map(p => p.y)));
      if (spread >= box.height * (foot ? 0.045 : 0.018)) return rect;
    }
  };
  const landmarks: SpriteWalkLandmarks = {};
  for (const side of profile ? [0] : [-1, 1]) {
    const hand = region(side, false), foot = region(side, true);
    if (!hand || !foot) continue;
    const name = profile ? (direction === "E" ? "right" : "left") : (side > 0) === direction.includes("S") ? "left" : "right";
    landmarks[name] = { hand, foot };
  }
  return Object.keys(landmarks).length ? { landmarks, confidence: "candidate",
    reason: profile ? "Visible profile side only. Confirm the patches lie on the near hand and boot." :
      "Distinctive moving patches on the standing silhouette. Confirm each hand and boot belongs to the named anatomical side." } :
    none("No same-side hand and boot pair could be reliably tracked. Supply visible regions from the standing image.");
}
