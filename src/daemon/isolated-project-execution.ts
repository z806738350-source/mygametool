import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { confirmIsolatedCommandFailure, getToolConfirmedFailure } from "./agent-tool-errors.js";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  mkdir,
  mkdtemp,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  reserveRecoverySpace,
  isRecoverySpaceInputRefusal,
  reconnectRetainedRecoverySpace,
  withRecoverySpaceReservation,
  reservationForPublication,
  type RecoverySpaceReservation,
  reserveVolumeMigrationSpace,
  createVolumeMigrationSpaceTerminalProof,
  type VolumeMigrationSpaceReservation,
  checkVolumeMigrationSpaceHeadroom,
  checkRecoverySpaceHeadroom,
} from "./recovery-space.js";
import {
  validateRasterArtifact,
  type ValidatedRasterArtifact,
} from "./validated-raster-artifact.js";
import {
  IsolatedVmLifecycle,
  readIsolatedVmStatus,
} from "./isolated-vm-lifecycle.js";
import { executionStorageSnapshot } from "./execution-storage-overview.js";
import type {
  ExecutionStorageOverview,
  ExecutionStorageSnapshot,
} from "../shared/execution-storage.js";
import type { IsolatedSourceReview, RetainedImageVariant, SourceDeletionWithdrawal } from "../shared/execution-storage.js";
import {
  approvedSourceReview,
  assertNoUnapprovedSourceReview,
  assertReviewedHost,
  assertRetainedReviewArtifacts,
  buildSourceReview,
  buildRetainedSourceReview,
  optimizeRetainedSourceReview,
  preparedReviewSnapshot,
  reviewSourceContract,
  reviewSnapshotDigest,
  publicSourceReview,
  readSourceReview,
  readReviewedRetainedImage,
  retainReviewRaster,
  preparedRasterArtifactPath,
  saveSourceReview,
  sourceDeletionReview,
  sourceReviews,
  supersedeUnapprovedSourceReviews,
  type ReviewSnapshot,
  type RetainedReviewSnapshot,
  type StoredSourceReview,
  type PreparedRasterFile,
} from "./isolated-source-review.js";
import type { ProjectState } from "../shared/contracts.js";
import {
  applySourceChanges,
  sourceRecoveryBudget,
  createSourcePublication,
  type WorkspaceGuard,
} from "./isolated-source-changes.js";
import {
  projectFiles,
  sourceManifestEntries,
  runtimeMediaPath,
  mediaHeaderMatches,
  readRuntimeMedia,
  type RuntimeMedia,
  publicPackages,
  restoreArtifacts,
  copyRuntimeMedia,
  transferPath,
  type TransferFile,
} from "./isolated-project-files.js";
import {
  assertSourcePublicationSettled,
  pendingSourcePublications,
  retainedPublicationOriginal,
  verifyRetainedPublicationOriginal,
  resumeSourcePublications,
  savePublicationManifest,
  initializePublicationManifest,
  samePublicationContext,
  sourcePublicationMetadata,
  type PublicationContext,
} from "./isolated-publication-journal.js";
import {
  isStaticRasterPath,
  validateRasterReturn,
} from "./isolated-raster-returns.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { getRuntimeCapacityProfile, RUNTIME_CAPACITY_PROFILES, runtimeMediaFileLimit, type RuntimeCapacityProfileId } from "../shared/execution-capacity-profiles.js";
import {
  createSourceManifest,
  createSourceManifestV2,
  parseSourceManifest,
  assertSourceDeltaSummary,
  parseSourceContract,
  planSourceDelta,
  type SourceContract,
} from "./isolated-source-manifest.js";
import {
  createIsolatedRepairProof,
  inheritIsolatedRepairProof,
  createIsolatedRepairPending,
  inheritIsolatedRepairPending,
  isolatedInputBudgetError,
  isIsolatedInputBudgetError,
  reportIsolatedOperation,
  type IsolatedRepairTarget,
} from "./isolated-tool-receipts.js";
import {
  containsKnownSensitiveValue,
  knownSensitiveValueRevision,
  redactKnownSensitiveValues,
  registerSensitiveValue,
  sensitiveValueStream,
} from "../shared/sensitive-values.js";

const RUNTIME_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.runtime/local-execution",
);
const LIMA = path.join(RUNTIME_ROOT, "tools/lima/bin/limactl");
const LIMA_SHA256 =
  "6d32fb0f880c0ea750434f2ac855a3f2129126752a301ce4d88adbd2fa599e1e";
const CONTROLLER = "/opt/ohmygame/guest-controller.py";
type Mode = "install" | "build" | "preview" | "shell";
interface Operation {
  id: string;
  projectId: string;
  binding?: OperationBinding;
  previewSource?: string;
  child?: ChildProcess;
  abort: AbortController;
  submitted: boolean;
  released: boolean;
  hold: boolean;
  closed: boolean;
  terminalCode?: number;
  transportCode?: number | null;
  port?: number;
  ready: Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
  rejectSettled: (cause: unknown) => void;
  finalizing?: Promise<void>;
  cancelling?: Promise<void>;
  snapshotId?: string;
  generation?: number;
  report: typeof reportIsolatedOperation;
  mode?: Mode;
  reviewVersion?: 2;
  spaceReservation?: RecoverySpaceReservation;
  sourceContract?: SourceContract;
  workspacePath?: string;
  physicalReservation?: VolumeMigrationSpaceReservation;
}
function linkRecoveryCancellation(
  state: Operation,
  signal?: AbortSignal,
): () => void {
  const cancel = () => state.abort.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return () => signal?.removeEventListener("abort", cancel);
}
type Namespace = "manual" | "test";
interface OperationBinding {
  namespace: Namespace;
  projectId: string;
  operationId: string;
  generation: number;
  leaseToken: string;
  rasterReturnVersion?: 0 | 1 | 2;
  captureVersion?: 2 | 3 | 4;
  sourceManifestVersion?: 1 | 2;
  sourceProfileId?: RuntimeCapacityProfileId;
  sourceBaseManifestId?: string;
  reviewSnapshotId?: string;
}
export interface IsolatedProjectStorage {
  namespace: Namespace;
  projectId: string;
  generation: number;
  state:
    | "resident"
    | "archived"
    | "recovery-pending"
    | "busy"
    | "deleting"
    | "deleted";
  dirty: boolean;
  active: boolean;
  sourceManifestVersion?: 1 | 2;
  sourceProfileId?: RuntimeCapacityProfileId;
  sourceBaseManifestId?: string;
  [key: string]: unknown;
}
export interface IsolatedSourceInspection {
  namespace: Namespace;
  projectId: string;
  generation: number;
  complete: boolean;
  changes: Array<{
    path: string;
    kind: "added" | "modified" | "deleted" | "blocked";
    size?: number;
    reason?: string;
  }>;
  excluded: number;
  blockers: number;
  rasterInspectionVersion?: 1 | 2;
  rasterReturnVersion?: 0 | 1 | 2;
  captureVersion?: 2;
}
interface SourceManifestEntry {
  path: string;
  sha256: string;
  executable?: boolean;
}
function checkControlResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid isolated control response");
  const { error } = value as {
    error?: { code?: unknown; message?: unknown; changed?: unknown };
  };
  if (error && typeof error === "object" && !Array.isArray(error)) {
    throw Object.assign(
      new Error(
        redactKnownSensitiveValues(
          (typeof error.message === "string"
            ? error.message
            : "Isolated lifecycle operation failed") +
            (error.code === "RECOVERY_REQUIRED"
              ? ". Inspect retained changes with recover_isolated_changes (action: inspect), then recover the inspected generation. The project card also offers Execution storage & recovery. Do not rerun the failed command or discard retained data to clear this state."
              : ""),
        ),
      ),
      {
        ...(typeof error.code === "string" && /^[A-Z_]{1,64}$/.test(error.code)
          ? { code: error.code }
          : {}),
        ...(typeof error.changed === "boolean"
          ? { changed: error.changed }
          : {}),
      },
    );
  }
}

interface BuildManifest {
  files: TransferFile[];
  media?: RuntimeMedia[];
  generatedMedia?: RuntimeMedia[];
}

/** One bounded JSON line followed by the newly generated files in manifest order. */
async function readBuildStream(source: Readable) {
  const chunks = source[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  async function available(): Promise<boolean> {
    while (!pending.length) {
      const next = await chunks.next();
      if (next.done) return false;
      pending = next.value;
    }
    return true;
  }
  const header: Buffer[] = [];
  let length = 0;
  while (await available()) {
    const newline = pending.indexOf(10);
    const part = newline < 0 ? pending : pending.subarray(0, newline);
    length += part.length;
    if (length > 16 * 1024 * 1024)
      throw new Error("Isolated build manifest is too large");
    header.push(part);
    pending = newline < 0 ? Buffer.alloc(0) : pending.subarray(newline + 1);
    if (newline >= 0) {
      let manifest: BuildManifest;
      try {
        manifest = JSON.parse(Buffer.concat(header, length).toString("utf8"));
      } catch {
        throw new Error("Invalid isolated build manifest");
      }
      checkControlResponse(manifest);
      return {
        manifest,
        async readMedia(entry: RuntimeMedia): Promise<Buffer> {
          // Only untrusted generated/raster payloads use this bounded Buffer reader. Known copies never enter it.
          if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 32 * 1024 * 1024) throw new Error("Isolated generated media exceeds its unchanged 32 MiB bound");
          const bytes = Buffer.allocUnsafe(entry.size);
          let offset = 0;
          while (offset < bytes.length) {
            if (!(await available()))
              throw new Error("Incomplete isolated build media");
            const copied = pending.copy(
              bytes,
              offset,
              0,
              Math.min(pending.length, bytes.length - offset),
            );
            pending = pending.subarray(copied);
            offset += copied;
          }
          return bytes;
        },
        async end(): Promise<void> {
          if (await available())
            throw new Error("Unexpected trailing isolated build data");
        },
      };
    }
  }
  throw new Error("Incomplete isolated build manifest");
}
function verifyCapturedMedia(
  files: Array<TransferFile | RuntimeMedia>,
  expected: RuntimeMedia[],
  rasterReturnVersion = 0,
): Array<TransferFile | RuntimeMedia> {
  const snapshots = new Map(expected.map((file) => [file.path, file]));
  const approved = new Map(expected.map((file) => [file.sha256, file.size]));
  const ordinary: Array<TransferFile | RuntimeMedia> = [];
  for (const file of files) {
    if ("data" in file) {
      const before = snapshots.get(file.path);
      if (before) {
        if (
          rasterReturnVersion !== 1 ||
          file.rasterBaseSha256 !== before.sha256 ||
          file.executable === true
        )
          throw new Error(
            "An isolated runtime asset changed; retained for review",
          );
        snapshots.delete(file.path);
      } else if (file.rasterBaseSha256 !== undefined)
        throw new Error(
          "Raster return has no bound original; retained for review",
        );
      ordinary.push(file);
      continue;
    }
    const original = snapshots.get(file.path);
    const unchanged =
      original?.sha256 === file.sha256 && original.size === file.size;
    if (
      (!unchanged && approved.get(file.sha256) !== file.size) ||
      ("executable" in file && file.executable !== false)
    )
      throw new Error("An isolated runtime asset changed; retained for review");
    if (!unchanged) ordinary.push(file);
    snapshots.delete(file.path);
  }
  if (snapshots.size)
    throw new Error(
      "An isolated runtime asset was removed; retained for review",
    );
  return ordinary;
}

async function writeNeededMedia(
  stream: Writable,
  workspace: string,
  media: RuntimeMedia[],
  paths: unknown,
  signal: AbortSignal,
  profile?: RuntimeCapacityProfileId,
): Promise<void> {
  const declared = new Map(media.map((file) => [file.path, file]));
  if (
    !Array.isArray(paths) ||
    paths.length > media.length ||
    new Set(paths).size !== paths.length ||
    paths.some((name) => typeof name !== "string" || !declared.has(name))
  )
    throw new Error(
      "The isolated component requested an undeclared media file",
    );
  for (const name of paths) {
    signal.throwIfAborted();
    await copyRuntimeMedia(workspace, declared.get(name)!, stream, { profile, signal });
  }
  stream.end();
}

function sourceManifest(files: SourceManifestEntry[]): string {
  if (!Array.isArray(files) || files.length > 2000)
    throw new Error("Invalid isolated source manifest");
  const seen = new Set<string>();
  const entries = files
    .map((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        seen.has(file.path) ||
        (file.executable !== undefined &&
          typeof file.executable !== "boolean") ||
        ("rasterBaseSha256" in file &&
          (typeof file.rasterBaseSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(file.rasterBaseSha256)))
      )
        throw new Error("Invalid isolated source manifest");
      transferPath(file.path);
      seen.add(file.path);
      return [file.path, file.sha256, file.executable === true] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(entries);
}

type ManifestScope = { sourceManifestVersion?: unknown; sourceBaseManifestId?: unknown; sourceProfileId?: unknown };
function sourceRequest(scope: ManifestScope | undefined): { sourceManifestVersion: 1 | 2; sourceBaseManifestId: string; sourceProfileId?: RuntimeCapacityProfileId } | undefined {
  if (scope?.sourceManifestVersion !== 1 && scope?.sourceManifestVersion !== 2) return undefined;
  if (typeof scope.sourceBaseManifestId !== "string" || !/^[a-f0-9]{64}$/.test(scope.sourceBaseManifestId)) throw new Error("Invalid isolated source manifest scope");
  if (scope.sourceManifestVersion === 2) return { sourceManifestVersion: 2, sourceBaseManifestId: scope.sourceBaseManifestId, sourceProfileId: getRuntimeCapacityProfile(scope.sourceProfileId).id };
  if (scope.sourceProfileId !== undefined) throw new Error("A legacy manifest cannot acquire a larger profile");
  return { sourceManifestVersion: 1, sourceBaseManifestId: scope.sourceBaseManifestId };
}
function sourceScope(contract: SourceContract) {
  return { sourceManifestVersion: contract.version, sourceBaseManifestId: contract.baseManifestId, sourceResultManifestId: contract.rawManifestId, ...(contract.version === 2 ? { sourceProfileId: contract.profileId } : {}) };
}
function manifestFor(files: Array<TransferFile | RuntimeMedia>, profile?: RuntimeCapacityProfileId) {
  const entries = sourceManifestEntries(files, profile ? { profile } : undefined).files;
  return profile ? createSourceManifestV2(profile, entries) : createSourceManifest(entries);
}
/** Independently binds the complete metadata to the legacy snapshot and actual inline bytes. */
function versionedSourceSnapshot(
  value: {
    files: Array<TransferFile | RuntimeMedia>;
    baselineFiles: SourceManifestEntry[];
    retainedRasters?: Array<RuntimeMedia & { executable: false }>;
    sourceManifestVersion?: unknown;
    sourceProfileId?: unknown;
    sourceBaselineManifest?: unknown;
    sourceManifest?: unknown;
    sourceResultManifestId?: unknown;
    sourceDelta?: unknown;
  },
  expectedBase?: string,
  expectedProfile?: RuntimeCapacityProfileId,
): SourceContract | undefined {
  const fields = [
    "sourceManifestVersion",
    "sourceBaselineManifest",
    "sourceManifest",
    "sourceResultManifestId",
    "sourceDelta",
    ...(expectedProfile ? ["sourceProfileId"] : []),
  ];
  if (!expectedBase) {
    if ([...fields,"sourceProfileId"].some((key) => Object.hasOwn(value, key)))
      throw new Error("An unnegotiated source manifest was returned");
    return undefined;
  }
  if (
    value.sourceManifestVersion !== (expectedProfile ? 2 : 1) ||
    (expectedProfile ? value.sourceProfileId !== expectedProfile : value.sourceProfileId !== undefined) ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(
      "The negotiated source manifest is missing; no legacy capture was requested",
    );
  const before = parseSourceManifest(value.sourceBaselineManifest),
    after = parseSourceManifest(value.sourceManifest);
  if (
    before.manifestId !== expectedBase ||
    before.version !== (expectedProfile ? 2 : 1) || after.version !== before.version || before.profile !== (expectedProfile ?? "current-64") || after.profile !== before.profile ||
    after.manifestId !== value.sourceResultManifestId ||
    before.files.length !== value.baselineFiles.length
  )
    throw new Error("The isolated source manifest binding changed");
  const baseline = new Map(
    value.baselineFiles.map((file) => [file.path, file]),
  );
  for (const entry of before.files) {
    const file = baseline.get(entry.path);
    if (
      !file ||
      Object.keys(file).some(
        (key) => !["path", "sha256", "executable", "size"].includes(key),
      ) ||
      entry.sha256 !== file.sha256 ||
      entry.executable !== !!file.executable ||
      entry.kind !== ("size" in file ? "media" : "source") ||
      ("size" in file && entry.size !== file.size)
    )
      throw new Error(
        "The complete baseline disagrees with the original snapshot metadata",
      );
  }
  const files = [...value.files, ...(value.retainedRasters ?? [])].map(
    (file) => {
      if ("data" in file) return file;
      if (
        Object.keys(file).some(
          (key) => !["path", "size", "sha256", "executable"].includes(key),
        ) ||
        ("executable" in file && file.executable !== false)
      )
        throw new Error("Invalid versioned media declaration");
      return { path: file.path, size: file.size, sha256: file.sha256 };
    },
  );
  const actual = manifestFor(files, expectedProfile);
  if (after.manifestId !== actual.manifestId)
    throw new Error(
      "The complete source manifest disagrees with the returned files",
    );
  assertSourceDeltaSummary(value.sourceDelta, before, after);
  if (expectedProfile && planSourceDelta(before, after).summary.afterMediaBytes > 64 * 1024 * 1024) throw new Error("Changed media exceeds the single-operation preservation contract; retained data requires review");
  return parseSourceContract({
    version: expectedProfile ? 2 : 1,
    ...(expectedProfile ? { profileId: expectedProfile } : {}),
    baseManifestId: before.manifestId,
    rawManifestId: after.manifestId,
  });
}

export async function isolatedProjectStore(
  runtimeRoot: string,
  dataDirectory: string,
): Promise<{ directory: string; manual: boolean }> {
  const root = await realpath(runtimeRoot);
  const directory = await realpath(path.join(dataDirectory, "projects"));
  for (const name of ["test-data", "manual-data"]) {
    if (directory === path.join(root, name, "projects"))
      return { directory, manual: name === "manual-data" };
  }
  throw new Error(
    "This source-edition isolated backend is not configured for this project store",
  );
}

/** A closed, source-edition backend. It cannot launch an arbitrary host command. */
export class IsolatedProjectExecution {
  readonly #operations = new WeakMap<ChildProcess, Operation>();
  readonly #children = new Set<ChildProcess>();
  readonly #jobs = new Set<ChildProcess>();
  #connections = 0;
  #runtimeMedia = false;
  #buildMedia = false;
  #sourceInspection = false;
  #sourceDeletionWithdrawal = false;
  #rasterReturns = false;
  #retainedReview = false;
  #captureMedia = false;
  #sourceManifests = false;
  #mediumProfile = false;
  #capacityProfiles = new Set<RuntimeCapacityProfileId>();
  #legacyReview = false;
  readonly #waitingConnections = new Set<() => void>();
  readonly dependenciesInGuest = true;
  readonly #projects = new Set<string>();
  readonly #retiring = new Set<string>();
  readonly #active = new Map<string, Operation>();
  readonly #preparing = new Map<string, Promise<void>>();
  readonly #recoveryRequests = new Set<string>();
  readonly #returning = new Map<string, Set<Promise<void>>>();
  readonly #epochs = new Map<string, number>();
  #admission?: (projectId: string) => void;
  #closed = false;
  #closing?: Promise<void>;
  // ponytail: This cache lasts only for the daemon process; persist only if offline history becomes required.
  #storageSnapshot?: ExecutionStorageSnapshot;
  #storageReading?: Promise<ExecutionStorageOverview>;

  private constructor(
    private readonly projectsDirectory: string,
    private readonly vm?: IsolatedVmLifecycle,
    readonly namespace: Namespace = "test",
  ) {}

  static async load(
    dataDirectory: string,
  ): Promise<IsolatedProjectExecution | undefined> {
    const file = path.join(dataDirectory, "isolated-execution.json");
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    try {
      const stat = await handle.stat();
      if (
        process.platform !== "darwin" ||
        process.arch !== "arm64" ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error("Isolated execution configuration is not private");
      const value = JSON.parse(await handle.readFile("utf8")) as {
        version?: unknown;
        projectsDirectory?: unknown;
      };
      const { directory: expected, manual } = await isolatedProjectStore(
        RUNTIME_ROOT,
        dataDirectory,
      );
      if (value.version !== 1 || value.projectsDirectory !== expected) {
        throw new Error(
          "This source-edition isolated backend is not configured for this project store",
        );
      }
      const binary = await open(
        LIMA,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await binary.stat();
        if (
          !stat.isFile() ||
          stat.size > 64 * 1024 * 1024 ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o022) !== 0 ||
          createHash("sha256")
            .update(await binary.readFile())
            .digest("hex") !== LIMA_SHA256
        )
          throw new Error("The reviewed Lima runtime is unavailable");
      } finally {
        await binary.close();
      }
      return new IsolatedProjectExecution(
        expected,
        manual
          ? new IsolatedVmLifecycle(
              RUNTIME_ROOT,
              process.env.OHMYGAME_LOCAL_LAUNCH_ID ?? "",
            )
          : undefined,
        manual ? "manual" : "test",
      );
    } finally {
      await handle.close();
    }
  }

  #spawn(operation: string, args: string[] = []): ChildProcess {
    const child = spawn(
      LIMA,
      [
        "shell",
        "--workdir=/",
        "omg",
        "--",
        "sudo",
        "-n",
        "python3",
        CONTROLLER,
        operation,
        ...args,
      ],
      {
        cwd: RUNTIME_ROOT,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: path.join(RUNTIME_ROOT, "home"),
          LIMA_HOME: path.join(RUNTIME_ROOT, "lima"),
          XDG_CONFIG_HOME: path.join(RUNTIME_ROOT, "config"),
          XDG_CACHE_HOME: path.join(RUNTIME_ROOT, "cache"),
          TMPDIR: path.join(RUNTIME_ROOT, "tmp"),
          PATH: `${path.dirname(LIMA)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          SSH: "/usr/bin/ssh -F /dev/null",
        },
      },
    );
    this.#children.add(child);
    child.once("close", () => this.#children.delete(child));
    return child;
  }

  async #control(
    operation: string,
    args: string[],
    input?: object,
    transfer?: {
      workspace: string;
      media: RuntimeMedia[];
      signal: AbortSignal;
      expectedPaths?: readonly string[];
      profile?: RuntimeCapacityProfileId;
    },
    controlSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = transfer?.signal ?? controlSignal;
    signal?.throwIfAborted();
    const child = this.#spawn(operation, args);
    let output = "",
      error = "";
    const stop = () => this.#stop(child);
    const timer = setTimeout(stop, transfer || operation === "migrate-capacity" ? 125_000 : 40_000);
    signal?.addEventListener("abort", stop, { once: true });
    let upload: Promise<void> | undefined, uploadError: unknown;
    try {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (output.length > 16 * 1024 * 1024) return;
        output += chunk;
        if (output.length > 16 * 1024 * 1024) {
          this.#stop(child);
          return;
        }
        if (transfer && !upload && output.includes("\n")) {
          const boundary = output.indexOf("\n");
          let header: { needMedia?: unknown };
          try {
            header = JSON.parse(output.slice(0, boundary));
          } catch {
            stop();
            return;
          }
          if (header && typeof header === "object" && "needMedia" in header) {
            output = output.slice(boundary + 1);
            if (transfer.expectedPaths && JSON.stringify(header.needMedia) !== JSON.stringify(transfer.expectedPaths)) {
              uploadError = new Error("The isolated upload window requested a different path set"); upload = Promise.resolve(); stop(); return;
            }
            upload = writeNeededMedia(
              child.stdin!,
              transfer.workspace,
              transfer.media,
              header.needMedia,
              transfer.signal,
              transfer.profile,
            ).catch((cause) => {
              uploadError = cause;
              stop();
            });
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString()).slice(-2000);
      });
      child.stdin!.on("error", () => this.#stop(child));
      const complete = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (transfer) child.stdin!.write(JSON.stringify(input) + "\n");
      else child.stdin!.end(input ? JSON.stringify(input) : "");
      const code = await complete;
      await upload;
      if (uploadError) throw uploadError;
      signal?.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        throw new Error(
          redactKnownSensitiveValues(
            error || "Invalid isolated control response",
          ),
        );
      }
      checkControlResponse(value);
      if (transfer && !upload)
        throw new Error(
          "The isolated component did not negotiate the media upload",
        );
      if (code !== 0)
        throw new Error(
          redactKnownSensitiveValues(
            error || "Isolated control operation failed",
          ),
        );
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  #binding(
    value: unknown,
    projectId: string,
    operationId: string,
  ): OperationBinding {
    const item = value as Partial<OperationBinding> | undefined;
    if (
      !item ||
      item.namespace !== this.namespace ||
      item.projectId !== projectId ||
      item.operationId !== operationId ||
      !Number.isSafeInteger(item.generation) ||
      item.generation! < 1 ||
      typeof item.leaseToken !== "string" ||
      !/^[a-f0-9]{32}$/.test(item.leaseToken) ||
      (item.rasterReturnVersion !== undefined &&
        ![0, 1, 2].includes(item.rasterReturnVersion)) ||
      (item.captureVersion !== undefined &&
        ![2, 3, 4].includes(item.captureVersion)) ||
      (item.captureVersion === 2 &&
        (item.rasterReturnVersion !== 2 ||
          item.reviewSnapshotId !== undefined)) ||
      (item.captureVersion === 3 &&
        (item.rasterReturnVersion !== 2 ||
          item.sourceManifestVersion !== 1 ||
          typeof item.sourceBaseManifestId !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.sourceBaseManifestId))) ||
      (item.captureVersion === 4 && (item.rasterReturnVersion !== 2 || item.sourceManifestVersion !== 2 || !this.#capacityProfiles.has(item.sourceProfileId as RuntimeCapacityProfileId) || typeof item.sourceBaseManifestId !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceBaseManifestId))) ||
      (item.captureVersion === 3 && item.sourceProfileId !== undefined) ||
      (![3,4].includes(item.captureVersion ?? 0) &&
        (item.sourceManifestVersion !== undefined || item.sourceProfileId !== undefined || item.sourceBaseManifestId !== undefined)) ||
      (item.rasterReturnVersion === 2 &&
        item.captureVersion === undefined &&
        item.reviewSnapshotId === undefined) ||
      (item.reviewSnapshotId !== undefined &&
        (typeof item.reviewSnapshotId !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.reviewSnapshotId)))
    )
      throw new Error("Invalid isolated operation binding");
    registerSensitiveValue(item.leaseToken);
    return {
      namespace: this.namespace,
      projectId,
      operationId,
      generation: item.generation!,
      leaseToken: item.leaseToken,
      ...(item.rasterReturnVersion
        ? { rasterReturnVersion: item.rasterReturnVersion }
        : {}),
      ...(item.captureVersion ? { captureVersion: item.captureVersion } : {}),
      ...(item.captureVersion === 3 || item.captureVersion === 4
        ? {
            sourceManifestVersion: item.captureVersion === 4 ? 2 as const : 1 as const,
            sourceBaseManifestId: item.sourceBaseManifestId!,
            ...(item.captureVersion === 4 ? { sourceProfileId: getRuntimeCapacityProfile(item.sourceProfileId).id } : {}),
          }
        : {}),
      ...(item.reviewSnapshotId
        ? { reviewSnapshotId: item.reviewSnapshotId }
        : {}),
    };
  }

  async #health(signal?: AbortSignal): Promise<void> {
    const value = (await this.#control("health", [], undefined, undefined, signal)) as {
      protocolVersion?: unknown;
      ready?: unknown;
      runtimeMediaVersion?: unknown;
      buildMediaVersion?: unknown;
      sourceInspectionVersion?: unknown;
      sourceDeletionWithdrawalVersion?: unknown;
      rasterReturnVersion?: unknown;
      retainedReviewVersion?: unknown;
      captureVersion?: unknown;
      sourceManifestVersion?: unknown;
      manifestCaptureVersion?: unknown;
      rasterInspectionVersion?: unknown;
      capacityProfileVersion?: unknown;
      profileManifestVersion?: unknown;
      profileCaptureVersion?: unknown;
      profileUploadVersion?: unknown;
      volumeMigrationVersion?: unknown;
      capacityProfiles?: unknown;
      legacyReviewVersion?: unknown;
      limits?: Record<string, unknown>;
    };
    if (value.protocolVersion !== 2 || value.ready !== true)
      throw Object.assign(
        new Error(
          "The isolated execution component needs a reviewed lifecycle update or migration; existing project data was not changed",
        ),
        { code: "PROTOCOL_MISMATCH", changed: false },
      );
    this.#runtimeMedia = value.runtimeMediaVersion === 1;
    this.#buildMedia = value.buildMediaVersion === 1;
    this.#sourceInspection = value.sourceInspectionVersion === 1;
    this.#sourceDeletionWithdrawal = value.sourceDeletionWithdrawalVersion === 1;
    this.#rasterReturns = value.rasterReturnVersion === 1;
    this.#captureMedia =
      value.captureVersion === 2 &&
      value.rasterInspectionVersion === 2 &&
      value.retainedReviewVersion === 2;
    this.#sourceManifests =
      this.#captureMedia &&
      this.#runtimeMedia &&
      this.#buildMedia &&
      value.sourceManifestVersion === 1 &&
      value.manifestCaptureVersion === 3;
    if (
      (value.sourceManifestVersion !== undefined ||
        value.manifestCaptureVersion !== undefined) &&
      !this.#sourceManifests
    )
      throw new Error(
        "The isolated source manifest capability is incomplete or incompatible; no project operation was submitted",
      );
    const descriptors = value.capacityProfileVersion === 2 ? [getRuntimeCapacityProfile("capacity-128-v2")] : value.capacityProfileVersion === 3 ? RUNTIME_CAPACITY_PROFILES : undefined;
    this.#mediumProfile = !!descriptors && value.profileManifestVersion === 2 && value.profileCaptureVersion === 4 && value.profileUploadVersion === 1 && value.volumeMigrationVersion === 1 && isDeepStrictEqual(value.capacityProfiles, descriptors) && this.#sourceManifests;
    this.#capacityProfiles = new Set(this.#mediumProfile ? descriptors!.map(profile => profile.id) : []);
    if (value.capacityProfileVersion !== undefined && !this.#mediumProfile) throw new Error("The medium execution profile has incomplete or incompatible capabilities");
    this.#retainedReview = value.retainedReviewVersion === 2;
    this.#legacyReview = value.legacyReviewVersion === 1;
    const limits = value.limits;
    if (
      !limits ||
      limits.residentVolumes !== 8 ||
      limits.volumeBytes !== 256 * 1024 * 1024 ||
      limits.totalLogicalBytes !== 4 * 1024 ** 3 ||
      limits.reserveBytes !== 1024 ** 3 ||
      limits.globalOperations !== 2 ||
      JSON.stringify(limits.identityRange) !== "[5000,5095]"
    )
      throw new Error(
        "The isolated lifecycle resource profile is not supported",
      );
  }

  /** Exact advertised identity only; this never starts or mounts the VM. */
  async supportsCapacityProfile(profile: RuntimeCapacityProfileId, signal?: AbortSignal): Promise<boolean> {
    if (this.#closed) throw new Error("Isolated execution is closing");
    getRuntimeCapacityProfile(profile);
    signal?.throwIfAborted();
    await this.#health(signal);
    return this.#capacityProfiles.has(profile);
  }

  async inventory(): Promise<{
    protocolVersion: 2;
    projects: IsolatedProjectStorage[];
  }> {
    if (this.#closed) throw new Error("Isolated execution is closing");
    await this.#health();
    const value = (await this.#control("inventory", [], {
      namespace: this.namespace,
    })) as {
      protocolVersion?: unknown;
      namespace?: unknown;
      projects?: unknown;
    };
    if (
      value.protocolVersion !== 2 ||
      value.namespace !== this.namespace ||
      !Array.isArray(value.projects) ||
      value.projects.length > 96
    )
      throw new Error("Invalid isolated storage inventory");
    const seen = new Set<string>();
    for (const item of value.projects as IsolatedProjectStorage[]) {
      if (
        !item ||
        item.namespace !== this.namespace ||
        !/^[a-f0-9-]{36}$/.test(item.projectId) ||
        seen.has(item.projectId) ||
        !Number.isSafeInteger(item.generation) ||
        item.generation < 1 ||
        ![
          "resident",
          "archived",
          "recovery-pending",
          "busy",
          "deleting",
          "deleted",
        ].includes(item.state) ||
        typeof item.dirty !== "boolean" ||
        typeof item.active !== "boolean" ||
        (item.sourceManifestVersion !== undefined &&
          (![1,2].includes(item.sourceManifestVersion) || !this.#sourceManifests || (item.sourceManifestVersion === 2 && !this.#capacityProfiles.has(item.sourceProfileId as RuntimeCapacityProfileId)) || (item.sourceManifestVersion === 1 && item.sourceProfileId !== undefined) ||
            typeof item.sourceBaseManifestId !== "string" ||
            !/^[a-f0-9]{64}$/.test(item.sourceBaseManifestId))) ||
        (item.sourceManifestVersion === undefined &&
          (item.sourceBaseManifestId !== undefined || item.sourceProfileId !== undefined))
      )
        throw new Error("Invalid isolated project storage record");
      seen.add(item.projectId);
    }
    return {
      protocolVersion: 2,
      projects: value.projects as IsolatedProjectStorage[],
    };
  }

  async inventoryProject(
    project: ProjectState,
  ): Promise<IsolatedProjectStorage | undefined> {
    return (await this.inventory()).projects.find(
      (item) => item.projectId === project.id && item.state !== "deleted",
    );
  }

  /** Metadata only: never starts the VM, reserves a task, publishes source or acknowledges it. */
  async inspectSource(
    project: ProjectState,
    generation: number,
  ): Promise<IsolatedSourceInspection | undefined> {
    if (this.#closed) throw new Error("Isolated execution is closing");
    await this.#health();
    if (!this.#sourceInspection) return undefined;
    const value = (await this.#control("inspect-source", [], {
      namespace: this.namespace,
      projectId: project.id,
      generation,
    })) as IsolatedSourceInspection;
    const validRasterRules =
      (value?.rasterInspectionVersion === 1 &&
        (value.rasterReturnVersion === 0 || value.rasterReturnVersion === 1)) ||
      (value?.rasterInspectionVersion === 2 && value.rasterReturnVersion === 2);
    if (this.#rasterReturns && !validRasterRules)
      throw new Error(
        "The installed isolated inspection rules need a reviewed update; metadata cannot establish recoverability",
      );
    if (
      value &&
      (value.rasterInspectionVersion !== undefined ||
        value.rasterReturnVersion !== undefined) &&
      !validRasterRules
    )
      throw new Error(
        "Invalid retained source inspection rule version; no recovery was attempted",
      );
    if (
      !value ||
      value.namespace !== this.namespace ||
      value.projectId !== project.id ||
      value.generation !== generation ||
      typeof value.complete !== "boolean" ||
      !Array.isArray(value.changes) ||
      value.changes.length > 2000 ||
      !Number.isSafeInteger(value.excluded) ||
      value.excluded < 0 ||
      value.excluded > 4000 ||
      !Number.isSafeInteger(value.blockers) ||
      value.blockers < 0 ||
      value.blockers > 2001 ||
      (!value.complete && value.blockers === 0)
    )
      throw new Error(
        "Invalid retained source inspection; no recovery was attempted",
      );
    const changes = value.changes.map((change) => {
      if (
        !change ||
        !["added", "modified", "deleted", "blocked"].includes(change.kind) ||
        typeof change.path !== "string" ||
        !change.path ||
        change.path.length > 1000 ||
        (change.size !== undefined &&
          (!Number.isSafeInteger(change.size) || change.size < 0)) ||
        (change.reason !== undefined &&
          (typeof change.reason !== "string" || change.reason.length > 2000))
      )
        throw new Error(
          "Invalid retained source inspection entry; no recovery was attempted",
        );
      if (change.kind !== "blocked") transferPath(change.path);
      return {
        path: redactKnownSensitiveValues(change.path),
        kind: change.kind,
        ...(change.size !== undefined ? { size: change.size } : {}),
        ...(change.reason !== undefined
          ? { reason: redactKnownSensitiveValues(change.reason) }
          : {}),
      };
    });
    return {
      namespace: value.namespace,
      projectId: value.projectId,
      generation: value.generation,
      complete: value.complete,
      changes,
      excluded: value.excluded,
      blockers: value.blockers,
      ...(value.rasterInspectionVersion !== undefined
        ? { rasterInspectionVersion: value.rasterInspectionVersion }
        : {}),
      ...(value.rasterReturnVersion !== undefined
        ? { rasterReturnVersion: value.rasterReturnVersion }
        : {}),
    };
  }

  async #reviewSnapshot(
    project: ProjectState,
    generation: string,
    verifyOnly = false,
    signal?: AbortSignal,
  ): Promise<
    | ReviewSnapshot
    | (RetainedReviewSnapshot & {
        rasters: Map<string, string>;
        spaceReservation?: RecoverySpaceReservation;
        borrowedSpace?: boolean;
      })
  > {
    if (this.#closed) throw new Error("Isolated execution is closing");
    if (
      !/^[0-9]{1,32}$/.test(generation) ||
      !Number.isSafeInteger(Number(generation)) ||
      Number(generation) < 1
    )
      throw new Error("Inspect the current generation before reviewing source");
    await this.#health();
    if (this.#retainedReview)
      return this.#reviewMediaSnapshot(
        project,
        generation,
        undefined,
        signal,
        verifyOnly,
      );
    if (!this.#legacyReview)
      throw new Error(
        "The installed isolated component does not support controlled legacy source review; update it before proceeding",
      );
    const value = (await this.#control("review-source", [], {
      namespace: this.namespace,
      projectId: project.id,
      generation: Number(generation),
    })) as ReviewSnapshot & {
      namespace: string;
      projectId: string;
      generation: number;
    };
    if (
      !value ||
      value.namespace !== this.namespace ||
      value.projectId !== project.id ||
      value.generation !== Number(generation) ||
      !/^[a-f0-9]{64}$/.test(value.snapshotId)
    )
      throw new Error("Invalid retained source review snapshot");
    sourceManifest(value.files);
    sourceManifest(value.baselineFiles);
    return value;
  }

  async #reviewMediaSnapshot(
    project: ProjectState,
    generation: string,
    state?: Operation,
    signal?: AbortSignal,
    verifyOnly = false,
  ): Promise<
    RetainedReviewSnapshot & {
      rasters: Map<string, string>;
      spaceReservation?: RecoverySpaceReservation;
      borrowedSpace?: boolean;
    }
  > {
    const current = state ? undefined : await this.inventoryProject(project);
    if (!state && (!current || String(current.generation) !== generation))
      throw new Error("Retained generation changed before its manifest review");
    const manifestScope = sourceRequest(state?.binding ?? current);
    const child = this.#spawn(state ? "capture-media" : "review-source-media"),
      timer = setTimeout(() => {
        child.stdout!.destroy(new Error("Retained review timed out"));
        this.#stop(child);
      }, 125_000);
    child.stderr!.resume();
    child.stdin!.on("error", () => this.#stop(child));
    const abort = () => {
      child.stdout!.destroy(new Error("Raster transfer was cancelled"));
      this.#stop(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let spaceReservation: RecoverySpaceReservation | undefined;
    let borrowedSpace = false;
    let transferred = false;
    let incoming: string | undefined;
    let incomingIdentity: { dev: number; ino: number } | undefined;
    const staged = new Set<string>();
    const cleanupIncoming = async () => {
      if (!incoming) return;
      const current = await lstat(incoming);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== incomingIdentity?.dev ||
        current.ino !== incomingIdentity?.ino
      )
        throw new Error(
          "Raster transfer staging changed; retained for inspection",
        );
      for (const name of await readdir(incoming)) {
        if (!staged.has(name))
          throw new Error(
            "Unknown raster staging file; retained for inspection",
          );
        const file = path.join(incoming, name),
          info = await lstat(file);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077
        )
          throw new Error(
            "Unsafe raster staging file; retained for inspection",
          );
        await unlink(file);
      }
      await rmdir(incoming);
      incoming = undefined;
    };
    const complete = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    void complete.catch(() => {});
    try {
      child.stdin!.end(
        JSON.stringify(
          state
            ? {
                namespace: this.namespace,
                projectId: project.id,
                operationId: state.id,
                generation: state.binding!.generation,
                leaseToken: state.binding!.leaseToken,
                captureVersion: state.binding!.captureVersion,
                ...manifestScope,
              }
            : {
                namespace: this.namespace,
                projectId: project.id,
                generation: Number(generation),
                reviewVersion: 2,
                ...manifestScope,
              },
        ),
      );
      const stream = await readBuildStream(child.stdout!);
      const raw = stream.manifest as unknown as RetainedReviewSnapshot & {
        namespace: string;
        projectId: string;
        operationId?: string;
        generation: number;
        captureVersion?: number;
        returnedRasters?: RetainedReviewSnapshot["retainedRasters"];
      };
      if (
        state &&
        (raw.captureVersion !== state.binding?.captureVersion ||
          raw.operationId !== state.id ||
          raw.rasterReturnVersion !== 2 ||
          !Array.isArray(raw.returnedRasters) ||
          "reviewVersion" in raw ||
          "originOperations" in raw ||
          "retainedRasters" in raw)
      )
        throw new Error("Invalid original-operation raster capture");
      const value = state
        ? {
            ...raw,
            reviewVersion: 2 as const,
            retainedRasters: raw.returnedRasters!,
            originOperations: [],
          }
        : raw;
      if (
        value.reviewVersion !== 2 ||
        value.namespace !== this.namespace ||
        value.projectId !== project.id ||
        value.generation !== Number(generation) ||
        !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
        ![0, 1, 2].includes(value.rasterReturnVersion) ||
        !Array.isArray(value.retainedRasters) ||
        !Array.isArray(value.originOperations) ||
        value.originOperations.length > 32
      )
        throw new Error("Invalid retained raster review manifest");
      sourceManifest(value.files);
      sourceManifest(value.baselineFiles);
      sourceManifest([...value.files, ...value.retainedRasters]);
      if (
        [...value.files, ...value.retainedRasters].some((file) =>
          containsKnownSensitiveValue(file.path),
        )
      )
        throw new Error("Protected retained file identity");
      let ordinary = 0,
        media = 0, rawMedia = 0;
      for (const file of value.files) {
        if ("data" in file) {
          if (
            typeof file.data !== "string" ||
            file.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              file.data,
            )
          )
            throw new Error("Invalid retained source encoding");
          const bytes = Buffer.from(file.data, "base64");
          ordinary += bytes.length;
          if (
            bytes.length > 2 * 1024 * 1024 ||
            ordinary > 8 * 1024 * 1024 ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
            containsKnownSensitiveValue(bytes.toString("utf8"))
          )
            throw new Error("Private, oversized or changed retained source");
        } else {
          if (
            !Number.isSafeInteger(file.size) ||
            file.size < 1 ||
            file.size > runtimeMediaFileLimit(file.path, manifestScope?.sourceProfileId === undefined ? undefined : getRuntimeCapacityProfile(manifestScope.sourceProfileId).id) ||
            !runtimeMediaPath(file.path) ||
            ("executable" in file && file.executable !== false)
          )
            throw new Error("Invalid retained media copy");
          media += file.size;
        }
      }
      for (const file of value.retainedRasters) {
        if (
          !Number.isSafeInteger(file.size) ||
          file.size < 1 ||
          file.size > 32 * 1024 * 1024 ||
          file.executable !== false ||
          !runtimeMediaPath(file.path) ||
          !isStaticRasterPath(file.path)
        )
          throw new Error("Invalid retained raster source");
        media += file.size; rawMedia += file.size;
      }
      if (
        media > (manifestScope?.sourceProfileId ? getRuntimeCapacityProfile(manifestScope.sourceProfileId).mediaBytes : 64 * 1024 * 1024) || rawMedia > 64 * 1024 * 1024 ||
        reviewSnapshotDigest([...value.files, ...value.retainedRasters]) !==
          value.snapshotId
      )
        throw new Error("Retained raster aggregate or snapshot did not match");
      const sourceContract = versionedSourceSnapshot(
        value,
        manifestScope?.sourceBaseManifestId,
        manifestScope?.sourceProfileId,
      );
      if (state) state.sourceContract = sourceContract;
      const origins = new Set<string>();
      for (const operation of value.originOperations) {
        if (
          !operation ||
          !/^[a-f0-9]{32}$/.test(operation.operationId) ||
          origins.has(operation.operationId) ||
          !["shell", "build", "install", "recovery"].includes(operation.mode) ||
          !["finished", "released"].includes(operation.phase) ||
          operation.snapshotId !== value.snapshotId ||
          typeof operation.acknowledged !== "boolean" ||
          (sourceContract && (operation.sourceManifestVersion !== sourceContract.version || (sourceContract.version === 2 ? operation.sourceProfileId !== sourceContract.profileId : operation.sourceProfileId !== undefined))) ||
          (operation.sourceManifestVersion !== undefined &&
            (![1,2].includes(operation.sourceManifestVersion) ||
              typeof operation.sourceBaseManifestId !== "string" ||
              !/^[a-f0-9]{64}$/.test(operation.sourceBaseManifestId) ||
              operation.sourceResultManifestId !==
                sourceContract?.rawManifestId)) ||
          (operation.sourceManifestVersion === undefined &&
            (operation.sourceBaseManifestId !== undefined ||
              operation.sourceResultManifestId !== undefined || operation.sourceProfileId !== undefined))
        )
          throw new Error("Invalid retained operation provenance");
        origins.add(operation.operationId);
      }
      signal?.throwIfAborted();
      if (!state?.spaceReservation && !verifyOnly) {
        const rawEntries = [
          ...value.files
            .filter((f): f is TransferFile => "data" in f)
            .map((f) => ({
              sha256: f.sha256,
              size: Buffer.byteLength(f.data, "base64"),
            })),
          ...value.retainedRasters,
        ];
        const approved = sourceContract
          ? await approvedSourceReview(
              project.workspacePath,
              project.id,
              this.namespace,
              generation,
            )
          : undefined;
        const approvedContract = approved
          ? reviewSourceContract(approved)
          : undefined;
        const publicationContract =
          approvedContract &&
          approvedContract.baseManifestId === sourceContract?.baseManifestId &&
          approvedContract.rawManifestId === sourceContract.rawManifestId
            ? approvedContract
            : sourceContract;
        spaceReservation = await this.#pendingSpace(project, {
          namespace: this.namespace,
          projectId: project.id,
          generation: Number(generation),
          snapshotId: value.snapshotId,
          ...(publicationContract
            ? { sourceContract: publicationContract }
            : {}),
        });
        spaceReservation ??= await reconnectRetainedRecoverySpace(
          project.workspacePath,
          {
            namespace: this.namespace,
            projectId: project.id,
            generation: Number(generation),
            rawSnapshotId: value.snapshotId,
            originOperations: value.originOperations,
            ...(sourceContract
              ? {
                  ...sourceScope(sourceContract),
                }
              : {}),
          },
        );
        borrowedSpace = !!spaceReservation;
        if (
          spaceReservation &&
          rawEntries.reduce((n, f) => n + f.size, 0) >
            spaceReservation.plan.rawBytes
        )
          throw new Error(
            "The original publication did not reserve space for another raw review; resume its exact transaction first",
          );
        spaceReservation ??= await this.#reserveSpace(
          project,
          randomUUID().replaceAll("-", ""),
          signal,
          rawEntries,
          sourceContract
            ? {
                ...sourceScope(sourceContract),
                generation: Number(generation),
                rawSnapshotId: value.snapshotId,
              }
            : undefined,
        );
      }
      const rasters = new Map<string, string>();
      if (!verifyOnly && value.retainedRasters.length) {
        const stagingRoot = path.join(
          path.dirname(project.workspacePath),
          "isolated-source-transfers",
        );
        await mkdir(stagingRoot, { mode: 0o700 }).catch((cause) => {
          if (cause.code !== "EEXIST") throw cause;
        });
        const info = await lstat(stagingRoot);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077 ||
          (await realpath(stagingRoot)) !== stagingRoot
        )
          throw new Error("Unsafe raster transfer storage");
        incoming = await mkdtemp(path.join(stagingRoot, "incoming-"));
        const created = await lstat(incoming);
        incomingIdentity = { dev: created.dev, ino: created.ino };
      }
      for (const file of value.retainedRasters) {
        signal?.throwIfAborted();
        const bytes = await stream.readMedia(file);
        if (
          createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
          !mediaHeaderMatches(file.path, bytes) ||
          containsKnownSensitiveValue(bytes.toString("utf8"))
        )
          throw new Error(
            "Retained raster bytes did not match the reviewed manifest",
          );
        if (!verifyOnly && !staged.has(file.sha256)) {
          const handle = await open(
            path.join(incoming!, file.sha256),
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          staged.add(file.sha256);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        rasters.set(file.path, file.sha256);
      }
      await stream.end();
      if ((await complete) !== 0)
        throw new Error("Retained raster export was not confirmed");
      signal?.throwIfAborted();
      if (!verifyOnly)
        for (const id of staged) {
          signal?.throwIfAborted();
          const bytes = await readSafeProjectFile(
            incoming!,
            path.join(incoming!, id),
            32 * 1024 * 1024,
          );
          if (createHash("sha256").update(bytes).digest("hex") !== id)
            throw new Error(
              "Staged raster changed before the complete transfer was confirmed",
            );
          await retainReviewRaster(project.workspacePath, bytes, manifestScope?.sourceProfileId);
          await unlink(path.join(incoming!, id));
        }
      await cleanupIncoming();
      if (state?.spaceReservation && sourceContract)
        await state.spaceReservation.bind({
          rawSnapshotId: value.snapshotId,
          sourceResultManifestId: sourceContract.rawManifestId,
        });
      transferred = true;
      return {
        ...value,
        rasters,
        ...(spaceReservation ? { spaceReservation, borrowedSpace } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout!.destroy();
      this.#stop(child);
      try {
        await cleanupIncoming();
      } finally {
        if (!transferred && !borrowedSpace) await spaceReservation?.release();
      }
    }
  }

  async #pendingSpace(
    project: ProjectState,
    context: PublicationContext,
  ): Promise<RecoverySpaceReservation | undefined> {
    const pending = await pendingSourcePublications(project.workspacePath);
    if (!pending.length) return undefined;
    if (pending.length !== 1)
      throw new Error(
        "More than one unfinished publication requires inspection",
      );
    const item = pending[0]!.manifest;
    if (item.version !== 3 && item.version !== 4 && item.version !== 5)
      throw new Error(
        "The legacy unfinished publication must be recovered under its original contract",
      );
    if (!samePublicationContext(item.context, context))
      throw new Error(
        "The unfinished publication belongs to another exact snapshot",
      );
    return reservationForPublication(
      project.workspacePath,
      item.reservationId!,
      context,
    );
  }
  async #releaseSpaceIfSettled(state: Operation, workspace: string): Promise<void> {
    if (!state.released) return;
    try { await assertSourcePublicationSettled(workspace); }
    catch { return; } // An unfinished journal still owns its allocation promise.
    await state.spaceReservation?.release();
    if (state.physicalReservation) {
      await state.physicalReservation.release(createVolumeMigrationSpaceTerminalProof(
        state.physicalReservation, state.submitted ? "released-host-settled" : "revoked-not-started",
      ));
      state.physicalReservation = undefined;
    }
  }

  async #checkSpace(state: Operation): Promise<void> {
    state.abort.signal.throwIfAborted();
    if (state.spaceReservation) await checkRecoverySpaceHeadroom(state.spaceReservation);
    if (state.physicalReservation) await checkVolumeMigrationSpaceHeadroom(state.physicalReservation);
  }

  async #reservePhysical(project: ProjectState, state: Operation, profileId: RuntimeCapacityProfileId, signal?: AbortSignal, returningArtifacts = false): Promise<void> {
    state.workspacePath = await this.#workspaceRoot(project);
    state.physicalReservation = await reserveVolumeMigrationSpace(state.workspacePath, {
      physicalBytes: getRuntimeCapacityProfile(profileId).volumeBytes + (returningArtifacts ? 136 * 1024 * 1024 : 0),
      hostInodes: returningArtifacts ? 4016 : 8,
      backingDevice: await this.capacityBackingDevice(project),
    }, { namespace: this.namespace, projectId: project.id, profileId, planId: state.id, purpose: "runtime" }, signal);
  }

  async #reserveSpace(
    project: ProjectState,
    ownerKey: string,
    signal?: AbortSignal,
    raw?: readonly { sha256: string; size: number }[],
    sourceScope?: {
      sourceManifestVersion: 1 | 2;
      sourceProfileId?: RuntimeCapacityProfileId;
      sourceBaseManifestId: string;
      sourceResultManifestId?: string;
      generation?: number;
      rawSnapshotId?: string;
    },
  ): Promise<RecoverySpaceReservation> {
    const MiB = 1024 * 1024;
    const media: RuntimeMedia[] = [],
      source = await projectFiles(project.workspacePath, media, undefined, sourceScope?.sourceProfileId ? { profile: sourceScope.sourceProfileId } : undefined);
    const beforeBytes =
      source.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0) +
      media.reduce((n, f) => n + f.size, 0);
    const existingArtifacts: Array<{
      kind: "raw";
      sha256: string;
      size: number;
    }> = [];
    for (const item of raw ?? []) {
      const file = path.join(
        path.dirname(project.workspacePath),
        "isolated-review-artifacts",
        "raw",
        item.sha256,
      );
      try {
        await lstat(file);
        existingArtifacts.push({ kind: "raw", ...item });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    return reserveRecoverySpace(
      project.workspacePath,
      {
        ...(sourceScope?.sourceProfileId ? { profileId: sourceScope.sourceProfileId, backingDevice: await this.capacityBackingDevice(project) } : {}),
        rawBytes: raw ? raw.reduce((n, f) => n + f.size, 0) : 72 * MiB,
        workingBytes: 64 * MiB,
        beforeBytes,
        afterBytes: 72 * MiB,
        manifestBytes: 2 * MiB,
        reviewBytes: 8 * MiB,
        existingArtifacts,
      },
      {
        ownerKey,
        namespace: this.namespace,
        projectId: project.id,
        signal,
        ...sourceScope,
      },
    );
  }
  #withSpace<T>(state: Operation, operation: () => Promise<T>): Promise<T> {
    return state.spaceReservation
      ? withRecoverySpaceReservation(state.spaceReservation, operation)
      : operation();
  }

  async openRecoveryStorage(): Promise<void> {
    if (this.#closed) throw new Error("Isolated execution is closing");
    await this.vm?.ready();
    await this.#health();
  }

  async reviewSource(
    project: ProjectState,
    generation: string | undefined,
    guard: WorkspaceGuard,
    signal?: AbortSignal,
  ): Promise<IsolatedSourceReview> {
    signal?.throwIfAborted();
    await this.#workspaceRoot(project);
    if (
      generation !== undefined &&
      (!/^[0-9]{1,32}$/.test(generation) ||
        !Number.isSafeInteger(Number(generation)))
    )
      throw new Error("Invalid review generation");
    await this.openRecoveryStorage();
    const current = await this.inventoryProject(project);
    if (!current?.dirty) {
      const pending = current
        ? await approvedSourceReview(
            project.workspacePath,
            project.id,
            this.namespace,
            String(current.generation),
          )
        : undefined;
      if (
        pending?.retained &&
        pending.publicationId &&
        pending.recoveryOperationId
      )
        return publicSourceReview(pending);
      throw new Error("There is no dirty retained generation to review");
    }
    if (generation !== undefined && generation !== String(current.generation))
      throw new Error("Retained generation changed; inspect its current state");
    generation = String(current.generation);
    const snapshot = await this.#reviewSnapshot(
      project,
      generation,
      false,
      signal,
    );
    try {
      return await guard(async () => {
        const approved = await approvedSourceReview(
          project.workspacePath,
          project.id,
          this.namespace,
          generation,
        );
        if (approved) {
          if (
            approved.retained &&
            approved.publicationId &&
            approved.recoveryOperationId
          ) {
            if (approved.review.snapshotId !== snapshot.snapshotId)
              throw new Error(
                "The original working publication is unconfirmed and its raw snapshot changed; keep every version and verify its original receipt",
              );
            return publicSourceReview(approved);
          }
          if ((await pendingSourcePublications(project.workspacePath)).length) {
            if (approved.review.snapshotId !== snapshot.snapshotId)
              throw new Error(
                "An interrupted publication and guest snapshot differ; retain all versions for conflict review",
              );
            return publicSourceReview(approved);
          }
          if (approved.review.snapshotId === snapshot.snapshotId) {
            try {
              await assertReviewedHost(
                project.workspacePath,
                approved,
                "before",
              );
              return publicSourceReview(approved);
            } catch {
              /* A completed publication may still be awaiting its guest ACK. */
            }
            try {
              await assertReviewedHost(
                project.workspacePath,
                approved,
                "after",
              );
              return publicSourceReview(approved);
            } catch {
              /* Explicit review may supersede stale consent, but never overwrite a concurrent save. */
            }
          }
          approved.superseded = true;
          await saveSourceReview(approved);
        }
        await assertSourcePublicationSettled(project.workspacePath);
        const record =
          "reviewVersion" in snapshot && snapshot.reviewVersion === 2
            ? await buildRetainedSourceReview(
                project.workspacePath,
                this.namespace,
                project.id,
                Number(generation),
                snapshot,
                snapshot.rasters,
                signal,
              )
            : await buildSourceReview(
                project.workspacePath,
                this.namespace,
                project.id,
                Number(generation),
                snapshot,
                undefined,
                signal,
              );
        signal?.throwIfAborted();
        await saveSourceReview(record);
        return publicSourceReview(record);
      });
    } finally {
      if ("spaceReservation" in snapshot && !snapshot.borrowedSpace)
        await snapshot.spaceReservation?.release();
    }
  }

  async optimizeSourceReview(
    project: ProjectState,
    reviewId: string,
    options: { paths: string[]; maxEdge?: number },
    guard: WorkspaceGuard,
    signal?: AbortSignal,
  ): Promise<IsolatedSourceReview> {
    await this.#workspaceRoot(project);
    signal?.throwIfAborted();
    return guard(async () => {
      await assertSourcePublicationSettled(project.workspacePath);
      const previous = await readSourceReview(
        project.workspacePath,
        project.id,
        this.namespace,
        reviewId,
      );
      if (!previous.retained)
        throw new Error("Only a retained image review can be prepared");
      const sourceContract = reviewSourceContract(previous);
      const lease = await this.#reserveSpace(
        project,
        randomUUID().replaceAll("-", ""),
        signal,
        previous.retained.rawFiles
          .filter((f) => f.kind !== "verified-media")
          .map((f) => ({ sha256: f.sha256, size: f.size! })),
        sourceContract
          ? {
              ...sourceScope(sourceContract),
              generation: Number(previous.review.generation),
              rawSnapshotId: previous.retained.rawSnapshotId,
            }
          : undefined,
      );
      try {
        await lease.bind({
          generation: Number(previous.review.generation),
          rawSnapshotId: previous.retained.rawSnapshotId,
        });
        const record = await optimizeRetainedSourceReview(
          previous,
          options,
          signal,
        );
        signal?.throwIfAborted();
        await saveSourceReview(record);
        return publicSourceReview(record);
      } finally {
        await lease.release();
      }
    });
  }

  async verifySourceReview(
    project: ProjectState,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<{ changed: string[]; recovery?: string }> {
    await this.#workspaceRoot(project);
    signal?.throwIfAborted();
    const record = await readSourceReview(
      project.workspacePath,
      project.id,
      this.namespace,
      reviewId,
    );
    if (
      !record.retained ||
      !record.approvedAt ||
      !record.publicationId ||
      !record.recoveryOperationId ||
      record.superseded
    )
      throw new Error(
        "The original working batch is not confirmed complete; no recovery, publication or acknowledgement was submitted",
      );
    await assertRetainedReviewArtifacts(record, signal);
    const sourceContract = reviewSourceContract(record);
    const snapshot = await this.#reviewSnapshot(
      project,
      record.review.generation,
      true,
      signal,
    );
    const operation =
      "reviewVersion" in snapshot && snapshot.reviewVersion === 2
        ? snapshot.originOperations.find(
            (item) => item.operationId === record.recoveryOperationId,
          )
        : undefined;
    if (
      snapshot.snapshotId !== record.retained.rawSnapshotId ||
      operation?.mode !== "recovery" ||
      !operation.acknowledged ||
      operation.snapshotId !== record.retained.rawSnapshotId ||
      operation.phase !== "released" ||
      !!sourceContract !== (snapshot.sourceManifestVersion === 1 || snapshot.sourceManifestVersion === 2) ||
      (sourceContract &&
        (snapshot.sourceManifestVersion !== sourceContract.version || (sourceContract.version === 2 ? snapshot.sourceProfileId !== sourceContract.profileId : snapshot.sourceProfileId !== undefined) || snapshot.sourceManifest?.manifestId !== sourceContract.rawManifestId ||
          operation.sourceManifestVersion !== sourceContract.version || (sourceContract.version === 2 ? operation.sourceProfileId !== sourceContract.profileId : operation.sourceProfileId !== undefined) ||
          operation.sourceBaseManifestId !== sourceContract.baseManifestId ||
          operation.sourceResultManifestId !== sourceContract.rawManifestId))
    )
      throw new Error(
        "The original acknowledgement and release are not confirmed; no recovery, publication or acknowledgement was submitted",
      );
    signal?.throwIfAborted();
    await assertReviewedHost(project.workspacePath, record, "after");
    if ((await pendingSourcePublications(project.workspacePath)).length)
      throw new Error(
        "The original publication is not confirmed complete; its retained transaction needs inspection",
      );
    const root = path.join(
      path.dirname(project.workspacePath),
      "isolated-changes",
    );
    const manifest = JSON.parse(
      (
        await readSafeProjectFile(
          root,
          path.join(root, record.publicationId, "manifest.json"),
          2 * 1024 * 1024,
        )
      ).toString(),
    ) as {
      state?: string;
      context?: PublicationContext;
      versions?: Array<{
        path: string;
        afterSha256: string;
        afterSize: number;
        afterMode: number;
      }>;
      verifiedReviewId?: string;
      targetFingerprint?: string;
    };
    if (
      manifest.state !== "committed" ||
      manifest.context?.namespace !== this.namespace ||
      manifest.context.projectId !== project.id ||
      manifest.context.generation !== Number(record.review.generation) ||
      manifest.context.snapshotId !== record.retained.rawSnapshotId ||
      !samePublicationContext(manifest.context, {
        namespace: this.namespace,
        projectId: project.id,
        generation: Number(record.review.generation),
        snapshotId: record.retained.rawSnapshotId,
        ...(sourceContract ? { sourceContract } : {}),
      })
    )
      throw new Error(
        "The original publication receipt does not match this working batch",
      );
    const targetFingerprint = createHash("sha256")
      .update(JSON.stringify(record.targetFiles))
      .digest("hex");
    if (
      !Array.isArray(manifest.versions) ||
      manifest.versions.some((version) => {
        const expected = record.targetFiles.find(
          (file) => file.path === version.path,
        );
        return (
          !expected ||
          expected.sha256 !== version.afterSha256 ||
          expected.size !== version.afterSize ||
          expected.mode !== version.afterMode
        );
      }) ||
      (!manifest.versions.length &&
        (manifest.verifiedReviewId !== reviewId ||
          manifest.targetFingerprint !== targetFingerprint))
    )
      throw new Error(
        "The original committed versions do not match this reviewed working batch",
      );
    signal?.throwIfAborted();
    record.acknowledged = true;
    await saveSourceReview(record);
    return this.#workingReviewProof(
      project,
      record,
      { changed: [], recovery: "isolated-changes/" + record.publicationId },
      true,
    );
  }

  async sourceReview(
    project: ProjectState,
    reviewId: string,
  ): Promise<IsolatedSourceReview> {
    await this.#workspaceRoot(project);
    return publicSourceReview(
      await readSourceReview(
        project.workspacePath,
        project.id,
        this.namespace,
        reviewId,
      ),
    );
  }

  async deletionWithdrawalStatus(project: ProjectState, storage: IsolatedProjectStorage | undefined, inspection?: IsolatedSourceInspection): Promise<{
    deletionWithdrawal?: SourceDeletionWithdrawal;
    deletionWithdrawalReason?: string;
    deletionWithdrawalNeedsReview?: boolean;
  }> {
    if (!storage || project.workspaceLocation === "external") return {};
    const workspace = await this.#workspaceRoot(project);
    const reviews = await sourceReviews(workspace, project.id, this.namespace);
    const current = reviews.filter(record => Number(record.review.generation) === storage.generation);
    const pending = reviews.find(record => record.deletionWithdrawal && record.deletionWithdrawal.phase !== "withdrawn");
    const deletions = inspection?.complete && inspection.changes.length > 0 && inspection.changes.every(change => change.kind === "deleted")
      ? new Set(inspection.changes.map(change => change.path)) : undefined;
    const record = pending ?? current
      .filter(record => {
        if (!storage.dirty) return record.deletionWithdrawal?.phase === "withdrawn";
        const selection = sourceDeletionReview(record);
        return !record.deletionWithdrawal && selection && selection.source.baseManifestId === storage.sourceBaseManifestId &&
          (!inspection || deletions?.size === selection.deleted.length && selection.deleted.every(file => deletions.has(file.path)));
      })
      .sort((a, b) => b.review.expiresAt.localeCompare(a.review.expiresAt))[0];
    const selection = record && sourceDeletionReview(record);
    if (!record || !selection) {
      if (pending) return { deletionWithdrawalReason: "The saved deletion withdrawal needs review; its original source evidence is unavailable." };
      if (!storage.dirty || !deletions) return {};
      if (!this.#sourceDeletionWithdrawal) return { deletionWithdrawalReason: "This isolated component needs its reviewed deletion withdrawal update before this batch can be withdrawn." };
      if (!storage.sourceManifestVersion) return { deletionWithdrawalReason: "This retained deletion has no verified shared source manifest. Keep both copies for review." };
      return { deletionWithdrawalNeedsReview: true };
    }
    if (!this.#sourceDeletionWithdrawal && record.deletionWithdrawal?.phase !== "withdrawn")
      return { deletionWithdrawalReason: "This isolated component needs its reviewed deletion withdrawal update before this batch can be withdrawn." };
    return { deletionWithdrawal: {
      reviewId: record.review.reviewId, generation: record.review.generation,
      paths: selection.deleted.map(file => file.path),
      status: record.deletionWithdrawal?.phase === "withdrawn" ? "withdrawn" : record.deletionWithdrawal ? "pending" : "available",
    } };
  }

  async sourceDeletionDisposition(project: ProjectState, target: IsolatedRepairTarget): Promise<{ reviewId: string; withdrawalId: string } | undefined> {
    if (target.projectId !== project.id || target.namespace !== this.namespace || target.mode !== "shell") return undefined;
    const workspace = await this.#workspaceRoot(project);
    for (const record of await sourceReviews(workspace, project.id, this.namespace)) {
      if (record.deletionWithdrawal?.phase !== "withdrawn" || Number(record.review.generation) !== target.generation) continue;
      const source = sourceDeletionReview(record);
      if (source?.original.operationId === target.operationId && source.original.snapshotId === target.rawSnapshotId)
        return { reviewId: record.review.reviewId, withdrawalId: record.deletionWithdrawal.id };
    }
  }

  /** A user-confirmed source disposition. The project write guard is held by the caller. */
  async withdrawSourceDeletion(project: ProjectState, generation: string, reviewId: string): Promise<SourceDeletionWithdrawal> {
    const workspace = await this.#workspaceRoot(project);
    const records = await sourceReviews(workspace, project.id, this.namespace);
    const record = records.find(candidate => candidate.review.reviewId === reviewId);
    const selection = record && sourceDeletionReview(record);
    if (!record || !selection || record.review.generation !== generation)
      throw new Error("This review does not prove that the retained source batch contains only ordinary file deletions.");
    const result = { reviewId, generation, paths: selection.deleted.map(file => file.path), status: "withdrawn" as const };
    if (record.deletionWithdrawal?.phase === "withdrawn") return result;
    if (records.some(other => other !== record && other.deletionWithdrawal && other.deletionWithdrawal.phase !== "withdrawn"))
      throw new Error("Finish the existing deletion withdrawal before starting another one.");
    await assertSourcePublicationSettled(workspace);
    const entry = await this.inventoryProject(project);
    if (!this.#sourceDeletionWithdrawal) throw new Error("The isolated component does not support deletion withdrawal.");
    if (!entry || entry.active || entry.operation || entry.state === "busy" || entry.state === "deleting" ||
      (!record.deletionWithdrawal && (!entry.dirty || entry.generation !== Number(generation) || entry.sourceBaseManifestId !== selection.source.baseManifestId)))
      throw new Error("The retained execution copy has changed or is busy; refresh its state before withdrawing a deletion.");
    await assertReviewedHost(workspace, record, "before");
    if (!record.deletionWithdrawal) {
      record.deletionWithdrawal = { id: randomUUID().replaceAll("-", ""), phase: "restoring" };
      await saveSourceReview(record);
    }
    const journal = record.deletionWithdrawal;
    const binding = {
      namespace: this.namespace, projectId: project.id, generation: Number(generation), reviewId,
      originalOperationId: selection.original.operationId, withdrawalId: journal.id,
      rawSnapshotId: selection.original.snapshotId, rawManifestId: selection.source.rawManifestId, baseManifestId: selection.source.baseManifestId,
    };
    const command = async (operation: string, allowed: readonly string[], files?: TransferFile[]) => {
      const value = await this.#control(operation, [], files ? { ...binding, files } : binding) as Record<string, unknown>;
      if (!value || Object.entries(binding).some(([key, expected]) => value[key] !== expected) || !allowed.includes(String(value.phase)))
        throw new Error("The isolated deletion withdrawal receipt could not be verified. Check the same withdrawal before continuing.");
      return String(value.phase);
    };
    let phase = await command("inspect-source-deletion-withdrawal", ["absent", "restoring", "restored", "confirmed"]);
    if (journal.phase === "restoring") {
      if (phase === "confirmed") throw new Error("The isolated copy reported a completed withdrawal before the host disposition was saved.");
      if (phase !== "restored") {
        const files: TransferFile[] = [];
        for (const entry of selection.deleted) {
          const bytes = await readSafeProjectFile(workspace, path.join(workspace, entry.path), entry.size!);
          if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
            throw new Error("A local source file changed before its isolated copy could be restored.");
          files.push({ path: entry.path, sha256: entry.sha256, data: bytes.toString("base64"), executable: !!entry.executable });
        }
        phase = await command("restore-source-deletions", ["restored"], files);
      }
      await assertReviewedHost(workspace, record, "before");
      journal.phase = "disposed";
      await saveSourceReview(record);
    }
    if (phase !== "confirmed") {
      if (phase !== "restored") throw new Error("The isolated copy has no matching restoration receipt. The original protection remains in effect.");
      await command("confirm-source-deletion-withdrawal", ["confirmed"]);
    }
    await assertReviewedHost(workspace, record, "before");
    journal.phase = "withdrawn";
    await saveSourceReview(record);
    return result;
  }

  async readRetainedImage(
    project: ProjectState,
    reviewId: string,
    relative: string,
    variant: RetainedImageVariant,
    expectedSha256: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Isolated execution is closing");
    await this.#workspaceRoot(project);
    const result = await readReviewedRetainedImage(project.workspacePath, project.id, this.namespace, reviewId, relative, variant, expectedSha256, signal);
    signal?.throwIfAborted();
    if (this.#closed || result.metadata.scannerRevision !== knownSensitiveValueRevision()) throw new Error("The saved image read was superseded or its disclosure policy changed");
    return result;
  }

  async approvedSourceReview(
    project: ProjectState,
    generation: string,
  ): Promise<IsolatedSourceReview | undefined> {
    await this.#workspaceRoot(project);
    const record = await approvedSourceReview(
      project.workspacePath,
      project.id,
      this.namespace,
      generation,
    );
    return record && publicSourceReview(record);
  }

  /** Called only after the trusted Approval card accepted this exact review, never from model-supplied approval flags. */
  async approveSourceReview(
    project: ProjectState,
    reviewId: string,
    guard: WorkspaceGuard,
  ): Promise<void> {
    await this.#workspaceRoot(project);
    const record = await readSourceReview(
      project.workspacePath,
      project.id,
      this.namespace,
      reviewId,
    );
    if (record.superseded)
      throw new Error(
        "This approval was superseded; inspect a fresh review before adopting",
      );
    if (record.approvedAt) {
      await guard(() => supersedeUnapprovedSourceReviews(record));
      return;
    }
    if (
      record.review.blockers.length ||
      !record.review.files.length ||
      Date.parse(record.review.expiresAt) < Date.now()
    )
      throw new Error(
        "This review is blocked or expired; inspect a fresh complete file list before approving",
      );
    const sourceContract = reviewSourceContract(record);
    if (sourceContract && !sourceContract.preparedManifestId)
      throw new Error(
        "The versioned working batch is incomplete; no approval was recorded",
      );
    if (record.retained) await assertRetainedReviewArtifacts(record);
    const snapshot = await this.#reviewSnapshot(
      project,
      record.review.generation,
      true,
    );
    if (
      snapshot.snapshotId !== record.review.snapshotId ||
      !!sourceContract !== (snapshot.sourceManifestVersion === 1 || snapshot.sourceManifestVersion === 2) ||
      (sourceContract &&
        (snapshot.sourceManifestVersion !== sourceContract.version || (sourceContract.version === 2 ? snapshot.sourceProfileId !== sourceContract.profileId : snapshot.sourceProfileId !== undefined) || snapshot.sourceBaselineManifest?.manifestId !==
          sourceContract.baseManifestId ||
          snapshot.sourceManifest?.manifestId !==
            sourceContract.rawManifestId)) ||
      sourceManifest(snapshot.baselineFiles) !==
        sourceManifest(record.guestBaseline)
    )
      throw new Error(
        "Retained source changed after review; this approval cannot be applied",
      );
    await guard(async () => {
      await assertSourcePublicationSettled(project.workspacePath);
      await assertReviewedHost(project.workspacePath, record, "before");
      const other = await approvedSourceReview(
        project.workspacePath,
        project.id,
        this.namespace,
        record.review.generation,
      );
      if (other && other.review.reviewId !== reviewId)
        throw new Error("Another approved recovery must settle first");
      record.approvedAt = new Date().toISOString();
      await saveSourceReview(record);
      await supersedeUnapprovedSourceReviews(record);
    });
  }

  async storageOverview(
    projects: readonly Pick<ProjectState, "id" | "name">[],
  ): Promise<ExecutionStorageOverview> {
    const reading = (this.#storageReading ??= this.#readStorageOverview());
    let result: ExecutionStorageOverview;
    try {
      result = structuredClone(await reading);
    } finally {
      if (this.#storageReading === reading) this.#storageReading = undefined;
    }
    const names = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const snapshot = result.snapshot;
    if (snapshot) {
      snapshot.projects = snapshot.projects.map((project) => ({
        ...project,
        currentStore: project.namespace === this.namespace,
        projectName:
          project.namespace === this.namespace
            ? (names.get(project.projectId) ?? null)
            : null,
      }));
      if (result.dataStatus === "current" && snapshot.countsTrusted) {
        const allocated = new Set(
          snapshot.projects
            .filter((project) => project.currentStore)
            .map((project) => project.projectId),
        );
        result.unallocatedProjects = projects
          .filter((project) => !allocated.has(project.id))
          .map((project) => ({
            projectId: project.id,
            projectName: project.name,
          }));
      }
    }
    return result;
  }

  async #readStorageOverview(): Promise<ExecutionStorageOverview> {
    let vmState: ExecutionStorageOverview["vmState"] = "unknown";
    let reason: ExecutionStorageOverview["reason"] = "vm-unavailable";
    try {
      if (this.#closed) throw new Error("Isolated execution is closing");
      vmState =
        (await readIsolatedVmStatus(RUNTIME_ROOT)) === "Running"
          ? "running"
          : "stopped";
      reason = vmState === "stopped" ? "vm-stopped" : "snapshot-unavailable";
      if (vmState === "running") {
        const raw = await this.#control("overview", [], {});
        const observedAt = new Date().toISOString();
        const snapshot = executionStorageSnapshot(raw, observedAt);
        this.#storageSnapshot = snapshot;
        return {
          supported: true,
          vmState,
          dataStatus: "current",
          checkedAt: observedAt,
          ...(snapshot.countsTrusted
            ? {}
            : { reason: "review-required" as const }),
          snapshot,
          unallocatedProjects: null,
        };
      }
    } catch {
      /* A failed read cannot replace a previously verified snapshot with empty data. */
    }
    return {
      supported: true,
      vmState,
      dataStatus: this.#storageSnapshot ? "stale" : "unavailable",
      checkedAt: new Date().toISOString(),
      reason,
      snapshot: this.#storageSnapshot ?? null,
      unallocatedProjects: null,
    };
  }

  #admit(projectId: string): void {
    if (this.#closed) throw new Error("Isolated execution is closing");
    if (this.#retiring.has(projectId))
      throw new Error("The isolated project is being deleted");
    this.#admission?.(projectId);
  }

  setAdmission(admission: (projectId: string) => void): void {
    this.#admission = admission;
  }

  #trackReturn(projectId: string): () => void {
    let done!: () => void;
    const pending = new Promise<void>((resolve) => {
      done = resolve;
    });
    let returning = this.#returning.get(projectId);
    if (!returning) this.#returning.set(projectId, (returning = new Set()));
    returning.add(pending);
    return () => {
      returning.delete(pending);
      if (!returning.size) this.#returning.delete(projectId);
      done();
    };
  }

  #settle(state: Operation, cause?: unknown): void {
    if (state.released && this.#active.get(state.id) === state) {
      this.#active.delete(state.id);
      if (
        ![...this.#active.values()].some(
          (item) => item.projectId === state.projectId,
        )
      )
        this.#projects.delete(state.projectId);
    }
    if (cause) state.rejectSettled(cause);
    else state.resolveSettled();
  }

  async #report(
    state: Operation,
    phase: Parameters<typeof reportIsolatedOperation>[0]["phase"],
    budgetError?: unknown,
  ): Promise<void> {
    await state.report(
      {
        scope: "project_command",
        namespace: this.namespace,
        projectId: state.projectId,
        operationId: state.id,
        phase,
        ...(state.binding || state.generation
          ? { generation: state.binding?.generation ?? state.generation }
          : {}),
        ...(state.snapshotId ? { snapshotId: state.snapshotId } : {}),
        ...(state.mode ? { mode: state.mode } : {}),
        ...(phase === "input_rejected"
          ? { rejection: "input_budget" as const }
          : {}),
      },
      budgetError,
    );
  }

  async #idempotent(
    operation: "acknowledge" | "release",
    input: object,
  ): Promise<unknown> {
    try {
      return await this.#control(operation, [], input);
    } catch {
      return this.#control(operation, [], input);
    }
  }

  async #release(state: Operation): Promise<void> {
    if (state.released) return;
    if (!state.binding)
      throw new Error(
        "The isolated reservation outcome is unknown; project data is retained",
      );
    const value = (await this.#idempotent("release", state.binding)) as {
      released?: unknown;
    };
    if (value.released !== true)
      throw new Error("Isolated lease release could not be confirmed");
    state.released = true;
    await this.#report(state, "released");
  }

  #finish(state: Operation): Promise<void> {
    return (state.finalizing ??= (async () => {
      try {
        await this.#release(state);
        if (
          state.transportCode === 0 &&
          state.terminalCode !== undefined &&
          state.terminalCode !== 0
        )
          throw new Error(
            "Isolated terminal status did not match the transport",
          );
        if (!state.hold && state.workspacePath) await this.#releaseSpaceIfSettled(state, state.workspacePath);
        this.#settle(state);
      } catch (cause) {
        this.#settle(state, cause);
        state.finalizing = undefined;
        throw cause;
      }
    })());
  }

  #cancel(state: Operation): Promise<void> {
    if (state.released) return Promise.resolve();
    return (state.cancelling ??= (async () => {
      if (
        state.closed &&
        state.terminalCode !== undefined &&
        !state.hold &&
        state.binding
      ) {
        await this.#release(state);
        this.#settle(state);
        return;
      }
      const request = state.binding ?? {
        namespace: this.namespace,
        projectId: state.projectId,
        operationId: state.id,
      };
      let value: { stopped?: unknown; operation?: unknown };
      try {
        value = (await this.#control(
          "cancel",
          [state.id],
          request,
        )) as typeof value;
      } catch {
        value = (await this.#control(
          "cancel",
          [state.id],
          request,
        )) as typeof value;
      }
      if (value.stopped !== true)
        throw new Error("Isolated cancellation could not be confirmed");
      if (value.operation) {
        const binding = this.#binding(
          value.operation,
          state.projectId,
          state.id,
        );
        if (
          state.binding &&
          (binding.generation !== state.binding.generation ||
            binding.leaseToken !== state.binding.leaseToken)
        )
          throw new Error(
            "Isolated cancellation binding changed; the original operation requires review",
          );
        state.binding = binding;
      }
      // The controller confirms cgroup stop and releases this exact reservation.
      state.released = true;
      if (state.child) this.#stop(state.child);
      await this.#report(state, "released");
      if (!state.hold && state.workspacePath) await this.#releaseSpaceIfSettled(state, state.workspacePath);
      this.#settle(state);
    })().catch((cause) => {
      state.cancelling = undefined;
      throw cause;
    }));
  }

  async quiesceProject(projectId: string): Promise<void> {
    this.#epochs.set(projectId, (this.#epochs.get(projectId) ?? 0) + 1);
    this.#retiring.add(projectId);
    for (const state of this.#active.values())
      if (state.projectId === projectId)
        state.abort.abort(new Error("The isolated project is being deleted"));
    await this.#preparing.get(projectId);
    const pending = [...this.#active.values()].filter(
      (state) => state.projectId === projectId,
    );
    const outcomes = await Promise.allSettled(
      pending.map((state) => this.#cancel(state)),
    );
    if (outcomes.some((result) => result.status === "rejected"))
      throw new Error(
        "The isolated project could not be stopped; its data is retained",
      );
    await Promise.all(this.#returning.get(projectId) ?? []);
  }

  resumeProject(projectId: string): void {
    this.#retiring.delete(projectId);
  }

  async retireProject(
    project: ProjectState,
    beforeRetire: () => Promise<void>,
  ): Promise<{ deleted: true; absent?: boolean }> {
    if (!this.#retiring.has(project.id) || this.#projects.has(project.id))
      throw new Error("Stop the isolated project before deleting its data");
    const epoch = this.#epochs.get(project.id);
    const unavailable = () =>
      Object.assign(
        new Error(
          "Execution storage could not be checked. This deletion attempt did not request storage removal. Please try again when local execution is available.",
        ),
        { code: "EXECUTION_RETIREMENT_UNAVAILABLE", changed: false },
      );
    const assertCurrent = () => {
      if (
        this.#closed ||
        !this.#retiring.has(project.id) ||
        this.#projects.has(project.id) ||
        this.#epochs.get(project.id) !== epoch
      )
        throw unavailable();
    };
    let current: IsolatedProjectStorage | undefined;
    try {
      assertCurrent();
      await this.vm?.ready();
      assertCurrent();
      current = await this.inventoryProject(project);
      assertCurrent();
    } catch {
      throw unavailable();
    }
    await beforeRetire();
    assertCurrent();
    const value = (await this.#control("retire", [], {
      namespace: this.namespace,
      projectId: project.id,
      ...(current ? { generation: current.generation } : {}),
      confirmation: "DELETE_PROJECT_VOLUME",
    })) as { deleted?: unknown; absent?: boolean };
    if (value.deleted !== true)
      throw new Error("Isolated storage deletion was not confirmed");
    return {
      deleted: true,
      ...(value.absent === true ? { absent: true } : {}),
    };
  }

  /** Metadata only: the fixed reviewed Lima instance uses this growing disk. No disk contents are read. */
  async capacityBackingDevice(project: Pick<ProjectState, "id" | "workspacePath">): Promise<number> {
    const workspace = await this.#workspaceRoot(project);
    const disk = path.join(RUNTIME_ROOT, "lima/omg/disk");
    if (await realpath(disk) !== disk) throw new Error("The fixed VM backing disk is unavailable or redirected");
    const handle = await open(disk, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat(), current = await lstat(disk);
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 ||
          current.dev !== before.dev || current.ino !== before.ino || (await lstat(workspace)).dev !== before.dev)
        throw new Error("The VM backing disk and project control storage need a verified shared filesystem; cross-device capacity profiles are not supported");
      return before.dev;
    } finally { await handle.close(); }
  }

  async #capacityControl(operation: "plan-capacity" | "inspect-capacity-plan" | "register-capacity-authorization" | "migrate-capacity", project: Pick<ProjectState, "id" | "workspacePath">, input: {namespace: "manual" | "test"; projectId: string; planId: string}, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("Isolated execution is closing");
    if (operation !== "inspect-capacity-plan") this.#admit(project.id);
    if (input.namespace !== this.namespace || input.projectId !== project.id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.planId))
      throw new Error("The native capacity request is outside its exact project scope");
    if (this.#projects.has(project.id) || this.#recoveryRequests.has(project.id))
      throw new Error("Wait for this project's isolated operations before inspecting or changing its capacity");
    // Claim before the first await, just as start/recovery do; quiescence must wait too.
    this.#projects.add(project.id);
    let finished!: () => void;
    this.#preparing.set(project.id, new Promise<void>(resolve => { finished = resolve; }));
    try {
      await this.#workspaceRoot(project);
      signal?.throwIfAborted();
      await this.vm?.ready();
      signal?.throwIfAborted();
      await this.#health(signal);
      if (!this.#mediumProfile) throw new Error("The installed isolated component does not support the reviewed medium capacity protocol");
      if ("sourceProfileId" in input && !this.#capacityProfiles.has(getRuntimeCapacityProfile(input.sourceProfileId).id)) throw new Error("The selected capacity profile is not advertised by the installed guest");
      if (operation !== "inspect-capacity-plan") this.#admit(project.id);
      signal?.throwIfAborted();
      return await this.#control(operation, [], input, undefined, signal);
    } finally {
      this.#preparing.delete(project.id);
      this.#projects.delete(project.id);
      finished();
    }
  }

  async planCapacityMigration(project: Pick<ProjectState, "id" | "workspacePath">, input: {namespace: "manual" | "test"; projectId: string; planId: string} & ({capacityProfileVersion: 2; sourceProfileId: "capacity-128-v2"} | {capacityProfileVersion: 3; sourceProfileId: "capacity-128-media64-v3"}), signal?: AbortSignal): Promise<unknown> {
    return this.#capacityControl("plan-capacity", project, input, signal);
  }
  inspectCapacityPlan(project: Pick<ProjectState, "id" | "workspacePath">, input: {namespace: "manual" | "test"; projectId: string; planId: string}, signal?: AbortSignal): Promise<unknown> {
    return this.#capacityControl("inspect-capacity-plan", project, input, signal);
  }
  registerCapacityAuthorization(project: Pick<ProjectState, "id" | "workspacePath">, input: {namespace: "manual" | "test"; projectId: string; planId: string; authorizationId: string; source: unknown; target: unknown; recoveryReservationBytes: 1073741824; expiresAt: number}, signal?: AbortSignal): Promise<unknown> {
    return this.#capacityControl("register-capacity-authorization", project, input, signal);
  }
  executeCapacityPlan(project: Pick<ProjectState, "id" | "workspacePath">, input: {namespace: "manual" | "test"; projectId: string; planId: string; authorizationId: string}, signal?: AbortSignal): Promise<unknown> {
    return this.#capacityControl("migrate-capacity", project, input, signal);
  }

  async #recovery(
    project: ProjectState,
    expectedGeneration?: string,
    allowRetiring = false,
    reviewSnapshotId?: string,
    reviewVersion?: 2,
    sourceContract?: SourceContract,
    priorSpace?: RecoverySpaceReservation,
    artifacts = false,
  ): Promise<Operation> {
    if (!allowRetiring) this.#admit(project.id);
    if (this.#closed) throw new Error("Isolated execution is closing");
    if (this.#projects.has(project.id))
      throw new Error(
        "Stop the existing project operation before recovering its data",
      );
    this.#projects.add(project.id);
    const state = this.#operation(project.id, true);
    state.reviewVersion = reviewVersion;
    state.spaceReservation = priorSpace;
    state.workspacePath = project.workspacePath;
    let prepared!: () => void;
    this.#preparing.set(
      project.id,
      new Promise<void>((resolve) => {
        prepared = resolve;
      }),
    );
    try {
      await this.#report(state, "input_preflight");
      const current = await this.inventoryProject(project);
      if (!allowRetiring) this.#admit(project.id);
      state.abort.signal.throwIfAborted();
      if (!current) throw new Error("The isolated project data is unavailable");
      if (
        expectedGeneration !== undefined &&
        String(current.generation) !== expectedGeneration
      )
        throw new Error(
          "Isolated storage changed; refresh its state before recovery",
        );
      state.generation = current.generation;
      if (current.sourceManifestVersion === 2) {
        if (artifacts) await this.#reservePhysical(project, state, getRuntimeCapacityProfile(current.sourceProfileId).id, state.abort.signal, true);
        else if (!state.spaceReservation) state.spaceReservation = await this.#reserveSpace(project, state.id, state.abort.signal, undefined, {
          ...(sourceContract ? sourceScope(sourceContract) : { sourceManifestVersion: 2, sourceProfileId: current.sourceProfileId!, sourceBaseManifestId: current.sourceBaseManifestId! }), generation: current.generation,
          ...(reviewSnapshotId ? { rawSnapshotId: reviewSnapshotId } : {}),
        });
      }
      await this.#report(state, "prepare_submitting");
      if (this.#closed) throw new Error("Isolated execution is closing");
      if (!allowRetiring) this.#admit(project.id);
      state.abort.signal.throwIfAborted();
      await this.#checkSpace(state);
      state.submitted = true;
      const value = await this.#control("recover", [], {
        namespace: this.namespace,
        projectId: project.id,
        operationId: state.id,
        generation: current.generation,
        ...(reviewSnapshotId ? { reviewSnapshotId } : {}),
        ...(reviewVersion ? { reviewVersion } : {}),
        ...sourceRequest(current),
        ...(sourceContract
          ? { sourceResultManifestId: sourceContract.rawManifestId }
          : {}),
      });
      state.binding = this.#binding(value, project.id, state.id);
      if (
        !!sourceRequest(current) !== ([3,4].includes(state.binding.captureVersion ?? 0)) ||
        (sourceContract &&
          (state.binding.sourceBaseManifestId !==
            sourceContract.baseManifestId ||
            current.sourceBaseManifestId !== sourceContract.baseManifestId))
      )
        throw new Error(
          "The recovery source manifest differs from the approved original contract",
        );
      state.sourceContract = sourceContract;
      if (state.binding.reviewSnapshotId !== reviewSnapshotId)
        throw new Error(
          "Reviewed recovery scope differs from the approved snapshot",
        );
      await state.spaceReservation?.bind({
        generation: state.binding.generation,
      });
      await this.#report(state, "prepared");
      if (!allowRetiring) this.#admit(project.id);
      state.abort.signal.throwIfAborted();
      return state;
    } catch (cause) {
      if (state.submitted) {
        await this.#report(state, "retained").catch(() => {});
        try {
          await this.#cancel(state);
        } catch {
          if (!state.released)
            throw new Error(
              "Isolated recovery reservation is uncertain; all versions are retained",
            );
        }
      } else {
        state.released = true;
        this.#settle(state);
      }
      await this.#releaseSpaceIfSettled(state, project.workspacePath);
      throw cause;
    } finally {
      this.#preparing.delete(project.id);
      prepared();
    }
  }

  async #capture(
    state: Operation,
    project?: ProjectState,
    signal?: AbortSignal,
  ): Promise<{
    files: Array<TransferFile | RuntimeMedia>;
    baselineFiles: SourceManifestEntry[];
    snapshotId: string;
    rasterReturnVersion: 0 | 1 | 2;
  }> {
    if (
      state.binding?.captureVersion === 2 ||
      state.binding?.captureVersion === 3 || state.binding?.captureVersion === 4
    ) {
      if (!project || state.reviewVersion)
        throw new Error(
          "Streamed capture requires the original project operation",
        );
      // A clean generic recovery is a read/ACK check; dirty policy2 is rejected
      // by the guest before such a lease can be created. It stages no candidates.
      const value = await this.#reviewMediaSnapshot(
        project,
        String(state.binding.generation),
        state,
        signal,
        !state.mode,
      );
      state.snapshotId = value.snapshotId;
      await state.spaceReservation?.bind({
        rawSnapshotId: value.snapshotId,
        ...(state.sourceContract
          ? { sourceResultManifestId: state.sourceContract.rawManifestId }
          : {}),
      });
      await this.#report(state, "captured");
      if (value.retainedRasters.length)
        throw new Error(
          "Isolated image candidates are retained for complete review and approval. Use recover_isolated_changes (inspect, review, adopt); do not replay the command or regenerate.",
        );
      return {
        files: value.files,
        baselineFiles: value.baselineFiles,
        snapshotId: value.snapshotId,
        rasterReturnVersion: 2,
      };
    }
    const value = (await this.#control("capture", [], state.binding)) as {
      files?: unknown;
      baselineFiles?: unknown;
      snapshotId?: unknown;
      generation?: unknown;
      rasterReturnVersion?: unknown;
    };
    if (
      !Array.isArray(value.files) ||
      !Array.isArray(value.baselineFiles) ||
      typeof value.snapshotId !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
      value.generation !== state.binding?.generation ||
      (value.rasterReturnVersion ?? 0) !==
        (state.binding?.rasterReturnVersion ?? 0)
    )
      throw new Error("Invalid isolated source snapshot");
    sourceManifest(value.files as TransferFile[]);
    sourceManifest(value.baselineFiles as SourceManifestEntry[]);
    versionedSourceSnapshot(
      value as unknown as Parameters<typeof versionedSourceSnapshot>[0],
    );
    state.snapshotId = value.snapshotId;
    await this.#report(state, "captured");
    return {
      files: value.files as Array<TransferFile | RuntimeMedia>,
      baselineFiles: value.baselineFiles as SourceManifestEntry[],
      snapshotId: value.snapshotId,
      rasterReturnVersion: value.rasterReturnVersion === 1 ? 1 : 0,
    };
  }

  async #acknowledge(state: Operation, snapshotId: string): Promise<void> {
    if (
      [3,4].includes(state.binding?.captureVersion ?? 0) &&
      (!state.sourceContract ||
        state.sourceContract.baseManifestId !==
          state.binding?.sourceBaseManifestId)
    )
      throw new Error(
        "The original source manifest result is unconfirmed; acknowledgement was not submitted",
      );
    const value = (await this.#idempotent("acknowledge", {
      ...state.binding,
      snapshotId,
      ...(state.reviewVersion ? { reviewVersion: state.reviewVersion } : {}),
      ...(state.binding?.captureVersion
        ? { captureVersion: state.binding.captureVersion }
        : {}),
      ...(state.sourceContract
        ? { sourceResultManifestId: state.sourceContract.rawManifestId }
        : {}),
    })) as { acknowledged?: unknown };
    if (value.acknowledged !== true)
      throw new Error(
        "Host source was saved but isolated acknowledgement is unknown; do not rerun the command",
      );
    await this.#report(state, "acknowledged");
  }

  async recoverSource(
    project: ProjectState,
    guard: WorkspaceGuard,
    expectedGeneration?: string,
    expectedReviewId?: string,
    signal?: AbortSignal,
  ): Promise<{ changed: string[]; recovery?: string }> {
    signal?.throwIfAborted();
    await this.#workspaceRoot(project);
    if (expectedReviewId) {
      const previous = await readSourceReview(
        project.workspacePath,
        project.id,
        this.namespace,
        expectedReviewId,
      );
      if (previous.review.generation !== expectedGeneration)
        throw new Error("The requested generation differs from this review");
      if (!previous.approvedAt || previous.superseded)
        throw new Error("This source review has no trusted user approval");
      if (previous.acknowledged && !previous.retained) return { changed: [] }; // A confirmed legacy receipt never replays later work.
    }
    await this.assertSourceReviewSettled(project);
    if (this.#recoveryRequests.has(project.id))
      throw new Error("Isolated source recovery is already running");
    this.#recoveryRequests.add(project.id);
    const alreadyRetiring = this.#retiring.has(project.id);
    const epoch = (this.#epochs.get(project.id) ?? 0) + 1;
    let returned: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      await this.quiesceProject(project.id);
      if (this.#epochs.get(project.id) !== epoch)
        throw new Error(
          "Isolated recovery was superseded by another stop request",
        );
      returned = this.#trackReturn(project.id);
      const approved = expectedGeneration
        ? await approvedSourceReview(
            project.workspacePath,
            project.id,
            this.namespace,
            expectedGeneration,
          )
        : undefined;
      if (expectedReviewId && approved?.review.reviewId !== expectedReviewId)
        throw new Error("This source review has no trusted user approval");
      if (approved?.retained)
        return await this.#recoverWorkingReview(
          project,
          approved,
          guard,
          signal,
        );
      signal?.throwIfAborted();
      const state = await this.#recovery(
        project,
        expectedGeneration,
        true,
        approved?.review.snapshotId,
      );
      const unlinkCancellation = linkRecoveryCancellation(state, signal);
      let failed = false;
      try {
        state.abort.signal.throwIfAborted();
        const snapshot = await this.#capture(
          state,
          project,
          state.abort.signal,
        );
        if (approved && snapshot.snapshotId !== approved.review.snapshotId)
          throw new Error(
            "Approved source snapshot changed before publication",
          );
        state.abort.signal.throwIfAborted();
        const result = await guard(async () => {
          state.abort.signal.throwIfAborted();
          const context: PublicationContext = {
            namespace: this.namespace,
            projectId: project.id,
            generation: state.binding!.generation,
            snapshotId: snapshot.snapshotId,
            ...(state.sourceContract
              ? { sourceContract: state.sourceContract }
              : {}),
          };
          if (approved)
            await assertReviewedHost(
              project.workspacePath,
              approved,
              "unchanged",
            );
          const resumed = await resumeSourcePublications(
            project.workspacePath,
            context,
          );
          const media: RuntimeMedia[] = [];
          const separated =
            snapshot.baselineFiles.some((file) => "size" in file) ||
            snapshot.files.some((file) => !("data" in file));
          const current = await projectFiles(
            project.workspacePath,
            separated ? media : undefined,
            undefined,
            state.binding?.sourceProfileId ? { profile: state.binding.sourceProfileId } : undefined,
          );
          const baseline = new Map(
            snapshot.baselineFiles.map((file) => [file.path, file]),
          );
          const guest = new Map(
            snapshot.files.map((file) => [file.path, file]),
          );
          const host = new Map(
            [...current, ...media].map((file) => [file.path, file]),
          );
          const same = (
            a: SourceManifestEntry | undefined,
            b: SourceManifestEntry | undefined,
          ) =>
            a?.sha256 === b?.sha256 &&
            Boolean(a?.executable) === Boolean(b?.executable);
          if (snapshot.baselineFiles.some((file) => !guest.has(file.path)))
            throw new Error(
              "Source deletion requires review; both versions are retained",
            );
          const changes = snapshot.files.filter(
            (file) => !same(file, baseline.get(file.path)),
          );
          if (approved) {
            for (const file of changes) {
              const before = baseline.get(file.path);
              if (before && same(host.get(file.path), file))
                await verifyRetainedPublicationOriginal(
                  project.workspacePath,
                  context,
                  file.path,
                  before.sha256,
                  file.sha256,
                );
            }
          }
          if (
            changes.some(
              (file) =>
                !same(host.get(file.path), baseline.get(file.path)) &&
                !same(host.get(file.path), file),
            )
          )
            throw new Error(
              "Host source changed since the isolated operation; both versions are retained for review",
            );
          if (snapshot.rasterReturnVersion === 1) {
            for (const file of changes) {
              if (
                !("data" in file) ||
                !isStaticRasterPath(file.path) ||
                !same(host.get(file.path), file)
              )
                continue;
              const before = baseline.get(file.path);
              const original = before
                ? await retainedPublicationOriginal(
                    project.workspacePath,
                    context,
                    file.path,
                    before.sha256,
                    file.sha256,
                  )
                : undefined;
              await validateRasterReturn(
                file.path,
                Buffer.from(file.data, "base64"),
                original,
                1,
                state.abort.signal,
              );
            }
          }
          // Keep newer host edits to paths the guest never changed, including after a lost ACK.
          const ordinary = verifyCapturedMedia(
            snapshot.files,
            snapshot.baselineFiles.filter(
              (file): file is SourceManifestEntry & RuntimeMedia =>
                "size" in file,
            ),
            snapshot.rasterReturnVersion,
          );
          const merged = new Map<string, TransferFile | RuntimeMedia>(
            current.map((file) => [file.path, file]),
          );
          for (const file of ordinary) {
            if (!changes.includes(file) || same(host.get(file.path), file))
              continue;
            merged.set(file.path, file);
          }
          const applied = await applySourceChanges(
            project.workspacePath,
            current,
            [...merged.values()],
            state.abort.signal,
            separated ? media : undefined,
            snapshot.rasterReturnVersion,
            context,
          );
          if (approved)
            await assertReviewedHost(project.workspacePath, approved, "after");
          return {
            changed: [...new Set([...resumed.changed, ...applied.changed])],
            recovery: applied.recovery ?? resumed.recovery,
          };
        });
        state.abort.signal.throwIfAborted();
        await this.#report(state, "published");
        state.abort.signal.throwIfAborted();
        await this.#acknowledge(state, snapshot.snapshotId);
        if (approved) {
          approved.acknowledged = true;
          await saveSourceReview(approved);
        }
        return result;
      } catch (cause) {
        failed = true;
        await this.#report(state, "retained").catch(() => {});
        throw cause;
      } finally {
        unlinkCancellation();
        try {
          await this.#finish(state);
        } catch (cause) {
          if (!failed) throw cause;
        }
      }
    } finally {
      returned?.();
      this.#recoveryRequests.delete(project.id);
      if (!alreadyRetiring && this.#epochs.get(project.id) === epoch)
        this.resumeProject(project.id);
    }
  }

  async #recoverWorkingReview(
    project: ProjectState,
    record: StoredSourceReview,
    guard: WorkspaceGuard,
    signal?: AbortSignal,
  ): Promise<{ changed: string[]; recovery?: string }> {
    const plan = record.retained!;
    const sourceContract = reviewSourceContract(record);
    if (sourceContract && !sourceContract.preparedManifestId)
      throw new Error(
        "The versioned working batch is incomplete; no recovery was submitted",
      );
    await assertRetainedReviewArtifacts(record, signal);
    const context: PublicationContext = {
      namespace: this.namespace,
      projectId: project.id,
      generation: Number(record.review.generation),
      snapshotId: plan.rawSnapshotId,
      ...(sourceContract ? { sourceContract } : {}),
    };
    if (record.recoveryOperationId && record.publicationId)
      return this.verifySourceReview(project, record.review.reviewId, signal);
    const publicationSpace = await this.#pendingSpace(project, context);
    const pendingSpace =
      publicationSpace ??
      (await reconnectRetainedRecoverySpace(project.workspacePath, {
        namespace: this.namespace,
        projectId: project.id,
        generation: context.generation,
        rawSnapshotId: plan.rawSnapshotId,
        originOperations: plan.originOperations,
        ...(sourceContract
          ? {
              ...sourceScope(sourceContract),
            }
          : {}),
      }));
    signal?.throwIfAborted();
    const state = await this.#recovery(
      project,
      record.review.generation,
      true,
      plan.rawSnapshotId,
      2,
      sourceContract,
      pendingSpace,
    );
    const unlinkCancellation = linkRecoveryCancellation(state, signal);
    let failure: unknown,
      result: { changed: string[]; recovery?: string } | undefined,
      published = false,
      ackSubmitted = false,
      released = false;
    try {
      state.abort.signal.throwIfAborted();
      state.spaceReservation ??= pendingSpace ??
        (await this.#reserveSpace(
          project,
          state.id,
          state.abort.signal,
          plan.rawFiles
            .filter((f) => f.kind !== "verified-media")
            .map((f) => ({ sha256: f.sha256, size: f.size! })),
          sourceContract
            ? {
                ...sourceScope(sourceContract),
                generation: context.generation,
                rawSnapshotId: plan.rawSnapshotId,
              }
            : undefined,
        ));
      if (!pendingSpace)
        await state.spaceReservation.bind({
          generation: Number(record.review.generation),
          rawSnapshotId: plan.rawSnapshotId,
        });
      record.recoveryOperationId = state.id;
      await saveSourceReview(record);
      const snapshot = (await this.#control("capture", [], {
        ...state.binding,
        reviewVersion: 2,
      })) as RetainedReviewSnapshot & {
        namespace?: string;
        projectId?: string;
        generation?: number;
      };
      if (
        !snapshot ||
        snapshot.reviewVersion !== 2 ||
        snapshot.namespace !== this.namespace ||
        snapshot.projectId !== project.id ||
        snapshot.generation !== context.generation ||
        snapshot.snapshotId !== plan.rawSnapshotId ||
        snapshot.rasterReturnVersion !== plan.rasterReturnVersion ||
        !Array.isArray(snapshot.retainedRasters) ||
        !Array.isArray(snapshot.files)
      )
        throw new Error(
          "The reviewed raw generation changed before publication",
        );
      sourceManifest(snapshot.baselineFiles);
      sourceManifest([...snapshot.files, ...snapshot.retainedRasters]);
      const capturedContract = versionedSourceSnapshot(
        snapshot,
        state.binding?.sourceBaseManifestId,
        state.binding?.sourceProfileId,
      );
      if (
        !!capturedContract !== !!sourceContract ||
        (sourceContract &&
          (capturedContract?.version !== sourceContract.version || (sourceContract.version === 2 && (capturedContract?.version !== 2 || capturedContract.profileId !== sourceContract.profileId)) || capturedContract?.baseManifestId !== sourceContract.baseManifestId ||
            capturedContract?.rawManifestId !== sourceContract.rawManifestId))
      )
        throw new Error(
          "The reviewed raw source manifest changed before publication",
        );
      if (
        reviewSnapshotDigest([
          ...snapshot.files,
          ...snapshot.retainedRasters,
        ]) !== plan.rawSnapshotId ||
        sourceManifest(snapshot.baselineFiles) !==
          sourceManifest(record.guestBaseline)
      )
        throw new Error("The reviewed raw snapshot or baseline changed");
      state.snapshotId = snapshot.snapshotId;
      await this.#report(state, "captured");
      result = await guard(() =>
        this.#withSpace(state, async () => {
          state.abort.signal.throwIfAborted();
          await assertReviewedHost(project.workspacePath, record, "unchanged");
          const resumed = await resumeSourcePublications(
            project.workspacePath,
            context,
          );
          if (publicationSpace && !resumed.recovery) {
            // A staging-only journal was proved rolled back. Its retained bytes
            // are history now; a fresh publication needs a fresh complete plan.
            await assertSourcePublicationSettled(project.workspacePath);
            await state.spaceReservation!.release();
            state.spaceReservation = await this.#reserveSpace(
              project,
              state.id,
              state.abort.signal,
              plan.rawFiles
                .filter((f) => f.kind !== "verified-media")
                .map((f) => ({ sha256: f.sha256, size: f.size! })),
              sourceContract
                ? {
                    ...sourceScope(sourceContract),
                    generation: context.generation,
                    rawSnapshotId: plan.rawSnapshotId,
                  }
                : undefined,
            );
            await state.spaceReservation.bind({
              generation: context.generation,
              rawSnapshotId: context.snapshotId,
            });
          }
          const media: RuntimeMedia[] = [],
            current = await projectFiles(project.workspacePath, media, undefined, state.binding?.sourceProfileId ? { profile: state.binding.sourceProfileId } : undefined);
          const rasterArtifacts: ValidatedRasterArtifact[] = [];
          const prepared = await preparedReviewSnapshot(
              record,
              state.abort.signal,
            ),
            selected = new Map(prepared.files.map((file) => [file.path, file]));
          const merged = new Map<string, TransferFile | RuntimeMedia>(
            [...current, ...media].map((file) => [file.path, file]),
          );
          for (const reviewed of record.review.files) {
            const file = selected.get(reviewed.path);
            if (!file || file.sha256 !== reviewed.afterSha256)
              throw new Error(
                "The immutable working batch no longer matches the approval",
              );
            const existing = merged.get(reviewed.path),
              before = record.hostFiles.find(
                (item) => item.path === reviewed.path,
              ),
              after = record.targetFiles.find(
                (item) => item.path === reviewed.path,
              )!;
            if (
              (existing &&
                existing.sha256 !== before?.sha256 &&
                existing.sha256 !== after.sha256) ||
              (!existing && before)
            )
              throw new Error(
                "Host source changed since the exact working batch was approved; every version remains retained",
              );
            if (existing) {
              const actualMode =
                (await lstat(path.join(project.workspacePath, reviewed.path)))
                  .mode & 0o777;
              const expected =
                existing.sha256 === after.sha256 ? after : before;
              if (actualMode !== expected?.mode)
                throw new Error(
                  "Host source permissions changed after approval; every version remains retained",
                );
            }
            if ("artifactKind" in file) {
              rasterArtifacts.push(
                await validateRasterArtifact(
                  project.workspacePath,
                  {
                    path: file.path,
                    artifactPath: preparedRasterArtifactPath(
                      project.workspacePath,
                      file,
                    ),
                    sha256: file.sha256,
                    size: file.size,
                    ...(existing ? { beforeSha256: existing.sha256 } : {}),
                  },
                  state.abort.signal,
                ),
              );
              merged.delete(file.path);
            } else if ("data" in file) {
              const { rasterBaseSha256: _base, ...ordinary } = file;
              const before = media.find((item) => item.path === file.path);
              merged.set(file.path, {
                ...ordinary,
                ...(before && isStaticRasterPath(file.path)
                  ? { rasterBaseSha256: before.sha256 }
                  : {}),
              });
            } else merged.set(file.path, file);
          }
          const applied = await this.#withSpace(state, () =>
            applySourceChanges(
              project.workspacePath,
              current,
              [...merged.values()],
              state.abort.signal,
              media,
              plan.rasterPolicyVersion === 2 ? 2 : 1,
              context,
              { rasterArtifacts },
            ),
          );
          await assertReviewedHost(project.workspacePath, record, "after");
          let recovery =
            applied.recovery ??
            resumed.recovery ??
            (record.publicationId
              ? "isolated-changes/" + record.publicationId
              : undefined);
          if (!recovery) {
            const actualMedia: RuntimeMedia[] = [];
            const actualFiles = sourceContract
              ? await projectFiles(project.workspacePath, actualMedia, undefined, state.binding?.sourceProfileId ? { profile: state.binding.sourceProfileId } : undefined)
              : [];
            const complete = sourceContract
              ? manifestFor([...actualFiles, ...actualMedia], state.binding?.sourceProfileId)
              : undefined;
            const manifest = {
              ...(complete
                ? sourcePublicationMetadata(context, complete, complete)
                : { version: 3 as const, context }),
              state: "committed" as const,
              versions: [],
              published: [],
              steps: {},
              spacePlan: { ...state.spaceReservation!.plan },
              reservationId: state.spaceReservation!.id,
              verifiedReviewId: record.review.reviewId,
              targetFingerprint: createHash("sha256")
                .update(JSON.stringify(record.targetFiles))
                .digest("hex"),
            };
            if (
              !(
                await sourceRecoveryBudget(
                  project.workspacePath,
                  3 * Buffer.byteLength(JSON.stringify(manifest)),
                  state.binding?.sourceProfileId,
                )
              ).fits
            )
              throw new Error(
                "The shared recovery store cannot retain the verified publication receipt",
              );
            const { id, directory } = await createSourcePublication(
              project.workspacePath,
            );
            await initializePublicationManifest(directory, manifest);
            recovery = "isolated-changes/" + id;
          }
          record.publicationId = recovery.slice("isolated-changes/".length);
          await saveSourceReview(record);
          published = true;
          return {
            changed: [...new Set([...resumed.changed, ...applied.changed])],
            recovery,
          };
        }),
      );
      state.abort.signal.throwIfAborted();
      await this.#report(state, "published");
      state.abort.signal.throwIfAborted();
      ackSubmitted = true;
      await this.#acknowledge(state, plan.rawSnapshotId);
    } catch (cause) {
      failure = cause;
      await this.#report(state, "retained").catch(() => {});
    } finally {
      unlinkCancellation();
      try {
        await this.#finish(state);
        released = true;
        await this.#releaseSpaceIfSettled(state, project.workspacePath);
      } catch (cause) {
        failure ??= cause;
      }
    }
    const pending = async (cause: unknown): Promise<unknown> => {
      if (
        !published ||
        !ackSubmitted ||
        !released ||
        !cause ||
        typeof cause !== "object"
      )
        return cause;
      if (
        [
          "EACCES",
          "EPERM",
          "INVALID_REQUEST",
          "INVALID_BINDING",
          "GENERATION_CHANGED",
          "ACTIVE_OPERATION",
          "RECOVERY_REQUIRED",
          "UNSAFE_STORAGE",
          "PROTOCOL_REQUIRED",
          "IDENTITY_PROVISIONING_REQUIRED",
          "PERMISSION_DENIED",
          "AUTHORIZATION_DENIED",
          "APPROVAL_REQUIRED",
        ].includes(String((cause as { code?: unknown }).code))
      )
        return cause;
      try {
        await guard(() =>
          assertReviewedHost(project.workspacePath, record, "after"),
        );
        await assertRetainedReviewArtifacts(record, signal);
      } catch {
        return cause;
      }
      try {
        return inheritIsolatedRepairPending(
          cause,
          createIsolatedRepairPending({
            ...this.#workingReviewIdentity(project, record),
            publicationVerified: true,
          }),
        );
      } catch {
        return cause;
      }
    };
    if (failure !== undefined) throw await pending(failure);
    try {
      await guard(() =>
        assertReviewedHost(project.workspacePath, record, "after"),
      );
      await assertRetainedReviewArtifacts(record, signal);
      record.acknowledged = true;
      await saveSourceReview(record);
      return this.#workingReviewProof(project, record, result!);
    } catch (cause) {
      throw await pending(cause);
    }
  }

  #workingReviewIdentity(project: ProjectState, record: StoredSourceReview) {
    const plan = record.retained!;
    const originOperations = plan.originOperations.filter(
      (
        operation,
      ): operation is typeof operation & {
        mode: "shell" | "build" | "install";
        snapshotId: string;
      } =>
        ["shell", "build", "install"].includes(operation.mode) &&
        operation.snapshotId === plan.rawSnapshotId,
    );
    return {
      namespace: this.namespace,
      projectId: project.id,
      generation: Number(record.review.generation),
      rawSnapshotId: plan.rawSnapshotId,
      preparedBatchId: plan.preparedBatchId!,
      reviewId: record.review.reviewId,
      preparedSnapshotId: record.review.preparedSnapshotId!,
      hostTargetFingerprint: createHash("sha256")
        .update(JSON.stringify(record.targetFiles))
        .digest("hex"),
      publicationId: record.publicationId!,
      recoveryOperationId: record.recoveryOperationId!,
      allOriginalsDurable: true as const,
      released: true as const,
      originOperations,
    };
  }

  #workingReviewProof(
    project: ProjectState,
    record: StoredSourceReview,
    result: { changed: string[]; recovery?: string },
    verification = false,
  ) {
    const identity = this.#workingReviewIdentity(project, record);
    if (!identity.originOperations.length && !verification) return result;
    return inheritIsolatedRepairProof(
      result,
      createIsolatedRepairProof({ ...identity, acknowledged: true }),
    );
  }

  async artifacts(
    project: ProjectState,
    directory = project.workspacePath,
    options: { playable?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const returned = this.#trackReturn(project.id);
    try {
      await this.#artifacts(project, directory, options);
    } finally {
      returned();
    }
  }

  async #artifacts(
    project: ProjectState,
    directory: string,
    options: { playable?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    this.#admit(project.id);
    options.signal?.throwIfAborted();
    const workspace = await realpath(project.workspacePath);
    const destination = await realpath(directory);
    const relative = path.relative(workspace, destination);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("The isolated artifact directory left the project");
    this.#admit(project.id);
    const state = await this.#recovery(project, undefined, false, undefined, undefined, undefined, undefined, true);
    let failed = false;
    try {
      const request = {
        ...state.binding,
        directory: relative.split(path.sep).join("/"),
        runtimeMediaVersion: 1,
      };
      const signal = options.signal
        ? AbortSignal.any([state.abort.signal, options.signal])
        : state.abort.signal;
      const restore = async (
        value: BuildManifest,
        readGenerated?: (entry: RuntimeMedia) => Promise<Buffer>,
        checkEnd?: () => Promise<void>,
      ) => {
        signal.throwIfAborted();
        const copies = value?.media === undefined ? [] : value.media;
        const generated =
          value?.generatedMedia === undefined ? [] : value.generatedMedia;
        if (
          !Array.isArray(value?.files) ||
          !Array.isArray(copies) ||
          !Array.isArray(generated) ||
          copies.length + generated.length > 2000 ||
          (generated.length && !readGenerated)
        )
          throw new Error("Invalid isolated build media manifest");
        if (
          options.playable &&
          !value.files.some((file) =>
            /^(dist|build|out)\/index\.html$/.test(file.path),
          )
        )
          throw new Error(
            "Build completed without a playable index.html in dist, build, or out; the previous local output was preserved",
          );
        const sources: RuntimeMedia[] = [];
        if (copies.length) await projectFiles(workspace, sources, undefined, state.binding?.sourceProfileId ? { profile: state.binding.sourceProfileId, signal } : undefined);
        const byDigest = new Map(sources.map((file) => [file.sha256, file]));
        const streamed = new Set(generated);
        await this.#report(state, "captured");
        signal.throwIfAborted();
        await restoreArtifacts(
          destination,
          value.files,
          [...copies, ...generated],
          async (entry) => {
            signal.throwIfAborted();
            if (streamed.has(entry)) return readGenerated!(entry);
            const original = byDigest.get(entry.sha256);
            if (!original || original.size !== entry.size)
              throw new Error(
                "The build references runtime media that changed on the host",
              );
            return readRuntimeMedia(workspace, original);
          },
          async () => {
            await checkEnd?.();
            signal.throwIfAborted();
          },
          state.binding?.sourceProfileId ? {
            profile: state.binding.sourceProfileId, sourceWorkspace: workspace, signal,
            verifiedCopies: new Map(copies.map(entry => { const original = byDigest.get(entry.sha256); if (!original || original.size !== entry.size) throw new Error("The build copy no longer matches its exact host source"); return [entry.path, original]; })),
          } : undefined,
        );
        await this.#report(state, "published");
      };
      await this.#report(state, "run_submitting");
      signal.throwIfAborted();
      if (!this.#buildMedia) {
        await restore(
          (await this.#control("export", [], request)) as BuildManifest,
        );
        return;
      }
      const child = this.#spawn("export-media");
      const stop = () => {
        child.stdout!.destroy(
          new Error("Isolated build export was interrupted"),
        );
        this.#stop(child);
      };
      let error = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString()).slice(-2000);
      });
      child.stdin!.on("error", stop);
      const complete = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      void complete.catch(() => {});
      const timer = setTimeout(stop, 125_000);
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        child.stdin!.end(JSON.stringify(request));
        const stream = await readBuildStream(child.stdout!);
        await restore(stream.manifest, stream.readMedia, async () => {
          await stream.end();
          if ((await complete) !== 0)
            throw new Error(
              redactKnownSensitiveValues(error) ||
                "Isolated build export failed",
            );
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        child.stdout!.destroy();
        this.#stop(child);
      }
    } catch (cause) {
      failed = true;
      await this.#report(state, "retained").catch(() => {});
      throw cause;
    } finally {
      try {
        await this.#finish(state);
      } catch (cause) {
        if (!failed) throw cause;
      } finally { await this.#releaseSpaceIfSettled(state, project.workspacePath); }
    }
  }

  #operation(projectId: string, hold: boolean, port?: number): Operation {
    let resolveSettled!: () => void, rejectSettled!: (cause: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    void settled.catch(() => {});
    const state: Operation = {
      id: randomUUID().replaceAll("-", ""),
      projectId,
      abort: new AbortController(),
      submitted: false,
      released: false,
      hold,
      closed: false,
      port,
      ready: Promise.resolve(),
      settled,
      resolveSettled,
      rejectSettled,
      report: AsyncLocalStorage.bind(reportIsolatedOperation),
    };
    this.#active.set(state.id, state);
    return state;
  }

  async shell(
    project: ProjectState,
    command: string,
    timeout: number,
    guard: WorkspaceGuard,
    signal?: AbortSignal,
  ): Promise<{ output: string; changed: string[]; recovery?: string }> {
    const returned = this.#trackReturn(project.id);
    try {
      return await this.#shell(project, command, timeout, guard, signal);
    } finally {
      returned();
    }
  }

  async #shell(
    project: ProjectState,
    command: string,
    timeout: number,
    guard: WorkspaceGuard,
    signal?: AbortSignal,
  ): Promise<{ output: string; changed: string[]; recovery?: string }> {
    this.#admit(project.id);
    signal?.throwIfAborted();
    let baseline: TransferFile[] = [];
    const media: RuntimeMedia[] = [];
    let separateMedia = false;
    const child = await this.start(
      project,
      "shell",
      project.workspacePath,
      [command, String(timeout)],
      undefined,
      {
        files: async (separate, profile) => {
          separateMedia = separate;
          baseline = await guard(() =>
            projectFiles(project.workspacePath, separate ? media : undefined, undefined, profile ? { profile, signal } : undefined),
          );
          return { files: baseline, media };
        },
        signal,
        hold: true,
      },
    );
    const state = this.#operations.get(child)!;
    const combined = signal
      ? AbortSignal.any([signal, state.abort.signal])
      : state.abort.signal;
    let output = "",
      timedOut = false,
      cancellation: Promise<void> | undefined;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-64 * 1024);
      });
    const cancel = () => {
      cancellation ??= this.#cancel(state);
      void cancellation.catch(() => {});
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        cancel();
      },
      (timeout + 5) * 1000,
    );
    combined.addEventListener("abort", cancel, { once: true });
    let failed = false, commandFailure: Error | undefined;
    try {
      const completed = state.closed
        ? Promise.resolve(state.transportCode ?? null)
        : new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
      if (combined.aborted) cancel();
      const code = await completed;
      if (cancellation) await cancellation;
      combined.throwIfAborted();
      if (state.terminalCode === undefined)
        throw new Error(
          "Isolated connection closed without confirmed task cleanup; its data is retained",
        );
      if (code !== state.terminalCode)
        throw new Error("Isolated terminal status did not match the transport");
      if (timedOut)
        throw new Error(
          `Isolated command failed (timeout). ${output}`,
        );
      if (code !== 0) commandFailure = new Error(`Isolated command failed (${code}). ${output}`);
      const value = await this.#capture(state, project, combined);
      combined.throwIfAborted();
      if (code !== 0) {
        // A terminated command may still have edited files. Only an unchanged
        // original source snapshot can be settled without publishing failed work.
        if (typeof code !== "number" || !Number.isSafeInteger(code) || code < 1 || code > 255 ||
          sourceManifest(value.files) !== sourceManifest(value.baselineFiles) ||
          sourceManifest(value.baselineFiles) !== sourceManifest([...baseline, ...media]))
          throw commandFailure;
        await this.#acknowledge(state, value.snapshotId);
        combined.throwIfAborted();
        await this.#finish(state);
        combined.throwIfAborted();
        throw confirmIsolatedCommandFailure(commandFailure!, state.id, code);
      }
      const result = await guard(() =>
        this.#withSpace(state, () =>
          applySourceChanges(
            project.workspacePath,
            baseline,
            verifyCapturedMedia(value.files, media, value.rasterReturnVersion),
            combined,
            separateMedia ? media : undefined,
            value.rasterReturnVersion,
            {
              namespace: this.namespace,
              projectId: project.id,
              generation: state.binding!.generation,
              snapshotId: value.snapshotId,
              ...(state.sourceContract
                ? { sourceContract: state.sourceContract }
                : {}),
            },
          ),
        ),
      );
      combined.throwIfAborted();
      await this.#report(state, "published");
      combined.throwIfAborted();
      await this.#acknowledge(state, value.snapshotId);
      return { output, ...result };
    } catch (cause) {
      failed = true;
      if (!getToolConfirmedFailure(cause))
        await this.#report(state, "retained").catch(() => {});
      if (commandFailure && cause !== commandFailure)
        throw new Error(`${commandFailure.message}\nThe original isolated result remains unconfirmed: ${cause instanceof Error ? cause.message : "result verification failed"}`, { cause });
      throw cause;
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", cancel);
      try {
        if (state.terminalCode === undefined) await this.#cancel(state);
        else await this.#finish(state);
      } catch (cause) {
        if (!failed) throw cause;
      } finally {
        this.#stop(child);
        // This releases only an allocation promise after all host writes ended;
        // it never settles a failed tool or an uncertain acknowledgement.
        await this.#releaseSpaceIfSettled(state, project.workspacePath);
      }
    }
  }

  async #workspaceRoot(project: Pick<ProjectState, "id" | "workspacePath">): Promise<string> {
    const workspace = await realpath(project.workspacePath);
    if (
      !/^[a-f0-9-]{36}$/.test(project.id) ||
      workspace !== path.join(this.projectsDirectory, project.id, "workspace")
    )
      throw new Error(
        "An isolated workspace is not configured for this project",
      );
    return workspace;
  }

  async #workspace(project: ProjectState): Promise<string> {
    const workspace = await this.#workspaceRoot(project);
    await assertSourcePublicationSettled(workspace);
    await assertNoUnapprovedSourceReview(workspace, project.id, this.namespace);
    return workspace;
  }

  async assertSourceReviewSettled(project: ProjectState): Promise<void> {
    const workspace = await this.#workspaceRoot(project);
    await assertNoUnapprovedSourceReview(workspace, project.id, this.namespace);
  }

  async #prepareProfile(project: ProjectState, state: Operation, input: object, media: RuntimeMedia[], signal: AbortSignal): Promise<unknown> {
    const value = await this.#control("prepare-begin", [], input, undefined, signal) as { prepared?: unknown; uploadVersion?: unknown; windowCount?: unknown; windows?: unknown };
    const binding = this.#binding(value, project.id, state.id);
    const expected = input as { sourceManifest?: { manifestId?: string }; sourceProfileId?: RuntimeCapacityProfileId };
    if (binding.captureVersion !== 4 || binding.sourceManifestVersion !== 2 || binding.sourceProfileId !== expected.sourceProfileId || !this.#capacityProfiles.has(binding.sourceProfileId!) || binding.sourceBaseManifestId !== expected.sourceManifest?.manifestId || value.prepared !== false || value.uploadVersion !== 1 || !Array.isArray(value.windows) || value.windows.length > 2000 || value.windowCount !== value.windows.length) throw new Error("Invalid complete medium-profile preparation transaction");
    state.binding = binding;
    await state.spaceReservation?.bind({ generation: binding.generation });
    const declared = new Map(media.map(file => [file.path, file])), seen = new Set<string>();
    for (let index = 0; index < value.windows.length; index++) {
      signal.throwIfAborted();
      const window = value.windows[index] as { windowIndex: number; windowId: string; paths: string[]; bytes: number };
      if (!window || window.windowIndex !== index || !/^[a-f0-9]{32}$/.test(window.windowId) || !Array.isArray(window.paths) || !window.paths.length || window.paths.length > media.length || window.paths.some(name => typeof name !== "string" || !declared.has(name) || seen.has(name))) throw new Error("Invalid isolated media upload window");
      const selected = window.paths.map(name => declared.get(name)!);
      const bytes = selected.reduce((sum, file) => sum + file.size, 0);
      if (window.bytes !== bytes || bytes > 64 * 1024 * 1024) throw new Error("An upload window exceeds the independent media payload limit");
      for (const name of window.paths) { if (seen.has(name)) throw new Error("Duplicate upload path"); seen.add(name); }
      await this.#checkSpace(state);
      const appended = await this.#control("prepare-append", [], { ...binding, uploadVersion: 1, windowIndex: index, windowId: window.windowId }, { workspace: project.workspacePath, media: selected, expectedPaths: window.paths, signal, profile: binding.sourceProfileId }) as { appended?: unknown; windowIndex?: unknown; windowId?: unknown };
      if (appended.appended !== true || appended.windowIndex !== index || appended.windowId !== window.windowId) throw new Error("The original upload window receipt is unconfirmed; the transaction remains retained");
    }
    signal.throwIfAborted();
    await this.#checkSpace(state);
    return this.#control("prepare-commit", [], { ...binding, uploadVersion: 1 }, undefined, signal);
  }

  async start(
    project: ProjectState,
    mode: Mode,
    cwd: string,
    args: string[] = [],
    port?: number,
    options: {
      files?: (
        separateMedia: boolean,
        profile?: RuntimeCapacityProfileId,
      ) => Promise<{ files: TransferFile[]; media: RuntimeMedia[] }>;
      signal?: AbortSignal;
      hold?: boolean;
    } = {},
  ): Promise<ChildProcess> {
    this.#admit(project.id);
    const workspace = await this.#workspace(project);
    const directory = await realpath(cwd);
    const relative = path.relative(workspace, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("The isolated working directory left the project");
    const publicInput = {
      projectId: project.id,
      mode,
      cwd: relative.split(path.sep).join("/"),
      args,
      ...(port ? { port } : {}),
    };
    if (
      JSON.stringify(publicInput).length > 64 * 1024 ||
      containsKnownSensitiveValue(JSON.stringify(publicInput))
    )
      throw new Error("Private values cannot be passed to isolated execution");
    this.#admit(project.id);
    if (this.#projects.has(project.id))
      throw new Error(
        "Stop the existing project operation before starting another",
      );
    if (this.#projects.size >= 2)
      throw new Error("Two isolated operations are already running");
    this.#projects.add(project.id);
    const state = this.#operation(project.id, options.hold === true, port);
    state.mode = mode;
    const combined = options.signal
      ? AbortSignal.any([options.signal, state.abort.signal])
      : state.abort.signal;
    let prepared!: () => void;
    this.#preparing.set(
      project.id,
      new Promise<void>((resolve) => {
        prepared = resolve;
      }),
    );
    let child: ChildProcess;
    try {
      await this.#report(state, "input_preflight");
      combined.throwIfAborted();
      await this.vm?.ready();
      await this.#health();
      const storage = this.#mediumProfile ? await this.inventoryProject(project) : undefined;
      const profile = storage?.sourceManifestVersion === 2 ? getRuntimeCapacityProfile(storage.sourceProfileId).id : undefined;
      this.#admit(project.id);
      combined.throwIfAborted();
      if (profile && mode !== "shell") await this.#reservePhysical(project, state, profile, combined);
      state.workspacePath = workspace;
      let media: RuntimeMedia[] = [],
        files: TransferFile[];
      try {
        if (options.files)
          ({ files, media } = await options.files(this.#runtimeMedia, profile));
        else
          files = await projectFiles(
            workspace,
            this.#runtimeMedia ? media : undefined,
            undefined,
            profile ? { profile, signal: combined } : undefined,
          );
      } catch (cause) {
        if (!state.submitted && isIsolatedInputBudgetError(cause))
          await this.#report(state, "input_rejected", cause);
        if (
          !this.#runtimeMedia &&
          cause instanceof Error &&
          /transfer budget|per-file limit/i.test(cause.message)
        ) {
          const message =
            "The installed isolated component uses legacy source limits. Update the guest controller to enable separate runtime media transfer. " +
            cause.message;
          throw isIsolatedInputBudgetError(cause)
            ? isolatedInputBudgetError(message)
            : new Error(message);
        }
        throw cause;
      }
      const seed = this.#sourceManifests
        ? manifestFor([...files, ...media], profile)
        : undefined;
      if (this.#captureMedia && mode === "shell") {
        try {
          state.spaceReservation = await this.#reserveSpace(
            project,
            state.id,
            combined,
            undefined,
            seed
              ? {
                  sourceManifestVersion: profile ? 2 : 1,
                  sourceBaseManifestId: seed.manifestId,
                  ...(profile ? { sourceProfileId: profile } : {}),
                }
              : undefined,
          );
        } catch (cause) {
          if (!state.submitted && isRecoverySpaceInputRefusal(cause)) {
            const rejection = isolatedInputBudgetError(
              cause instanceof Error
                ? cause.message
                : "Storage admission failed before command submission",
            );
            await this.#report(state, "input_rejected", rejection);
            throw rejection;
          }
          throw cause;
        }
      }
      const packages =
        mode === "install"
          ? await publicPackages(directory, path.join(RUNTIME_ROOT, "packages"))
          : [];
      this.#admit(project.id);
      combined.throwIfAborted();
      if (mode === "preview")
        state.previewSource = sourceManifest([...files, ...media]);
      const prepareInput = {
        namespace: this.namespace,
        projectId: project.id,
        operationId: state.id,
        mode,
        files: media.length ? [...files, ...media] : files,
        packages,
        ...(this.#captureMedia
          ? { rasterReturnVersion: 2 }
          : this.#rasterReturns
            ? { rasterReturnVersion: 1 }
            : {}),
        ...(seed ? { sourceManifestVersion: profile ? 2 : 1, sourceManifest: seed, ...(profile ? { sourceProfileId: profile } : {}) } : {}),
      };
      // This is the actual full-inline control header, not the changed-byte budget.
      if (
        Buffer.byteLength(JSON.stringify(prepareInput), "utf8") >
        24 * 1024 * 1024
      ) {
        const cause = isolatedInputBudgetError(
          "The complete isolated seed header exceeds 24 MiB; no operation was submitted. Source data is still fully inline; reduce the source/package header rather than repeating the request.",
        );
        await this.#report(state, "input_rejected", cause);
        throw cause;
      }
      await this.#report(state, "prepare_submitting");
      this.#admit(project.id);
      combined.throwIfAborted();
      await this.#checkSpace(state);
      state.submitted = true;
      const response = (await (profile ? this.#prepareProfile(project, state, prepareInput, media, combined) : this.#control(
        media.length ? "prepare-media" : "prepare",
        [],
        prepareInput,
        media.length ? { workspace, media, signal: combined } : undefined,
      ))) as {
        prepared?: unknown;
        protocolVersion?: unknown;
        sourceDigest?: unknown;
      };
      state.binding = this.#binding(response, project.id, state.id);
      if (
        response.prepared !== true ||
        (state.binding.rasterReturnVersion ?? 0) !==
          (this.#captureMedia ? 2 : this.#rasterReturns ? 1 : 0) ||
        response.protocolVersion !== 2 ||
        typeof response.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(response.sourceDigest) ||
        (seed
          ? state.binding.captureVersion !== (profile ? 4 : 3) || (profile ? state.binding.sourceProfileId !== profile : state.binding.sourceProfileId !== undefined) ||
            state.binding.sourceBaseManifestId !== seed.manifestId ||
            response.sourceDigest !== reviewSnapshotDigest([...files, ...media])
          : [3,4].includes(state.binding.captureVersion ?? 0))
      )
        throw new Error("Invalid isolated preparation response");
      await state.spaceReservation?.bind({
        generation: state.binding.generation,
      });
      await this.#report(state, "prepared");
      this.#admit(project.id);
      combined.throwIfAborted();
      await this.#report(state, "run_submitting");
      this.#admit(project.id);
      combined.throwIfAborted();
      child = this.#spawn("run", [state.id]);
      state.child = child;
    } catch (cause) {
      if (state.submitted) {
        await this.#report(state, "retained").catch(() => {});
        try {
          await this.#cancel(state);
        } catch {
          if (!state.released)
            throw new Error(
              "Isolated preparation stopped with an uncertain reservation; project data is retained and must be recovered",
            );
        }
      } else {
        state.released = true;
        this.#settle(state);
      }
      if (state.released) await this.#releaseSpaceIfSettled(state, workspace);
      throw cause;
    } finally {
      this.#preparing.delete(project.id);
      prepared();
    }
    this.#jobs.add(child);
    child.once("close", (code) => {
      state.closed = true;
      state.transportCode = code;
      this.#jobs.delete(child);
      if (!state.hold) {
        const settle =
          state.terminalCode === undefined
            ? this.#cancel(state)
            : this.#finish(state);
        void settle.then(() => this.#releaseSpaceIfSettled(state, workspace)).catch((cause) => this.#settle(state, cause));
      }
    });
    const raw = child.stdout!,
      rawError = child.stderr!;
    const output = new PassThrough(),
      errors = new PassThrough();
    child.stdout = output;
    child.stderr = errors;
    let resolveReady!: () => void, rejectReady!: (cause: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Install/build callers use process completion rather than preview readiness.
    void ready.catch(() => {});
    state.ready = ready;
    this.#operations.set(child, state);
    let buffer = "";
    let total = 0;
    const decode = new StringDecoder("utf8");
    const redact = sensitiveValueStream(),
      redactError = sensitiveValueStream();
    raw.setEncoding("utf8");
    raw.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) {
        rejectReady(new Error("Isolated control output exceeded its limit"));
        this.#stop(child);
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line) as {
            kind: string;
            id?: string;
            data?: string;
            message?: string;
            code?: number;
          };
          if (value.kind === "started" || value.kind === "ready") {
            if (!value.id || !/^[a-f0-9]{32}$/.test(value.id))
              throw new Error();
            if (value.id !== state.id)
              throw new Error("Isolated operation identity changed");
            if (value.kind === "ready") resolveReady();
          } else if (value.kind === "exit") {
            if (
              value.id !== state.id ||
              !Number.isInteger(value.code) ||
              value.code! < 0 ||
              value.code! > 255 ||
              state.terminalCode !== undefined
            )
              throw new Error("Invalid isolated terminal response");
            state.terminalCode = value.code;
          } else if (
            value.kind === "stdout" &&
            typeof value.data === "string"
          ) {
            total += value.data.length;
            if (total > 768 * 1024) throw new Error();
            output.write(
              redact(decode.write(Buffer.from(value.data, "base64"))),
            );
          } else if (value.kind === "error") {
            const error = new Error(
              redactKnownSensitiveValues(
                value.message ?? "Isolated execution failed",
              ),
            );
            errors.write(error.message);
            rejectReady(error);
          }
        } catch {
          rejectReady(new Error("Invalid isolated control response"));
          this.#stop(child);
        }
      }
    });
    rawError.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 768 * 1024) {
        this.#stop(child);
        return;
      }
      errors.write(redactError(chunk.toString("utf8")));
    });
    const heartbeat = setInterval(() => {
      if (!child.stdin?.destroyed) child.stdin?.write('{"op":"heartbeat"}\n');
    }, 2_000);
    heartbeat.unref();
    child.stdin?.on("error", () => this.#stop(child));
    child.on("error", (cause) => rejectReady(cause));
    child.once("close", () => {
      clearInterval(heartbeat);
      output.end(redact(decode.end(), true));
      errors.end(redactError("", true));
      rejectReady(new Error("Isolated execution stopped before readiness"));
    });
    child.stdin!.write(
      `${JSON.stringify({ ...publicInput, ...state.binding })}\n`,
    );
    try {
      await this.#report(state, "running");
      combined.throwIfAborted();
    } catch (cause) {
      await this.#report(state, "retained").catch(() => {});
      await this.#cancel(state).catch(() => {});
      throw cause;
    }
    return child;
  }

  settled(child: ChildProcess, requireSuccessfulExit = false): Promise<void> {
    const state = this.#operations.get(child);
    if (!state) throw new Error("Unknown isolated operation");
    return requireSuccessfulExit
      ? state.settled.then(() => {
          if (state.terminalCode !== 0 || state.transportCode !== 0)
            throw new Error(
              "Isolated command ended without a confirmed successful exit",
            );
        })
      : state.settled;
  }

  owns(child: ChildProcess): boolean {
    return this.#operations.has(child);
  }

  async stop(child: ChildProcess): Promise<void> {
    const state = this.#operations.get(child);
    if (!state) throw new Error("Unknown isolated operation");
    state.abort.abort(new Error("Isolated operation stopped"));
    await this.#cancel(state);
    this.#stop(child);
  }

  ready(child: ChildProcess): Promise<void> {
    const state = this.#operations.get(child);
    if (!state) throw new Error("Unknown isolated operation");
    return state.ready;
  }

  /** Compare the inputs actually sent to this job, including verified runtime media. */
  async previewSourceMatches(
    child: ChildProcess,
    project: ProjectState,
  ): Promise<boolean> {
    const state = this.#operations.get(child);
    if (state?.projectId !== project.id || state.previewSource === undefined)
      return false;
    this.#admit(project.id);
    const media: RuntimeMedia[] = [];
    const files = await projectFiles(
      await this.#workspace(project),
      this.#runtimeMedia ? media : undefined,
      undefined,
      state.binding?.sourceProfileId ? { profile: state.binding.sourceProfileId } : undefined,
    );
    return sourceManifest([...files, ...media]) === state.previewSource;
  }

  connection(child: ChildProcess): Duplex {
    const state = this.#operations.get(child);
    if (!state?.id || state.closed || state.released || !state.port)
      throw new Error("Isolated preview connection is unavailable");
    if (this.#waitingConnections.size >= 32)
      throw new Error("Isolated preview connection queue is full");
    const input = new PassThrough(),
      output = new PassThrough();
    const stream = Duplex.from({
      readable: output,
      writable: input,
    });
    // HTTP removes its socket error listener after completion; a late SSH pipe close must not crash the daemon.
    stream.on("error", () => {});
    let proxy: ChildProcess | undefined;
    const start = () => {
      this.#waitingConnections.delete(start);
      if (stream.destroyed) return;
      if (state.closed || state.released || state.abort.signal.aborted) {
        stream.destroy(new Error("Isolated preview has stopped"));
        return;
      }
      if (this.#connections >= 8) {
        this.#waitingConnections.add(start);
        return;
      }
      clearTimeout(timer);
      try {
        proxy = this.#spawn("proxy", [state.id, String(state.port)]);
        this.#connections += 1;
        input.pipe(proxy.stdin!);
        proxy.stdout!.pipe(output);
        proxy.stderr?.resume();
        proxy.on("error", (cause) => stream.destroy(cause));
        for (const pipe of [proxy.stdin!, proxy.stdout!])
          pipe.on("error", (cause) => stream.destroy(cause));
      } catch (cause) {
        stream.destroy(cause as Error);
      }
    };
    const timer = setTimeout(
      () =>
        stream.destroy(new Error("Isolated preview connection wait timed out")),
      10_000,
    );
    timer.unref();
    const cancel = () =>
      stream.destroy(new Error("Isolated preview has stopped"));
    state.abort.signal.addEventListener("abort", cancel, { once: true });
    stream.once("close", () => {
      clearTimeout(timer);
      state.abort.signal.removeEventListener("abort", cancel);
      this.#waitingConnections.delete(start);
      if (proxy) {
        this.#connections -= 1;
        this.#stop(proxy);
      }
      // Reserve released slots synchronously, before another HTTP request can take them.
      for (const pending of this.#waitingConnections) {
        if (this.#connections >= 8) break;
        pending();
      }
    });
    start();
    return stream;
  }

  #stop(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      for (const state of this.#active.values())
        state.abort.abort(new Error("Isolated execution is closing"));
      await Promise.allSettled(this.#preparing.values());
      const cancellations = await Promise.allSettled(
        [...this.#active.values()].map((state) => this.#cancel(state)),
      );
      for (const child of this.#children) this.#stop(child);
      await Promise.all(
        [...this.#returning.values()].flatMap((returning) => [...returning]),
      );
      await this.vm?.close();
      if (cancellations.some((result) => result.status === "rejected"))
        throw new Error(
          "Some isolated jobs could not confirm cancellation; their data is retained",
        );
    })());
  }
}
