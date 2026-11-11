import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { localAgentPath } from "./agent-local-files.js";
import { readSafeProjectFile, inspectSafeProjectMedia } from "./safe-project-file.js";
import { transferPath, withCheckedFileStream } from "./isolated-project-files.js";
import {
  assertSourceDeltaSummary,
  parseSourceContract,
  parseSourceManifest,
  planSourceDelta,
  type SourceContract,
  type SourceDeltaSummaryV1,
  type SourceManifest,
} from "./isolated-source-manifest.js";
import { getRuntimeCapacityProfile, runtimeMediaFileLimit, type RuntimeCapacityProfileId } from "../shared/execution-capacity-profiles.js";
import {
  LEGACY_RECOVERY_LIMIT_BYTES,
  RECOVERY_LIMIT_BYTES,
  checkRecoverySpaceHeadroom,
  currentRecoverySpaceReservation,
  reservationForPublication,
  validRecoverySpacePlan,
  type RecoverySpacePlan,
} from "./recovery-space.js";

export interface PublicationContext {
  namespace: "manual" | "test";
  projectId: string;
  generation: number;
  snapshotId: string;
  sourceContract?: SourceContract;
}
export interface PublicationVersion {
  path: string;
  beforeSha256?: string;
  beforeSize?: number;
  beforeMode?: number;
  afterSha256: string;
  afterSize: number;
  afterMode: number;
}
export interface PublicationManifest {
  version: 2 | 3 | 4 | 5;
  spacePlan?: RecoverySpacePlan;
  reservationId?: string;
  kind?: "local-image";
  localWorkspace?: string;
  localProjectId?: string;
  state:
    "staging" | "publishing" | "committed" | "rolled-back" | "needs-review";
  context?: PublicationContext;
  versions: PublicationVersion[];
  published: string[];
  steps: Record<
    string,
    "staged" | "moving" | "moved" | "linking" | "published"
  >;
  rasterReceipts?: unknown[];
  publicationBefore?: SourceManifest;
  publicationAfter?: SourceManifest;
  publicationDelta?: SourceDeltaSummaryV1;
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export function samePublicationContext(
  left: PublicationContext | undefined,
  right: PublicationContext,
): boolean {
  if (
    !left ||
    ["namespace", "projectId", "generation", "snapshotId"].some(
      (key) =>
        left[key as keyof PublicationContext] !==
        right[key as keyof PublicationContext],
    )
  )
    return false;
  if (left.sourceContract === undefined || right.sourceContract === undefined)
    return left.sourceContract === right.sourceContract;
  try {
    const a = parseSourceContract(left.sourceContract),
      b = parseSourceContract(right.sourceContract);
    return (
      a.version === b.version &&
      (a.version === 2 ? a.profileId : undefined) ===
        (b.version === 2 ? b.profileId : undefined) &&
      a.baseManifestId === b.baseManifestId &&
      a.rawManifestId === b.rawManifestId &&
      a.preparedManifestId === b.preparedManifestId
    );
  } catch {
    return false;
  }
}

/** Identity metadata only; callers still need approval, an exact reservation and retained payloads. */
export function sourcePublicationMetadata(
  context: PublicationContext,
  before: SourceManifest,
  after: SourceManifest,
): Pick<
  PublicationManifest,
  | "version"
  | "context"
  | "publicationBefore"
  | "publicationAfter"
  | "publicationDelta"
> {
  if (
    Object.keys(context).length !== 5 ||
    ![
      "namespace",
      "projectId",
      "generation",
      "snapshotId",
      "sourceContract",
    ].every((key) => Object.hasOwn(context, key)) ||
    !["manual", "test"].includes(context.namespace) ||
    !/^[a-z0-9-]{1,128}$/i.test(context.projectId) ||
    !Number.isSafeInteger(context.generation) ||
    context.generation < 1 ||
    !/^[a-f0-9]{64}$/.test(context.snapshotId)
  )
    throw review("invalid versioned publication context");
  const sourceContract = parseSourceContract(context.sourceContract),
    publicationBefore = parseSourceManifest(before),
    publicationAfter = parseSourceManifest(after),
    delta = planSourceDelta(publicationBefore, publicationAfter);
  if (
    sourceContract.version !== publicationBefore.version ||
    sourceContract.version !== publicationAfter.version ||
    (sourceContract.version === 2 &&
      (publicationBefore.profile !== sourceContract.profileId ||
        publicationAfter.profile !== sourceContract.profileId ||
        delta.summary.afterMediaBytes >
          getRuntimeCapacityProfile(sourceContract.profileId).mediaWindowBytes))
  )
    throw review("publication profile or media return window differs");
  if (delta.summary.removedFiles)
    throw review("source deletion is not authorized by a delta");
  return {
    version: sourceContract.version === 2 ? 5 : 4,
    context: { ...context, sourceContract },
    publicationBefore,
    publicationAfter,
    publicationDelta: delta.summary,
  };
}

export async function durablePublicationDirectory(
  directory: string,
  mode = 0o700,
): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw review("linked publication directory");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await durablePublicationDirectory(path.dirname(directory), mode);
  try {
    await mkdir(directory, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw review("publication directory changed");
  await syncPublicationDirectory(path.dirname(directory));
}

export async function syncPublicationDirectory(
  directory: string,
): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durablePublicationFile(
  file: string,
  bytes: Buffer | ((handle: FileHandle) => Promise<void>),
  mode = 0o600,
): Promise<void> {
  const handle = await open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    if (typeof bytes === "function") await bytes(handle);
    else await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncPublicationDirectory(path.dirname(file));
}

export async function savePublicationManifest(
  directory: string,
  manifest: PublicationManifest,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > 2 * 1024 * 1024)
    throw review("transaction metadata exceeds its bound");
  // At most the old manifest and two bounded temporary copies can coexist.
  // Unknown old temporaries are retained, never silently discarded.
  if (
    (await readdir(directory)).filter((name) =>
      /^\.manifest-[a-f0-9-]+\.tmp$/.test(name),
    ).length >= 2
  )
    throw review("unfinished manifest copies need inspection");
  const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
  let identity: { ino: number; dev: number } | undefined;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      identity = { ino: info.ino, dev: info.dev };
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncPublicationDirectory(directory);
    await rename(temporary, path.join(directory, "manifest.json"));
    identity = undefined;
    await syncPublicationDirectory(directory);
  } catch (cause) {
    if (identity) {
      try {
        const current = await lstat(temporary);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.nlink === 1 &&
          current.ino === identity.ino &&
          current.dev === identity.dev
        ) {
          await rm(temporary);
          await syncPublicationDirectory(directory);
        }
      } catch {
        /* Failure remains bounded and blocks an unsafe later rewrite. */
      }
    }
    throw cause;
  }
}

/** Before the first durable journal there can be no payload or live moves. Never recursively remove unknown contents. */
export async function initializePublicationManifest(
  directory: string,
  manifest: PublicationManifest,
): Promise<void> {
  try {
    await savePublicationManifest(directory, manifest);
  } catch (cause) {
    try {
      if (!(await readdir(directory)).length) {
        await rmdir(directory);
        await syncPublicationDirectory(path.dirname(directory));
      }
    } catch {
      /* A nonempty or uncertain directory is retained and blocks new work. */
    }
    throw cause;
  }
}

function review(message: string): Error {
  return Object.assign(
    new Error(
      `Retained source publication requires review: ${message}. All versions are retained; do not rerun the command.`,
    ),
    { code: "SOURCE_PUBLICATION_REVIEW_REQUIRED" },
  );
}

async function journals(
  workspace: string,
): Promise<Array<{ directory: string; manifest: PublicationManifest }>> {
  const root = path.join(path.dirname(workspace), "isolated-changes");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if ((await realpath(root)) !== root || entries.length > 2000)
    throw review("unsafe or oversized journal storage");
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw review("linked or unknown journal entry");
    const directory = path.join(root, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(
        (
          await readSafeProjectFile(
            root,
            path.join(directory, "manifest.json"),
            2 * 1024 * 1024,
          )
        ).toString(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw review("missing transaction manifest in isolated-changes");
      throw review("unreadable transaction manifest");
    }
    // Existing completed version-1 recovery folders are not silently migrated.
    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5
    )
      throw review("unknown transaction version");
    if (!value || typeof value !== "object")
      throw review("unknown legacy transaction metadata");
    if (!("version" in value)) {
      const legacy = value as {
        changed?: unknown;
        deleted?: unknown;
        versions?: unknown;
      };
      if (
        Object.keys(legacy).some(
          (key) => !["changed", "deleted", "versions"].includes(key),
        ) ||
        !Array.isArray(legacy.changed) ||
        legacy.changed.length > 2000 ||
        !legacy.changed.every((p) => typeof p === "string") ||
        !Array.isArray(legacy.deleted) ||
        legacy.deleted.length ||
        (legacy.versions !== undefined && !Array.isArray(legacy.versions))
      )
        throw review("unknown legacy transaction metadata");
      for (const p of legacy.changed) transferPath(p);
      continue; // Recognized old receipts have no resumable phase and are never adopted or rewritten.
    }
    const m = value as PublicationManifest;
    if (m.kind !== undefined)
      throw review(
        "a different workflow's publication cannot authorize source recovery",
      );
    if (
      m.version >= 3 &&
      (!validRecoverySpacePlan(m.spacePlan) ||
        m.spacePlan?.version !== (m.version === 5 ? 2 : 1) ||
        typeof m.reservationId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.reservationId))
    )
      throw review("invalid versioned complete recovery plan");
    if (
      m.version >= 3 &&
      m.spacePlan &&
      Buffer.byteLength(JSON.stringify(m)) > m.spacePlan.manifestBytes
    )
      throw review("manifest exceeds its complete reservation plan");
    if (
      m.version === 2 &&
      (m.spacePlan !== undefined || m.reservationId !== undefined)
    )
      throw review("legacy transaction cannot claim a newer budget");
    if (
      ![
        "staging",
        "publishing",
        "committed",
        "rolled-back",
        "needs-review",
      ].includes(m.state) ||
      !Array.isArray(m.versions) ||
      m.versions.length > 2000 ||
      !Array.isArray(m.published) ||
      !m.steps ||
      typeof m.steps !== "object"
    )
      throw review("invalid transaction state");
    const seen = new Set<string>();
    if (
      m.context &&
      (!["manual", "test"].includes(m.context.namespace) ||
        typeof m.context.projectId !== "string" ||
        !/^[a-z0-9-]{1,128}$/i.test(m.context.projectId) ||
        !Number.isSafeInteger(m.context.generation) ||
        m.context.generation < 1 ||
        !/^[a-f0-9]{64}$/.test(m.context.snapshotId))
    )
      throw review("invalid transaction context");
    if (m.version === 4 || m.version === 5) {
      try {
        if (
          !m.context ||
          Object.keys(m.context).length !== 5 ||
          ![
            "namespace",
            "projectId",
            "generation",
            "snapshotId",
            "sourceContract",
          ].every((key) => Object.hasOwn(m.context!, key))
        )
          throw new Error();
        const contract = parseSourceContract(m.context.sourceContract);
        if (
          contract.version !== (m.version === 5 ? 2 : 1) ||
          (contract.version === 2 &&
            m.spacePlan?.profileId !== contract.profileId)
        )
          throw new Error();
      } catch {
        throw review("invalid versioned source contract");
      }
    } else if (
      m.context?.sourceContract !== undefined ||
      m.publicationBefore !== undefined ||
      m.publicationAfter !== undefined ||
      m.publicationDelta !== undefined
    ) {
      throw review(
        "legacy transaction cannot claim a versioned source contract",
      );
    }
    for (const v of m.versions) {
      transferPath(v.path);
      if (
        seen.has(v.path) ||
        !/^[a-f0-9]{64}$/.test(v.afterSha256) ||
        (v.beforeSha256 !== undefined &&
          !/^[a-f0-9]{64}$/.test(v.beforeSha256)) ||
        !Number.isSafeInteger(v.afterSize) ||
        v.afterSize < 0 ||
        v.afterSize > publicationLimit(m, v.path) ||
        !Number.isSafeInteger(v.afterMode) ||
        v.afterMode < 0 ||
        v.afterMode > 0o777 ||
        (v.beforeSha256 !== undefined &&
          (!Number.isSafeInteger(v.beforeSize) ||
            v.beforeSize! < 0 ||
            v.beforeSize! > publicationLimit(m, v.path)))
      )
        throw review("invalid transaction file binding");
      if (
        v.beforeMode !== undefined &&
        (!v.beforeSha256 ||
          !Number.isSafeInteger(v.beforeMode) ||
          v.beforeMode < 0 ||
          v.beforeMode > 0o777)
      )
        throw review("invalid baseline mode");
      seen.add(v.path);
      if (
        !["staged", "moving", "moved", "linking", "published"].includes(
          m.steps[v.path],
        )
      )
        throw review("unknown publication file phase");
    }
    if (m.published.some((p) => !seen.has(p)))
      throw review("unknown published path");
    if (
      m.versions.reduce(
        (sum, v) => sum + 2 * (v.afterSize + (v.beforeSize ?? 0)),
        0,
      ) >
      (m.version === 2 ? LEGACY_RECOVERY_LIMIT_BYTES : m.spacePlan!.limitBytes)
    )
      throw review("transaction payload exceeds the recovery budget");
    if (
      m.version >= 3 &&
      m.spacePlan &&
      (m.versions.reduce((sum, v) => sum + (v.beforeSize ?? 0), 0) >
        m.spacePlan.beforeBytes ||
        m.versions.reduce((sum, v) => sum + v.afterSize, 0) >
          m.spacePlan.afterBytes)
    )
      throw review("committed versions exceed the reserved complete plan");
    if (m.version === 4 || m.version === 5) {
      try {
        const before = parseSourceManifest(m.publicationBefore),
          after = parseSourceManifest(m.publicationAfter),
          delta = planSourceDelta(before, after);
        assertSourceDeltaSummary(m.publicationDelta, before, after);
        const contract = parseSourceContract(m.context!.sourceContract);
        if (
          before.version !== contract.version ||
          after.version !== contract.version ||
          (contract.version === 2 &&
            (before.profile !== contract.profileId ||
              after.profile !== contract.profileId ||
              delta.summary.afterMediaBytes >
                getRuntimeCapacityProfile(contract.profileId).mediaWindowBytes))
        )
          throw new Error();
        const changed = delta.changes.filter(
          (value) => value.change !== "unchanged",
        );
        if (
          delta.summary.removedFiles ||
          changed.length !== m.versions.length ||
          delta.summary.beforeBytes > m.spacePlan!.beforeBytes ||
          delta.summary.afterBytes > m.spacePlan!.afterBytes
        )
          throw new Error();
        for (const change of changed) {
          const version = m.versions.find(
            (value) => value.path === change.path,
          );
          if (
            !version ||
            !change.after ||
            version.beforeSha256 !== change.before?.sha256 ||
            version.beforeSize !== change.before?.size ||
            version.afterSha256 !== change.after.sha256 ||
            version.afterSize !== change.after.size ||
            Boolean(version.afterMode & 0o111) !== change.after.executable ||
            (change.before &&
              version.beforeMode !== undefined &&
              Boolean(version.beforeMode & 0o111) !== change.before.executable)
          )
            throw new Error();
        }
      } catch {
        throw review(
          "publication manifests, delta and retained versions differ",
        );
      }
    }
    result.push({ directory, manifest: m });
  }
  return result;
}

export async function pendingSourcePublications(workspace: string) {
  return (await journals(workspace)).filter(
    ({ manifest }) => !["committed", "rolled-back"].includes(manifest.state),
  );
}

export async function assertSourcePublicationSettled(
  workspace: string,
): Promise<void> {
  if ((await pendingSourcePublications(workspace)).length)
    throw review(
      "an interrupted host transaction must be inspected and recovered before new work",
    );
}

/** A lost guest ACK may be reconciled only with the exact original preserved by that publication. */
function publicationProfile(
  manifest: PublicationManifest,
): RuntimeCapacityProfileId | undefined {
  return manifest.context?.sourceContract?.version === 2
    ? manifest.context.sourceContract.profileId
    : undefined;
}
function publicationLimit(
  manifest: PublicationManifest,
  relative: string,
): number {
  return runtimeMediaFileLimit(relative, publicationProfile(manifest));
}
/** Bounded integrity check for a transaction-owned descriptor, including its special two-link stage. */
export async function hashPublicationHandle(
  handle: FileHandle,
  expectedSize: number,
): Promise<string> {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.size !== BigInt(expectedSize) ||
    expectedSize > 64 * 1024 * 1024
  )
    throw review("retained file size changed");
  const hash = createHash("sha256"),
    chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, expectedSize - offset),
      offset,
    );
    if (!bytesRead) throw review("retained file changed");
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    after.nlink !== before.nlink
  )
    throw review("retained file changed");
  return hash.digest("hex");
}
async function verifyVersion(
  root: string,
  relative: string,
  sha256: string,
  size: number,
  limit: number,
): Promise<void> {
  const checked = await inspectSafeProjectMedia(
    root,
    path.join(root, relative),
    limit,
  );
  if (checked.size !== size || checked.sha256 !== sha256)
    throw review("retained file content changed");
}

export async function retainedPublicationOriginal(
  workspace: string,
  context: PublicationContext,
  relative: string,
  beforeSha256: string,
  afterSha256: string,
): Promise<Buffer> {
  for (const { directory, manifest } of await journals(workspace)) {
    const bound = manifest.context;
    if (
      manifest.state !== "committed" ||
      !samePublicationContext(bound, context)
    )
      continue;
    const version = manifest.versions.find(
      (v) =>
        v.path === relative &&
        v.beforeSha256 === beforeSha256 &&
        v.afterSha256 === afterSha256,
    );
    if (version)
      return readVersion(
        directory,
        `original/${relative}`,
        beforeSha256,
        version.beforeSize!,
      );
  }
  throw review(
    "the replaced raster original has no matching committed receipt",
  );
}

export async function verifyRetainedPublicationOriginal(
  workspace: string,
  context: PublicationContext,
  relative: string,
  beforeSha256: string,
  afterSha256: string,
): Promise<void> {
  for (const { directory, manifest } of await journals(workspace)) {
    const bound = manifest.context;
    if (
      manifest.state !== "committed" ||
      !samePublicationContext(bound, context)
    )
      continue;
    const version = manifest.versions.find(
      (v) =>
        v.path === relative &&
        v.beforeSha256 === beforeSha256 &&
        v.afterSha256 === afterSha256,
    );
    if (version)
      return verifyVersion(
        directory,
        `original/${relative}`,
        beforeSha256,
        version.beforeSize!,
        publicationLimit(manifest, relative),
      );
  }
  throw review(
    "the replaced raster original has no matching committed receipt",
  );
}

async function readVersion(
  root: string,
  relative: string,
  sha256: string,
  size: number,
): Promise<Buffer> {
  const bytes = await readSafeProjectFile(
    root,
    path.join(root, relative),
    32 * 1024 * 1024,
  );
  if (bytes.length !== size || digest(bytes) !== sha256)
    throw review("retained file content changed");
  return bytes;
}

async function detachOwnedStagingLink(
  workspace: string,
  directory: string,
  v: PublicationVersion,
  step: string,
): Promise<void> {
  const target = path.join(workspace, v.path),
    staged = path.join(directory, "after", v.path);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.nlink === 1) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 2 ||
    !["linking", "published"].includes(step)
  )
    throw review("unknown destination links");
  await localAgentPath(workspace, path.posix.dirname(v.path), false);
  if ((await realpath(staged)) !== staged) throw review("linked staging path");
  const alias = await lstat(staged);
  if (
    !alias.isFile() ||
    alias.isSymbolicLink() ||
    alias.ino !== info.ino ||
    alias.dev !== info.dev ||
    alias.nlink !== 2
  )
    throw review("destination links do not belong to this transaction");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size !== v.afterSize ||
      (before.mode & 0o777) !== v.afterMode
    )
      throw review("linked destination changed");
    const hash = await hashPublicationHandle(handle, v.afterSize);
    const after = await handle.stat();
    if (
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      hash !== v.afterSha256
    )
      throw review("linked destination was edited outside this transaction");
  } finally {
    await handle.close();
  }
  await rm(staged);
  await syncPublicationDirectory(path.dirname(staged));
}

async function checkMode(
  target: string,
  expected: number | undefined,
): Promise<void> {
  const info = await lstat(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (expected === undefined
      ? !!(info.mode & 0o111)
      : (info.mode & 0o777) !== expected)
  )
    throw review("file mode or links changed");
}

/** Explicit recovery only, under the workspace guard and bound to a freshly captured guest snapshot. */
export async function resumeSourcePublications(
  workspace: string,
  context: PublicationContext,
): Promise<{ changed: string[]; recovery?: string }> {
  const changed = new Set<string>();
  let recovery: string | undefined;
  for (const { directory, manifest: m } of await pendingSourcePublications(
    workspace,
  )) {
    if (!samePublicationContext(m.context, context))
      throw review("transaction and current guest generation/snapshot differ");
    const reservation =
      m.version >= 3
        ? await reservationForPublication(workspace, m.reservationId!, context)
        : undefined;
    const ownsReservation =
      reservation &&
      currentRecoverySpaceReservation(await realpath(workspace))?.id !==
        reservation.id;
    if (m.state === "staging") {
      // Publication has a durable phase barrier before any live file is moved.
      const before = await readdir(path.join(directory, "before")).catch(
        (cause) => {
          if (
            m.version >= 3 &&
            (cause as NodeJS.ErrnoException).code === "ENOENT"
          )
            return [];
          throw cause;
        },
      );
      if (m.published.length || before.length)
        throw review("staging journal contains publication effects");
      m.state = "rolled-back";
      await savePublicationManifest(directory, m);
      if (ownsReservation) await reservation.release();
      continue;
    }
    if (reservation) await checkRecoverySpaceHeadroom(reservation);
    const plans = [];
    for (const v of m.versions) {
      await verifyVersion(
        directory,
        `returned/${v.path}`,
        v.afterSha256,
        v.afterSize,
        publicationLimit(m, v.path),
      );
      if (v.beforeSha256)
        await verifyVersion(
          directory,
          `original/${v.path}`,
          v.beforeSha256,
          v.beforeSize!,
          publicationLimit(m, v.path),
        );
      await detachOwnedStagingLink(workspace, directory, v, m.steps[v.path]);
      const target = await localAgentPath(workspace, v.path, true);
      let current: { sha256: string } | undefined;
      try {
        current = await inspectSafeProjectMedia(
          workspace,
          target,
          publicationLimit(m, v.path),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const currentHash = current?.sha256;
      if (current !== undefined)
        await checkMode(
          target,
          currentHash === v.afterSha256 ? v.afterMode : v.beforeMode,
        );
      if (
        currentHash !== v.afterSha256 &&
        currentHash !== v.beforeSha256 &&
        current !== undefined
      )
        throw review("a concurrent host save wins; no file was replaced");
      const step = m.steps[v.path];
      if (
        currentHash !== v.afterSha256 &&
        ["linking", "published"].includes(step)
      )
        throw review(
          "publication outcome or a later host deletion/save is uncertain",
        );
      if (current === undefined && v.beforeSha256) {
        if (!["moving", "moved"].includes(step))
          throw review(
            "a baseline destination disappeared outside publication",
          );
        await verifyVersion(
          directory,
          `before/${v.path}`,
          v.beforeSha256,
          v.beforeSize!,
          publicationLimit(m, v.path),
        );
        await checkMode(path.join(directory, "before", v.path), v.beforeMode);
      }
      if (currentHash === v.beforeSha256 && v.beforeSha256 && step === "moved")
        throw review("a host save restored a moved destination");
      plans.push({ v, target, currentHash });
    }
    m.state = "publishing";
    await savePublicationManifest(directory, m);
    for (const { v, target, currentHash } of plans) {
      if (currentHash !== v.afterSha256) {
        await localAgentPath(workspace, v.path, true);
        if (currentHash === v.beforeSha256 && v.beforeSha256) {
          const current = await inspectSafeProjectMedia(
            workspace,
            target,
            publicationLimit(m, v.path),
          );
          if (current.sha256 !== v.beforeSha256)
            throw review("host changed during recovery");
          await checkMode(target, v.beforeMode);
          const moved = path.join(directory, "before", ...v.path.split("/"));
          await durablePublicationDirectory(path.dirname(moved));
          // Never overwrite an earlier backup, including one changed through an old open handle.
          try {
            await lstat(moved);
            throw review("an earlier moved inode needs review");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          m.steps[v.path] = "moving";
          await savePublicationManifest(directory, m);
          await rename(target, moved);
          await syncPublicationDirectory(path.dirname(target));
          await syncPublicationDirectory(path.dirname(moved));
          await verifyVersion(
            directory,
            `before/${v.path}`,
            v.beforeSha256,
            v.beforeSize!,
            publicationLimit(m, v.path),
          );
          await checkMode(moved, v.beforeMode);
          m.steps[v.path] = "moved";
          await savePublicationManifest(directory, m);
        }
        await durablePublicationDirectory(path.dirname(target), 0o755);
        const temporary = path.join(directory, "after", v.path);
        await durablePublicationDirectory(path.dirname(temporary));
        try {
          await verifyVersion(
            directory,
            `after/${v.path}`,
            v.afterSha256,
            v.afterSize,
            publicationLimit(m, v.path),
          );
          await checkMode(temporary, v.afterMode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await withCheckedFileStream(
            directory,
            path.join(directory, "returned", v.path),
            {
              maxBytes: publicationLimit(m, v.path),
              expectedSha256: v.afterSha256,
              expectedSize: v.afterSize,
            },
            async (stream) => {
              await durablePublicationFile(
                temporary,
                async (handle) => {
                  for await (const chunk of stream)
                    await handle.writeFile(chunk);
                },
                v.afterMode,
              );
            },
          );
        }
        m.steps[v.path] = "linking";
        await savePublicationManifest(directory, m);
        try {
          await link(temporary, target);
          await syncPublicationDirectory(path.dirname(target));
        } finally {
          await rm(temporary);
          await syncPublicationDirectory(path.dirname(temporary));
        }
      }
      const saved = await inspectSafeProjectMedia(
        workspace,
        target,
        publicationLimit(m, v.path),
      );
      if (saved.sha256 !== v.afterSha256)
        throw review("host changed after recovery publication");
      await checkMode(target, v.afterMode);
      if (!m.published.includes(v.path)) m.published.push(v.path);
      m.steps[v.path] = "published";
      await savePublicationManifest(directory, m);
      changed.add(v.path);
    }
    m.state = "committed";
    await savePublicationManifest(directory, m);
    if (ownsReservation) await reservation.release();
    recovery = `isolated-changes/${path.basename(directory)}`;
  }
  return { changed: [...changed], ...(recovery ? { recovery } : {}) };
}
