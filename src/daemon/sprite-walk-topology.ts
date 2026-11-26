import type { SpriteWalkRaster, SpriteWalkRect } from "./sprite-walk-gait.js";

export interface SpriteWalkTopologyFinding extends SpriteWalkRect {
  frame: number;
  kind: "detached-fragment" | "opened-joint";
  pixels: number;
}
interface Region extends SpriteWalkRect { pixels: number; core: number; samples: number[] }

function regions(mask: Uint8Array, width: number, height: number, diagonal: boolean, visit: (area: Region, points: Int32Array) => void) {
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let n = 1, core = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    queue[0] = start;
    core += Number(mask[start] >= 192);
    mask[start] = 0;
    for (let i = 0; i < n; i++) {
      const k = queue[i], x = k % width, y = Math.floor(k / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          if (!diagonal && xx !== x && yy !== y) continue;
          const j = yy * width + xx;
          if (!mask[j]) continue;
          core += Number(mask[j] >= 192);
          mask[j] = 0;
          queue[n++] = j;
        }
      }
    }
    if (n < 4) continue;
    const samples = [];
    for (let i = 0; i < n; i += Math.ceil(n / 16)) samples.push(queue[i]);
    visit({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: n, core, samples }, queue.subarray(0, n));
  }
}

function silhouette(frame: SpriteWalkRaster) {
  const { width, height, data } = frame;
  const mask = new Uint8Array(width * height), main = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const alpha = data[4 * i + 3];
    if (alpha >= 96) mask[i] = alpha;
  }
  const parts: Region[] = [];
  let body: Region | undefined;
  let bodyPixels = new Int32Array();
  regions(mask, width, height, true, (region, points) => {
    if (!body || region.pixels > body.pixels) {
      if (body) parts.push(body);
      body = region;
      bodyPixels = points.slice();
    } else parts.push(region);
  });
  for (const k of bodyPixels) main[k] = 1;
  return { parts, main, body: body as Region | undefined };
}

function matches(a: Region, b: Region, reach: number) {
  return Math.min(a.pixels, b.pixels) >= Math.max(a.pixels, b.pixels) / 3 &&
    Math.hypot(a.x - b.x + (a.width - b.width) / 2, a.y - b.y + (a.height - b.height) / 2) <= reach;
}

function nearBody(part: Region, main: Uint8Array, width: number, height: number, reach: number) {
  return part.samples.filter(k => {
    const cx = k % width, cy = Math.floor(k / width);
    for (let y = Math.max(0, cy - reach); y <= Math.min(height - 1, cy + reach); y++)
      for (let x = Math.max(0, cx - reach); x <= Math.min(width - 1, cx + reach); x++)
        if (main[y * width + x]) return true;
    return false;
  }).length >= part.samples.length * 0.6;
}

function openJoints(standing: SpriteWalkRaster, current: SpriteWalkRaster, previous: SpriteWalkRaster,
  next: SpriteWalkRaster, prior: SpriteWalkRaster | undefined, bodyHeight: number) {
  const { width, height, data } = current;
  const minGap = Math.max(3, Math.round(bodyHeight / 45)), maxGap = Math.max(minGap, Math.ceil(bodyHeight / 10));
  const minSpan = Math.max(6, Math.ceil(bodyHeight / 15));
  const found: Region[] = [];
  for (const vertical of [true, false]) {
    const mask = new Uint8Array(width * height);
    const across = vertical ? width : height, along = vertical ? height : width;
    const index = (u: number, v: number) => vertical ? v * width + u : u * width + v;
    for (let u = 0; u < across; u++) {
      let start = 0;
      const hasBank = (edge: number, sign: number) => {
        for (let step = 0; step < 3; step++) {
          const row = edge + sign * step;
          if (row >= 0 && row < along && data[4 * index(u, row) + 3] >= 160) return true;
        }
        return false;
      };
      for (let v = 0; v <= along; v++) {
        if (v < along && data[4 * index(u, v) + 3] <= 48) continue;
        if (start && v < along && v - start >= minGap && v - start <= maxGap &&
            hasBank(start - 1, -1) && hasBank(v, 1)) {
          for (let k = start; k < v; k++) {
            const p = index(u, k), a = 4 * p + 3;
            const prevSolid = previous.data[a] >= 160, nextSolid = next.data[a] >= 160;
            if ((prior?.data[a] ?? 0) < 160 && (standing.data[a] < 160 || (prior && !(prevSolid && nextSolid)))) continue;
            if (prevSolid || nextSolid) mask[p] = prevSolid && nextSolid ? 255 : 96;
          }
        }
        start = v + 1;
      }
    }
    regions(mask, width, height, false, part => {
      const span = vertical ? part.width : part.height, thick = vertical ? part.height : part.width;
      if (span >= minSpan && thick >= minGap && span >= thick * 1.5 && part.pixels >= minSpan * minGap &&
          part.core >= part.pixels * 0.52 && part.pixels >= span * thick * 0.40) found.push(part);
    });
  }
  return found;
}

/** Only count faults that have painted support in the standing art, neighbouring phases or the pre-repair frame. */
export function inspectSpriteWalkTopology(standing: SpriteWalkRaster, frames: readonly SpriteWalkRaster[],
  beforeFrames?: readonly SpriteWalkRaster[]): SpriteWalkTopologyFinding[] {
  const { width, height } = standing;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      (beforeFrames && beforeFrames.length !== frames.length) ||
      ![standing, ...frames, ...(beforeFrames ?? [])].every(r => r.width === width && r.height === height && r.data.length === width * height * 4))
    throw new Error("Align the standing reference, walk frames and any pre-repair frames on one RGBA canvas.");
  const reference = silhouette(standing), bodyHeight = reference.body?.height;
  if (!bodyHeight || !frames.length) return [];
  const shapes = frames.map(silhouette), result: SpriteWalkTopologyFinding[] = [];
  const add = (r: Region, frame: number, kind: SpriteWalkTopologyFinding["kind"]) =>
    result.push({ frame, kind, x: r.x, y: r.y, width: r.width, height: r.height, pixels: r.pixels });
  for (const [i, shape] of shapes.entries()) {
    const previous = (i + frames.length - 1) % frames.length, next = (i + 1) % frames.length;
    const reach = Math.max(2, Math.round(bodyHeight / 18));
    for (const part of shape.parts) {
      if (part.pixels < Math.max(4, Math.round(bodyHeight / 27)) || part.core < Math.max(2, part.pixels * 0.12)) continue;
      if (reference.parts.some(p => matches(p, part, reach * 2))) continue;
      const recurring = shapes.filter(s => s.parts.some(p => matches(p, part, reach))).length;
      if (recurring >= Math.ceil(frames.length * 0.7) || !nearBody(part, reference.main, width, height, reach) ||
          !nearBody(part, shape.main, width, height, reach)) continue;
      add(part, i, "detached-fragment");
    }
    if (frames.length >= 4) {
      for (const part of openJoints(standing, frames[i], frames[previous], frames[next], beforeFrames?.[i], bodyHeight)) {
        add(part, i, "opened-joint");
      }
    }
  }
  return result;
}
