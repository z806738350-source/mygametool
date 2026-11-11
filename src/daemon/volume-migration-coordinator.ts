import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getRuntimeCapacityProfile, type RuntimeCapacityProfileId } from "../shared/execution-capacity-profiles.js";
import type { ExecutionStorageOverview } from "../shared/execution-storage.js";
import {
  isVolumeMigrationReview,
  validVolumeMigrationConfirmation,
  validVolumeMigrationReview,
  type VolumeMigrationConfirmation,
  type VolumeMigrationReview,
} from "../shared/volume-migration.js";
import {
  durablePublicationFile,
  syncPublicationDirectory,
} from "./isolated-publication-journal.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { inspectProjectSourceBudget } from "./isolated-project-files.js";
import {
  checkVolumeMigrationSpaceHeadroom,
  createVolumeMigrationSpaceTerminalProof,
  inspectRecoveryCapacity,
  inspectVolumeMigrationHeadroom,
  inspectVolumeMigrationSpaces,
  planRecoverySpace,
  reconnectVolumeMigrationSpace,
  reserveVolumeMigrationSpace,
  type LocalImageRecoveryAnchor,
  type VolumeMigrationSpaceOwner,
} from "./recovery-space.js";

const MiB = 1024 * 1024;
const defaultProfileId = "capacity-128-v2" as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hex32 = /^[a-f0-9]{32}$/;
const hash = /^[a-f0-9]{64}$/;
const activeCoordinators = new Set<string>();
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function fail(reason: string): never {
  throw new Error(
    `Volume migration: ${reason}; preserve the original plan and volume for inspection`,
  );
}

export interface MigrationProject {
  id: string;
  workspacePath: string;
}
export interface CapacityMigrationRawPlan {
  version: 1;
  planId: string;
  namespace: "manual" | "test";
  projectId: string;
  sourceProfileId: RuntimeCapacityProfileId;
  kind: "create" | "enlarge";
  status: "ready" | "blocked";
  expiresAt: number;
  source: {
    absent: boolean;
    generation: number;
    imageId: string | null;
    imageSha256: string | null;
    sourceSnapshotId: string | null;
    sourceManifestVersion: 1 | null;
    sourceBaseManifestId: string | null;
    volumeBytes: number;
  };
  target: {
    sourceProfileId: RuntimeCapacityProfileId;
    volumeId: string;
    limits: ReturnType<typeof getRuntimeCapacityProfile>;
    targetBaseManifestId: string;
  };
  budget: {
    logicalBeforeBytes: number;
    logicalAfterBytes: number;
    residentBefore: number;
    residentDuring: number;
    availableBytes: number | null;
    availableInodes: number | null;
    requiredGrowthBytes: number;
    reserveBytes: number;
  };
  blockers: string[];
}
export interface CapacityMigrationScope {
  namespace: "manual" | "test";
  projectId: string;
  planId: string;
}
export interface CapacityMigrationBackend {
  planCapacityMigration(
    project: MigrationProject,
    request: CapacityMigrationScope & ({ capacityProfileVersion: 2; sourceProfileId: "capacity-128-v2" } | { capacityProfileVersion: 3; sourceProfileId: "capacity-128-media64-v3" }),
    signal?: AbortSignal,
  ): Promise<unknown>;
  inspectCapacityPlan(
    project: MigrationProject,
    request: CapacityMigrationScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  registerCapacityAuthorization(
    project: MigrationProject,
    request: CapacityMigrationScope & {
      authorizationId: string;
      source: CapacityMigrationRawPlan["source"];
      target: CapacityMigrationRawPlan["target"];
      recoveryReservationBytes: 1073741824;
      expiresAt: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  executeCapacityPlan(
    project: MigrationProject,
    request: CapacityMigrationScope & { authorizationId: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  storageOverview?(projects: readonly { id: string; name: string }[]): Promise<ExecutionStorageOverview>;
  supportsCapacityProfile?(profileId: RuntimeCapacityProfileId, signal?: AbortSignal): Promise<boolean>;
}
export type AskVolumeMigration = (
  review: VolumeMigrationReview,
  signal?: AbortSignal,
) => Promise<{
  decision: "allow" | "allow-session" | "deny";
  volumeMigrationConfirmation?: VolumeMigrationConfirmation;
}>;
export interface VolumeMigrationCoordinatorOptions {
  namespace: "manual" | "test";
  backend: CapacityMigrationBackend;
  localImageAnchor(
    project: MigrationProject,
  ): Promise<LocalImageRecoveryAnchor>;
  /** Trusted host-verified backing device of the existing VM disk, never a model-supplied path. */
  backingDevice(project: MigrationProject): Promise<number>;
}
type Phase =
  | "planning"
  | "awaiting-approval"
  | "declined"
  | "approved"
  | "reserved"
  | "registering"
  | "authorized"
  | "executing"
  | "committed";
interface Receipt {
  version: 1;
  namespace: "manual" | "test";
  projectId: string;
  planId: string;
  phase: Phase;
  authorizationId: string | null;
  reservationId: string | null;
  plan: CapacityMigrationRawPlan | null;
  review: VolumeMigrationReview | null;
  targetProfileId?: "capacity-128-media64-v3";
}

function parsePlan(
  value: unknown,
  scope: CapacityMigrationScope,
): CapacityMigrationRawPlan {
  if (
    !exact(value, [
      "version",
      "planId",
      "namespace",
      "projectId",
      "sourceProfileId",
      "kind",
      "status",
      "expiresAt",
      "source",
      "target",
      "budget",
      "blockers",
    ]) ||
    value.version !== 1 ||
    value.planId !== scope.planId ||
    value.namespace !== scope.namespace ||
    value.projectId !== scope.projectId ||
    !["capacity-128-v2", "capacity-128-media64-v3"].includes(String(value.sourceProfileId)) ||
    !["create", "enlarge"].includes(String(value.kind)) ||
    !["ready", "blocked"].includes(String(value.status)) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > 64 ||
    value.blockers.some(
      (v) => typeof v !== "string" || !/^[A-Z0-9_]{1,64}$/.test(v),
    )
  )
    return fail("invalid immutable guest plan");
  const profileId = value.sourceProfileId as RuntimeCapacityProfileId;
  const source = value.source,
    target = value.target,
    budget = value.budget;
  if (
    !exact(source, [
      "absent",
      "generation",
      "imageId",
      "imageSha256",
      "sourceSnapshotId",
      "sourceManifestVersion",
      "sourceBaseManifestId",
      "volumeBytes",
    ]) ||
    typeof source.absent !== "boolean" ||
    !integer(source.generation) ||
    !integer(source.volumeBytes)
  )
    return fail("invalid original volume identity");
  if (source.absent) {
    if (
      value.kind !== "create" ||
      source.generation !== 0 ||
      source.volumeBytes !== 0 ||
      source.imageId !== null ||
      source.imageSha256 !== null ||
      source.sourceSnapshotId !== null ||
      source.sourceManifestVersion !== null ||
      source.sourceBaseManifestId !== null
    )
      return fail("invalid unallocated original");
  } else if (
    value.kind !== "enlarge" ||
    source.generation < 1 ||
    source.volumeBytes !== 256 * MiB ||
    typeof source.imageId !== "string" ||
    !(
      source.imageId === "legacy" ||
      hex32.test(source.imageId) ||
      uuid.test(source.imageId)
    ) ||
    typeof source.imageSha256 !== "string" ||
    !hash.test(source.imageSha256) ||
    typeof source.sourceSnapshotId !== "string" ||
    !hash.test(source.sourceSnapshotId) ||
    !(
      (source.sourceManifestVersion === null &&
        source.sourceBaseManifestId === null) ||
      (source.sourceManifestVersion === 1 &&
        typeof source.sourceBaseManifestId === "string" &&
        hash.test(source.sourceBaseManifestId))
    )
  )
    return fail("invalid original volume identity");
  if (
    !exact(target, [
      "sourceProfileId",
      "volumeId",
      "limits",
      "targetBaseManifestId",
    ]) ||
    target.sourceProfileId !== profileId ||
    typeof target.volumeId !== "string" ||
    !hex32.test(target.volumeId) ||
    typeof target.targetBaseManifestId !== "string" ||
    !hash.test(target.targetBaseManifestId) ||
    !isDeepStrictEqual(target.limits, getRuntimeCapacityProfile(profileId))
  )
    return fail("invalid target profile or identity");
  if (
    !exact(budget, [
      "logicalBeforeBytes",
      "logicalAfterBytes",
      "residentBefore",
      "residentDuring",
      "availableBytes",
      "availableInodes",
      "requiredGrowthBytes",
      "reserveBytes",
    ]) ||
    ![
      budget.logicalBeforeBytes,
      budget.logicalAfterBytes,
      budget.residentBefore,
      budget.residentDuring,
      budget.requiredGrowthBytes,
      budget.reserveBytes,
    ].every(integer) ||
    !(budget.availableBytes === null || integer(budget.availableBytes)) ||
    !(budget.availableInodes === null || integer(budget.availableInodes)) ||
    budget.logicalAfterBytes !==
      Number(budget.logicalBeforeBytes) + 512 * MiB ||
    budget.residentDuring !== Number(budget.residentBefore) + 1 ||
    Number(budget.requiredGrowthBytes) < 512 * MiB ||
    budget.reserveBytes !== 1024 * MiB
  )
    return fail("invalid guest capacity budget");
  return structuredClone(value) as unknown as CapacityMigrationRawPlan;
}
function owner(scope: CapacityMigrationScope, profileId: RuntimeCapacityProfileId): VolumeMigrationSpaceOwner {
  return {
    namespace: scope.namespace,
    projectId: scope.projectId,
    profileId,
    planId: scope.planId,
    purpose: "migration",
  };
}
function resultMatches(
  value: unknown,
  plan: CapacityMigrationRawPlan,
  auth: string,
): boolean {
  return (
    exact(value, [
      "migrated",
      "planId",
      "authorizationId",
      "kind",
      "namespace",
      "projectId",
      "generation",
      "volumeId",
      "volumeBytes",
      "sourceProfileId",
      "sourceManifestVersion",
      "sourceBaseManifestId",
      "originalRetained",
    ]) &&
    value.migrated === true &&
    value.planId === plan.planId &&
    value.authorizationId === auth &&
    value.kind === plan.kind &&
    value.namespace === plan.namespace &&
    value.projectId === plan.projectId &&
    value.generation ===
      (plan.source.absent ? 1 : plan.source.generation + 1) &&
    value.volumeId === plan.target.volumeId &&
    value.volumeBytes === plan.target.limits.volumeBytes &&
    value.sourceProfileId === plan.sourceProfileId &&
    value.sourceManifestVersion === 2 &&
    value.sourceBaseManifestId === plan.target.targetBaseManifestId &&
    value.originalRetained === !plan.source.absent
  );
}
function inspectPlan(
  value: unknown,
  scope: CapacityMigrationScope,
  expected?: CapacityMigrationRawPlan,
): {
  plan: CapacityMigrationRawPlan;
  phase: string;
  authorizationId?: string;
  expired: boolean;
  verified: boolean;
  result?: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid plan inspection");
  const raw = { ...(value as Record<string, unknown>) },
    phase = raw.phase,
    expired = raw.expired,
    verified = raw.verified,
    authorizationId = raw.authorizationId,
    result = raw.result;
  delete raw.phase;
  delete raw.expired;
  delete raw.verified;
  delete raw.authorizationId;
  delete raw.result;
  const plan = parsePlan(raw, scope);
  if (expected && !isDeepStrictEqual(plan, expected))
    return fail("the immutable plan changed");
  if (
    !["planned", "authorized", "started", "unknown", "committed"].includes(
      String(phase),
    ) ||
    typeof expired !== "boolean" ||
    typeof verified !== "boolean" ||
    (phase !== "committed" && verified) ||
    (phase === "planned"
      ? authorizationId !== undefined
      : typeof authorizationId !== "string" || !hex32.test(authorizationId)) ||
    (phase === "committed" ? result === undefined : result !== undefined)
  )
    return fail("invalid original plan phase");
  return {
    plan,
    phase: phase as string,
    expired,
    verified,
    ...(authorizationId === undefined
      ? {}
      : { authorizationId: authorizationId as string }),
    ...(result === undefined ? {} : { result }),
  };
}

async function receiptDirectory(
  project: MigrationProject,
  create: boolean,
): Promise<string> {
  if (!uuid.test(project.id) || typeof project.workspacePath !== "string")
    return fail("invalid trusted project identity");
  const workspace = await realpath(project.workspacePath),
    info = await lstat(workspace);
  if (!info.isDirectory() || info.isSymbolicLink())
    return fail("unsafe workspace anchor");
  const directory = path.join(
    path.dirname(workspace),
    "isolated-volume-migrations",
  );
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncPublicationDirectory(path.dirname(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const own = await lstat(directory);
  if (
    !own.isDirectory() ||
    own.isSymbolicLink() ||
    own.uid !== process.getuid?.() ||
    own.mode & 0o077 ||
    (await realpath(directory)) !== directory
  )
    return fail("unsafe private migration receipts");
  return directory;
}
function receiptFile(
  directory: string,
  namespace: "manual" | "test",
  project: MigrationProject,
): string {
  return path.join(directory, `${namespace}-${project.id}.json`);
}
function archiveFile(
  directory: string,
  namespace: "manual" | "test",
  project: MigrationProject,
  planId: string,
): string {
  return path.join(directory, `${namespace}-${project.id}.plan-${planId}.json`);
}

/** A successful hard link uniquely claims this exact old receipt. Never clean an uncertain link. */
async function archiveOriginalReceipt(
  directory: string,
  project: MigrationProject,
  receipt: Receipt,
  signal?: AbortSignal,
): Promise<void> {
  const current = receiptFile(directory, receipt.namespace, project),
    archive = archiveFile(
      directory,
      receipt.namespace,
      project,
      receipt.planId,
    );
  const prefix = `${receipt.namespace}-${project.id}.plan-`;
  const history = (await readdir(directory)).filter((name) =>
    name.startsWith(prefix),
  );
  if (history.length >= 64)
    return fail("capacity plan history is full; inspect retained plans");
  let historyBytes = 0;
  for (const name of history) {
    const info = await lstat(path.join(directory, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      return fail("capacity plan history requires inspection");
    historyBytes += info.size;
    if (historyBytes > 8 * MiB)
      return fail(
        "capacity plan history exceeds its limit; inspect retained plans",
      );
  }
  const currentInfo = await lstat(current, { bigint: true });
  if (
    !currentInfo.isFile() ||
    currentInfo.nlink !== 1n ||
    currentInfo.uid !== BigInt(process.getuid?.() ?? -1) ||
    (currentInfo.mode & 0o077n) !== 0n
  )
    return fail("the original plan receipt requires inspection");
  if (historyBytes + Number(currentInfo.size) > 8 * MiB)
    return fail(
      "capacity plan history exceeds its limit; inspect retained plans",
    );
  try {
    await link(current, archive);
  } catch {
    return fail(
      "the original plan archive is already claimed or unavailable; inspect the original plan",
    );
  }
  await syncPublicationDirectory(directory);
  signal?.throwIfAborted();
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    const existing = await lstat(archive, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 2n ||
      before.dev !== currentInfo.dev ||
      before.ino !== currentInfo.ino ||
      before.uid !== currentInfo.uid ||
      before.gid !== currentInfo.gid ||
      before.size !== currentInfo.size ||
      before.mtimeNs !== currentInfo.mtimeNs ||
      before.mode !== currentInfo.mode ||
      before.size > BigInt(2 * MiB) ||
      existing.dev !== before.dev ||
      existing.ino !== before.ino ||
      existing.nlink !== 2n
    )
      return fail(
        "the original plan archive changed; inspect the original plan",
      );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      if (!bytesRead) return fail("the original plan archive is incomplete");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      pathname = await lstat(current, { bigint: true }),
      archived = await lstat(archive, { bigint: true });
    if (
      !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), receipt) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.mode !== before.mode ||
      after.nlink !== 2n ||
      !pathname.isFile() ||
      pathname.dev !== after.dev ||
      pathname.ino !== after.ino ||
      pathname.size !== after.size ||
      pathname.mode !== after.mode ||
      pathname.mtimeNs !== after.mtimeNs ||
      pathname.ctimeNs !== after.ctimeNs ||
      pathname.nlink !== 2n ||
      !archived.isFile() ||
      archived.dev !== after.dev ||
      archived.ino !== after.ino ||
      archived.size !== after.size ||
      archived.mode !== after.mode ||
      archived.mtimeNs !== after.mtimeNs ||
      archived.ctimeNs !== after.ctimeNs ||
      archived.nlink !== 2n
    )
      return fail(
        "the original plan changed during archival; inspect the original plan",
      );
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
  await unlink(current);
  await syncPublicationDirectory(directory);
}

async function saveReceipt(directory: string, receipt: Receipt): Promise<void> {
  const tmp = path.join(directory, `.receipt-${randomUUID()}`),
    bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > 2 * MiB) return fail("receipt exceeds its metadata limit");
  await durablePublicationFile(tmp, bytes);
  await rename(
    tmp,
    receiptFile(directory, receipt.namespace, {
      id: receipt.projectId,
      workspacePath: "",
    }),
  );
  await syncPublicationDirectory(directory);
}
async function readReceipt(
  directory: string,
  namespace: "manual" | "test",
  project: MigrationProject,
): Promise<Receipt> {
  const filename = receiptFile(directory, namespace, project),
    info = await lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    return fail("unsafe migration receipt");
  const value: unknown = JSON.parse(
    (await readSafeProjectFile(directory, filename, 2 * MiB)).toString("utf8"),
  );
  if (
    !exact(value, [
      "version",
      "namespace",
      "projectId",
      "planId",
      "phase",
      "authorizationId",
      "reservationId",
      "plan",
      "review",
      ...(value && typeof value === "object" && Object.hasOwn(value, "targetProfileId") ? ["targetProfileId"] : []),
    ]) ||
    value.version !== 1 ||
    (Object.hasOwn(value, "targetProfileId") && value.targetProfileId !== "capacity-128-media64-v3") ||
    value.namespace !== namespace ||
    value.projectId !== project.id ||
    typeof value.planId !== "string" ||
    !uuid.test(value.planId) ||
    ![
      "planning",
      "awaiting-approval",
      "declined",
      "approved",
      "reserved",
      "registering",
      "authorized",
      "executing",
      "committed",
    ].includes(String(value.phase)) ||
    !(
      value.authorizationId === null ||
      (typeof value.authorizationId === "string" &&
        hex32.test(value.authorizationId))
    ) ||
    !(
      value.reservationId === null ||
      (typeof value.reservationId === "string" &&
        uuid.test(value.reservationId))
    )
  )
    return fail("invalid migration receipt");
  const scope = { namespace, projectId: project.id, planId: value.planId };
  if ((value.plan === null) !== (value.review === null))
    return fail("incomplete immutable approval receipt");
  if (value.plan !== null) {
    const plan = parsePlan(value.plan, scope),
      review = value.review;
    if (
      !isVolumeMigrationReview(review) ||
      review.planId !== plan.planId ||
      review.projectId !== plan.projectId ||
      review.generation !== plan.source.generation ||
      review.source.imageId !== plan.source.imageId ||
      review.source.imageSha256 !== plan.source.imageSha256 ||
      review.source.volumeBytes !== plan.source.volumeBytes ||
      review.target.profileId !== plan.sourceProfileId ||
      plan.sourceProfileId !== (value.targetProfileId ?? defaultProfileId) ||
      review.expiresAt !== new Date(plan.expiresAt * 1000).toISOString()
    )
      return fail("approval receipt does not bind its exact plan");
  }
  if (
    (value.phase !== "planning" && value.plan === null) ||
    ([
      "approved",
      "reserved",
      "registering",
      "authorized",
      "executing",
      "committed",
    ].includes(String(value.phase)) &&
      value.authorizationId === null) ||
    (["reserved", "registering", "authorized", "executing"].includes(
      String(value.phase),
    ) &&
      value.reservationId === null)
  )
    return fail("incomplete migration phase binding");
  return value as unknown as Receipt;
}

export class VolumeMigrationCoordinator {
  constructor(private readonly options: VolumeMigrationCoordinatorOptions) {
    if (!["manual", "test"].includes(options.namespace))
      fail("invalid native namespace");
  }
  private async review(
    project: MigrationProject,
    plan: CapacityMigrationRawPlan,
    signal?: AbortSignal,
  ): Promise<VolumeMigrationReview> {
    signal?.throwIfAborted();
    const profileId = plan.sourceProfileId;
    const limits = getRuntimeCapacityProfile(profileId),
      blockers = [...plan.blockers];
    let unknown = false;
    const raw = planRecoverySpace({
      profileId,
      rawBytes: 72 * MiB,
      workingBytes: 64 * MiB,
      beforeBytes: 136 * MiB,
      afterBytes: 72 * MiB,
      manifestBytes: 2 * MiB,
      reviewBytes: 8 * MiB,
    });
    let recoveryUsed: number | null = null,
      hostRequired: number | null = null,
      hostAvailable: number | null = null,
      inodeRequired: number | null = null,
      inodeAvailable: number | null = null;
    try {
      const anchor = await this.options.localImageAnchor(project);
      if (
        anchor.projectId !== project.id ||
        (await realpath(anchor.workspace)) !==
          (await realpath(project.workspacePath))
      )
        throw new Error("local anchor mismatch");
      const recovery = await inspectRecoveryCapacity(
        project.workspacePath,
        anchor,
        signal,
        profileId,
      );
      const headroom = await inspectVolumeMigrationHeadroom(
        project.workspacePath,
        signal,
      );
      const backing = await this.options.backingDevice(project);
      const device = (await lstat(await realpath(project.workspacePath))).dev;
      if (backing !== device || !Number.isSafeInteger(backing))
        throw new Error("volume backing device is not established");
      if (
        recovery.status !== "complete" ||
        recovery.localImageStorage !== "included" ||
        recovery.promises.ledger !== "known" ||
        recovery.quota.usedBytes === null ||
        recovery.promises.own.logicalBytes === null ||
        headroom.status !== "complete" ||
        headroom.availableBytes === null ||
        headroom.availableInodes === null ||
        headroom.physicalOutstandingBytes === null ||
        headroom.inodeOutstanding === null ||
        headroom.allocationUnitBytes === null ||
        headroom.floorBytes === null
      )
        throw new Error("capacity is unknown");
      recoveryUsed =
        recovery.quota.usedBytes + recovery.promises.own.logicalBytes;
      const priced = planRecoverySpace({
        profileId,
        rawBytes: 72 * MiB,
        workingBytes: 64 * MiB,
        beforeBytes: 136 * MiB,
        afterBytes: 72 * MiB,
        manifestBytes: 2 * MiB,
        reviewBytes: 8 * MiB,
        allocationUnitBytes: headroom.allocationUnitBytes,
      });
      hostRequired =
        plan.budget.requiredGrowthBytes +
        priced.diskBytes +
        3 * headroom.allocationUnitBytes;
      if (!Number.isSafeInteger(hostRequired))
        throw new Error("physical requirement is out of range");
      hostAvailable = Math.max(
        0,
        headroom.availableBytes -
          headroom.physicalOutstandingBytes -
          headroom.floorBytes,
      );
      inodeRequired = priced.additionalEntries + 2 + 8;
      const hostInodes = Math.max(
        0,
        headroom.availableInodes - headroom.inodeOutstanding,
      );
      inodeAvailable =
        plan.budget.availableInodes === null
          ? null
          : Math.min(
              hostInodes,
              plan.budget.availableInodes + priced.additionalEntries + 2,
            );
      if (inodeAvailable === null) unknown = true;
      const inventory = await inspectProjectSourceBudget(
        project.workspacePath,
        [],
        true,
        signal,
        { profile: profileId },
      );
      if (!inventory.complete) unknown = true;
      else if (Object.values(inventory.overage).some((value) => value > 0))
        blockers.push("Project source exceeds the selected profile limits.");
    } catch (error) {
      signal?.throwIfAborted();
      unknown = true;
    }
    const guestRequired =
      plan.budget.requiredGrowthBytes + plan.budget.reserveBytes + 16 * MiB;
    if (
      !Number.isSafeInteger(guestRequired) ||
      plan.budget.availableBytes === null ||
      plan.budget.availableInodes === null
    )
      unknown = true;
    if (plan.status !== "ready")
      blockers.push("The guest capacity plan is blocked.");
    if (
      plan.budget.logicalAfterBytes > limits.globalVolumeBytes ||
      plan.budget.residentDuring > limits.residentVolumes ||
      (plan.budget.availableBytes !== null &&
        guestRequired > plan.budget.availableBytes) ||
      (plan.budget.availableInodes !== null &&
        plan.budget.availableInodes < 8) ||
      (hostRequired !== null &&
        hostAvailable !== null &&
        hostRequired > hostAvailable) ||
      (inodeRequired !== null &&
        inodeAvailable !== null &&
        inodeRequired > inodeAvailable) ||
      (recoveryUsed !== null &&
        recoveryUsed + raw.requiredBytes > limits.recoveryBytes)
    )
      blockers.push("Current capacity is insufficient for the full plan.");
    const review: VolumeMigrationReview = {
      version: 1,
      planId: plan.planId,
      projectId: plan.projectId,
      generation: plan.source.generation,
      source: {
        profileId: plan.source.absent ? "unallocated" : "current-64",
        volumeBytes: plan.source.volumeBytes,
        ...(plan.source.absent ? {} : { recoveryBytes: 512 * MiB }),
        imageId: plan.source.imageId,
        imageSha256: plan.source.imageSha256,
      },
      target: {
        profileId,
        volumeBytes: limits.volumeBytes,
        mediaBytes: limits.mediaBytes,
        recoveryBytes: limits.recoveryBytes,
        ...(profileId === "capacity-128-media64-v3" ? { mediaFileBytes: 32 * MiB, largeMediaFileBytes: 64 * MiB, mediaWindowBytes: 64 * MiB, largeMediaFilePolicy: "video-audio-glb-v1" as const } : {}),
      },
      resources: {
        globalBeforeBytes: plan.budget.logicalBeforeBytes,
        globalDuringBytes: plan.budget.logicalAfterBytes,
        guestRequiredBytes: Number.isSafeInteger(guestRequired)
          ? guestRequired
          : null,
        guestAvailableBytes: plan.budget.availableBytes,
        hostRequiredBytes: hostRequired,
        hostAvailableBytes: hostAvailable,
        requiredInodes: inodeRequired,
        availableInodes: inodeAvailable,
        recoveryUsedBytes: recoveryUsed,
        recoveryRequiredBytes: raw.requiredBytes,
      },
      oldVolumeRetention: "retained-no-auto-delete",
      supportsResume: false,
      supportsRollback: false,
      status: blockers.length ? "blocked" : unknown ? "unknown" : "ready",
      blockers,
      expiresAt: new Date(plan.expiresAt * 1000).toISOString(),
    };
    if (!isVolumeMigrationReview(review)) return fail("invalid native review");
    return review;
  }

  async requestUpgrade(
    project: MigrationProject,
    askApproval: AskVolumeMigration,
    signal?: AbortSignal,
    targetProfileId: RuntimeCapacityProfileId = defaultProfileId,
  ): Promise<{
    status: "blocked" | "declined" | "committed";
    review: VolumeMigrationReview;
  }> {
    return this.exclusive(project, () =>
      this.requestOriginal(project, askApproval, signal, targetProfileId),
    );
  }

  private async exclusive<T>(
    project: MigrationProject,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${this.options.namespace}:${project.id}`;
    if (activeCoordinators.has(key))
      return fail("the native migration operation is already in progress");
    activeCoordinators.add(key);
    try {
      return await operation();
    } finally {
      activeCoordinators.delete(key);
    }
  }

  private async requestOriginal(
    project: MigrationProject,
    askApproval: AskVolumeMigration,
    signal?: AbortSignal,
    targetProfileId: RuntimeCapacityProfileId = defaultProfileId,
  ): Promise<{
    status: "blocked" | "declined" | "committed";
    review: VolumeMigrationReview;
  }> {
    signal?.throwIfAborted();
    if (typeof askApproval !== "function")
      return fail("native approval callback is unavailable");
    if (!["capacity-128-v2", "capacity-128-media64-v3"].includes(targetProfileId))
      return fail("the requested target profile is unavailable");
    if (this.options.backend.storageOverview) {
      let overview: ExecutionStorageOverview | undefined;
      try { overview = await this.options.backend.storageOverview([{ id: project.id, name: "" }]); }
      catch { signal?.throwIfAborted(); if (targetProfileId === "capacity-128-media64-v3") return fail("fresh storage status is unavailable; inspect the original volume before requesting this profile"); }
      signal?.throwIfAborted();
      const snapshot = overview?.dataStatus === "current" && overview.snapshot?.capacityOverviewVersion === 1 && overview.snapshot.countsTrusted ? overview.snapshot : undefined;
      if (!snapshot && targetProfileId === "capacity-128-media64-v3") return fail("fresh storage status is unknown; inspect the original volume before requesting this profile");
      const existing = snapshot?.projects.find((item) => item.namespace === this.options.namespace && item.projectId === project.id);
      if (existing && (existing.volumeProfileVersion === 2 || existing.volumeProfileVersion === 3))
        return fail("changing an existing 512 MiB volume to another profile is not supported");
      if (targetProfileId === "capacity-128-media64-v3" && (!snapshot || !Array.isArray(snapshot.capacityReservations) || snapshot.capacityReservations.length || (existing ? existing.volumeProfileVersion !== 0 || existing.volumeBytes !== 256 * MiB || existing.sourceProfileId !== null : !overview?.unallocatedProjects?.some((item) => item.projectId === project.id))))
        return fail("the original volume identity is unknown; inspect it before requesting this profile");
    } else if (targetProfileId === "capacity-128-media64-v3") return fail("fresh storage status is unavailable; inspect the original volume before requesting this profile");
    if (targetProfileId === "capacity-128-media64-v3") {
      if (!this.options.backend.supportsCapacityProfile) return fail("the requested target capability is unavailable; no plan was created");
      let supported: boolean;
      try { supported = await this.options.backend.supportsCapacityProfile(targetProfileId, signal); }
      catch { signal?.throwIfAborted(); return fail("the requested target capability is unknown; no plan was created"); }
      signal?.throwIfAborted();
      if (supported !== true) return fail("the requested target capability is unavailable; no plan was created");
    }
    const directory = await receiptDirectory(project, true);
    const current = receiptFile(directory, this.options.namespace, project);
    let existing: Receipt | undefined;
    let currentExists = false;
    try {
      await lstat(current);
      currentExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return fail(
          "the existing original plan receipt requires inspection before another request",
        );
    }
    if (currentExists) {
      try {
        existing = await readReceipt(
          directory,
          this.options.namespace,
          project,
        );
      } catch {
        return fail(
          "the existing original plan receipt requires inspection before another request",
        );
      }
    } else {
      const prefix = `${this.options.namespace}-${project.id}.plan-`;
      try {
        if ((await readdir(directory)).some((name) => name.startsWith(prefix)))
          return fail(
            "the original plan archive exists but its current receipt is missing; inspect the original plan",
          );
      } catch {
        return fail(
          "the original plan history requires inspection before another request",
        );
      }
    }
    if (existing) {
      const knownDeclined = existing.phase === "declined";
      const knownBlocked =
        existing.phase === "awaiting-approval" &&
        existing.review?.status === "blocked" &&
        Object.values(existing.review.resources).every(
          (value) =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0,
        );
      if (
        (!knownDeclined && !knownBlocked) ||
        !existing.plan ||
        !existing.review ||
        existing.authorizationId !== null ||
        existing.reservationId !== null
      )
        return fail(
          `original plan ${existing.planId} must be inspected before another request`,
        );
      const originalScope: CapacityMigrationScope = {
        namespace: existing.namespace,
        projectId: existing.projectId,
        planId: existing.planId,
      };
      const inspected = inspectPlan(
        await this.options.backend.inspectCapacityPlan(
          project,
          originalScope,
          signal,
        ),
        originalScope,
        existing.plan,
      );
      if (
        inspected.phase !== "planned" ||
        inspected.authorizationId !== undefined
      )
        return fail(
          `original plan ${existing.planId} may have been authorized or started; inspect it`,
        );
      const spaces = await inspectVolumeMigrationSpaces(project.workspacePath);
      if (
        spaces.state !== "known" ||
        !spaces.reservations ||
        spaces.reservations.length
      )
        return fail(
          `original plan ${existing.planId} has an unresolved physical promise; inspect it`,
        );
      if (
        !isDeepStrictEqual(
          await readReceipt(directory, this.options.namespace, project),
          existing,
        )
      )
        return fail("the original plan changed before archival; inspect it");
      try {
        await archiveOriginalReceipt(directory, project, existing, signal);
      } catch {
        signal?.throwIfAborted();
        return fail(
          `original plan ${existing.planId} could not be safely archived; inspect it`,
        );
      }
    }
    signal?.throwIfAborted();
    const planId = randomUUID();
    const scope: CapacityMigrationScope = {
      namespace: this.options.namespace,
      projectId: project.id,
      planId,
    };
    const receipt: Receipt = {
      version: 1,
      ...scope,
      phase: "planning",
      authorizationId: null,
      reservationId: null,
      plan: null,
      review: null,
      ...(targetProfileId === "capacity-128-media64-v3" ? { targetProfileId } : {}),
    };
    // The plan ID is durable before the guest receives it. A lost response is inspect-only.
    try {
      await durablePublicationFile(
        current,
        Buffer.from(JSON.stringify(receipt)),
      );
    } catch {
      return fail(
        "the original capacity plan receipt is unavailable; inspect the original plan before another request",
      );
    }
    const raw = await this.options.backend.planCapacityMigration(
      project,
      targetProfileId === "capacity-128-media64-v3" ? { ...scope, capacityProfileVersion: 3, sourceProfileId: targetProfileId } : { ...scope, capacityProfileVersion: 2, sourceProfileId: defaultProfileId },
      signal,
    );
    signal?.throwIfAborted();
    const plan = parsePlan(raw, scope);
    if (plan.sourceProfileId !== targetProfileId) return fail("the native plan does not match the requested target profile");
    const
      review = await this.review(project, plan, signal);
    receipt.plan = plan;
    receipt.review = review;
    receipt.phase = "awaiting-approval";
    await saveReceipt(directory, receipt);
    if (!validVolumeMigrationReview(review))
      return { status: "blocked", review };
    const answer = await askApproval(structuredClone(review), signal);
    signal?.throwIfAborted();
    if (
      answer?.decision !== "allow" ||
      !validVolumeMigrationConfirmation(
        review,
        answer.volumeMigrationConfirmation,
      )
    ) {
      receipt.phase = "declined";
      await saveReceipt(directory, receipt);
      return { status: "declined", review };
    }
    const inspected = inspectPlan(
      await this.options.backend.inspectCapacityPlan(project, scope, signal),
      scope,
      plan,
    );
    if (inspected.phase !== "planned" || inspected.expired)
      return fail("the approved plan is no longer available");
    const fresh = await this.review(project, plan, signal);
    if (!validVolumeMigrationReview(fresh))
      return fail("capacity changed after the native review");
    const authorizationId = randomBytes(16).toString("hex");
    receipt.authorizationId = authorizationId;
    receipt.phase = "approved";
    await saveReceipt(directory, receipt);
    const headroom = await inspectVolumeMigrationHeadroom(
      project.workspacePath,
      signal,
    );
    if (headroom.status !== "complete" || headroom.allocationUnitBytes === null)
      return fail("physical capacity became unknown");
    const priced = planRecoverySpace({
      profileId: plan.sourceProfileId,
      rawBytes: 72 * MiB,
      workingBytes: 64 * MiB,
      beforeBytes: 136 * MiB,
      afterBytes: 72 * MiB,
      manifestBytes: 2 * MiB,
      reviewBytes: 8 * MiB,
      allocationUnitBytes: headroom.allocationUnitBytes,
    });
    const backingDevice = await this.options.backingDevice(project);
    const reservation = await reserveVolumeMigrationSpace(
      project.workspacePath,
      {
        physicalBytes: plan.budget.requiredGrowthBytes + priced.diskBytes,
        hostInodes: priced.additionalEntries + 2 + 8,
        backingDevice,
      },
      owner(scope, plan.sourceProfileId),
      signal,
    );
    receipt.reservationId = reservation.id;
    receipt.phase = "reserved";
    await saveReceipt(directory, receipt);
    await checkVolumeMigrationSpaceHeadroom(reservation);
    if ((await this.options.backingDevice(project)) !== backingDevice)
      return fail("volume backing device changed");
    signal?.throwIfAborted();
    receipt.phase = "registering";
    await saveReceipt(directory, receipt);
    const registered = await this.options.backend.registerCapacityAuthorization(
      project,
      {
        ...scope,
        authorizationId,
        source: plan.source,
        target: plan.target,
        recoveryReservationBytes: 1073741824,
        expiresAt: plan.expiresAt,
      },
      signal,
    );
    if (
      !exact(registered, ["registered", "planId", "authorizationId"]) ||
      registered.registered !== true ||
      registered.planId !== plan.planId ||
      registered.authorizationId !== authorizationId
    )
      return fail("authorization registration was not confirmed");
    receipt.phase = "authorized";
    await saveReceipt(directory, receipt);
    await checkVolumeMigrationSpaceHeadroom(reservation);
    if ((await this.options.backingDevice(project)) !== backingDevice)
      return fail("volume backing device changed");
    signal?.throwIfAborted();
    receipt.phase = "executing";
    await saveReceipt(directory, receipt);
    const result = await this.options.backend.executeCapacityPlan(
      project,
      { ...scope, authorizationId },
      signal,
    );
    if (!resultMatches(result, plan, authorizationId))
      return fail("migration result was not confirmed");
    const verified = inspectPlan(
      await this.options.backend.inspectCapacityPlan(project, scope, signal),
      scope,
      plan,
    );
    if (
      verified.phase !== "committed" ||
      !verified.verified ||
      verified.authorizationId !== authorizationId ||
      !resultMatches(verified.result, plan, authorizationId)
    )
      return fail("fresh exact migration completion was not confirmed");
    receipt.phase = "committed";
    await saveReceipt(directory, receipt);
    await reservation.release(
      createVolumeMigrationSpaceTerminalProof(reservation, "committed"),
    );
    receipt.reservationId = null;
    await saveReceipt(directory, receipt);
    return { status: "committed", review };
  }

  /** Inspection may reconcile an exact terminal receipt; it never submits registration or execution. */
  async inspectUpgrade(
    project: MigrationProject,
    signal?: AbortSignal,
  ): Promise<{
    phase: string;
    planId: string;
    review: VolumeMigrationReview | null;
    guestPhase: string;
    committed: boolean;
  }> {
    return this.exclusive(project, () => this.inspectOriginal(project, signal));
  }

  private async inspectOriginal(
    project: MigrationProject,
    signal?: AbortSignal,
  ): Promise<{
    phase: string;
    planId: string;
    review: VolumeMigrationReview | null;
    guestPhase: string;
    committed: boolean;
  }> {
    signal?.throwIfAborted();
    const directory = await receiptDirectory(project, false),
      receipt = await readReceipt(directory, this.options.namespace, project);
    const scope: CapacityMigrationScope = {
      namespace: receipt.namespace,
      projectId: receipt.projectId,
      planId: receipt.planId,
    };
    const inspected = inspectPlan(
      await this.options.backend.inspectCapacityPlan(project, scope, signal),
      scope,
      receipt.plan ?? undefined,
    );
    if (inspected.plan.sourceProfileId !== (receipt.targetProfileId ?? defaultProfileId)) return fail("the original plan does not match its recorded target profile");
    if (
      receipt.authorizationId &&
      inspected.authorizationId !== undefined &&
      inspected.authorizationId !== receipt.authorizationId
    )
      return fail("the inspected authorization differs from the original");
    const committed =
      !!receipt.plan &&
      !!receipt.authorizationId &&
      inspected.phase === "committed" &&
      inspected.verified &&
      inspected.authorizationId === receipt.authorizationId &&
      resultMatches(inspected.result, receipt.plan, receipt.authorizationId);
    if (inspected.phase === "committed" && !committed)
      return fail("the guest completion does not match the native approval");
    if (committed) {
      const reservation = await reconnectVolumeMigrationSpace(
        project.workspacePath,
        owner(scope, receipt.plan!.sourceProfileId),
        await this.options.backingDevice(project),
      );
      if (reservation && receipt.reservationId !== reservation.id)
        return fail("the physical promise differs from the original receipt");
      if (!reservation && receipt.phase !== "committed")
        return fail("the original physical promise is missing");
      receipt.phase = "committed";
      await saveReceipt(directory, receipt);
      if (reservation)
        await reservation.release(
          createVolumeMigrationSpaceTerminalProof(reservation, "committed"),
        );
      receipt.reservationId = null;
      await saveReceipt(directory, receipt);
    }
    return {
      phase: receipt.phase,
      planId: receipt.planId,
      review: receipt.review,
      guestPhase: inspected.phase,
      committed,
    };
  }
}
