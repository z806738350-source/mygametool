import type { CharacterViewCanvas, CharacterViewDirection, CharacterViewPoint } from "../shared/character-views.js";

export interface SpriteWalkRaster extends CharacterViewCanvas { data: Uint8Array }
export interface SpriteWalkRect extends CharacterViewCanvas, CharacterViewPoint {}
export interface SpriteWalkLandmarks {
  left?: { hand: SpriteWalkRect; foot: SpriteWalkRect };
  right?: { hand: SpriteWalkRect; foot: SpriteWalkRect };
  body?: SpriteWalkRect;
}

type Status = "pass" | "fail" | "inconclusive";
type Track = (CharacterViewPoint | null)[];
export interface SideEvidence {
  status: Status;
  reason: string;
  hand: (number | null)[];
  foot: (number | null)[];
  passingFrames: number[];
  sampledRegions?: { hand: SpriteWalkRect; foot: SpriteWalkRect };
}

function inBounds(raster: SpriteWalkRaster, r: SpriteWalkRect) {
  return [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) && r.x >= 0 && r.y >= 0 &&
    r.width >= 2 && r.height >= 2 && r.x + r.width <= raster.width && r.y + r.height <= raster.height;
}

function appearance(raster: SpriteWalkRaster, rect: SpriteWalkRect) {
  const sample: { offset: number; r: number; g: number; b: number }[] = [];
  if (!inBounds(raster, rect)) return sample;
  let contrast = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += Math.ceil(rect.height / 7)) {
    for (let x = rect.x; x < rect.x + rect.width; x += Math.ceil(rect.width / 7)) {
      const offset = 4 * (y * raster.width + x);
      if (raster.data[offset + 3] < 160) continue;
      const r = raster.data[offset], g = raster.data[offset + 1], b = raster.data[offset + 2];
      const first = sample[0];
      if (first) contrast = Math.max(contrast, Math.abs(first.r - r), Math.abs(first.g - g), Math.abs(first.b - b));
      sample.push({ offset, r, g, b });
    }
  }
  return sample.length >= 6 && contrast >= 9 ? sample : [];
}

// Match saved standing-image pixels; repeated or occluded textures must never certify an identity.
function track(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[], rect: SpriteWalkRect, radius: number): Track {
  const sample = appearance(standing, rect);
  if (!sample.length) return frames.map(() => null);
  const left = Math.max(-radius, -rect.x), right = Math.min(radius, standing.width - rect.x - rect.width);
  const top = Math.max(-radius, -rect.y), bottom = Math.min(radius, standing.height - rect.y - rect.height);
  const width = right - left + 1;
  const costs = new Float32Array(width * (bottom - top + 1));
  return frames.map(({ data }) => {
    let lowest = Infinity, bx = 0, by = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const shift = 4 * (y * standing.width + x);
        let sum = 0;
        for (const pixel of sample) {
          const i = pixel.offset + shift;
          sum += data[i + 3] < 128 ? 110 : (Math.abs(data[i] - pixel.r) +
            Math.abs(data[i + 1] - pixel.g) + Math.abs(data[i + 2] - pixel.b)) / 3;
          // This candidate can neither pass the match threshold nor compete with a passing one.
          if (sum > 25 * sample.length) break;
        }
        const cost = sum / sample.length;
        costs[(y - top) * width + x - left] = cost;
        if (cost < lowest) { lowest = cost; bx = x; by = y; }
      }
    }
    if (lowest > 18) return null;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (Math.max(Math.abs(x - bx), Math.abs(y - by)) <= 1) continue;
        if (costs[(y - top) * width + x - left] < lowest + Math.max(1.5, lowest * 0.35)) return null;
      }
    }
    return { x: bx, y: by };
  });
}

export { track as trackSpriteWalkLandmark };

// All candidates share the original standing artwork. Select purely on match coverage and motion
// continuity before comparing hand and foot phase. A repeated texture on another limb is unsafe.
function refineLandmarkTrack(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[],
  region: SpriteWalkRect, radius: number, contacts: readonly [number, number]) {
  const original = track(standing, frames, region, radius);
  const coverage = (points: Track) => contacts.filter(i => points[i]).length * (frames.length + 1) + points.filter(Boolean).length;
  let best = { region, points: original }, score = coverage(original);
  if (contacts.every(i => original[i]) || original.filter(Boolean).length < Math.max(2, frames.length / 4) ||
    !inBounds(standing, region)) return best;
  const sx = Math.min(3, Math.floor((region.width - 1) / 2)), sy = Math.min(3, Math.floor((region.height - 1) / 2));
  const shifts = [[0, -1], [0, 1], [-1, 0], [1, 0], [0, -sy], [0, sy], [-sx, 0], [sx, 0]];
  for (const [dx, dy] of shifts) {
    if ((!dx && !dy) || Math.abs(dx) > sx || Math.abs(dy) > sy) continue;
    const shifted = { ...region, x: region.x + dx, y: region.y + dy };
    if (!inBounds(standing, shifted)) continue;
    const cx = Math.round(centerX(region)), cy = region.y + Math.floor(region.height / 2);
    // Never step over a transparent crease to borrow a neighbouring part.
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    let connected = true;
    for (let i = 0; i <= steps; i++) {
      const p = 4 * ((cy + Math.round(dy * i / steps)) * standing.width + cx + Math.round(dx * i / steps));
      if (standing.data[p + 3] < 160) connected = false;
    }
    if (!connected) continue;
    const next = track(standing, frames, shifted, radius);
    const known = next.filter((p, i) => p && original[i]).length;
    if (known < Math.max(2, frames.length / 4)) continue;
    const conflicts = next.flatMap((p, i) => p && original[i] && Math.hypot(p.x - original[i]!.x, p.y - original[i]!.y) > 2 ? [i] : []);
    // One stray non-contact match can occur on the other boot. Replace it only when independent
    // common frames and the adjacent trajectory favour the new location, never on a contact.
    if (conflicts.length > 1) continue;
    const outlier = conflicts[0];
    if (outlier !== undefined) {
      if (contacts.includes(outlier) || known < Math.max(5, frames.length * 0.65)) continue;
      const near = (sign: number) => {
        for (let k = 1; k <= Math.ceil(frames.length / 4); k++) {
          const p = original[(outlier + frames.length + sign * k) % frames.length];
          if (p) return { p, k };
        }
      };
      const earlier = near(-1), later = near(1);
      if (!earlier || !later) continue;
      const t = earlier.k / (earlier.k + later.k);
      const x = earlier.p.x + t * (later.p.x - earlier.p.x), y = earlier.p.y + t * (later.p.y - earlier.p.y);
      const prev = original[outlier]!, replacement = next[outlier]!;
      if (Math.hypot(prev.x - x, prev.y - y) < 4 + Math.hypot(replacement.x - x, replacement.y - y) * 1.5) continue;
    }
    const merged = original.map((p, i) => i === outlier ? next[i] : p ?? next[i]);
    const better = coverage(merged);
    if (better <= score) continue;
    const speeds = merged.flatMap((p, i) => {
      const q = merged[(i + 1) % merged.length];
      return p && q ? [Math.hypot(q.x - p.x, q.y - p.y)] : [];
    }).sort((a, b) => a - b);
    if (speeds.length < 3 || speeds.at(-1)! > Math.max(4, speeds[Math.floor(speeds.length / 2)] * 3 + 1)) continue;
    best = { region: shifted, points: merged };
    score = better;
  }
  return best;
}

function bodyTrack(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[], region: SpriteWalkRect | undefined, radius: number): Track {
  if (region) return track(standing, frames, region, radius);
  let l = standing.width, r = -1, t = standing.height, b = -1;
  for (let y = 0; y < standing.height; y++) for (let x = 0; x < standing.width; x++) {
    if (standing.data[4 * (y * standing.width + x) + 3] < 160) continue;
    l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
  }
  let best: Track = frames.map(() => null), known = 0;
  const size = Math.max(3, Math.min(11, Math.round((b - t + 1) / 11)));
  for (const [fx, fy] of [[0.5, 0.25], [0.35, 0.28], [0.62, 0.36], [0.5, 0.45]]) {
    const found = track(standing, frames, { x: Math.round(l + fx * (r - l) - size / 2),
      y: Math.round(t + fy * (b - t) - size / 2), width: size, height: size }, radius);
    const count = found.filter(Boolean).length;
    if (count > known) { best = found; known = count; }
    if (count === frames.length) break;
  }
  return best;
}

function sameRegion(a: SpriteWalkRect, b: SpriteWalkRect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const centerX = (r: SpriteWalkRect) => r.x + (r.width - 1) / 2;

// Only infer an image midline when the actual frontal silhouette exposes both gloves beside a
// wider torso and two separate boots below it. Crossed, side-on or occluded poses need other evidence.
function frontalSide(standing: SpriteWalkRaster, region: SpriteWalkRect, hand: boolean) {
  if (!inBounds(standing, region)) return;
  const evidence: { side: number; middle: number; width: number }[] = [];
  for (let y = region.y; y < region.y + region.height; y += Math.max(1, Math.floor(region.height / 5))) {
    const spans: { left: number; right: number; width: number }[] = [];
    let start = 0;
    for (let x = 0; x <= standing.width; x++) {
      if (x < standing.width && standing.data[4 * (y * standing.width + x) + 3] >= 160) continue;
      if (x - start >= 3) spans.push({ left: start, right: x - 1, width: x - start });
      start = x + 1;
    }
    if (spans.length !== (hand ? 3 : 2)) continue;
    const first = spans[0], last = spans.at(-1)!;
    if (Math.min(first.width, last.width) < Math.max(first.width, last.width) * 0.55) continue;
    const width = last.right - first.left + 1, middle = (first.left + last.right) / 2;
    if (hand && (spans[1].width <= Math.max(first.width, last.width) ||
      Math.abs((spans[1].left + spans[1].right) / 2 - middle) > width * 0.08)) continue;
    const x = centerX(region);
    if (x >= first.left && x <= first.right) evidence.push({ side: -1, middle, width });
    if (x >= last.left && x <= last.right) evidence.push({ side: 1, middle, width });
  }
  if (evidence.length >= 2 && evidence.every(e => e.side === evidence[0].side &&
    Math.abs(e.middle - evidence[0].middle) <= e.width * 0.06)) return evidence[0];
}

function assess(hand: (number | null)[], foot: (number | null)[], a: number, b: number): SideEvidence {
  const passingFrames: number[] = [];
  const result = (status: Status, reason: string) => ({ status, reason, hand, foot, passingFrames });
  const ha = hand[a], hb = hand[b], fa = foot[a], fb = foot[b];
  if (ha === null || hb === null || fa === null || fb === null) {
    return result("inconclusive", "A contact landmark is hidden, ambiguous or unlike the standing reference.");
  }
  const hd = hb - ha, fd = fb - fa;
  if (Math.abs(hd) < 2 || Math.abs(fd) < 2) {
    return result("inconclusive", "The body-relative contact displacement is too small to identify the swing.");
  }
  for (const [from, to] of [[a, b], [b, a]]) {
    const span = (to - from + hand.length) % hand.length;
    let closest: number | undefined, error = Infinity;
    for (let i = 1; i < span; i++) {
      const f = (from + i) % hand.length, h = hand[f], p = foot[f];
      if (h === null || p === null) continue;
      const hFraction = (h - ha) / hd, fFraction = (p - fa) / fd;
      if (Math.min(hFraction, fFraction) <= 0.035 || Math.max(hFraction, fFraction) >= 0.965) continue;
      const distance = Math.abs(i / span - 0.5);
      if (distance < error) { closest = f; error = distance; }
    }
    if (closest !== undefined) passingFrames.push(closest);
  }
  if (hd * fd > 0) return result("fail", "The same anatomical hand and boot travel together between the two contacts.");
  if (passingFrames.length !== 2) {
    return result("inconclusive", "Opposed contacts are visible, but a passing pose in each half-cycle could not be confirmed.");
  }
  return result("pass", "The same-side hand and boot swing in opposition with a visible passing pose on each half-cycle.");
}

export function inspectSpriteWalkGait(input: {
  standing: SpriteWalkRaster; frames: readonly SpriteWalkRaster[]; direction: CharacterViewDirection;
  landmarks: SpriteWalkLandmarks; contacts?: readonly [number, number];
}) {
  const { standing, frames, direction, landmarks } = input;
  const sides: Partial<Record<"left" | "right", SideEvidence>> = {};
  const contacts = input.contacts ?? [0, Math.floor(frames.length / 2)] as const;
  const result = (status: Status, reasons: string[]) => ({ status, reasons, contacts, sides });
  if (!/^(?:[NS][EW]?|[EW])$/.test(direction) || frames.length < 4 ||
      !contacts.every(f => Number.isSafeInteger(f) && f >= 0 && f < frames.length) ||
      contacts[0] === contacts[1] || ![standing, ...frames].every(r => r.width === standing.width &&
        r.height === standing.height && Number.isSafeInteger(r.width) && r.width > 0 &&
        Number.isSafeInteger(r.height) && r.height > 0 && r.data.length === r.width * r.height * 4)) {
    return result("inconclusive", ["Use equally sized RGBA frames and two distinct contact frames within the cycle."]);
  }
  if (landmarks.left && landmarks.right && (sameRegion(landmarks.left.hand, landmarks.right.hand) ||
      sameRegion(landmarks.left.foot, landmarks.right.foot))) {
    return result("inconclusive", ["The two sides overlap in the standing reference. Provide distinct visible landmarks or the visible side alone."]);
  }
  if (landmarks.left && landmarks.right) {
    const { left, right } = landmarks;
    const handOrder = centerX(left.hand) - centerX(right.hand), footOrder = centerX(left.foot) - centerX(right.foot);
    if (Math.abs(handOrder) >= (left.hand.width + right.hand.width) / 2 &&
        Math.abs(footOrder) >= (left.foot.width + right.foot.width) / 2 && handOrder * footOrder < 0) {
      return result("inconclusive", ["The separated hands and boots have conflicting anatomical pairings in the standing image."]);
    }
  }
  if (!landmarks.left && !landmarks.right) {
    return result("inconclusive", ["Supply a visible anatomical hand and boot on the same side."]);
  }
  const dx = Number(direction.includes("E")) - Number(direction.includes("W"));
  const dy = Number(direction.includes("S")) - Number(direction.includes("N"));
  const norm = Math.hypot(dx, dy);
  // ponytail: local translation covers registered two-dimensional art; large redrawn or rotated limbs need visual review.
  const radius = Math.min(40, Math.max(5, Math.ceil(Math.max(standing.width, standing.height) / 6)));
  const body = bodyTrack(standing, frames, landmarks.body, radius);
  const projected = (points: Track) => points.map((p, i) => {
    const ref = body[i];
    return p && ref ? ((p.x - ref.x) * dx + (p.y - ref.y) * dy) / norm : null;
  });
  for (const side of ["left", "right"] as const) {
    const pair = landmarks[side];
    if (!pair) continue;
    let reason = sameRegion(pair.hand, pair.foot) ? "The hand and boot require distinct standing-image regions." : undefined;
    if (direction === "N" || direction === "S") {
      const h = frontalSide(standing, pair.hand, true), f = frontalSide(standing, pair.foot, false);
      if (h && f && h.side !== f.side && Math.abs(h.middle - f.middle) <= h.width * 0.08) {
        const shin = frontalSide(standing, { ...pair.foot, y: Math.round((pair.hand.y + pair.foot.y) / 2) }, false);
        if (shin?.side === f.side && Math.abs(shin.middle - f.middle) <= h.width * 0.08)
          reason = "These landmarks lie on opposite sides of a clearly separated front/back standing silhouette.";
      }
    }
    if (reason) {
      sides[side] = { status: "inconclusive", reason, hand: [], foot: [], passingFrames: [] };
      continue;
    }
    const hand = refineLandmarkTrack(standing, frames, pair.hand, radius, contacts);
    const foot = refineLandmarkTrack(standing, frames, pair.foot, radius, contacts);
    sides[side] = { ...assess(projected(hand.points), projected(foot.points), contacts[0], contacts[1]),
      sampledRegions: { hand: hand.region, foot: foot.region } };
  }
  const observed = Object.values(sides), reasons = observed.map(s => s.reason);
  if (observed.some(s => s.status === "fail")) return result("fail", reasons);
  if (observed.some(s => s.status === "inconclusive")) return result("inconclusive", reasons);
  if (sides.left && sides.right) {
    const [a, b] = contacts;
    const travel = (s: SideEvidence) => s.foot[b]! - s.foot[a]!;
    if (travel(sides.left) * travel(sides.right) > 0) {
      return result("fail", ["Both boots move in the same direction between contacts instead of alternating."]);
    }
  }
  return result("pass", reasons);
}
