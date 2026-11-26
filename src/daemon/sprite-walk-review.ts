import { createHash } from "node:crypto";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { CHARACTER_VIEW_DIRECTIONS, type CharacterViewDirection } from "../shared/character-views.js";
import { localAgentPath } from "./agent-local-files.js";
import { readActiveManifest } from "./character-view-publish.js";
import { resolveStartupDirectory } from "./projects.js";
import { RASTER_BYTES, RASTER_PIXELS, serializeRasterDecoding } from "./raster-policy.js";
import { inspectSafeProjectMedia, readSafeProjectFile } from "./safe-project-file.js";
import { inspectSpriteWalkSeams } from "./sprite-walk-alpha.js";
import { inspectSpriteWalkTopology } from "./sprite-walk-topology.js";
import { inspectSpriteWalkGait, type SpriteWalkLandmarks, type SpriteWalkRaster } from "./sprite-walk-gait.js";
import { suggestSpriteWalkLandmarks } from "./sprite-walk-landmarks.js";

export type WalkProject = { workspacePath: string; startupDirectory?: string };
type Frame = { x: number; y: number };
type WalkManifest = {
  image: string;
  frameSize: { width: number; height: number };
  gait?: string;
  stridePx?: number;
  animations: Partial<Record<CharacterViewDirection, { frames: Frame[] }>>;
};

export async function readWalkPackage(project: WalkProject, setId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(setId)) throw new Error("Choose a published character set ID.");
  const root = project.workspacePath;
  const startup = await resolveStartupDirectory(root, project.startupDirectory ?? ".");
  const directory = path.posix.join(startup.relativePath, "public", "characters", setId);
  const file = (name: string) => localAgentPath(root, path.posix.join(directory, name));
  const metadata = (name: string) => file(name).then((f) => readSafeProjectFile(root, f, 1024 * 1024));
  const [idleBytes, walkBytes] = await Promise.all([metadata("manifest.json"), metadata("walk.json")]);
  const idle = readActiveManifest(idleBytes, setId);
  const walk: WalkManifest = JSON.parse(walkBytes.toString("utf8"));
  if (
    typeof walk?.image !== "string" ||
    !/^(?:[\w-]+\/)*[\w.-]+\.png$/i.test(walk.image) ||
    !walk.animations ||
    typeof walk.animations !== "object" ||
    Array.isArray(walk.animations) ||
    walk.frameSize?.width !== idle.canvas.width ||
    walk.frameSize.height !== idle.canvas.height
  ) {
    throw new Error("Use a package-relative PNG and the same frame dimensions as the published standing views.");
  }
  const directions = CHARACTER_VIEW_DIRECTIONS.filter((d) => Object.hasOwn(walk.animations, d));
  if (!directions.length) throw new Error("The walk manifest has no directional loops to inspect.");
  for (const d of directions) {
    const frames = walk.animations[d]?.frames;
    if (
      !Array.isArray(frames) ||
      frames.length < 2 ||
      frames.length > 128 ||
      frames.length * idle.canvas.width * idle.canvas.height > RASTER_PIXELS ||
      !frames.every((f) => f && [f.x, f.y].every((n) => Number.isSafeInteger(n) && n >= 0))
    ) {
      throw new Error(`Invalid or oversized walk frame rectangles for ${d}.`);
    }
  }
  // Match observations to the texture and both manifests that the game actually reads.
  const identity = (sheetDigest: string) => ({
    revision: createHash("sha256")
      .update(idleBytes)
      .update("\0")
      .update(walkBytes)
      .update("\0")
      .update(sheetDigest)
      .digest("hex"),
    directions,
    image: walk.image,
    ...(typeof walk.gait === "string" ? { biped: walk.gait === "biped" } : {}),
  });
  return { root, directory, file, walk, idle, directions, identity };
}

export async function readPublishedSpriteWalkIdentity(project: WalkProject, setId: string, signal?: AbortSignal) {
  const pkg = await readWalkPackage(project, setId, signal);
  const sheet = await inspectSafeProjectMedia(pkg.root, await pkg.file(pkg.walk.image), RASTER_BYTES, 16, signal);
  for (const d of pkg.directions) {
    const reference = pkg.idle.views[d]!;
    const source = await inspectSafeProjectMedia(pkg.root, await pkg.file(reference.file), RASTER_BYTES, 16, signal);
    if (source.sha256 !== reference.sha256)
      throw new Error(`The ${d} standing reference no longer matches its publication.`);
  }
  return pkg.identity(sheet.sha256);
}

export async function decodeWalkPng(bytes: Buffer) {
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: RASTER_PIXELS });
  const info = await image.metadata();
  if (info.format !== "png" || (info.pages ?? 1) !== 1 || !info.hasAlpha)
    throw new Error("Use a single transparent PNG for the standing reference and walk atlas.");
  const raw = await image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .timeout({ seconds: 5 })
    .toBuffer({ resolveWithObject: true });
  return { width: raw.info.width, height: raw.info.height, data: raw.data };
}

export function reviewSpriteWalkDirection(input: {
  standing: SpriteWalkRaster;
  frames: readonly SpriteWalkRaster[];
  beforeFrames?: readonly SpriteWalkRaster[];
  direction: CharacterViewDirection;
  landmarks?: SpriteWalkLandmarks;
  contacts?: readonly [number, number];
}) {
  const seams = inspectSpriteWalkSeams(input.standing, input.frames);
  const topology = inspectSpriteWalkTopology(input.standing, input.frames, input.beforeFrames);
  const gait = inspectSpriteWalkGait({ ...input, landmarks: input.landmarks ?? {} });
  return { status: seams.length || topology.length ? ("fail" as const) : gait.status, seams, topology, gait };
}

export function readWalkFrames(sheet: SpriteWalkRaster, size: { width: number; height: number }, clip: readonly Frame[]) {
  const { width, height } = size;
  return clip.map(({ x, y }) => {
    if (x + width > sheet.width || y + height > sheet.height) throw new Error("A walk frame is outside the source atlas.");
    const data = Buffer.allocUnsafe(width * height * 4);
    for (let row = 0; row < height; row++) {
      const offset = ((y + row) * sheet.width + x) * 4;
      data.set(sheet.data.subarray(offset, offset + width * 4), row * width * 4);
    }
    return { width, height, data };
  });
}

/** Include the idle silhouette and labelled cycle phases, with real alpha on a contrasting ground. */
export async function renderWalkFrames(
  standing: SpriteWalkRaster,
  frames: readonly SpriteWalkRaster[],
  direction: CharacterViewDirection,
  landmarks?: SpriteWalkLandmarks,
  selectedFrames?: readonly number[],
  extraMarks: readonly { x: number; y: number; width: number; height: number }[] = [],
) {
  const count = Math.min(12, frames.length);
  const indices = selectedFrames ?? Array.from({ length: count }, (_, n) => Math.round((n * (frames.length - 1)) / Math.max(1, count - 1)));
  const tiles = [standing, ...indices.map((i) => frames[i])];
  const scale = Math.min(1, 140 / standing.height, 140 / standing.width);
  const tw = Math.max(1, Math.round(standing.width * scale)),
    th = Math.max(1, Math.round(standing.height * scale));
  const cols = Math.min(7, tiles.length),
    width = tw * cols,
    height = (th + 18) * Math.ceil(tiles.length / cols);
  const labels: string[] = [],
    images: OverlayOptions[] = [];
  for (const [i, tile] of tiles.entries()) {
    const left = (i % cols) * tw,
      top = Math.floor(i / cols) * (th + 18);
    const input = await sharp(tile.data, { raw: { width: tile.width, height: tile.height, channels: 4 } })
      .resize(tw, th)
      .png()
      .toBuffer();
    images.push({ input, left, top: top + 18 });
    labels.push(
      `<text x="${left + 2}" y="${top + 13}" fill="black" font-size="12">${direction} ${i ? indices[i - 1] : "idle"}</text>`,
    );
  }
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#f1eddf"/><path d="M0 0h10v10H0zM10 10h10v10H10z" fill="#acb8bf"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/>${labels.join("")}</svg>`,
  );
  const marks: string[] = [];
  const sx = tw / standing.width,
    sy = th / standing.height;
  for (const [side, color] of [
    ["left", "#00e1ed"],
    ["right", "#ff5871"],
  ] as const) {
    const pair = landmarks?.[side];
    if (pair)
      for (const box of [pair.hand, pair.foot]) {
        if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
        marks.push(
          `<rect x="${box.x * sx}" y="${box.y * sy}" width="${box.width * sx}" height="${box.height * sy}" stroke="${color}" fill="none"/>`,
        );
      }
  }
  for (const [i, box] of extraMarks.entries()) {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
    const x = box.x * sx, y = box.y * sy;
    marks.push(`<rect x="${x}" y="${y}" width="${box.width * sx}" height="${box.height * sy}" stroke="#00e1ed" fill="none"/>
      <text x="${x}" y="${Math.max(9, y - 1)}" font-size="10" stroke="#fff" stroke-width="2" paint-order="stroke" fill="#172228">${i + 1}</text>`);
  }
  if (marks.length)
    images.push({
      left: 0,
      top: 18,
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}">${marks.join("")}</svg>`),
    });
  return sharp(background).composite(images).removeAlpha().png().toBuffer();
}

export async function readWalkStanding(pkg: Awaited<ReturnType<typeof readWalkPackage>>, direction: CharacterViewDirection) {
  const view = pkg.idle.views[direction]!;
  const bytes = await readSafeProjectFile(pkg.root, await pkg.file(view.file), RASTER_BYTES);
  if (createHash("sha256").update(bytes).digest("hex") !== view.sha256)
    throw new Error(`The ${direction} standing reference no longer matches its publication.`);
  const standing = await decodeWalkPng(bytes);
  if (standing.width !== view.width || standing.height !== view.height)
    throw new Error("Standing PNG dimensions differ from the manifest.");
  return standing;
}

export async function inspectPublishedSpriteWalk(
  project: WalkProject,
  setId: string,
  direction: CharacterViewDirection,
  landmarks?: SpriteWalkLandmarks,
  contacts?: readonly [number, number],
  signal?: AbortSignal,
  includePreview = false,
) {
  const pkg = await readWalkPackage(project, setId, signal);
  const clip = pkg.walk.animations[direction],
    view = pkg.idle.views[direction];
  if (!clip || !view) throw new Error(`No published ${direction} walk loop is available yet.`);
  return serializeRasterDecoding(async () => {
    signal?.throwIfAborted();
    const sheetBytes = await readSafeProjectFile(pkg.root, await pkg.file(pkg.walk.image), RASTER_BYTES);
    const standing = await readWalkStanding(pkg, direction);
    const sheet = await decodeWalkPng(sheetBytes);
    const frames = readWalkFrames(sheet, pkg.walk.frameSize, clip.frames);
    const suggestion = landmarks?.left || landmarks?.right ? undefined : suggestSpriteWalkLandmarks(standing, frames, direction);
    const regions = suggestion ? { ...suggestion.landmarks, ...landmarks } : landmarks;
    const result = reviewSpriteWalkDirection({ standing, frames, direction, landmarks: regions, contacts });
    signal?.throwIfAborted();
    const preview = includePreview ? await renderWalkFrames(standing, frames, direction, regions) : undefined;
    return {
      ...pkg.identity(createHash("sha256").update(sheetBytes).digest("hex")),
      direction,
      ...result,
      ...(suggestion && { landmarkSuggestion: suggestion }),
      standingReference: { file: path.posix.join(pkg.directory, view.file), width: standing.width, height: standing.height },
      ...(preview && { preview }),
    };
  });
}
