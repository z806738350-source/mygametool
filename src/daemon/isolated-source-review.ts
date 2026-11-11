import { createHash, randomUUID } from "node:crypto";
import {
  createSourceManifest,
  createSourceManifestV2,
  parseSourceManifest,
  parseSourceContract,
  sourceManifestFromLegacyBaseline,
  planSourceDelta,
  assertSourceDeltaSummary,
  type SourceManifest,
  type SourceManifestEntryV1,
  type SourceDeltaSummaryV1,
  type SourceContract,
} from "./isolated-source-manifest.js";
import { lstat, readdir, realpath, rename } from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import type {
  IsolatedSourceReview,
  IsolatedSourceReviewFile,
  RetainedImageMetadata,
  RetainedImageMimeType,
  RetainedImageVariant,
} from "../shared/execution-storage.js";
import { containsKnownSensitiveValue, knownSensitiveValueRevision } from "../shared/sensitive-values.js";
import { sniffImageType } from "./image-format.js";
import { prepareSessionImageDisplay } from "./retained-image-display.js";
import {
  projectFiles,
  inspectRuntimeMedia,
  mediaHeaderMatches,
  runtimeMediaPath,
  inspectProjectSourceBudget,
  transferPath,
  type TransferFile,
  type RuntimeMedia,
} from "./isolated-project-files.js";
import {
  durablePublicationDirectory,
  durablePublicationFile,
  syncPublicationDirectory,
} from "./isolated-publication-journal.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { parseCanvasJson } from "./canvas-files.js";
import { CANVAS_BOARD_SCHEMA } from "../shared/canvas-workspace.js";
import {
  sourceRecoveryBudget,
  assertSourcePublicationCapacity,
} from "./isolated-source-changes.js";
import { runtimeMediaFileLimit, getRuntimeCapacityProfile, type RuntimeCapacityProfileId } from "../shared/execution-capacity-profiles.js";
import { localAgentPath } from "./agent-local-files.js";
import type { RasterReturnReceipt } from "./isolated-raster-returns.js";
import {
  isStaticRasterPath,
  validateRasterReturn,
} from "./isolated-raster-returns.js";
import {
  prepareWorkingImage,
  serializeWorkingImages,
} from "./image-working-assets.js";

export interface ReviewVersion {
  path: string;
  sha256: string;
  executable?: boolean;
  size?: number;
  mode?: number;
}
export interface StoredSourceReview {
  version: 1;
  nonce: string;
  namespace: "manual" | "test";
  workspace: string;
  review: IsolatedSourceReview;
  hostFiles: ReviewVersion[];
  targetFiles: ReviewVersion[];
  guestBaseline: ReviewVersion[];
  separateMedia: boolean;
  approvedAt?: string;
  acknowledged?: boolean;
  superseded?: boolean;
  retained?: RetainedReviewPlan;
  publicationId?: string;
  recoveryOperationId?: string;
}
export interface PreparedRasterFile extends RuntimeMedia {
  artifactKind: "raw" | "working";
  artifactId: string;
  rasterPolicyVersion: 2;
  executable: false;
}
export interface ReviewSnapshot {
  files: Array<TransferFile | RuntimeMedia | PreparedRasterFile>;
  baselineFiles: ReviewVersion[];
  snapshotId: string;
  sourceManifestVersion?: 1 | 2;
  sourceProfileId?: RuntimeCapacityProfileId;
  sourceBaselineManifest?: SourceManifest;
  sourceManifest?: SourceManifest;
  sourceDelta?: SourceDeltaSummaryV1;
  sourceResultManifestId?: string;
}
export interface RetainedReviewSnapshot extends ReviewSnapshot {
  reviewVersion: 2;
  rasterReturnVersion: 0 | 1 | 2;
  retainedRasters: Array<RuntimeMedia & { executable: false }>;
  originOperations: Array<{
    operationId: string;
    mode: string;
    phase: string;
    snapshotId: string | null;
    acknowledged: boolean;
    sourceManifestVersion?: 1 | 2;
    sourceProfileId?: RuntimeCapacityProfileId;
    sourceBaseManifestId?: string;
    sourceResultManifestId?: string;
  }>;
}
interface RetainedReviewFile extends ReviewVersion {
  kind: "source" | "verified-media" | "retained-raster";
  artifact?: string;
  rasterBaseSha256?: string;
}
interface PreparedReviewImage {
  originalSha256: string;
  originalBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  maxEdge?: number;
  originalRetained: boolean;
  workingSha256?: string;
  needsMaxEdge?: boolean;
  error?: string;
}
export interface RetainedReviewPlan {
  reviewVersion: 2;
  rasterPolicyVersion?: 2;
  rawSnapshotId: string;
  rasterReturnVersion: 0 | 1 | 2;
  rawFiles: RetainedReviewFile[];
  originOperations: RetainedReviewSnapshot["originOperations"];
  images: Record<string, PreparedReviewImage>;
  allOriginalsRetained: boolean;
  retentionError?: string;
  preparedBatchId?: string;
  sourceContract?: SourceContract;
  sourceBaselineSizes?: number[];
}
export function reviewSnapshotDigest(files: ReviewVersion[]): string {
  const compare = (a: string, b: string) => {
    const left = Array.from(a),
      right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
      if (difference) return difference;
    }
    return left.length - right.length;
  };
  return digest(
    JSON.stringify(
      files
        .map((file) => ({
          executable: !!file.executable,
          path: file.path,
          sha256: file.sha256,
        }))
        .sort((a, b) => compare(a.path, b.path)),
    ).replace(
      /[\u007f-\uffff]/g,
      (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
    ),
  );
}
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const fingerprint = (files: ReviewVersion[]) =>
  JSON.stringify(
    files
      .map((f) => ({
        path: f.path,
        sha256: f.sha256,
        executable: !!f.executable,
        mode: f.mode,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
const code = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".bash",
  ".html",
  ".htm",
  ".svg",
  ".css",
  ".scss",
  ".glsl",
  ".vert",
  ".frag",
]);
const text = new Set([
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
]);
const isCode = (name: string) =>
  code.has(path.extname(name).toLowerCase()) ||
  [".json", ".yaml", ".yml", ".toml"].includes(
    path.extname(name).toLowerCase(),
  ) ||
  /^agents\.md$/i.test(path.basename(name));
const hashPattern = /^[a-f0-9]{64}$/;

function refusal(reason: string) {
  return Object.assign(
    new Error(
      `Retained source review: ${reason}. All versions remain retained; do not rerun or regenerate.`,
    ),
    { code: "ISOLATED_REVIEW_REQUIRED" },
  );
}

/** The ignored set is trusted reviewed paths only; the publisher separately verifies those exact inodes. */
export async function reviewHostFiles(
  workspace: string,
  ignored?: ReadonlySet<string>,
  separateMedia = true,
  options?: { profile?: RuntimeCapacityProfileId; signal?: AbortSignal },
): Promise<ReviewVersion[]> {
  const media: RuntimeMedia[] = [];
  const files = await projectFiles(
    workspace,
    separateMedia ? media : undefined,
    ignored,
    options,
  );
  if (
    [...files, ...media].some((file) => containsKnownSensitiveValue(file.path))
  )
    throw refusal("protected file identity");
  return Promise.all(
    [...files, ...media].map(async (f) => ({
      path: f.path,
      sha256: f.sha256,
      executable: "executable" in f && f.executable === true,
      size: "size" in f ? f.size : Buffer.byteLength(f.data, "base64"),
      mode: (await lstat(path.join(workspace, f.path))).mode & 0o777,
    })),
  );
}

function identity(record: StoredSourceReview): string {
  const { projectId, generation, snapshotId, files, blockers } = record.review;
  return digest(
    JSON.stringify({
      version: 1,
      nonce: record.nonce,
      namespace: record.namespace,
      workspace: record.workspace,
      projectId,
      generation,
      snapshotId,
      files,
      blockers,
      hostFiles: record.hostFiles,
      targetFiles: record.targetFiles,
      guestBaseline: record.guestBaseline,
      separateMedia: record.separateMedia,
      ...(record.retained
        ? {
            retained: record.retained,
            reviewVersion: record.review.reviewVersion,
            rawSnapshotId: record.review.rawSnapshotId,
            preparedSnapshotId: record.review.preparedSnapshotId,
            optimizablePaths: record.review.optimizablePaths,
            publicationUnchanged: record.review.publicationUnchanged,
            ...(record.review.sourceManifestVersion !== undefined
              ? {
                  sourceManifestVersion: record.review.sourceManifestVersion,
                  ...(record.review.sourceProfileId !== undefined
                    ? { sourceProfileId: record.review.sourceProfileId }
                    : {}),
                  sourceRawDelta: record.review.sourceRawDelta,
                  sourcePreparedDelta: record.review.sourcePreparedDelta,
                }
              : {}),
          }
        : {}),
    }),
  );
}

function createReviewManifest(
  files: readonly SourceManifestEntryV1[],
  contract?: SourceContract,
): SourceManifest {
  return contract?.version === 2
    ? createSourceManifestV2(contract.profileId, files)
    : createSourceManifest(files);
}
function baselineReviewManifest(
  files: ReviewVersion[],
  sizes: number[],
  contract: SourceContract,
): SourceManifest {
  return sourceManifestFromLegacyBaseline(
    files,
    sizes,
    contract.version === 2
      ? { sourceManifestVersion: 2, sourceProfileId: contract.profileId }
      : undefined,
  );
}
function manifestForRawFiles(
  files: RetainedReviewFile[],
  contract?: SourceContract,
): SourceManifest {
  return createReviewManifest(
    files.map((file) => ({
      path: file.path,
      kind: file.kind === "source" ? ("source" as const) : ("media" as const),
      size: file.size!,
      sha256: file.sha256,
      executable: file.executable === true,
    })),
    contract,
  );
}

function manifestForPreparedSnapshot(
  snapshot: ReviewSnapshot,
  plan: RetainedReviewPlan,
): SourceManifest {
  const raw = new Map(plan.rawFiles.map((file) => [file.path, file]));
  if (snapshot.files.length !== raw.size)
    throw refusal("incomplete prepared source manifest");
  return createReviewManifest(
    snapshot.files.map((file) => {
      const original = raw.get(file.path);
      if (!original) throw refusal("unexpected prepared source path");
      return {
        path: file.path,
        kind: "data" in file ? ("source" as const) : ("media" as const),
        size:
          "data" in file ? Buffer.byteLength(file.data, "base64") : file.size,
        sha256: file.sha256,
        executable: "executable" in file && file.executable === true,
      };
    }),
    plan.sourceContract,
  );
}

/** Reconstruct compact identities independently of the untrusted receipt. */
export function reviewSourceManifests(record: StoredSourceReview): {
  base: SourceManifest;
  raw: SourceManifest;
  prepared?: SourceManifest;
} {
  const plan = record.retained;
  if (!plan?.sourceContract || !plan.sourceBaselineSizes)
    throw refusal("review has no versioned source manifest");
  const base = baselineReviewManifest(
    record.guestBaseline,
    plan.sourceBaselineSizes,
    plan.sourceContract,
  );
  const raw = manifestForRawFiles(plan.rawFiles, plan.sourceContract);
  const prepared = plan.sourceContract.preparedManifestId
    ? createReviewManifest(
        raw.files.map((file) => {
          const image = plan.images[file.path];
          if (!image) return file;
          if (!image.workingSha256)
            throw refusal("prepared image is incomplete");
          const kind =
            plan.rasterPolicyVersion === 2 &&
            runtimeMediaPath(file.path) &&
            isStaticRasterPath(file.path)
              ? ("media" as const)
              : file.kind;
          const executable = kind === "media" ? false : file.executable;
          if (image.workingSha256 === file.sha256)
            return { ...file, kind, executable };
          const reviewed = record.review.files.find(
            (candidate) => candidate.path === file.path,
          );
          if (
            !reviewed ||
            reviewed.afterSha256 !== image.workingSha256 ||
            !Number.isSafeInteger(reviewed.bytes)
          )
            throw refusal(
              "prepared image is missing its reviewed byte binding",
            );
          return {
            ...file,
            kind,
            executable,
            sha256: image.workingSha256,
            size: reviewed.bytes,
          };
        }),
        plan.sourceContract,
      )
    : undefined;
  const contract = parseSourceContract(plan.sourceContract);
  if (
    base.manifestId !== contract.baseManifestId ||
    raw.manifestId !== contract.rawManifestId ||
    (contract.preparedManifestId !== undefined &&
      prepared?.manifestId !== contract.preparedManifestId)
  )
    throw refusal("source manifest identities do not match the review");
  return { base, raw, ...(prepared ? { prepared } : {}) };
}

export function reviewSourceContract(
  record: StoredSourceReview,
): SourceContract | undefined {
  if (!record.retained?.sourceContract) return undefined;
  reviewSourceManifests(record);
  return parseSourceContract(record.retained.sourceContract);
}

export async function buildSourceReview(
  workspace: string,
  namespace: "manual" | "test",
  projectId: string,
  generation: number,
  snapshot: ReviewSnapshot,
  retained?: RetainedReviewPlan,
  signal?: AbortSignal,
): Promise<StoredSourceReview> {
  signal?.throwIfAborted();
  const separateMedia =
    !!retained ||
    snapshot.baselineFiles.some((file) => file.size !== undefined) ||
    snapshot.files.some((file) => !("data" in file));
  const profile =
    retained?.sourceContract?.version === 2
      ? retained.sourceContract.profileId
      : undefined;
  const hostFiles = await reviewHostFiles(workspace, undefined, separateMedia, {
      profile,
      signal,
    }),
    host = new Map(hostFiles.map((f) => [f.path, f]));
  const baseline = new Map(snapshot.baselineFiles.map((f) => [f.path, f]));
  const files: IsolatedSourceReviewFile[] = [],
    blockers: IsolatedSourceReview["blockers"] = [];
  const target = new Map(hostFiles.map((f) => [f.path, f]));
  const rasterReceipts: RasterReturnReceipt[] = [];
  const seen = new Set<string>(),
    approvedMedia = new Map(
      snapshot.baselineFiles
        .filter((f) => f.size !== undefined)
        .map((f) => [f.sha256, f]),
    );
  let bytes = 0,
    previewLeft = 64 * 1024;
  if (snapshot.files.length > 2000 || snapshot.baselineFiles.length > 2000)
    throw refusal("file count exceeds the existing limit");
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    transferPath(file.path);
    await localAgentPath(workspace, file.path, true);
    if (containsKnownSensitiveValue(file.path))
      throw refusal("protected file identity");
    if (
      seen.has(file.path) ||
      !hashPattern.test(file.sha256) ||
      file.path
        .split("/")
        .some((p) => ["node_modules", "dist", "build", "out"].includes(p))
    )
      throw refusal("invalid or duplicate candidate path");
    seen.add(file.path);
    const before = baseline.get(file.path),
      current = host.get(file.path);
    const raw = retained?.rawFiles.find((item) => item.path === file.path);
    const optimization = retained?.images[file.path];
    const changed =
      before?.sha256 !== (raw?.sha256 ?? file.sha256) ||
      !!before?.executable !== ("executable" in file && !!file.executable);
    if (
      retained &&
      (optimization?.error ||
        (raw && raw.kind !== "verified-media" && !raw.artifact))
    ) {
      if (changed) {
        files.push({
          path: file.path,
          change: before ? "modified" : "added",
          kind: isStaticRasterPath(file.path)
            ? "image"
            : isCode(file.path)
              ? "code"
              : "text",
          bytes: raw?.size ?? 0,
          beforeBytes: current?.size,
          beforeSha256: before?.sha256,
          afterSha256: file.sha256,
          ...(optimization ? { optimization } : {}),
        });
        blockers.push({
          path: file.path,
          reason:
            optimization?.error ??
            retained.retentionError ??
            "The original bytes are not durably retained; keep the retained generation",
        });
      }
      continue;
    }
    let content: Buffer | undefined;
    const preparedRaster = "artifactKind" in file ? file : undefined;
    if (preparedRaster) {
      if (
        !retained ||
        retained.rasterPolicyVersion !== 2 ||
        preparedRaster.rasterPolicyVersion !== 2 ||
        !runtimeMediaPath(file.path) ||
        !isStaticRasterPath(file.path) ||
        preparedRaster.executable !== false ||
        preparedRaster.artifactId !== file.sha256 ||
        retained.images[file.path]?.workingSha256 !== file.sha256
      )
        throw refusal("unbound prepared raster artifact");
      content = await readArtifact(
        workspace,
        preparedRaster.artifactKind,
        preparedRaster.artifactId,
      );
      if (
        content.length !== preparedRaster.size ||
        content.length > 32 * 1024 * 1024
      )
        throw refusal("prepared raster length differs");
    }
    if ("data" in file) {
      if (
        typeof file.data !== "string" ||
        file.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          file.data,
        )
      )
        throw refusal("invalid candidate encoding");
      content = Buffer.from(file.data, "base64");
      bytes += content.length;
      if (
        content.length > 2 * 1024 * 1024 ||
        bytes > 8 * 1024 * 1024 ||
        digest(content) !== file.sha256 ||
        containsKnownSensitiveValue(content.toString("utf8"))
      )
        throw refusal("private, oversized or corrupt candidate data");
      if (
        file.rasterBaseSha256 !== undefined &&
        (before?.size === undefined || file.rasterBaseSha256 !== before.sha256)
      )
        throw refusal("raster proposal has no matching registered baseline");
    }
    if (!changed) continue;
    const kind =
      isStaticRasterPath(file.path) && content
        ? "image"
        : content
          ? isCode(file.path)
            ? "code"
            : "text"
          : "verified-media";
    const entry: IsolatedSourceReviewFile = {
      path: file.path,
      change: before ? "modified" : "added",
      kind,
      bytes: content?.length ?? ("size" in file ? file.size : 0),
      beforeBytes: current?.size,
      beforeSha256: before?.sha256,
      afterSha256: file.sha256,
      ...(optimization ? { optimization } : {}),
    };
    files.push(entry);
    try {
      if (
        before
          ? current?.sha256 !== before.sha256 ||
            !!current?.executable !== !!before.executable
          : current !== undefined
      )
        throw refusal("host content differs from this guest baseline");
      if ("executable" in file && file.executable)
        throw refusal("executable permission changes require separate review");
      if (/^canvas\/(?:assets\.json$|schemas\/)/i.test(file.path))
        throw refusal(
          "Canvas registration and schema edits require the controlled Canvas workflow",
        );
      if (content) {
        if (
          before?.size !== undefined &&
          (kind !== "image" ||
            (!preparedRaster &&
              (!("data" in file) || file.rasterBaseSha256 !== before.sha256)))
        )
          throw refusal("unsupported registered-media change");
        if (kind === "image") {
          const receipt = await validateRasterReturn(
            file.path,
            content,
            before
              ? await readSafeProjectFile(
                  workspace,
                  path.join(workspace, file.path),
                )
              : undefined,
            retained?.rasterPolicyVersion === 2 ? 2 : 1,
            signal,
          );
          if (receipt.imageCost) entry.imageCost = receipt.imageCost;
          if (file.sha256 !== before?.sha256) rasterReceipts.push(receipt);
        } else {
          const extension = path.extname(file.path).toLowerCase();
          if (!code.has(extension) && !text.has(extension))
            throw refusal(
              "unknown file type cannot be approved through this flow",
            );
          if (content.includes(0))
            throw refusal("binary content cannot be reviewed as source");
          const source = new TextDecoder("utf-8", { fatal: true }).decode(
            content,
          );
          if (extension === ".json") JSON.parse(source);
          const board = /^canvas\/boards\/([^/]+)\.json$/i.exec(file.path);
          if (
            board &&
            parseCanvasJson<{ id: string }>(
              source,
              file.path,
              CANVAS_BOARD_SCHEMA,
            ).id !== board[1]
          )
            throw refusal("Canvas board identity differs from its filename");
          const sourceBytes = Buffer.byteLength(source, "utf8");
          const completePreview = sourceBytes <= previewLeft;
          entry.preview = completePreview
            ? source
            : Buffer.from(source).subarray(0, previewLeft).toString("utf8");
          previewLeft -= Math.min(sourceBytes, previewLeft);
          if (!completePreview)
            throw refusal(
              "the complete source preview exceeds its 64 KiB review budget; separate file inspection is required",
            );
        }
      } else {
        const original = approvedMedia.get(file.sha256);
        if (
          !("size" in file) ||
          !original ||
          original.size !== file.size ||
          !Number.isSafeInteger(file.size) ||
          file.size < 1 ||
          file.size > runtimeMediaFileLimit(file.path, snapshot.sourceProfileId)
        )
          throw refusal("media copy has no verified prepared source");
        await inspectRuntimeMedia(workspace, original as RuntimeMedia, { profile: snapshot.sourceProfileId, signal, formatPath: file.path });
      }
      const afterMode =
        (current?.sha256 === file.sha256
          ? current.mode!
          : before &&
              !(
                separateMedia &&
                runtimeMediaPath(file.path) &&
                !current?.executable
              )
            ? (current?.mode ?? 0o600)
            : 0o600) & 0o666;
      target.set(file.path, {
        path: file.path,
        sha256: file.sha256,
        executable: false,
        size: entry.bytes,
        mode: afterMode,
      });
    } catch (error) {
      blockers.push({
        path: file.path,
        reason:
          error instanceof Error
            ? error.message
            : "Candidate validation failed",
      });
    }
  }
  for (const f of snapshot.baselineFiles)
    if (!seen.has(f.path))
      blockers.push({
        path: f.path,
        reason:
          "Deletion is not supported; keep the baseline and retained version.",
      });
  if (retained?.retentionError)
    blockers.push({ path: "workspace", reason: retained.retentionError });
  if (!files.length && !blockers.length)
    blockers.push({
      path: "workspace",
      reason: "No unreturned changes were found.",
    });
  if (!blockers.length) {
    try {
      await assertSourcePublicationCapacity(workspace);
      const projected = await inspectProjectSourceBudget(
        workspace,
        files.map((file) => ({ path: file.path, size: file.bytes })),
        separateMedia,
        signal,
        { profile },
      );
      if (
        !projected.complete ||
        Object.values(projected.overage).some((value) => value > 0)
      )
        throw refusal(
          "the reviewed target exceeds the existing file/source/media budget",
        );
      const versions = files.map((file) => {
        const before = host.get(file.path),
          after = target.get(file.path)!;
        return {
          path: file.path,
          ...(before
            ? {
                beforeSha256: before.sha256,
                beforeSize: before.size,
                ...(!(
                  separateMedia &&
                  runtimeMediaPath(file.path) &&
                  !before.executable
                )
                  ? { beforeMode: before.mode }
                  : {}),
              }
            : {}),
          afterSha256: file.afterSha256,
          afterSize: file.bytes,
          afterMode: after.mode,
        };
      });
      const manifest = {
        version: 2,
        state: "needs-review",
        context: {
          namespace,
          projectId,
          generation,
          snapshotId: snapshot.snapshotId,
        },
        versions,
        published: files.map((file) => file.path),
        steps: Object.fromEntries(
          files.map((file) => [file.path, "published"]),
        ),
        rasterReceipts,
      };
      const metadataBytes = Buffer.byteLength(JSON.stringify(manifest)) + 16;
      const required =
        versions.reduce(
          (sum, file) => sum + 2 * (file.afterSize + (file.beforeSize ?? 0)),
          0,
        ) +
        2 * metadataBytes;
      if (
        metadataBytes > 2 * 1024 * 1024 ||
        !(await sourceRecoveryBudget(workspace, required, profile)).fits
      )
        throw refusal(
          "the recovery store has insufficient room for independent originals and returned bytes",
        );
    } catch (error) {
      signal?.throwIfAborted();
      blockers.push({
        path: "workspace",
        reason:
          error instanceof Error
            ? error.message
            : "Target or recovery capacity cannot be verified",
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  blockers.sort((a, b) => a.path.localeCompare(b.path));
  const byPath = (a: ReviewVersion, b: ReviewVersion) =>
    a.path.localeCompare(b.path);
  const record: StoredSourceReview = {
    version: 1,
    nonce: randomUUID(),
    namespace,
    workspace: await realpath(workspace),
    hostFiles: hostFiles.sort(byPath),
    targetFiles: [...target.values()].sort(byPath),
    guestBaseline: [...snapshot.baselineFiles].sort(byPath),
    separateMedia,
    ...(retained ? { retained } : {}),
    review: {
      reviewId: "",
      projectId,
      generation: String(generation),
      snapshotId: snapshot.snapshotId,
      files,
      blockers,
      approved: false,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      ...(retained
        ? {
            reviewVersion: 2 as const,
            rawSnapshotId: retained.rawSnapshotId,
            optimizablePaths: Object.keys(retained.images).sort(),
            publicationUnchanged:
              !blockers.length &&
              retained.allOriginalsRetained &&
              fingerprint(hostFiles) === fingerprint([...target.values()]),
            ...(!blockers.length && retained.allOriginalsRetained
              ? {
                  preparedSnapshotId: reviewSnapshotDigest([
                    ...target.values(),
                  ]),
                }
              : {}),
          }
        : {}),
    },
  };
  if (retained?.sourceContract) {
    const base = baselineReviewManifest(
      record.guestBaseline,
      retained.sourceBaselineSizes!,
      retained.sourceContract,
    );
    const raw = manifestForRawFiles(retained.rawFiles, retained.sourceContract);
    const complete =
      !blockers.length &&
      retained.allOriginalsRetained &&
      !retained.retentionError &&
      Object.values(retained.images).every(
        (image) =>
          image.originalRetained && !image.error && !!image.workingSha256,
      );
    retained.sourceContract = {
      ...(retained.sourceContract.version === 2
        ? { version: 2 as const, profileId: retained.sourceContract.profileId }
        : { version: 1 as const }),
      baseManifestId: base.manifestId,
      rawManifestId: raw.manifestId,
      ...(complete
        ? {
            preparedManifestId: manifestForPreparedSnapshot(snapshot, retained)
              .manifestId,
          }
        : {}),
    };
    record.review.sourceManifestVersion = retained.sourceContract.version;
    if (retained.sourceContract.version === 2)
      record.review.sourceProfileId = retained.sourceContract.profileId;
    record.review.sourceRawDelta = planSourceDelta(base, raw).summary;
    if (complete) {
      const preparedDelta = planSourceDelta(
        base,
        manifestForPreparedSnapshot(snapshot, retained),
      ).summary;
      if (
        retained.sourceContract.version === 2 &&
        preparedDelta.afterMediaBytes > 64 * 1024 * 1024
      )
        throw refusal("prepared changed media exceeds its 64 MiB return limit");
      record.review.sourcePreparedDelta = preparedDelta;
    }
  }
  if (retained)
    retained.preparedBatchId = digest(
      JSON.stringify({
        raw: retained.rawSnapshotId,
        ...(retained.rasterPolicyVersion === 2
          ? { rasterPolicyVersion: 2 }
          : {}),
        files: retained.rawFiles,
        images: retained.images,
        hostFiles: record.hostFiles,
        targetFiles: record.targetFiles,
        ...(retained.sourceContract
          ? {
              sourceContract: retained.sourceContract,
              sourceBaselineSizes: retained.sourceBaselineSizes,
            }
          : {}),
      }),
    );
  record.review.reviewId = identity(record);
  return record;
}

async function artifactRoot(
  workspace: string,
  create = false,
): Promise<string> {
  const root = path.join(
    path.dirname(await realpath(workspace)),
    "isolated-review-artifacts",
  );
  if (create) await durablePublicationDirectory(root);
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw refusal("retained artifact storage is not private");
  return root;
}

async function readArtifact(
  workspace: string,
  kind: "raw" | "working",
  id: string,
): Promise<Buffer> {
  if (!hashPattern.test(id))
    throw refusal("invalid retained artifact identity");
  const root = await artifactRoot(workspace),
    file = path.join(root, kind, id);
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw refusal("unsafe retained artifact");
  const bytes = await readSafeProjectFile(root, file, 32 * 1024 * 1024);
  if (digest(bytes) !== id) throw refusal("retained artifact bytes changed");
  return bytes;
}

async function retainArtifact(
  workspace: string,
  kind: "raw" | "working",
  bytes: Buffer,
  profile?: RuntimeCapacityProfileId,
): Promise<string> {
  const id = digest(bytes);
  if (
    bytes.length > 32 * 1024 * 1024 ||
    containsKnownSensitiveValue(bytes.toString("utf8"))
  )
    throw refusal("private or oversized retained original");
  try {
    const existing = await readArtifact(workspace, kind, id);
    if (!existing.equals(bytes)) throw refusal("retained artifact conflict");
    return id;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (!(await sourceRecoveryBudget(workspace, bytes.length, profile)).fits)
    throw refusal(
      "the shared recovery store cannot retain every raw original and working version; keep the retained generation",
    );
  const root = await artifactRoot(workspace, true),
    folder = path.join(root, kind);
  await durablePublicationDirectory(folder);
  await durablePublicationFile(path.join(folder, id), bytes);
  if (!(await readArtifact(workspace, kind, id)).equals(bytes))
    throw refusal("retained original verification failed");
  return id;
}

export async function retainReviewRaster(
  workspace: string,
  bytes: Buffer,
  profile?: RuntimeCapacityProfileId,
): Promise<string> {
  return retainArtifact(workspace, "raw", bytes, profile);
}
export function preparedRasterArtifactPath(
  workspace: string,
  file: PreparedRasterFile,
): string {
  if (
    file.rasterPolicyVersion !== 2 ||
    !hashPattern.test(file.artifactId) ||
    file.artifactId !== file.sha256 ||
    !["raw", "working"].includes(file.artifactKind)
  )
    throw refusal("invalid private raster reference");
  return path.join(
    path.dirname(workspace),
    "isolated-review-artifacts",
    file.artifactKind,
    file.artifactId,
  );
}

async function prepareRetainedImage(
  workspace: string,
  raw: RetainedReviewFile,
  maxEdge: number | undefined,
  signal?: AbortSignal,
  profile?: RuntimeCapacityProfileId,
): Promise<PreparedReviewImage> {
  signal?.throwIfAborted();
  const result: PreparedReviewImage = {
    originalSha256: raw.sha256,
    originalBytes: raw.size!,
    originalRetained: !!raw.artifact,
    ...(maxEdge !== undefined ? { maxEdge } : {}),
  };
  if (!raw.artifact)
    return {
      ...result,
      error:
        "All raw originals must be durably retained before image preparation",
    };
  const bytes = await readArtifact(workspace, "raw", raw.artifact);
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 32 * 1024 * 1024,
      limitInputChannels: 4,
    }).metadata();
    result.originalWidth = metadata.width;
    result.originalHeight = metadata.height;
    result.hasAlpha = metadata.hasAlpha === true;
    signal?.throwIfAborted();
    const prepared = await prepareWorkingImage(
      bytes,
      maxEdge,
      "preserve-dimensions",
      signal,
    );
    if (!mediaHeaderMatches(raw.path, prepared.bytes))
      throw refusal("image format differs from its destination");
    signal?.throwIfAborted();
    if (prepared.workingSha256 !== raw.sha256)
      await retainArtifact(workspace, "working", prepared.bytes, profile);
    return {
      ...result,
      width: prepared.width,
      height: prepared.height,
      hasAlpha: prepared.hasAlpha === true,
      workingSha256: prepared.workingSha256,
    };
  } catch (cause) {
    signal?.throwIfAborted();
    const message =
      cause instanceof Error
        ? cause.message
        : "The retained image could not be prepared";
    return {
      ...result,
      needsMaxEdge: false,
      error:
        message +
        ". Keep the original or choose another supported workflow; do not regenerate.",
    };
  }
}

export async function preparedReviewSnapshot(
  record: StoredSourceReview,
  signal?: AbortSignal,
): Promise<ReviewSnapshot> {
  signal?.throwIfAborted();
  const plan = record.retained;
  if (!plan) throw refusal("this review has no retained working batch");
  const files: ReviewSnapshot["files"] = [];
  for (const raw of plan.rawFiles) {
    signal?.throwIfAborted();
    if (raw.kind === "verified-media") {
      files.push({ path: raw.path, sha256: raw.sha256, size: raw.size! });
      continue;
    }
    const prepared = plan.images[raw.path],
      id = prepared?.workingSha256 ?? raw.artifact;
    const bytes = id
      ? await readArtifact(
          record.workspace,
          prepared?.workingSha256 && prepared.workingSha256 !== raw.sha256
            ? "working"
            : "raw",
          id,
        )
      : Buffer.alloc(0);
    signal?.throwIfAborted();
    const before = record.guestBaseline.find((file) => file.path === raw.path);
    if (
      plan.rasterPolicyVersion === 2 &&
      prepared?.workingSha256 &&
      runtimeMediaPath(raw.path) &&
      isStaticRasterPath(raw.path)
    ) {
      files.push({
        path: raw.path,
        sha256: id!,
        size: bytes.length,
        executable: false,
        artifactKind: prepared.workingSha256 !== raw.sha256 ? "working" : "raw",
        artifactId: id!,
        rasterPolicyVersion: 2,
      });
      continue;
    }
    files.push({
      path: raw.path,
      sha256: id ?? raw.sha256,
      data: bytes.toString("base64"),
      executable: raw.executable === true,
      ...(before?.size !== undefined && isStaticRasterPath(raw.path)
        ? { rasterBaseSha256: before.sha256 }
        : raw.rasterBaseSha256
          ? { rasterBaseSha256: raw.rasterBaseSha256 }
          : {}),
    });
  }
  const result: ReviewSnapshot = {
    files,
    baselineFiles: record.guestBaseline,
    snapshotId: plan.rawSnapshotId,
  };
  if (
    plan.sourceContract &&
    plan.sourceBaselineSizes &&
    plan.allOriginalsRetained &&
    !plan.retentionError &&
    Object.values(plan.images).every(
      (image) =>
        image.originalRetained && !image.error && !!image.workingSha256,
    )
  ) {
    const base = baselineReviewManifest(
      record.guestBaseline,
      plan.sourceBaselineSizes,
      plan.sourceContract,
    );
    const prepared = manifestForPreparedSnapshot(result, plan);
    result.sourceManifestVersion = plan.sourceContract.version;
    if (plan.sourceContract.version === 2)
      result.sourceProfileId = plan.sourceContract.profileId;
    result.sourceBaselineManifest = base;
    result.sourceManifest = prepared;
    result.sourceDelta = planSourceDelta(base, prepared).summary;
    result.sourceResultManifestId = prepared.manifestId;
  }
  return result;
}

export async function assertRetainedReviewArtifacts(
  record: StoredSourceReview,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const plan = record.retained;
  if (
    !plan ||
    !plan.allOriginalsRetained ||
    plan.retentionError ||
    (plan.sourceContract !== undefined &&
      !plan.sourceContract.preparedManifestId) ||
    !hashPattern.test(plan.preparedBatchId ?? "") ||
    record.review.preparedSnapshotId !==
      reviewSnapshotDigest(record.targetFiles)
  )
    throw refusal("the working batch is incomplete");
  for (const raw of plan.rawFiles) {
    signal?.throwIfAborted();
    if (
      raw.kind !== "verified-media" &&
      (!raw.artifact ||
        (await readArtifact(record.workspace, "raw", raw.artifact)).length !==
          raw.size)
    )
      throw refusal("a raw original is missing");
    const image = plan.images[raw.path];
    if (image) {
      if (!image.originalRetained || image.error || !image.workingSha256)
        throw refusal("an image preparation is incomplete");
      const source = await readArtifact(record.workspace, "raw", raw.artifact!);
      const working = await readArtifact(
        record.workspace,
        image.workingSha256 === raw.sha256 ? "raw" : "working",
        image.workingSha256,
      );
      const verified = await validateRasterReturn(
        raw.path,
        working,
        source,
        plan.rasterPolicyVersion === 2 ? 2 : 1,
        signal,
      );
      const originalMetadata = await sharp(source, {
        failOn: "warning",
        limitInputPixels: 32 * 1024 * 1024,
        limitInputChannels: 4,
      }).metadata();
      if (
        image.width !== verified.width ||
        image.height !== verified.height ||
        image.hasAlpha !== verified.hasAlpha ||
        image.originalWidth !== originalMetadata.width ||
        image.originalHeight !== originalMetadata.height
      )
        throw refusal(
          "stored image dimensions or alpha differ from the actual approved bytes",
        );
    }
  }
  if (plan.sourceContract?.preparedManifestId) {
    const prepared = await preparedReviewSnapshot(record, signal);
    if (
      manifestForPreparedSnapshot(prepared, plan).manifestId !==
      plan.sourceContract.preparedManifestId
    )
      throw refusal("prepared source bytes do not match their manifest");
  }
}

export async function buildRetainedSourceReview(
  workspace: string,
  namespace: "manual" | "test",
  projectId: string,
  generation: number,
  snapshot: RetainedReviewSnapshot,
  rasters: ReadonlyMap<string, Buffer | string>,
  signal?: AbortSignal,
): Promise<StoredSourceReview> {
  return serializeWorkingImages(async () => {
    signal?.throwIfAborted();
    const plan: RetainedReviewPlan = {
      reviewVersion: 2,
      rasterPolicyVersion: 2,
      rawSnapshotId: snapshot.snapshotId,
      rasterReturnVersion: snapshot.rasterReturnVersion,
      rawFiles: [],
      originOperations: snapshot.originOperations,
      images: Object.create(null) as Record<string, PreparedReviewImage>,
      allOriginalsRetained: false,
    };
    for (const file of snapshot.files)
      plan.rawFiles.push({
        path: file.path,
        sha256: file.sha256,
        size:
          "data" in file ? Buffer.byteLength(file.data, "base64") : file.size,
        executable: "executable" in file && file.executable === true,
        kind: "data" in file ? "source" : "verified-media",
        ...("data" in file && file.rasterBaseSha256
          ? { rasterBaseSha256: file.rasterBaseSha256 }
          : {}),
      });
    for (const file of snapshot.retainedRasters)
      plan.rawFiles.push({ ...file, kind: "retained-raster" });
    const hasManifestFields =
      snapshot.sourceManifestVersion !== undefined ||
      snapshot.sourceProfileId !== undefined ||
      snapshot.sourceBaselineManifest !== undefined ||
      snapshot.sourceManifest !== undefined ||
      snapshot.sourceDelta !== undefined ||
      snapshot.sourceResultManifestId !== undefined;
    if (hasManifestFields) {
      if (
        (snapshot.sourceManifestVersion !== 1 &&
          snapshot.sourceManifestVersion !== 2) ||
        (snapshot.sourceManifestVersion === 1 &&
          snapshot.sourceProfileId !== undefined) ||
        (snapshot.sourceManifestVersion === 2 &&
          !(snapshot.sourceProfileId && ["capacity-128-v2", "capacity-128-media64-v3"].includes(snapshot.sourceProfileId))) ||
        !snapshot.sourceBaselineManifest ||
        !snapshot.sourceManifest ||
        !snapshot.sourceDelta ||
        !snapshot.sourceResultManifestId
      )
        throw refusal("incomplete versioned source manifest binding");
      const base = parseSourceManifest(snapshot.sourceBaselineManifest);
      const raw = parseSourceManifest(snapshot.sourceManifest);
      if (
        base.version !== snapshot.sourceManifestVersion ||
        raw.version !== snapshot.sourceManifestVersion ||
        (base.version === 2 && base.profile !== snapshot.sourceProfileId) ||
        (raw.version === 2 && raw.profile !== snapshot.sourceProfileId)
      )
        throw refusal("source manifest profile changed");
      const sizes = base.files.map((file) => file.size);
      const contract: SourceContract =
        snapshot.sourceManifestVersion === 2
          ? {
              version: 2,
              profileId: getRuntimeCapacityProfile(snapshot.sourceProfileId!).id,
              baseManifestId: base.manifestId,
              rawManifestId: raw.manifestId,
            }
          : {
              version: 1,
              baseManifestId: base.manifestId,
              rawManifestId: raw.manifestId,
            };
      if (
        baselineReviewManifest(snapshot.baselineFiles, sizes, contract)
          .manifestId !== base.manifestId ||
        manifestForRawFiles(plan.rawFiles, contract).manifestId !==
          raw.manifestId ||
        snapshot.sourceResultManifestId !== raw.manifestId
      )
        throw refusal("source manifest does not match the retained snapshot");
      assertSourceDeltaSummary(snapshot.sourceDelta, base, raw);
      if (
        contract.version === 2 &&
        planSourceDelta(base, raw).summary.afterMediaBytes > 64 * 1024 * 1024
      )
        throw refusal("changed runtime media exceeds its 64 MiB return limit");
      for (const origin of plan.originOperations) {
        if (
          origin.sourceManifestVersion !== contract.version ||
          (contract.version === 2
            ? origin.sourceProfileId !== contract.profileId
            : origin.sourceProfileId !== undefined) ||
          !hashPattern.test(origin.sourceBaseManifestId ?? "") ||
          origin.sourceResultManifestId !== raw.manifestId
        )
          throw refusal("invalid versioned source origin binding");
      }
      if (
        contract.version === 2 &&
        (snapshot.rasterReturnVersion !== 2 ||
          snapshot.retainedRasters.some(
            (file) =>
              !Number.isSafeInteger(file.size) ||
              file.size < 1 ||
              file.size > 32 * 1024 * 1024,
          ) ||
          snapshot.retainedRasters.reduce((sum, file) => sum + file.size, 0) >
            64 * 1024 * 1024)
      )
        throw refusal(
          "returned raster payload exceeds its 64 MiB transfer limit",
        );
      plan.sourceContract = contract;
      plan.sourceBaselineSizes = sizes;
    } else if (
      plan.originOperations.some(
        (origin) =>
          origin.sourceManifestVersion !== undefined ||
          origin.sourceProfileId !== undefined ||
          origin.sourceBaseManifestId !== undefined ||
          origin.sourceResultManifestId !== undefined,
      )
    ) {
      throw refusal("source origin binding has no manifest");
    }
    const temporary: StoredSourceReview = {
      version: 1,
      nonce: randomUUID(),
      namespace,
      workspace: await realpath(workspace),
      hostFiles: [],
      targetFiles: [],
      guestBaseline: snapshot.baselineFiles,
      separateMedia: true,
      retained: plan,
      review: {
        reviewId: "",
        projectId,
        generation: String(generation),
        snapshotId: snapshot.snapshotId,
        files: [],
        blockers: [],
        approved: false,
        expiresAt: "",
      },
    };
    try {
      for (const raw of plan.rawFiles) {
        signal?.throwIfAborted();
        if (raw.kind === "verified-media") continue;
        const original = snapshot.files.find((file) => file.path === raw.path);
        const bytes =
          raw.kind === "retained-raster"
            ? typeof rasters.get(raw.path) === "string"
              ? await readArtifact(
                  workspace,
                  "raw",
                  rasters.get(raw.path) as string,
                )
              : (rasters.get(raw.path) as Buffer | undefined)
            : original && "data" in original
              ? Buffer.from(original.data, "base64")
              : undefined;
        if (!bytes || digest(bytes) !== raw.sha256 || bytes.length !== raw.size)
          throw refusal("raw snapshot bytes did not match their manifest");
        raw.artifact = await retainArtifact(
          workspace,
          "raw",
          bytes,
          plan.sourceContract?.version === 2
            ? plan.sourceContract.profileId
            : undefined,
        );
      }
      plan.allOriginalsRetained = true;
    } catch (cause) {
      signal?.throwIfAborted();
      plan.retentionError =
        cause instanceof Error
          ? cause.message
          : "Raw retention failed; every guest original remains retained";
    }
    for (const raw of plan.rawFiles)
      if (
        raw.kind !== "verified-media" &&
        isStaticRasterPath(raw.path) &&
        (snapshot.baselineFiles.find((file) => file.path === raw.path)
          ?.sha256 !== raw.sha256 ||
          !!snapshot.baselineFiles.find((file) => file.path === raw.path)
            ?.executable !== !!raw.executable)
      )
        plan.images[raw.path] = plan.allOriginalsRetained
          ? await prepareRetainedImage(
              workspace,
              raw,
              undefined,
              signal,
              plan.sourceContract?.version === 2
                ? plan.sourceContract.profileId
                : undefined,
            )
          : {
              originalSha256: raw.sha256,
              originalBytes: raw.size!,
              originalRetained: !!raw.artifact,
              error: plan.retentionError,
            };
    return buildSourceReview(
      workspace,
      namespace,
      projectId,
      generation,
      await preparedReviewSnapshot(temporary, signal),
      plan,
      signal,
    );
  });
}

export async function optimizeRetainedSourceReview(
  record: StoredSourceReview,
  options: { paths: string[]; maxEdge?: number },
  signal?: AbortSignal,
): Promise<StoredSourceReview> {
  return serializeWorkingImages(async () => {
    if (
      !record.retained ||
      record.approvedAt ||
      record.acknowledged ||
      record.superseded
    )
      throw refusal(
        "request a fresh unapproved retained review before preparing images",
      );
    if (
      !Array.isArray(options.paths) ||
      !options.paths.length ||
      options.paths.length > 16 ||
      new Set(options.paths).size !== options.paths.length ||
      options.paths.some(
        (name) =>
          typeof name !== "string" ||
          !Object.hasOwn(record.retained!.images, name),
      )
    )
      throw refusal(
        "choose one to sixteen retained image paths from this review",
      );
    await assertReviewedHost(record.workspace, record, "before");
    const plan = structuredClone(record.retained);
    if (plan.allOriginalsRetained)
      for (const name of options.paths) {
        signal?.throwIfAborted();
        plan.images[name] = await prepareRetainedImage(
          record.workspace,
          plan.rawFiles.find((file) => file.path === name)!,
          options.maxEdge,
          signal,
          plan.sourceContract?.version === 2
            ? plan.sourceContract.profileId
            : undefined,
        );
      }
    const next = { ...record, retained: plan };
    return buildSourceReview(
      record.workspace,
      record.namespace,
      record.review.projectId,
      Number(record.review.generation),
      await preparedReviewSnapshot(next, signal),
      plan,
      signal,
    );
  });
}

export async function assertReviewedHost(
  workspace: string,
  record: StoredSourceReview,
  phase: "before" | "unchanged" | "after",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const ignored =
    phase === "unchanged"
      ? new Set(record.review.files.map((f) => f.path))
      : undefined;
  const expected = (
    phase === "after" ? record.targetFiles : record.hostFiles
  ).filter((f) => !ignored?.has(f.path));
  const actual = await reviewHostFiles(
    workspace,
    ignored,
    record.separateMedia,
    {
      profile:
        record.retained?.sourceContract?.version === 2
          ? record.retained.sourceContract.profileId
          : undefined,
      signal,
    },
  );
  if (fingerprint(actual) !== fingerprint(expected)) {
    const a = new Map(actual.map((file) => [file.path, file])),
      b = new Map(expected.map((file) => [file.path, file]));
    const conflicts = [...new Set([...a.keys(), ...b.keys()])].filter(
      (name) =>
        fingerprint(a.has(name) ? [a.get(name)!] : []) !==
        fingerprint(b.has(name) ? [b.get(name)!] : []),
    );
    throw refusal(
      "the host changed since this approval; inspect conflicting paths: " +
        JSON.stringify(conflicts.slice(0, 10)).slice(0, 1500),
    );
  }
}

export interface RetainedImageRead {
  bytes: Buffer;
  mimeType: RetainedImageMimeType;
  metadata: RetainedImageMetadata;
}
let pendingImageReads = 0;

/** Saved, immutable host review only. No guest access, mutation, adoption or acknowledgement. */
export async function readReviewedRetainedImage(
  workspace: string,
  projectId: string,
  namespace: "manual" | "test",
  reviewId: string,
  relative: string,
  variant: RetainedImageVariant,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<RetainedImageRead> {
  signal?.throwIfAborted();
  transferPath(relative);
  if (
    !hashPattern.test(reviewId) ||
    !hashPattern.test(expectedSha256) ||
    !["raw", "working"].includes(variant) ||
    !isStaticRasterPath(relative) ||
    containsKnownSensitiveValue(relative)
  )
    return Promise.reject(
      refusal("choose a listed static image and its exact saved review digest"),
    );
  // Count both the active request and queued requests. Cancelled callers retain their
  // slot until the queued operation safely exits; they cannot create an unbounded queue.
  if (pendingImageReads >= 4)
    return Promise.reject(
      refusal("saved image reads are busy; no image was loaded"),
    );
  pendingImageReads++;
  const pending = serializeWorkingImages(
    async (): Promise<RetainedImageRead> => {
      signal?.throwIfAborted();
      const revision = knownSensitiveValueRevision();
      const current = () => {
        signal?.throwIfAborted();
        if (revision !== knownSensitiveValueRevision())
          throw refusal(
            "the image disclosure policy changed; request the saved image again",
          );
      };
      const record = await readSourceReview(
          workspace,
          projectId,
          namespace,
          reviewId,
        ),
        plan = record.retained;
      if (
        !plan ||
        record.superseded ||
        (!record.approvedAt && Date.parse(record.review.expiresAt) < Date.now())
      )
        throw refusal(
          "this saved image review is expired, superseded or unavailable",
        );
      const raw = plan.rawFiles.find((file) => file.path === relative),
        image = plan.images[relative];
      const listed = record.review.files.find(
        (file) => file.path === relative && file.kind === "image",
      );
      if (
        !raw ||
        !image ||
        !listed ||
        !raw.artifact ||
        raw.artifact !== raw.sha256 ||
        raw.executable ||
        !image.originalRetained
      )
        throw refusal(
          "the image has no independently retained original in this review",
        );
      const selectedSha = variant === "raw" ? raw.sha256 : image.workingSha256;
      const selectedSize = variant === "raw" ? raw.size : listed.bytes;
      if (
        selectedSha !== expectedSha256 ||
        (variant === "working" &&
          (image.error ||
            listed.afterSha256 !== selectedSha ||
            record.targetFiles.find((file) => file.path === relative)
              ?.sha256 !== selectedSha))
      )
        throw refusal(
          "the requested image digest differs from this saved variant",
        );
      let hostPhase: "before" | "after" = "before";
      try {
        await assertReviewedHost(workspace, record, "before", signal);
      } catch (cause) {
        current();
        if (!record.approvedAt || !record.publicationId) throw cause;
        await assertReviewedHost(workspace, record, "after", signal);
        hostPhase = "after";
      }
      const root = await artifactRoot(workspace);
      const read = async (
        kind: "raw" | "working",
        id: string,
        size: number | undefined,
      ) => {
        current();
        if (
          !Number.isSafeInteger(size) ||
          size! < 1 ||
          size! > 32 * 1024 * 1024
        )
          throw refusal(
            "the retained image size is outside its existing bound",
          );
        const file = path.join(root, kind, id),
          before = await lstat(file, { bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.uid !== BigInt(process.getuid?.() ?? -1) ||
          before.mode & 0o177n ||
          before.size !== BigInt(size!)
        )
          throw refusal("the retained image permissions or size changed");
        const bytes = await readArtifact(workspace, kind, id);
        current();
        const unchanged = async () => {
          const after = await lstat(file, { bigint: true });
          if (
            ![
              "dev",
              "ino",
              "size",
              "mode",
              "uid",
              "gid",
              "nlink",
              "mtimeNs",
              "ctimeNs",
            ].every(
              (key) =>
                before[key as keyof typeof before] ===
                after[key as keyof typeof after],
            )
          )
            throw refusal("the retained image changed during its read");
        };
        await unchanged();
        return { bytes, unchanged };
      };
      const original = await read("raw", raw.artifact, raw.size);
      const selected =
        variant === "raw" || selectedSha === raw.sha256
          ? original
          : await read("working", selectedSha!, selectedSize);
      if (variant === "working") {
        const verified = await validateRasterReturn(
          relative,
          selected.bytes,
          original.bytes,
          2,
          signal,
        );
        if (
          verified.width !== image.width ||
          verified.height !== image.height ||
          verified.hasAlpha !== image.hasAlpha
        )
          throw refusal(
            "the working image dimensions or alpha differ from its saved recipe",
          );
      }
      const mimeType = sniffImageType(selected.bytes);
      if (!mimeType)
        throw refusal("the retained image has no supported static format");
      const display = await prepareSessionImageDisplay(
        selected.bytes,
        mimeType,
        signal,
      );
      if (
        display.sourceSha256 !== expectedSha256 ||
        display.sourceBytes !== selectedSize ||
        (variant === "raw" &&
          ((image.originalWidth !== undefined &&
            image.originalWidth !== display.sourceWidth) ||
            (image.originalHeight !== undefined &&
              image.originalHeight !== display.sourceHeight)))
      )
        throw refusal(
          "the retained image differs from its saved source binding",
        );
      current();
      await original.unchanged();
      if (selected !== original) await selected.unchanged();
      await assertReviewedHost(workspace, record, hostPhase, signal);
      if (
        JSON.stringify(
          await readSourceReview(workspace, projectId, namespace, reviewId),
        ) !== JSON.stringify(record)
      )
        throw refusal("the saved review changed during its image read");
      if (
        !record.approvedAt &&
        Date.parse(record.review.expiresAt) < Date.now()
      )
        throw refusal("the saved image review expired during its read");
      current();
      return {
        bytes: display.bytes,
        mimeType: display.mimeType,
        metadata: {
          namespace,
          projectId,
          reviewId,
          generation: record.review.generation,
          rawSnapshotId: plan.rawSnapshotId,
          ...(record.review.preparedSnapshotId
            ? { preparedSnapshotId: record.review.preparedSnapshotId }
            : {}),
          path: relative,
          variant,
          sourceSha256: display.sourceSha256,
          sourceMimeType: display.sourceMimeType,
          sourceBytes: display.sourceBytes,
          sourceWidth: display.sourceWidth,
          sourceHeight: display.sourceHeight,
          sourceHasAlpha: display.sourceHasAlpha,
          displaySha256: display.displaySha256,
          displayWidth: display.displayWidth,
          displayHeight: display.displayHeight,
          displayBytes: display.displayBytes,
          isProxy: display.isProxy,
          scannerRevision: revision,
          freshGuest: false,
          adoptionApproved: false,
        },
      };
    },
  );
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal?.reason ?? new Error("Saved image read was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    pending.then(
      (result) => {
        pendingImageReads--;
        signal?.removeEventListener("abort", abort);
        resolve(result);
      },
      (cause) => {
        pendingImageReads--;
        signal?.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

async function rootFor(workspace: string, create = false) {
  const root = path.join(path.dirname(workspace), "isolated-reviews");
  if (create) await durablePublicationDirectory(root);
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw refusal("review storage is not private");
  return root;
}

export async function readSourceReview(
  workspace: string,
  projectId: string,
  namespace: "manual" | "test",
  reviewId: string,
): Promise<StoredSourceReview> {
  if (!hashPattern.test(reviewId)) throw refusal("invalid review identity");
  const root = await rootFor(workspace),
    file = path.join(root, reviewId + ".json"),
    info = await lstat(file);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw refusal("unsafe review receipt");
  const value = JSON.parse(
    (await readSafeProjectFile(root, file, 2 * 1024 * 1024)).toString(),
  ) as StoredSourceReview;
  if (
    value.version !== 1 ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.nonce) ||
    value.namespace !== namespace ||
    value.workspace !== (await realpath(workspace)) ||
    value.review?.projectId !== projectId ||
    !Array.isArray(value.review.files) ||
    !Array.isArray(value.review.blockers) ||
    !Array.isArray(value.hostFiles) ||
    !Array.isArray(value.targetFiles) ||
    !Array.isArray(value.guestBaseline) ||
    typeof value.separateMedia !== "boolean" ||
    !/^[0-9]{1,32}$/.test(value.review.generation) ||
    !hashPattern.test(value.review.snapshotId) ||
    !Number.isFinite(Date.parse(value.review.expiresAt)) ||
    identity(value) !== reviewId ||
    value.review.reviewId !== reviewId ||
    value.review.approved !== false ||
    (value.approvedAt !== undefined &&
      !Number.isFinite(Date.parse(value.approvedAt))) ||
    (value.acknowledged !== undefined &&
      typeof value.acknowledged !== "boolean") ||
    (value.superseded !== undefined && typeof value.superseded !== "boolean")
  )
    throw refusal("review receipt is damaged or belongs to different source");
  for (const f of [...value.hostFiles, ...value.targetFiles]) {
    transferPath(f.path);
    if (
      !hashPattern.test(f.sha256) ||
      !Number.isInteger(f.mode) ||
      f.mode! < 0 ||
      f.mode! > 0o777
    )
      throw refusal("invalid reviewed file binding");
  }
  if (
    value.publicationId !== undefined &&
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.publicationId)
  )
    throw refusal("invalid publication binding");
  if (
    value.recoveryOperationId !== undefined &&
    !/^[a-f0-9]{32}$/.test(value.recoveryOperationId)
  )
    throw refusal("invalid recovery operation binding");
  if (value.retained) {
    const plan = value.retained;
    if (
      plan.reviewVersion !== 2 ||
      (plan.rasterPolicyVersion !== undefined &&
        plan.rasterPolicyVersion !== 2) ||
      value.review.reviewVersion !== 2 ||
      plan.rawSnapshotId !== value.review.snapshotId ||
      plan.rawSnapshotId !== value.review.rawSnapshotId ||
      !Array.isArray(plan.rawFiles) ||
      plan.rawFiles.length > 2000 ||
      !Array.isArray(plan.originOperations) ||
      plan.originOperations.length > 32 ||
      typeof plan.allOriginalsRetained !== "boolean" ||
      !plan.images ||
      typeof plan.images !== "object" ||
      Array.isArray(plan.images) ||
      !hashPattern.test(plan.preparedBatchId ?? "") ||
      reviewSnapshotDigest(plan.rawFiles) !== plan.rawSnapshotId ||
      (value.review.preparedSnapshotId !== undefined &&
        value.review.preparedSnapshotId !==
          reviewSnapshotDigest(value.targetFiles)) ||
      plan.preparedBatchId !==
        digest(
          JSON.stringify({
            raw: plan.rawSnapshotId,
            ...(plan.rasterPolicyVersion === 2
              ? { rasterPolicyVersion: 2 }
              : {}),
            files: plan.rawFiles,
            images: plan.images,
            hostFiles: value.hostFiles,
            targetFiles: value.targetFiles,
            ...(plan.sourceContract
              ? {
                  sourceContract: plan.sourceContract,
                  sourceBaselineSizes: plan.sourceBaselineSizes,
                }
              : {}),
          }),
        )
    )
      throw refusal("invalid retained working batch binding");
    if (
      (plan.sourceContract === undefined) !==
      (plan.sourceBaselineSizes === undefined)
    )
      throw refusal("incomplete source manifest receipt");
    if (plan.sourceContract) {
      const contract = parseSourceContract(plan.sourceContract);
      if (
        contract.version === 2 &&
        (plan.rasterReturnVersion !== 2 ||
          plan.rawFiles
            .filter((file) => file.kind === "retained-raster")
            .some(
              (file) =>
                !Number.isSafeInteger(file.size) ||
                file.size! < 1 ||
                file.size! > 32 * 1024 * 1024,
            ) ||
          plan.rawFiles
            .filter((file) => file.kind === "retained-raster")
            .reduce((sum, file) => sum + file.size!, 0) >
            64 * 1024 * 1024)
      )
        throw refusal(
          "returned raster payload exceeds its 64 MiB transfer limit",
        );
      const manifests = reviewSourceManifests(value);
      if (
        value.review.sourceManifestVersion !== contract.version ||
        (contract.version === 2
          ? value.review.sourceProfileId !== contract.profileId
          : value.review.sourceProfileId !== undefined) ||
        !value.review.sourceRawDelta ||
        !!value.review.sourcePreparedDelta !== !!manifests.prepared
      )
        throw refusal("incomplete public source delta binding");
      assertSourceDeltaSummary(
        value.review.sourceRawDelta,
        manifests.base,
        manifests.raw,
      );
      if (
        contract.version === 2 &&
        (value.review.sourceRawDelta.afterMediaBytes > 64 * 1024 * 1024 ||
          (value.review.sourcePreparedDelta?.afterMediaBytes ?? 0) >
            64 * 1024 * 1024)
      )
        throw refusal("changed runtime media exceeds its 64 MiB return limit");
      if (manifests.prepared)
        assertSourceDeltaSummary(
          value.review.sourcePreparedDelta,
          manifests.base,
          manifests.prepared,
        );
      if (
        contract.baseManifestId !== manifests.base.manifestId ||
        contract.rawManifestId !== manifests.raw.manifestId ||
        (contract.preparedManifestId !== undefined &&
          contract.preparedManifestId !== manifests.prepared?.manifestId) ||
        (contract.preparedManifestId === undefined &&
          (!value.review.blockers.length || value.approvedAt)) ||
        plan.originOperations.some(
          (origin) =>
            origin.sourceManifestVersion !== contract.version ||
            (contract.version === 2
              ? origin.sourceProfileId !== contract.profileId
              : origin.sourceProfileId !== undefined) ||
            !hashPattern.test(origin.sourceBaseManifestId ?? "") ||
            origin.sourceResultManifestId !== contract.rawManifestId,
        )
      )
        throw refusal("invalid versioned source manifest receipt");
    } else if (
      value.review.sourceManifestVersion !== undefined ||
      value.review.sourceProfileId !== undefined ||
      value.review.sourceRawDelta !== undefined ||
      value.review.sourcePreparedDelta !== undefined
    ) {
      throw refusal("public source delta has no manifest receipt");
    } else if (
      plan.originOperations.some(
        (origin) =>
          origin.sourceManifestVersion !== undefined ||
          origin.sourceProfileId !== undefined ||
          origin.sourceBaseManifestId !== undefined ||
          origin.sourceResultManifestId !== undefined,
      )
    )
      throw refusal("source origin binding has no manifest receipt");
    const paths = new Set<string>();
    for (const raw of plan.rawFiles) {
      transferPath(raw.path);
      if (
        paths.has(raw.path) ||
        !hashPattern.test(raw.sha256) ||
        !Number.isSafeInteger(raw.size) ||
        raw.size! < 0 ||
        raw.size! >
          (raw.kind === "verified-media" &&
          plan.sourceContract?.version === 2 &&
          value.hostFiles.some(
            (file) =>
              file.sha256 === raw.sha256 &&
              file.size === raw.size &&
              !file.executable,
          )
            ? runtimeMediaFileLimit(raw.path, plan.sourceContract.profileId)
            : 32 * 1024 * 1024) ||
        !["source", "verified-media", "retained-raster"].includes(raw.kind) ||
        (raw.artifact !== undefined && raw.artifact !== raw.sha256)
      )
        throw refusal("invalid retained original binding");
      paths.add(raw.path);
    }
    for (const [name, image] of Object.entries(plan.images)) {
      const raw = plan.rawFiles.find((file) => file.path === name);
      if (
        !raw ||
        !isStaticRasterPath(name) ||
        image.originalSha256 !== raw.sha256 ||
        image.originalBytes !== raw.size ||
        typeof image.originalRetained !== "boolean" ||
        (image.workingSha256 !== undefined &&
          !hashPattern.test(image.workingSha256)) ||
        (image.maxEdge !== undefined &&
          ![256, 512, 1024, 1536, 2048].includes(image.maxEdge))
      )
        throw refusal("invalid retained image recipe");
    }
  } else if (
    value.review.reviewVersion !== undefined ||
    value.review.sourceManifestVersion !== undefined ||
    value.review.sourceProfileId !== undefined ||
    value.review.sourceRawDelta !== undefined ||
    value.review.sourcePreparedDelta !== undefined
  )
    throw refusal("retained review metadata has no private working batch");
  return value;
}

export async function saveSourceReview(
  record: StoredSourceReview,
): Promise<void> {
  const root = await rootFor(record.workspace, true),
    entries = await readdir(root);
  if (
    entries.length > 128 ||
    (entries.filter((n) => n.endsWith(".json")).length >= 64 &&
      !entries.includes(record.review.reviewId + ".json"))
  )
    throw refusal(
      "review history budget is full; retain receipts for inspection",
    );
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > 2 * 1024 * 1024)
    throw refusal("review metadata exceeds its bound");
  let used = 0;
  for (const name of entries) {
    const info = await lstat(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw refusal("unknown linked review storage");
    used += info.size;
  }
  if (used + bytes.length > 8 * 1024 * 1024)
    throw refusal("review history exceeds its 8 MiB local storage budget");
  const temporary = path.join(root, `.review-${randomUUID()}.tmp`);
  await durablePublicationFile(temporary, bytes);
  await rename(temporary, path.join(root, record.review.reviewId + ".json"));
  await syncPublicationDirectory(root);
}

async function sourceReviews(
  workspace: string,
  projectId: string,
  namespace: "manual" | "test",
): Promise<StoredSourceReview[]> {
  let root;
  try {
    root = await rootFor(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(root);
  if (entries.length > 128) throw refusal("oversized review history");
  const records: StoredSourceReview[] = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      if (/^\.review-[a-f0-9-]+\.tmp$/.test(name)) continue;
      throw refusal("unknown review history entry");
    }
    const record = await readSourceReview(
      workspace,
      projectId,
      namespace,
      name.slice(0, -5),
    );
    records.push(record);
  }
  return records;
}

export async function assertNoUnapprovedSourceReview(
  workspace: string,
  projectId: string,
  namespace: "manual" | "test",
): Promise<void> {
  const records = await sourceReviews(workspace, projectId, namespace);
  if (
    records.some(
      (record) =>
        !record.approvedAt &&
        !record.acknowledged &&
        !record.superseded &&
        (record.review.files.length || record.review.blockers.length),
    )
  )
    throw refusal(
      "A retained batch awaits trusted user confirmation. Ordinary Agent writes and generation are paused. Use recover_isolated_changes review/adopt; the user can inspect or edit files manually before a fresh review.",
    );
}

/** Preserve drafts as history while allowing the exact approved batch to settle. */
export async function supersedeUnapprovedSourceReviews(
  approved: StoredSourceReview,
): Promise<void> {
  const records = await sourceReviews(
    approved.workspace,
    approved.review.projectId,
    approved.namespace,
  );
  for (const record of records) {
    if (
      record.review.reviewId !== approved.review.reviewId &&
      record.review.generation === approved.review.generation &&
      !record.approvedAt &&
      !record.acknowledged &&
      !record.superseded
    ) {
      record.superseded = true;
      await saveSourceReview(record);
    }
  }
}

export async function approvedSourceReview(
  workspace: string,
  projectId: string,
  namespace: "manual" | "test",
  generation: string,
): Promise<StoredSourceReview | undefined> {
  const approved = (
    await sourceReviews(workspace, projectId, namespace)
  ).filter(
    (record) =>
      record.approvedAt &&
      !record.acknowledged &&
      !record.superseded &&
      record.review.generation === generation,
  );
  if (approved.length > 1)
    throw refusal("multiple approvals require inspection");
  return approved[0];
}

export function publicSourceReview(
  record: StoredSourceReview,
): IsolatedSourceReview {
  return {
    ...record.review,
    approved: !!record.approvedAt && !record.superseded,
    completed: !!record.acknowledged,
    ...(record.superseded
      ? {
          blockers: [
            ...record.review.blockers,
            {
              path: "workspace",
              reason:
                "This approval was superseded after a host change; request a fresh review.",
            },
          ],
        }
      : {}),
  };
}
