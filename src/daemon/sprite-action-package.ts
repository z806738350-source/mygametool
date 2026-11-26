import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  CHARACTER_VIEW_DIRECTIONS,
  type CharacterViewDirection as Direction,
} from "../shared/character-views.js";
import { localAgentPath } from "./agent-local-files.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { readActiveManifest } from "./character-view-publish.js";
import type { ProjectSourceProfile } from "./isolated-project-files.js";
import { resolveStartupDirectory } from "./projects.js";
import {
  RASTER_BYTES,
  RASTER_PIXELS,
  serializeRasterDecoding,
} from "./raster-policy.js";
import {
  inspectSafeProjectMedia,
  readSafeProjectFile,
} from "./safe-project-file.js";
import {
  applySpriteActionMotionRepair,
  inspectSpriteActionMotion,
  type SpriteActionLandmarks,
} from "./sprite-action-motion.js";
import { observeSpriteActionParts } from "./sprite-action-parts.js";
import {
  inspectSpriteActionDamage,
  repairSpriteActionDamage,
} from "./sprite-action-repair.js";
import type { SpriteWalkRaster } from "./sprite-walk-gait.js";
import { publishReviewedSpritePng } from "./sprite-walk-publish.js";
import {
  decodeWalkPng,
  readWalkFrames,
  renderWalkFrames,
  type WalkProject,
} from "./sprite-walk-review.js";

interface ActionDirection {
  direction: Direction;
  landmarks?: SpriteActionLandmarks;
  parts?: Parameters<typeof observeSpriteActionParts>[2];
}
interface ActionRequest {
  setId: string;
  actionId: string;
  bodyPlan?: string;
  motion?: string;
}
export interface SpriteActionInspection extends ActionRequest, ActionDirection {
  frames?: readonly number[];
  partsRevision?: string;
}
export interface SpriteActionRepairInput extends ActionRequest {
  expectedRevision: string;
  candidateDigest?: string;
  directions: readonly ActionDirection[];
}
interface Frame {
  x: number;
  y: number;
  durationMs?: number;
}
interface Clip {
  frames: Frame[];
  reference?: string;
  loop?: boolean;
}
interface ActionManifest {
  image: string;
  frameSize: { width: number; height: number };
  bodyPlan?: string;
  motion?: string;
  gait?: string;
  animations: Partial<Record<Direction, Clip>>;
}
type Status = "pass" | "fail" | "inconclusive";
const identifier = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const png = /^(?:[\w-]+\/)*[\w.-]+\.png$/i;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const invalid = (message: string) =>
  toolPreflightError(message, "invalid_sprite_action_input");

async function openAction(
  project: WalkProject,
  setId: string,
  actionId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    !identifier.test(setId) ||
    !identifier.test(actionId) ||
    actionId === "manifest"
  )
    throw invalid("Choose an existing character and action ID.");
  const root = project.workspacePath;
  const startup = await resolveStartupDirectory(
    root,
    project.startupDirectory ?? ".",
  );
  const directory = path.posix.join(
    startup.relativePath,
    "public",
    "characters",
    setId,
  );
  const file = (name: string) =>
    localAgentPath(root, path.posix.join(directory, name));
  const metadata = (name: string) =>
    file(name).then((f) => readSafeProjectFile(root, f, 1024 * 1024));
  const actionBytes = await metadata(actionId + ".json");
  const action: ActionManifest = JSON.parse(actionBytes.toString("utf8"));
  const size = action?.frameSize;
  if (
    !size ||
    ![size.width, size.height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    typeof action.image !== "string" ||
    !png.test(action.image) ||
    !action.animations ||
    typeof action.animations !== "object" ||
    Array.isArray(action.animations) ||
    [action.bodyPlan, action.motion, action.gait].some(
      (v) => v !== undefined && (typeof v !== "string" || !identifier.test(v)),
    )
  )
    throw invalid(
      "Use a package-relative PNG, positive frame dimensions and named directional clips.",
    );
  const directions = CHARACTER_VIEW_DIRECTIONS.filter((d) =>
    Object.hasOwn(action.animations, d),
  );
  if (
    !directions.length ||
    directions.length !== Object.keys(action.animations).length
  )
    throw invalid(
      "Use the actual published facings (N, NE, E, SE, S, SW, W, NW). A single facing is sufficient.",
    );
  for (const d of directions) {
    const c = action.animations[d];
    if (
      !c ||
      !Array.isArray(c.frames) ||
      c.frames.length < 2 ||
      c.frames.length > 128 ||
      c.frames.length * size.width * size.height > RASTER_PIXELS ||
      !c.frames.every(
        (f) =>
          f &&
          [f.x, f.y].every((v) => Number.isSafeInteger(v) && v >= 0) &&
          (f.durationMs === undefined ||
            (Number.isFinite(f.durationMs) && f.durationMs > 0)),
      ) ||
      (c.loop !== undefined && typeof c.loop !== "boolean") ||
      (c.reference !== undefined &&
        (typeof c.reference !== "string" || !png.test(c.reference)))
    )
      throw invalid(
        `Invalid frame rectangles, reference PNG or loop setting for ${d}.`,
      );
  }
  const useIdle = directions.some((d) => !action.animations[d]!.reference);
  const idleBytes = useIdle ? await metadata("manifest.json") : undefined;
  const idle = idleBytes ? readActiveManifest(idleBytes, setId) : undefined;
  const hash = createHash("sha256").update(actionBytes);
  if (idleBytes) hash.update(idleBytes);
  const references = new Map<Direction, { filename: string; sha256: string }>();
  for (const d of directions) {
    const ref = action.animations[d]!.reference;
    const managed = idle?.views[d];
    const name = ref ?? managed?.file;
    if (!name) throw invalid(`Supply a registered standing PNG for ${d}.`);
    if (name.toLowerCase() === action.image.toLowerCase())
      throw invalid(
        "Keep the standing reference separate from the moving sheet.",
      );
    const filename = await file(name);
    const { sha256 } = await inspectSafeProjectMedia(
      root,
      filename,
      RASTER_BYTES,
      16,
      signal,
    );
    if (!ref && sha256 !== managed?.sha256)
      throw invalid(`The published ${d} standing image changed.`);
    hash.update(sha256);
    references.set(d, { filename, sha256 });
  }
  const identity = (sheet: string) => ({
    revision: hash.copy().update(sheet).digest("hex"),
    directions,
    image: action.image,
  });
  const filename = await file(action.image);
  return {
    root,
    directory,
    file,
    filename,
    action,
    directions,
    references,
    identity,
  };
}
type Package = Awaited<ReturnType<typeof openAction>>;
export async function readPublishedSpriteActionIdentity(
  project: WalkProject,
  setId: string,
  actionId: string,
  signal?: AbortSignal,
) {
  const pkg = await openAction(project, setId, actionId, signal);
  const kind = classified(pkg, { setId, actionId });
  return {
    ...pkg.identity(
      (
        await inspectSafeProjectMedia(
          pkg.root,
          pkg.filename,
          RASTER_BYTES,
          16,
          signal,
        )
      ).sha256,
    ),
    ...kind,
  };
}

function classified(pkg: Package, request: ActionRequest) {
  const bodyPlan =
    pkg.action.bodyPlan ?? pkg.action.gait ?? request.bodyPlan ?? "unknown";
  const motionName = pkg.action.motion ?? request.motion ?? request.actionId;
  if (
    (pkg.action.bodyPlan &&
      request.bodyPlan &&
      pkg.action.bodyPlan !== request.bodyPlan) ||
    (pkg.action.motion &&
      request.motion &&
      request.motion !== pkg.action.motion)
  )
    throw invalid(
      "Use the anatomy and action of the published clip. Correct its metadata if it labels the artwork incorrectly.",
    );
  if (
    (request.actionId === "walk" &&
      ((!pkg.action.bodyPlan && !pkg.action.gait) ||
        bodyPlan === "biped" ||
        pkg.action.gait === "biped")) ||
    (motionName === "walk" && bodyPlan === "biped")
  )
    throw invalid("Use review_sprite_walk for a published biped walk.");
  return { bodyPlan, motionName };
}

async function directionFrames(
  pkg: Package,
  sheet: SpriteWalkRaster,
  direction: Direction,
) {
  const clip = pkg.action.animations[direction];
  const ref = pkg.references.get(direction);
  if (!clip || !ref)
    throw invalid(`No published ${direction} clip is available.`);
  const bytes = await readSafeProjectFile(pkg.root, ref.filename, RASTER_BYTES);
  if (digest(bytes) !== ref.sha256)
    throw invalid("The standing reference changed. Reopen the current clip.");
  const standing = await decodeWalkPng(bytes);
  const size = pkg.action.frameSize;
  if (size.width !== standing.width || size.height !== standing.height)
    throw invalid("Align the reference and action frames on the same canvas.");
  return { standing, frames: readWalkFrames(sheet, size, clip.frames), clip };
}

function assess(
  standing: SpriteWalkRaster,
  frames: SpriteWalkRaster[],
  clip: Clip,
  { direction, landmarks, parts: selectedParts }: ActionDirection,
  { bodyPlan, motionName }: ReturnType<typeof classified>,
) {
  const damage = inspectSpriteActionDamage(
    standing,
    frames,
    clip.loop ?? false,
  );
  const motion = inspectSpriteActionMotion({
    standing,
    frames,
    direction,
    action: motionName,
    bodyPlan,
    landmarks,
  });
  if (
    motion.repair?.kind === "retime-hindlegs" &&
    (!clip.loop ||
      motion.repair.sourceFrames.some(
        (source, i) =>
          clip.frames[i].durationMs !== clip.frames[source].durationMs,
      ))
  ) {
    delete motion.repair;
    const failure = motion.checks.find((c) => c.status === "fail");
    if (failure)
      failure.reason +=
        " Redraw this stride to preserve the clip's timing. Automatic phase transfer requires a loop with matching donor and destination durations.";
  }
  const parts = selectedParts?.length
    ? observeSpriteActionParts(standing, frames, selectedParts)
    : [];
  for (const part of parts) motion.keyframes.push(...part.keyframes);
  const markedParts = [
    ...parts.map(({ name, region }) => ({ name, region })),
    ...Object.entries(motion.landmarks).map(([name, region]) => ({
      name,
      region,
    })),
  ];
  const first = frames[0].data;
  const hasVisibleMotion = frames.slice(1).some(({ data }) => {
    for (let i = 0; i < first.length; i += 4)
      if (
        first[i + 3] !== data[i + 3] ||
        (data[i + 3] > 0 &&
          (first[i] !== data[i] ||
            first[i + 1] !== data[i + 1] ||
            first[i + 2] !== data[i + 2]))
      )
        return true;
    return false;
  });
  const status: Status =
    motion.status === "fail" || damage.some((f) => f.certainty === "confirmed")
      ? "fail"
      : damage.length || !hasVisibleMotion
        ? "inconclusive"
        : motion.status;
  return {
    direction,
    status,
    damage,
    motion,
    bodyPlan,
    motionName,
    hasVisibleMotion,
    parts,
    markedParts,
  };
}
type Review = ReturnType<typeof assess>;

function pickFrames(
  count: number,
  review: Review,
  requested?: readonly number[],
) {
  if (requested) {
    if (
      !requested.length ||
      requested.length > 12 ||
      requested.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= count)
    )
      throw invalid(
        `Choose up to 12 zero-based frame indices from this ${count}-frame action.`,
      );
    return [...new Set(requested)].sort((a, b) => a - b);
  }
  const indices = new Set<number>();
  const add = (n: number) => {
    if (indices.size < 12 && n >= 0 && n < count) indices.add(n);
  };
  // Show the measured events and the affected neighbourhood even when the atlas has many in-between poses.
  for (const d of review.damage) add(d.frame);
  for (const c of review.motion.checks)
    if (c.status === "fail") for (const n of c.frames) add(n);
  for (const f of review.motion.keyframes) add(f.frame);
  for (const d of review.damage) {
    add(d.frame - 1);
    add(d.frame + 1);
  }
  const samples = Math.min(count, 12);
  for (let i = 0; i < samples; i++)
    add(Math.round((i * (count - 1)) / (samples - 1)));
  return [...indices].sort((a, b) => a - b);
}

async function preview(
  standing: SpriteWalkRaster,
  frames: SpriteWalkRaster[],
  report: Review,
  selected: number[],
) {
  const marks = report.markedParts.map((p) => p.region);
  return renderWalkFrames(
    standing,
    frames,
    report.direction,
    undefined,
    selected,
    marks,
  );
}

export async function inspectPublishedSpriteAction(
  project: WalkProject,
  input: SpriteActionInspection,
  signal?: AbortSignal,
  includePreview = false,
) {
  const pkg = await openAction(project, input.setId, input.actionId, signal);
  const kind = classified(pkg, input);
  return serializeRasterDecoding(async () => {
    signal?.throwIfAborted();
    const bytes = await readSafeProjectFile(
      pkg.root,
      pkg.filename,
      RASTER_BYTES,
    );
    const sheet = await decodeWalkPng(bytes);
    const { standing, frames, clip } = await directionFrames(
      pkg,
      sheet,
      input.direction,
    );
    const identity = pkg.identity(digest(bytes));
    const parts =
      !input.partsRevision || input.partsRevision === identity.revision
        ? input.parts
        : undefined;
    const report = assess(standing, frames, clip, { ...input, parts }, kind);
    const indices = pickFrames(frames.length, report, input.frames);
    return {
      ...identity,
      ...report,
      frameCount: frames.length,
      previewFrames: includePreview ? indices : [],
      ...(includePreview && {
        preview: await preview(standing, frames, report, indices),
      }),
    };
  });
}

// Two actions may deliberately reuse the same runtime sheet. Keep its shared cells read-only.
async function checkSharedCells(
  pkg: Package,
  actionId: string,
  selected: Frame[],
) {
  const dir = path.dirname(pkg.filename);
  const size = pkg.action.frameSize;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      entry.name === actionId + ".json"
    )
      continue;
    const bytes = await readSafeProjectFile(
      pkg.root,
      await pkg.file(entry.name),
      1024 * 1024,
    );
    let other: Partial<ActionManifest>;
    try {
      other = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (!other || !other.animations || typeof other.animations !== "object")
      continue;
    const clips = Object.values(other.animations);
    if (
      clips.some(
        (c) =>
          typeof c?.reference === "string" &&
          c.reference.toLowerCase() === pkg.action.image.toLowerCase(),
      )
    )
      throw invalid("This sheet is a standing reference for another action.");
    if (
      typeof other.image !== "string" ||
      other.image.toLowerCase() !== pkg.action.image.toLowerCase()
    )
      continue;
    const bounds = other.frameSize;
    if (
      !bounds ||
      ![bounds.width, bounds.height].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      clips.some(
        (c) =>
          !Array.isArray(c?.frames) ||
          c.frames.some(
            (f) =>
              !f ||
              ![f.x, f.y].every(Number.isSafeInteger) ||
              selected.some(
                (a) =>
                  a.x < f.x + bounds.width &&
                  f.x < a.x + size.width &&
                  a.y < f.y + bounds.height &&
                  f.y < a.y + size.height,
              ),
          ),
      )
    )
      throw invalid(
        "A sibling action shares these frame rectangles. Correct their owning source together.",
      );
  }
}

export async function repairPublishedSpriteAction(
  project: WalkProject,
  input: SpriteActionRepairInput,
  signal?: AbortSignal,
  profile?: ProjectSourceProfile,
) {
  const pkg = await openAction(project, input.setId, input.actionId, signal);
  const kind = classified(pkg, input);
  const selected = input.directions.map((d) => d.direction);
  if (
    !selected.length ||
    selected.length !== new Set(selected).size ||
    selected.some((d) => !pkg.directions.includes(d))
  )
    throw invalid("Select distinct published directions.");
  if (pkg.action.image !== input.actionId + ".png")
    throw invalid(
      "Automatic local repair requires the action's own PNG named after its action ID. Redraw shared atlas frames in their source workflow.",
    );
  const { width, height } = pkg.action.frameSize;
  const rects = pkg.directions.flatMap((d) =>
    pkg.action.animations[d]!.frames.map((f) => ({ ...f, direction: d })),
  );
  if (
    rects.some(
      (a, i) =>
        selected.includes(a.direction) &&
        rects.some(
          (b, j) =>
            i !== j &&
            Math.abs(a.x - b.x) < width &&
            Math.abs(a.y - b.y) < height,
        ),
    )
  )
    throw invalid(
      "Separate overlapping frame rectangles before replacing their pixels.",
    );
  const affected = rects.filter((f) => selected.includes(f.direction));
  await checkSharedCells(pkg, input.actionId, affected);
  return serializeRasterDecoding(async () => {
    signal?.throwIfAborted();
    const bytes = await readSafeProjectFile(
      pkg.root,
      pkg.filename,
      RASTER_BYTES,
    );
    const identity = pkg.identity(digest(bytes));
    if (identity.revision !== input.expectedRevision)
      throw invalid("The action changed. Review the current published frames.");
    const sheet = await decodeWalkPng(bytes);
    if (
      rects.some(
        (f) => f.x + width > sheet.width || f.y + height > sheet.height,
      )
    )
      throw invalid("Frame outside the published atlas.");
    const previews: { direction: Direction; data: Buffer }[] = [];
    const reviews: Review[] = [],
      changed: string[] = [];
    let updated = false;
    for (const selection of input.directions) {
      signal?.throwIfAborted();
      const { standing, frames, clip } = await directionFrames(
        pkg,
        sheet,
        selection.direction,
      );
      const loop = clip.loop ?? false;
      const before = assess(standing, frames, clip, selection, kind);
      let after = before;
      let poses: SpriteWalkRaster[] = frames;
      if (before.status === "fail") {
        const repaired = repairSpriteActionDamage(standing, frames, loop);
        const order = before.motion.repair;
        poses = order
          ? applySpriteActionMotionRepair(repaired.frames, order)
          : repaired.frames;
        after = assess(standing, poses, clip, selection, kind);
        const lostEvidence = before.motion.checks.some(
          (c) =>
            c.status === "pass" &&
            !after.motion.checks.some(
              (p) => p.name === c.name && p.status === "pass",
            ),
        );
        if (
          lostEvidence ||
          (before.motion.status === "fail" && after.motion.status !== "pass") ||
          after.damage.some(
            (f) =>
              !before.damage.some(
                (p) =>
                  p.frame === f.frame &&
                  p.kind === f.kind &&
                  p.x === f.x &&
                  p.y === f.y,
              ),
          )
        ) {
          after = before;
          poses = frames;
        } else if (
          after.status !== "fail" &&
          (repaired.changedFrames.length || order)
        ) {
          updated = true;
          for (const [i, f] of clip.frames.entries()) {
            for (let y = 0; y < height; y++) {
              const row = y * width * 4;
              sheet.data.set(
                poses[i].data.subarray(row, row + width * 4),
                ((f.y + y) * sheet.width + f.x) * 4,
              );
            }
          }
        }
      }
      reviews.push(after);
      if (!input.candidateDigest)
        previews.push({
          direction: selection.direction,
          data: await preview(
            standing,
            poses,
            after,
            pickFrames(poses.length, after),
          ),
        });
    }
    const status: Status = reviews.some((r) => r.status === "fail")
      ? "fail"
      : reviews.some((r) => r.status === "inconclusive")
        ? "inconclusive"
        : "pass";
    const receipt = {
      ...identity,
      status,
      reviews,
      previews,
      changed,
      candidateDigest: undefined as string | undefined,
    };
    if (!updated || status === "fail") return receipt;
    const out = await sharp(sheet.data, {
      raw: { width: sheet.width, height: sheet.height, channels: 4 },
    })
      .png()
      .toBuffer();
    const candidateDigest = digest(out);
    if (!input.candidateDigest) return { ...receipt, candidateDigest };
    if (candidateDigest !== input.candidateDigest)
      throw invalid(
        "The candidate differs from the preview. Inspect the current candidate.",
      );
    const relative = path.posix.join(pkg.directory, pkg.action.image);
    await publishReviewedSpritePng(
      pkg.root,
      relative,
      pkg.filename,
      out,
      async () => {
        await checkSharedCells(pkg, input.actionId, affected);
        if (
          (
            await readPublishedSpriteActionIdentity(
              project,
              input.setId,
              input.actionId,
              signal,
            )
          ).revision !== identity.revision ||
          (await pkg.file(pkg.action.image)) !== pkg.filename
        )
          throw invalid("The published action changed during repair.");
        signal?.throwIfAborted();
      },
      signal,
      profile,
    );
    return {
      ...receipt,
      ...pkg.identity(candidateDigest),
      candidateDigest,
      changed: [relative],
    };
  });
}
