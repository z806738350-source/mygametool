import { inspectSpriteWalkSeams } from "./sprite-walk-alpha.js";
import type { SpriteWalkRaster, SpriteWalkRect } from "./sprite-walk-gait.js";
import { inspectSpriteWalkTopology } from "./sprite-walk-topology.js";
import { RASTER_PIXELS } from "./raster-policy.js";

type Raster = SpriteWalkRaster;
type Kind =
  | "seam"
  | "opened-joint"
  | "detached-fragment"
  | "empty-frame"
  | "edge-clipping"
  | "color-flash"
  | "low-opacity";
export interface SpriteActionDamage extends SpriteWalkRect {
  frame: number;
  kind: Kind;
  certainty: "confirmed" | "suspect";
  reason: string;
}

function bounds(r: Raster) {
  let x = r.width,
    y = r.height,
    right = -1,
    bottom = -1,
    count = 0,
    peak = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    const alpha = r.data[i * 4 + 3];
    peak = Math.max(peak, alpha);
    if (alpha < 96) continue;
    x = Math.min(x, i % r.width);
    right = Math.max(right, i % r.width);
    y = Math.min(y, Math.floor(i / r.width));
    bottom = Math.max(bottom, Math.floor(i / r.width));
    count++;
  }
  return { x, y, right, bottom, count, peak };
}

function similar(
  a: Uint8Array,
  p: number,
  b: Uint8Array,
  q: number,
  tolerance = 18,
) {
  if (a[p + 3] <= 30 && b[q + 3] <= 30) return true;
  for (let c = 0; c < 4; c++)
    if (Math.abs(a[p + c] - b[q + c]) > tolerance) return false;
  return true;
}

// Register whole-sprite movement (e.g. jump height) only if the translated artwork actually matches better.
// ponytail: rotated or independently moving limbs need phase-specific art judgment.
function align(
  standing: Raster,
  reference: ReturnType<typeof bounds>,
  frame: Raster,
  box: ReturnType<typeof bounds>,
) {
  const { width, height } = frame;
  const dx = Math.round(
      (reference.x + reference.right - box.x - box.right) / 2,
    ),
    dy = reference.y - box.y;
  if (
    !box.count ||
    (!dx && !dy) ||
    box.x + dx < 0 ||
    box.right + dx >= width ||
    box.y + dy < 0 ||
    box.bottom + dy >= height
  )
    return { raster: frame, dx: 0, dy: 0 };
  let baseline = 0,
    shifted = 0,
    samples = 0;
  const step = Math.max(
    1,
    Math.ceil(Math.max(box.right - box.x, box.bottom - box.y) / 40),
  );
  for (let y = box.y; y <= box.bottom; y += step)
    for (let x = box.x; x <= box.right; x += step) {
      const p = (y * width + x) * 4;
      if (frame.data[p + 3] < 160) continue;
      samples++;
      if (similar(frame.data, p, standing.data, p)) baseline++;
      if (similar(frame.data, p, standing.data, p + 4 * (dx + dy * width)))
        shifted++;
    }
  if (
    shifted < samples * 0.5 ||
    shifted - baseline < Math.max(2, samples * 0.025)
  )
    return { raster: frame, dx: 0, dy: 0 };
  const data = new Uint8Array(frame.data.length);
  const x0 = Math.max(0, -dx),
    end = Math.min(width, width - dx);
  for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
    const from = (y * width + x0) * 4;
    data.set(
      frame.data.subarray(from, from + (end - x0) * 4),
      4 * ((y + dy) * width + x0 + dx),
    );
  }
  return { raster: { width, height, data }, dx, dy };
}

/** Find the same local painted banks when a limb or the head bobs independently of the body. */
function matchBanks(
  rect: SpriteWalkRect,
  at: Raster,
  donor: Raster,
  reach: number,
) {
  const { x, y, width, height } = rect;
  const points: number[] = [];
  for (
    let yy = Math.max(0, y - 2);
    yy < Math.min(at.height, y + height + 2);
    yy++
  ) {
    for (
      let xx = Math.max(0, x - 2);
      xx < Math.min(at.width, x + width + 2);
      xx++
    ) {
      if (xx >= x && xx < x + width && yy >= y && yy < y + height) continue;
      const p = (yy * at.width + xx) * 4;
      if (at.data[p + 3] >= 128) points.push(p);
    }
  }
  if (points.length < 4) return;
  let best = -1,
    offset: number | undefined;
  for (let radius = 0; radius <= reach; radius++) {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (
          Math.max(Math.abs(dx), Math.abs(dy)) !== radius ||
          x + dx < 0 ||
          y + dy < 0 ||
          x + width + dx > donor.width ||
          y + height + dy > donor.height
        )
          continue;
        const delta = 4 * (dx + donor.width * dy);
        let same = 0,
          distance = 0;
        for (const p of points) {
          const xx = ((p / 4) % at.width) + dx,
            yy = Math.floor(p / (at.width * 4)) + dy,
            q = p + delta;
          if (xx < 0 || xx >= donor.width || yy < 0 || yy >= donor.height) {
            distance += 1020;
            continue;
          }
          if (similar(at.data, p, donor.data, q)) same++;
          for (let c = 0; c < 4; c++)
            distance += Math.abs(at.data[p + c] - donor.data[q + c]);
        }
        if (same < points.length * 0.9) continue;
        const score = 1 - distance / (points.length * 1020);
        if (score > best) {
          best = score;
          offset = delta;
        }
        if (distance === 0) return delta;
      }
  }
  return offset;
}

function duplicateFragment(frame: Raster, indices: number[], reach: number) {
  const samples = indices.filter((p) => frame.data[p + 3] >= 160);
  if (
    samples.length < 5 ||
    !samples.some((p) => !similar(frame.data, p, frame.data, samples[0], 35))
  )
    return false;
  const coords = samples.map((p) => ({
    p,
    x: (p / 4) % frame.width,
    y: Math.floor(p / (4 * frame.width)),
  }));
  const minDistance =
    Math.max(...coords.map((c) => c.x)) -
    Math.min(...coords.map((c) => c.x)) +
    1;
  const minVertical =
    Math.max(...coords.map((c) => c.y)) -
    Math.min(...coords.map((c) => c.y)) +
    1;
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      if (Math.abs(dx) < minDistance && Math.abs(dy) < minVertical) continue;
      if (
        coords.every(
          ({ p, x, y }) =>
            x + dx >= 0 &&
            y + dy >= 0 &&
            x + dx < frame.width &&
            y + dy < frame.height &&
            similar(
              frame.data,
              p,
              frame.data,
              p + 4 * (dy * frame.width + dx),
              6,
            ),
        )
      )
        return true;
    }
  return false;
}

function scan(
  standing: Raster,
  frames: readonly Raster[],
  loop: boolean,
  patch?: (
    frame: number,
    pixel: number,
    donor: Uint8Array,
    src: number,
  ) => void,
) {
  const { width, height } = standing,
    area = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    frames.length < 2 ||
    frames.length > 128 ||
    area * frames.length > RASTER_PIXELS ||
    ![standing, ...frames].every(
      (f) =>
        f.width === width && f.height === height && f.data.length === area * 4,
    )
  )
    throw new Error(
      "Use bounded, aligned, single RGBA action frames and the registered standing reference.",
    );
  const reference = bounds(standing);
  if (!reference.peak)
    throw new Error("The standing reference has no visible body.");
  const boxes = frames.map(bounds);
  const aligned = frames.map((f, i) => align(standing, reference, f, boxes[i]));
  const poses = aligned.map((a) => a.raster);
  const findings: SpriteActionDamage[] = [];
  for (const [frame, box] of boxes.entries()) {
    const prev =
      loop || frame > 0
        ? boxes[(frame + boxes.length - 1) % boxes.length]
        : undefined;
    const next =
      loop || frame + 1 < frames.length
        ? boxes[(frame + 1) % boxes.length]
        : undefined;
    if (!box.peak) {
      findings.push({
        frame,
        kind: "empty-frame",
        certainty:
          frames.length >= 3 && prev?.count && next?.count
            ? "confirmed"
            : "suspect",
        x: 0,
        y: 0,
        width,
        height,
        reason:
          "The character disappears. Inspect this phase and redraw its pose if missing.",
      });
      continue;
    }
    if (!box.count) {
      if (prev?.count && next?.count)
        findings.push({
          frame,
          kind: "low-opacity",
          certainty: "suspect",
          x: 0,
          y: 0,
          width,
          height,
          reason:
            "The painted silhouette fades in this phase. Check its intended opacity.",
        });
      continue;
    }
    // A single unexpectedly flat painted edge warrants visual inspection. A foot on the common baseline does not.
    if (prev?.count && next?.count) {
      for (const edge of ["x", "right", "y", "bottom"] as const) {
        const vertical = edge === "x" || edge === "right",
          limit =
            edge === "right" ? width - 1 : edge === "bottom" ? height - 1 : 0;
        if (
          box[edge] !== limit ||
          [prev, next, reference].some((b) => b[edge] === limit)
        )
          continue;
        let run = 0,
          longest = 0;
        for (let n = 0; n < (vertical ? height : width); n++) {
          const p = vertical ? n * width + limit : limit * width + n;
          run = frames[frame].data[4 * p + 3] >= 192 ? run + 1 : 0;
          longest = Math.max(run, longest);
        }
        if (
          longest >=
          Math.max(
            4,
            Math.ceil((vertical ? box.bottom - box.y : box.right - box.x) / 8),
          )
        ) {
          findings.push({
            frame,
            kind: "edge-clipping",
            certainty: "suspect",
            x: vertical ? limit : box.x,
            y: vertical ? box.y : limit,
            width: vertical ? 1 : box.right - box.x + 1,
            height: vertical ? box.bottom - box.y + 1 : 1,
            reason:
              "An opaque contour meets this cell edge only in this phase. Inspect the visible extent before changing the canvas or pose.",
          });
        }
      }
    }
    if (prev?.count && next?.count && frames.length >= 3) {
      const before = poses[(frame + frames.length - 1) % frames.length].data,
        after = poses[(frame + 1) % frames.length].data;
      let discolored = 0;
      for (let i = 0; i < area * 4; i += 4) {
        if (
          poses[frame].data[i + 3] >= 192 &&
          standing.data[i + 3] >= 192 &&
          similar(before, i, standing.data, i) &&
          similar(after, i, standing.data, i) &&
          !similar(poses[frame].data, i, standing.data, i, 80)
        )
          discolored++;
      }
      if (discolored >= Math.max(16, box.count * 0.4))
        findings.push({
          frame,
          kind: "color-flash",
          certainty: "suspect",
          x: box.x,
          y: box.y,
          width: box.right - box.x + 1,
          height: box.bottom - box.y + 1,
          reason:
            "A large one-frame color change departs from both adjacent phases. Check whether this is an intended effect.",
        });
    }
  }

  if (reference.peak < 160) {
    findings.push({
      frame: 0,
      kind: "low-opacity",
      certainty: "suspect",
      x: 0,
      y: 0,
      width,
      height,
      reason:
        "The standing art is translucent. Inspect joint continuity visually against contrasting grounds.",
    });
    return findings;
  }
  function consider(
    frame: number,
    kind: "seam" | "opened-joint" | "detached-fragment",
    rect: SpriteWalkRect,
    indices: number[],
  ) {
    const { dx, dy, raster } = aligned[frame];
    const first = frame === 0 && !loop,
      last = frame === frames.length - 1 && !loop;
    const before =
      poses[first ? frame + 1 : (frame + frames.length - 1) % frames.length];
    const after = poses[last ? frame - 1 : (frame + 1) % frames.length];
    const fragment = kind === "detached-fragment";
    const target = indices.filter((p) =>
      fragment
        ? raster.data[p + 3] >= 16
        : raster.data[p + 3] <= 48 && standing.data[p + 3] >= 160,
    );
    if (!target.length) return;
    const reach = fragment
      ? 0
      : Math.min(4, Math.ceil((reference.bottom - reference.y + 1) / 40));
    const r = matchBanks(rect, raster, standing, reach),
      p = matchBanks(rect, raster, before, reach),
      n = matchBanks(rect, raster, after, reach);
    if (r === undefined || p === undefined || n === undefined) return;
    const supported = target.filter(
      (i) =>
        (fragment
          ? standing.data[i + r + 3] <= 12
          : standing.data[i + r + 3] >= 160) &&
        similar(standing.data, i + r, before.data, i + p) &&
        similar(standing.data, i + r, after.data, i + n),
    );
    // Persistent negative space or a conflicting projection must not be painted over.
    if (supported.length !== target.length) {
      if (
        !fragment &&
        !first &&
        !last &&
        frames.length >= 3 &&
        target.length >= 6 &&
        target.every((i) =>
          [
            standing.data[i + r + 3],
            before.data[i + p + 3],
            after.data[i + n + 3],
          ].every((a) => a >= 160),
        )
      ) {
        findings.push({
          frame,
          kind,
          x: rect.x - dx,
          y: rect.y - dy,
          width: rect.width,
          height: rect.height,
          certainty: "confirmed",
          reason:
            "The intact painted banks and both adjacent poses show missing coverage, but the surface colors differ. Redraw this local contour in its action phase.",
        });
      }
      return;
    }
    if (
      fragment &&
      (target.length > 256 ||
        !duplicateFragment(
          raster,
          target,
          Math.min(24, Math.ceil((reference.bottom - reference.y + 1) / 5)),
        ))
    )
      return;
    const confirmed = !first && !last && frames.length >= 3;
    findings.push({
      frame,
      kind,
      x: rect.x - dx,
      y: rect.y - dy,
      width: rect.width,
      height: rect.height,
      certainty: confirmed ? "confirmed" : "suspect",
      reason: confirmed
        ? "The standing texture and both neighbouring phases agree at this isolated change and around its contour."
        : "Only one adjacent phase is available. Visually inspect this endpoint and redraw it if the contour is broken.",
    });
    if (confirmed && patch)
      for (const i of supported)
        patch(frame, i - 4 * (dx + dy * width), standing.data, i + r);
  }
  for (const { frame, x, y, axis, length } of inspectSpriteWalkSeams(
    standing,
    poses,
  )) {
    const dx = axis === "vertical" ? 0 : 1,
      dy = axis === "horizontal" ? 0 : axis === "up-right" ? -1 : 1;
    const indices = Array.from(
      { length },
      (_, n) => 4 * ((y + n * dy) * width + x + n * dx),
    );
    consider(
      frame,
      "seam",
      {
        x,
        y: dy < 0 ? y - length + 1 : y,
        width: dx ? length : 1,
        height: dy ? length : 1,
      },
      indices,
    );
  }
  for (const {
    frame,
    kind,
    x,
    y,
    width: w,
    height: h,
  } of inspectSpriteWalkTopology(standing, poses)) {
    if (kind === "detached-fragment" && w * h > 512) continue;
    const indices: number[] = [];
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) indices.push(4 * (yy * width + xx));
    consider(frame, kind, { x, y, width: w, height: h }, indices);
  }
  return findings;
}

export function inspectSpriteActionDamage(
  standing: Raster,
  frames: readonly Raster[],
  loop: boolean,
) {
  return scan(standing, frames, loop);
}

export function repairSpriteActionDamage(
  standing: Raster,
  frames: readonly Raster[],
  loop: boolean,
) {
  let poses = [...frames],
    findings: SpriteActionDamage[] | undefined;
  const changed = new Set<number>();
  // The directional scan returns its longest tear per axis. Reveal further independent tears after each repair.
  // ponytail: four rescans bound the work for severely shredded material; remaining damage is returned for redrawing.
  for (let pass = 0; pass < 4; pass++) {
    const result = [...poses],
      touched = new Set<number>();
    const remaining = scan(standing, poses, loop, (i, p, donor, source) => {
      if (!touched.has(i)) {
        result[i] = { ...poses[i], data: new Uint8Array(poses[i].data) };
        touched.add(i);
        changed.add(i);
      }
      result[i].data.set(donor.subarray(source, source + 4), p);
    });
    findings ??= remaining;
    if (!touched.size)
      return {
        frames: poses,
        changedFrames: [...changed].sort((a, b) => a - b),
        findings,
        remaining,
      };
    poses = result;
  }
  return {
    frames: poses,
    changedFrames: [...changed].sort((a, b) => a - b),
    findings: findings!,
    remaining: inspectSpriteActionDamage(standing, poses, loop),
  };
}
