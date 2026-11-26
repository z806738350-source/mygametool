import { createHash, randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { CharacterViewDirection } from "../shared/character-views.js";
import { runtimeMediaFileLimit } from "../shared/execution-capacity-profiles.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { durablePublicationFile, syncPublicationDirectory } from "./isolated-publication-journal.js";
import { inspectProjectSourceBudget, mediaHeaderMatches, type ProjectSourceProfile } from "./isolated-project-files.js";
import { RASTER_BYTES, serializeRasterDecoding } from "./raster-policy.js";
import { assertNoKnownSecretBytes, readSafeProjectFile } from "./safe-project-file.js";
import type { SpriteWalkLandmarks } from "./sprite-walk-gait.js";
import { repairSpriteWalkDirection } from "./sprite-walk-repair.js";
import { suggestSpriteWalkLandmarks } from "./sprite-walk-landmarks.js";
import {
  decodeWalkPng,
  readPublishedSpriteWalkIdentity,
  readWalkFrames,
  readWalkPackage,
  readWalkStanding,
  renderWalkFrames,
  reviewSpriteWalkDirection,
  type WalkProject,
} from "./sprite-walk-review.js";

export interface SpriteWalkRepairInput {
  setId: string;
  expectedRevision: string;
  candidateDigest?: string;
  directions: readonly {
    direction: CharacterViewDirection;
    landmarks?: SpriteWalkLandmarks;
    contacts?: readonly [number, number];
  }[];
}

type Result = ReturnType<typeof reviewSpriteWalkDirection>;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Called under the project mutation lock; recheck references after staging and immediately before activation. */
export async function publishReviewedSpritePng(
  root: string, relative: string, filename: string, output: Buffer, assertCurrent: () => Promise<void>,
  signal?: AbortSignal, profile?: ProjectSourceProfile,
) {
  if (
    output.length > runtimeMediaFileLimit(relative, profile) ||
    !mediaHeaderMatches(relative, output, output.length, profile)
  )
    throw new Error("The corrected sprite sheet exceeds this project's runtime PNG limits.");
  assertNoKnownSecretBytes(output);
  const budget = await inspectProjectSourceBudget(root, [{ path: relative, size: output.length }], true, signal, {
    profile,
  });
  if (!budget.complete || Object.values(budget.overage).some((n) => n > 0))
    throw new Error("The corrected sprite sheet exceeds the available workspace capacity.");
  const temporary = path.join(path.dirname(filename), `.sprite-${randomUUID()}.tmp`);
  try {
    await durablePublicationFile(temporary, output);
    await assertCurrent();
    await rename(temporary, filename);
    await syncPublicationDirectory(path.dirname(filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The caller owns the project mutation lock. Only this local renderer can supply replacement pixels. */
export async function repairPublishedSpriteWalk(
  project: WalkProject,
  input: SpriteWalkRepairInput,
  signal?: AbortSignal,
  profile?: ProjectSourceProfile,
) {
  let replacing = false;
  try {
    const pkg = await readWalkPackage(project, input.setId, signal);
    if (pkg.walk.gait !== undefined && pkg.walk.gait !== "biped")
      throw new Error("Use this arm and leg repair only for a biped walk.");
    const selected = input.directions.map((item) => item.direction);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some((d) => !pkg.directions.includes(d)))
      throw new Error("Choose distinct published walk directions for repair.");
    const { width, height } = pkg.walk.frameSize;
    const filename = await pkg.file(pkg.walk.image),
      relative = path.posix.join(pkg.directory, pkg.walk.image);
    if (/^images\/(N|NE|E|SE|S|SW|W|NW)-[\w-]+-[a-f0-9]{64}\.png$/i.test(pkg.walk.image))
      throw new Error("Repair the walk sheet separately from immutable standing frames.");
    const rectangles = pkg.directions.flatMap((d) => pkg.walk.animations[d]!.frames.map((f) => ({ ...f, direction: d })));
    for (const [i, a] of rectangles.entries()) {
      if (
        selected.includes(a.direction) &&
        rectangles.some((b, j) => i !== j && Math.abs(a.x - b.x) < width && Math.abs(a.y - b.y) < height)
      )
        throw new Error("Separate shared or overlapping walk frame rectangles before editing an individual pose.");
    }
    return await serializeRasterDecoding(async () => {
      signal?.throwIfAborted();
      const original = await readSafeProjectFile(pkg.root, filename, RASTER_BYTES);
      const identity = pkg.identity(digest(original));
      if (identity.revision !== input.expectedRevision)
        throw new Error("The published walk changed. Inspect the current revision before repairing it.");
      const sheet = await decodeWalkPng(original);
      if (rectangles.some((f) => f.x + width > sheet.width || f.y + height > sheet.height))
        throw new Error("A walk frame is outside the current atlas.");
      const reviews: (Result & { direction: CharacterViewDirection; repairIssue?: string })[] = [];
      const previews: { direction: CharacterViewDirection; data: Buffer }[] = [];
      let updated = false;
      for (const { direction, landmarks: provided, contacts } of input.directions) {
        signal?.throwIfAborted();
        const clip = pkg.walk.animations[direction]!.frames;
        const standing = await readWalkStanding(pkg, direction);
        const frames = readWalkFrames(sheet, pkg.walk.frameSize, clip);
        const landmarks = provided ?? suggestSpriteWalkLandmarks(standing, frames, direction).landmarks;
        const previous = reviewSpriteWalkDirection({ standing, direction, frames, landmarks, contacts });
        if (previous.status !== "fail") {
          reviews.push({ direction, ...previous });
          if (!input.candidateDigest) previews.push({ direction, data: await renderWalkFrames(standing, frames, direction, landmarks) });
          continue;
        }
        let candidate: ReturnType<typeof repairSpriteWalkDirection>;
        try {
          candidate = repairSpriteWalkDirection({ standing, direction, landmarks, frames, contacts, signal });
        } catch (cause) {
          signal?.throwIfAborted();
          reviews.push({ direction, ...previous, repairIssue: cause instanceof Error ? cause.message : "Redraw this action with its hidden joints." });
          if (!input.candidateDigest) previews.push({ direction, data: await renderWalkFrames(standing, frames, direction, landmarks) });
          continue;
        }
        const result = reviewSpriteWalkDirection({ standing, direction, frames: candidate, beforeFrames: frames, landmarks, contacts });
        reviews.push({ direction, ...result });
        if (!input.candidateDigest)
          previews.push({ direction, data: await renderWalkFrames(standing, candidate, direction) });
        for (const [i, f] of clip.entries()) {
          for (let row = 0; row < height; row++) {
            const source = row * width * 4;
            sheet.data.set(candidate[i].data.subarray(source, source + width * 4), ((f.y + row) * sheet.width + f.x) * 4);
          }
        }
        updated = true;
      }
      const status =
        reviews.find((r) => r.status === "fail")?.status ??
        reviews.find((r) => r.status === "inconclusive")?.status ??
        "pass";
      const receipt = {
        ...identity,
        status,
        reviews,
        previews,
        changed: [] as string[],
        candidateDigest: undefined as string | undefined,
      };
      if (status !== "pass" || !updated) return receipt;
      const output = await sharp(sheet.data, { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
        .png()
        .toBuffer();
      const candidateDigest = digest(output);
      if (!input.candidateDigest) return { ...receipt, candidateDigest };
      if (candidateDigest !== input.candidateDigest)
        throw new Error("Repair settings or candidate pixels differ from the reviewed preview.");
      await publishReviewedSpritePng(pkg.root, relative, filename, output, async () => {
        const current = await readPublishedSpriteWalkIdentity(project, input.setId, signal);
        if (current.revision !== identity.revision || (await pkg.file(pkg.walk.image)) !== filename)
          throw new Error("The walk package changed during repair. The new sheet was not activated.");
        signal?.throwIfAborted();
        replacing = true;
      }, signal, profile);
      return { ...receipt, ...pkg.identity(candidateDigest), candidateDigest, changed: [relative] };
    });
  } catch (cause) {
    if (replacing || signal?.aborted) throw cause;
    throw toolPreflightError(
      cause instanceof Error ? cause.message : "The walking sprite could not be prepared.",
      "invalid_sprite_walk_input",
    );
  }
}
