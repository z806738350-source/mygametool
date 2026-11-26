import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  CHARACTER_VIEW_DIRECTIONS,
  type CharacterViewPublishInput,
  type CharacterViewRuntimeAsset,
  type CharacterViewRuntimeManifest,
} from "../shared/character-views.js";
import type { ProjectState } from "../shared/contracts.js";
import { runtimeMediaFileLimit } from "../shared/execution-capacity-profiles.js";
import { localAgentPath } from "./agent-local-files.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import type {
  CharacterViewOperationIdentity,
  CharacterViewPublicationJournal,
  CharacterViewPublicationReceipt,
} from "./character-view-publication.js";
import {
  checkCharacterViewPublication,
  stageCharacterViewPngs,
} from "./character-views.js";
import {
  inspectProjectSourceBudget,
  mediaHeaderMatches,
  runtimeMediaPath,
  type ProjectSourceProfile,
} from "./isolated-project-files.js";
import {
  durablePublicationDirectory,
  durablePublicationFile,
} from "./isolated-publication-journal.js";
import { resolveStartupDirectory } from "./projects.js";
import {
  RASTER_BATCH_BYTES,
  RASTER_BYTES,
  RASTER_PIXELS,
} from "./raster-policy.js";
import {
  assertNoKnownSecretBytes,
  inspectSafeProjectMedia,
  readSafeProjectFile,
} from "./safe-project-file.js";

const METADATA_LIMIT = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const metadata = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
const missing = (cause: unknown) =>
  (cause as NodeJS.ErrnoException)?.code === "ENOENT";
const imagePath = (direction: string, revision: string, digest: string) =>
  `images/${direction}-${revision}-${digest}.png`;

type Selection = CharacterViewPublishInput["views"][number];
type StagedObservation = Omit<
  Awaited<ReturnType<typeof stageCharacterViewPngs>>[number],
  "path"
> &
  Pick<
    Selection,
    "sourceHeadY" | "sourceGroundPoint" | "scale" | "sampling" | "visualReview"
  > & { file: string; sourceReference: Selection["source"] };

export interface CharacterViewPublishOptions {
  project: Pick<ProjectState, "workspacePath" | "startupDirectory">;
  setId: string;
  input: CharacterViewPublishInput;
  expectedAuthoringSha256: string;
  identity: CharacterViewOperationIdentity;
  journal: CharacterViewPublicationJournal;
  checkAuthoring(
    bytes: Buffer,
    input: CharacterViewPublishInput,
  ): { displayHeadToGround: number } | Promise<{ displayHeadToGround: number }>;
  readCandidate(source: Selection["source"]): Promise<Buffer>;
  sourceProfile?: () =>
    | ProjectSourceProfile
    | undefined
    | Promise<ProjectSourceProfile | undefined>;
  mutateWorkspace<T>(operation: () => Promise<T>): Promise<T>;
  signal?: AbortSignal;
}

interface PublicationFile {
  path: string;
  sha256: string;
  size: number;
  bytes: () => Promise<Buffer>;
}

async function readMetadata(
  root: string,
  relative: string,
): Promise<Buffer | null> {
  const file = await localAgentPath(root, relative, true);
  try {
    if ((await lstat(file)).mode & 0o111)
      throw new Error("Character publication metadata cannot be executable");
    return await readSafeProjectFile(root, file, METADATA_LIMIT);
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
}

async function checkFile(
  root: string,
  relative: string,
  expected: string,
  size?: number,
  profile?: ProjectSourceProfile,
): Promise<boolean> {
  const file = await localAgentPath(root, relative, true);
  const png = relative.endsWith(".png");
  const limit = png ? runtimeMediaFileLimit(relative, profile) : METADATA_LIMIT;
  try {
    if ((await lstat(file)).mode & 0o111)
      throw new Error("Character publication files cannot be executable");
    const actual = await inspectSafeProjectMedia(root, file, limit);
    if (
      actual.sha256 !== expected ||
      (size !== undefined && actual.size !== size) ||
      (png &&
        (!runtimeMediaPath(relative) ||
          !mediaHeaderMatches(relative, actual.prefix, actual.size, profile)))
    ) {
      throw new Error(
        `Conflicting immutable character publication file at ${relative}`,
      );
    }
    return true;
  } catch (cause) {
    if (missing(cause)) return false;
    throw cause;
  }
}

export function readActiveManifest(
  bytes: Buffer,
  setId: string,
): CharacterViewRuntimeManifest {
  const value = JSON.parse(
    bytes.toString("utf8"),
  ) as CharacterViewRuntimeManifest;
  const invalid = () =>
    new Error("The current character manifest is not a complete managed set");
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.setId !== setId ||
    value.complete !== true ||
    !identifier(value.setRevision) ||
    !identifier(value.designRevision) ||
    value.coordinates !== "top-left-pixel-edges-x-right-y-down" ||
    !Array.isArray(value.directionOrder) ||
    value.directionOrder.length !== 8 ||
    value.directionOrder.some(
      (direction, index) => direction !== CHARACTER_VIEW_DIRECTIONS[index],
    ) ||
    !value.canvas ||
    !value.pivot ||
    !value.views ||
    Object.keys(value.views).length !== 8 ||
    ![value.canvas.width, value.canvas.height].every(
      (dimension) => Number.isSafeInteger(dimension) && dimension >= 1,
    ) ||
    value.canvas.width * value.canvas.height > RASTER_PIXELS ||
    ![value.pivot.x, value.pivot.y, value.headToGround].every(
      Number.isFinite,
    ) ||
    value.pivot.x < 0 ||
    value.pivot.x > value.canvas.width ||
    value.pivot.y > value.canvas.height ||
    value.headToGround <= 0 ||
    value.headToGround > value.pivot.y
  )
    throw invalid();
  const views: CharacterViewRuntimeManifest["views"] = {};
  for (const direction of CHARACTER_VIEW_DIRECTIONS) {
    const asset = value.views[direction];
    if (
      !asset ||
      !identifier(asset.viewRevision) ||
      !SHA256.test(asset.sha256) ||
      asset.file !== imagePath(direction, asset.viewRevision, asset.sha256) ||
      asset.width !== value.canvas.width ||
      asset.height !== value.canvas.height
    )
      throw invalid();
    const { file, sha256, width, height, viewRevision } = asset;
    views[direction] = { file, sha256, width, height, viewRevision };
  }
  return { ...value, views };
}

function failureReason(cause: unknown): string {
  return cause instanceof Error && !(cause as NodeJS.ErrnoException).code
    ? cause.message
    : "Character publication could not finish safely";
}

export async function describeCharacterViewPublishReceipt(
  receipt: CharacterViewPublicationReceipt,
  options: Pick<CharacterViewPublishOptions, "project" | "setId">,
): Promise<CharacterViewPublicationReceipt> {
  if (receipt.state !== "committed") return receipt;
  const result = receipt.result as { manifestPath: string; sha256: string };
  try {
    const startup = await resolveStartupDirectory(
      options.project.workspacePath,
      options.project.startupDirectory ?? ".",
    );
    const base = path.posix.join(
      startup.relativePath,
      "public",
      "characters",
      options.setId,
    );
    const current =
      result && path.posix.dirname(result.manifestPath) === base
        ? await readMetadata(options.project.workspacePath, result.manifestPath)
        : null;
    return {
      state: "committed",
      result: {
        ...result,
        markerCurrent: !!current && sha256(current) === result.sha256,
      },
    };
  } catch {
    // The receipt proves historical commitment even when the current marker is unreadable.
    return {
      state: "committed",
      result: { ...result, markerCurrent: "unverified" },
    };
  }
}

/** Project-authorized reads and the shared writer come from the host. */
export async function publishCharacterViewSet(
  options: CharacterViewPublishOptions,
): Promise<CharacterViewPublicationReceipt> {
  const {
    project,
    setId,
    input,
    expectedAuthoringSha256,
    identity,
    journal,
    signal,
  } = options;
  const root = project.workspacePath;
  if (
    !identifier(setId) ||
    !identifier(input.designRevision) ||
    !SHA256.test(expectedAuthoringSha256) ||
    identity.action !== "publish" ||
    identity.purpose !== input.purpose ||
    (input.expectedActiveSha256 !== null &&
      !SHA256.test(input.expectedActiveSha256))
  ) {
    throw new Error(
      "Invalid character publication identity or expected file digest",
    );
  }
  const prior = await journal.recover(identity);
  if (prior.state !== "missing")
    return describeCharacterViewPublishReceipt(prior, options);
  signal?.throwIfAborted();
  const startup = await resolveStartupDirectory(
    root,
    project.startupDirectory ?? ".",
  );
  const base = path.posix.join(
    startup.relativePath,
    "public",
    "characters",
    setId,
  );
  const authoringPath = path.posix.join(
    "assets/generated/character-sets",
    setId,
    "authoring.json",
  );
  const activePath = path.posix.join(base, "manifest.json");
  const { canvas, pivot, headToGround, purpose } = input;
  if (
    !["sample", "release", "revision"].includes(purpose) ||
    (purpose === "release" && input.views.length !== 8) ||
    (purpose === "revision" && input.views.length !== 1)
  ) {
    throw toolPreflightError(
      "A complete release needs eight directions and a revision needs one direction", "invalid_character_view_input",
    );
  }
  if (canvas.width * canvas.height > RASTER_PIXELS) {
    throw toolPreflightError(
      "Character canvas exceeds the supported raster pixel budget",
      "invalid_character_view_input",
    );
  }

  const readAuthoring = async () => {
    const bytes = await readMetadata(root, authoringPath);
    const current = bytes && sha256(bytes);
    if (!bytes || current !== expectedAuthoringSha256)
      throw toolPreflightError(
        `Character authoring changed. Review ${authoringPath} before continuing. Its expectedAuthoringSha256 is ${current}.`, "invalid_character_view_input",
      );
    return options.checkAuthoring(bytes, input);
  };
  const readActive = async () => {
    const bytes = await readMetadata(root, activePath);
    const current = bytes && sha256(bytes);
    if (current !== input.expectedActiveSha256)
      throw toolPreflightError(
        `The active character manifest changed. Review ${activePath} before continuing. Its expectedActiveSha256 is ${current}.`, "invalid_character_view_input",
      );
    return bytes;
  };
  const readSource = async (selection: Selection) => {
    signal?.throwIfAborted();
    const bytes = await options.readCandidate(selection.source);
    if (
      bytes.length < 1 ||
      bytes.length > RASTER_BYTES ||
      sha256(bytes) !== selection.source.expectedSha256
    )
      throw toolPreflightError(
        `${selection.direction}: the approved source pixels changed or exceeded the raster limit`,
        "invalid_character_view_input",
      );
    return bytes;
  };

  const { displayHeadToGround } = await readAuthoring();
  const geometry = { canvas, pivot, headToGround, displayHeadToGround };
  const candidates = input.views.map((selection) => ({
    direction: selection.direction,
    viewRevision: selection.viewRevision,
    sourceSha256: selection.source.expectedSha256,
    sourceHeadY: selection.sourceHeadY,
    sourceGroundPoint: selection.sourceGroundPoint,
    scale: selection.scale,
    sampling: selection.sampling,
  }));
  try {
    checkCharacterViewPublication(candidates, geometry);
  } catch (cause) {
    throw toolPreflightError(
      failureReason(cause),
      "invalid_character_view_input",
    );
  }
  const before = await readActive();
  const active = before ? readActiveManifest(before, setId) : null;
  if (purpose === "revision") {
    if (
      !active ||
      active.designRevision !== input.designRevision ||
      active.canvas.width !== canvas.width ||
      active.canvas.height !== canvas.height ||
      active.pivot.x !== pivot.x ||
      active.pivot.y !== pivot.y ||
      active.headToGround !== headToGround
    ) {
      throw toolPreflightError(
        "A single-direction revision needs a complete set with the same design and display geometry",
        "invalid_character_view_input",
      );
    }
    if (
      active.views[input.views[0]!.direction]?.viewRevision ===
      input.views[0]!.viewRevision
    )
      throw toolPreflightError("A single-direction edit needs its own view revision", "invalid_character_view_input");
  }
  for (const selection of input.views) await readSource(selection);

  // Reserve a bounded PNG encoding of each RGBA canvas, including filtering, zlib and chunk overhead.
  const filteredBytes = (canvas.width * 4 + 1) * canvas.height;
  const perPng = Math.min(
    RASTER_BYTES,
    Math.ceil(filteredBytes * 1.01) + 64 * 1024,
  );
  const begun = await journal.begin(identity, {
    signal,
    space: {
      rawBytes: 0,
      workingBytes: 0,
      beforeBytes: before?.length ?? 0,
      afterBytes: Math.min(RASTER_BATCH_BYTES, perPng * candidates.length),
      manifestBytes: METADATA_LIMIT,
      reviewBytes: METADATA_LIMIT,
      additionalEntries: 64,
    },
  });
  if (begun.state !== "started")
    return describeCharacterViewPublishReceipt(begun, options);
  const operation = begun.operation;
  const attempted: PublicationFile[] = [];
  async function settle(
    cause: unknown,
    profile?: ProjectSourceProfile,
  ): Promise<CharacterViewPublicationReceipt> {
    try {
      const retainedFiles = [];
      for (const file of attempted) {
        if (await checkFile(root, file.path, file.sha256, file.size, profile))
          retainedFiles.push({ path: file.path, sha256: file.sha256 });
      }
      return await operation.settleFailure(failureReason(cause), {
        retainedFiles,
      });
    } catch {
      return {
        state: "unknown",
        operationId: identity.operationId,
        reason:
          "Cannot verify the original character publication and its retained files",
      };
    }
  }

  try {
    const selections = new Map(
      input.views.map((view) => [view.direction, view]),
    );
    const staged = await stageCharacterViewPngs(
      candidates,
      geometry,
      (candidate) => readSource(selections.get(candidate.direction)!),
      operation,
      signal,
    );
    const stagedFiles: PublicationFile[] = [];
    const selectedViews: CharacterViewRuntimeManifest["views"] = {};
    const observations: StagedObservation[] = [];
    for (const {
      path: privatePath,
      size,
      sha256: digest,
      ...report
    } of staged) {
      const {
        source,
        sourceHeadY,
        sourceGroundPoint,
        scale,
        sampling,
        visualReview,
      } = selections.get(report.direction)!;
      const file = imagePath(report.direction, report.viewRevision, digest);
      const relative = path.posix.join(base, file);
      selectedViews[report.direction] = {
        ...canvas,
        file,
        sha256: digest,
        viewRevision: report.viewRevision,
      };
      stagedFiles.push({
        path: relative,
        size,
        sha256: digest,
        bytes: () =>
          readSafeProjectFile(
            path.dirname(privatePath),
            privatePath,
            RASTER_BYTES,
          ),
      });
      observations.push({
        ...report,
        file,
        sha256: digest,
        size,
        sourceReference: source,
        sourceHeadY,
        sourceGroundPoint,
        scale,
        sampling,
        visualReview,
      });
    }
    const views = Object.fromEntries(
      CHARACTER_VIEW_DIRECTIONS.flatMap((direction) => {
        const asset: CharacterViewRuntimeAsset | undefined =
          selectedViews[direction] ??
          (purpose === "revision" ? active?.views[direction] : undefined);
        return asset ? [[direction, asset]] : [];
      }),
    ) as CharacterViewRuntimeManifest["views"];
    const content = {
      schemaVersion: 1 as const,
      setId,
      designRevision: input.designRevision,
      complete: purpose !== "sample",
      coordinates: "top-left-pixel-edges-x-right-y-down" as const,
      directionOrder: CHARACTER_VIEW_DIRECTIONS,
      canvas,
      pivot,
      headToGround,
      views,
    };
    const setRevision = sha256(metadata(content)).slice(0, 32);
    const manifest = { ...content, setRevision };
    const manifestPath =
      purpose === "sample"
        ? path.posix.join(base, `sample-${setRevision}.json`)
        : activePath;
    const manifestBytes = metadata(manifest);
    const manifestSha = sha256(manifestBytes);
    // The record describes the intended manifest. Only the live manifest establishes adoption.
    const reportPath = path.posix.join(
      path.posix.dirname(authoringPath),
      "publications",
      `${setRevision}.json`,
    );
    const report = metadata({
      schemaVersion: 1,
      setId,
      designRevision: input.designRevision,
      setRevision,
      authoringSha256: expectedAuthoringSha256,
      intendedManifestSha256: manifestSha,
      manifestPath,
      geometry,
      purpose,
      observations,
    });
    if (report.length > METADATA_LIMIT)
      throw new Error("Character measurement record exceeds its size limit");
    assertNoKnownSecretBytes(report);
    stagedFiles.push({
      path: reportPath,
      size: report.length,
      sha256: sha256(report),
      bytes: async () => report,
    });

    return await options.mutateWorkspace(async () => {
      let profile: ProjectSourceProfile | undefined;
      try {
        signal?.throwIfAborted();
        if (
          (await resolveStartupDirectory(root, project.startupDirectory ?? "."))
            .relativePath !== startup.relativePath
        )
          throw new Error(
            "The character publication startup directory changed",
          );
        if ((await readAuthoring()).displayHeadToGround !== displayHeadToGround)
          throw new Error("The approved character display scale changed");
        await readActive();
        for (const selection of input.views) await readSource(selection);
        const markerBefore =
          purpose === "sample"
            ? await readMetadata(root, manifestPath)
            : before;
        if (
          markerBefore &&
          (purpose === "sample" || markerBefore.equals(manifestBytes))
        )
          throw new Error(
            "The requested character publication already has a current marker",
          );
        profile = await options.sourceProfile?.();
        const existing = new Set<string>();
        for (const file of stagedFiles) {
          if (await checkFile(root, file.path, file.sha256, file.size, profile))
            existing.add(file.path);
        }
        const retained = CHARACTER_VIEW_DIRECTIONS.flatMap((direction) => {
          const view = views[direction];
          return view && !selectedViews[direction]
            ? [{ path: path.posix.join(base, view.file), sha256: view.sha256 }]
            : [];
        });
        for (const file of retained) {
          if (
            !(await checkFile(root, file.path, file.sha256, undefined, profile))
          )
            throw new Error(
              "An unchanged direction is missing from the active character set",
            );
        }
        const budget = await inspectProjectSourceBudget(
          root,
          [
            ...stagedFiles.map(({ path, size }) => ({ path, size })),
            { path: manifestPath, size: manifestBytes.length },
          ],
          true,
          signal,
          { profile },
        );
        if (!budget.complete)
          throw new Error(
            "Character publication needs a complete workspace inventory for its capacity check",
          );
        if (Object.values(budget.overage).some((value) => value > 0)) {
          throw new Error(
            `Character publication exceeds the current project budget. Runtime media ${budget.mediaBytes}/${budget.limits.mediaBytes} bytes, source ${budget.totalBytes}/${budget.limits.totalBytes} bytes.`,
          );
        }
        signal?.throwIfAborted();
        await operation.prepareCommit({
          marker: {
            path: manifestPath,
            before: markerBefore,
            after: manifestBytes,
          },
          files: [
            ...stagedFiles.map(({ path, sha256 }) => ({ path, sha256 })),
            ...retained,
          ],
          result: {
            manifestPath,
            manifest,
            sha256: manifestSha,
            reportPath,
            views: observations,
          },
        });
        for (const file of stagedFiles) {
          signal?.throwIfAborted();
          if (existing.has(file.path)) continue;
          const bytes = await file.bytes();
          if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
            throw new Error(
              "Staged character publication bytes changed before commit",
            );
          const target = await localAgentPath(root, file.path, true);
          attempted.push(file);
          await durablePublicationDirectory(path.dirname(target));
          await durablePublicationFile(
            await localAgentPath(root, file.path, true),
            bytes,
          );
        }
        signal?.throwIfAborted();
        await readActive();
        for (const file of [...stagedFiles, ...retained]) {
          if (
            !(await checkFile(root, file.path, file.sha256, undefined, profile))
          )
            throw new Error(
              "Character publication evidence changed before the manifest switch",
            );
        }
        signal?.throwIfAborted();
        await operation.publishMarker();
        return await operation.commit();
      } catch (cause) {
        return settle(cause, profile);
      }
    });
  } catch (cause) {
    return await settle(cause);
  } finally {
    operation.detach();
  }
}
