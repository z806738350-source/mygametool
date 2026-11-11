import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import type { SourceContract } from "./isolated-source-manifest.js";
import {
  getRuntimeCapacityProfile,
  RUNTIME_CAPACITY_PROFILES,
  type RuntimeCapacityProfileId,
} from "../shared/execution-capacity-profiles.js";
import {
  inspectSafeProjectMedia,
  readSafeProjectFile,
} from "./safe-project-file.js";

export const LEGACY_RECOVERY_LIMIT_BYTES = 32 * 1024 * 1024;
export const RECOVERY_LIMIT_BYTES = 512 * 1024 * 1024;
export const RECOVERY_ENTRY_ALLOWANCE_BYTES = 32 * 1024 * 1024;
export const RECOVERY_DISK_FLOOR_BYTES = 1024 * 1024 * 1024;
export const RECOVERY_ENTRY_LIMIT = 32768;
const MiB = 1024 * 1024;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface RecoverySpaceInputs {
  profileId?: RuntimeCapacityProfileId;
  /** Trusted host stat of the VM backing device; required by live plan-2 admission. */
  backingDevice?: number;
  rawBytes: number;
  workingBytes: number;
  beforeBytes: number;
  afterBytes: number;
  manifestBytes: number;
  reviewBytes?: number;
  additionalEntries?: number;
  allocationUnitBytes?: number;
  existingArtifacts?: readonly {
    kind: "raw" | "working";
    sha256: string;
    size: number;
  }[];
}
export interface RecoverySpacePlan {
  version: 1 | 2;
  profileId?: RuntimeCapacityProfileId;
  guestVolumeGrowthBytes?: number;
  limitBytes: number;
  rawBytes: number;
  workingBytes: number;
  existingRawBytes: number;
  existingWorkingBytes: number;
  beforeBytes: number;
  afterBytes: number;
  manifestBytes: number;
  reviewBytes: number;
  additionalEntries: number;
  entryLimit: typeof RECOVERY_ENTRY_LIMIT;
  entryAllowanceBytes: typeof RECOVERY_ENTRY_ALLOWANCE_BYTES;
  allocationUnitBytes: number;
  entryAllocationBytes: number;
  requiredBytes: number;
  diskBytes: number;
}
export interface SourceReservationIdentity {
  sourceManifestVersion?: 1 | 2;
  sourceProfileId?: RuntimeCapacityProfileId;
  sourceBaseManifestId?: string;
  sourceResultManifestId?: string;
}
export interface RecoverySpaceOwner extends SourceReservationIdentity {
  ownerKey: string;
  namespace: "manual" | "test" | "local-image";
  projectId: string;
  generation?: number;
  rawSnapshotId?: string;
}
export interface RecoverySpaceReservation {
  readonly id: string;
  readonly plan: Readonly<RecoverySpacePlan>;
  bind(
    binding: {
      generation?: number;
      rawSnapshotId?: string;
    } & SourceReservationIdentity,
  ): Promise<void>;
  release(): Promise<void>;
}
interface Intent {
  version: 1 | 2 | 3;
  id: string;
  workspace: string;
  device: number;
  owner: RecoverySpaceOwner;
  plan: RecoverySpacePlan;
  kind?: "source" | "local-image";
  storage?: string;
}
interface RecordState {
  intent: Intent;
  file: string;
  token?: RecoverySpaceReservation;
  restored?: boolean;
  activeScopes?: number;
  retainedConnection?: {
    namespace: "manual" | "test";
    projectId: string;
    generation: number;
    rawSnapshotId: string;
  } & SourceReservationIdentity;
}
const records = new Map<string, RecordState>();
export interface VolumeMigrationSpaceOwner {
  namespace: "manual" | "test";
  projectId: string;
  profileId: RuntimeCapacityProfileId;
  planId: string;
  purpose: "migration" | "runtime";
}
export interface VolumeMigrationSpaceInputs {
  physicalBytes: number;
  hostInodes: number;
  backingDevice: number;
}
interface VolumeSpaceIntent {
  version: 1;
  kind: "volume-physical";
  id: string;
  workspace: string;
  device: number;
  owner: VolumeMigrationSpaceOwner;
  requestedBytes: number;
  physicalBytes: number;
  metadataBytes: number;
  hostInodes: number;
}
interface VolumeSpaceRecord {
  intent: VolumeSpaceIntent;
  file: string;
  token?: VolumeMigrationSpaceReservation;
}
export interface VolumeMigrationSpaceTerminalProof {
  readonly kind: "volume-space-terminal";
}
export interface VolumeMigrationSpaceReservation {
  readonly id: string;
  readonly physicalBytes: number;
  readonly hostInodes: number;
  release(proof: VolumeMigrationSpaceTerminalProof): Promise<void>;
}
const volumeRecords = new Map<string, VolumeSpaceRecord>();
interface DerivedMediaSpaceRecord {
  device: number;
  physicalBytes: number;
  hostInodes: number;
}
const derivedMediaRecords = new Set<DerivedMediaSpaceRecord>();
export interface DerivedMediaSpaceReservation {
  readonly physicalBytes: number;
  readonly hostInodes: number;
  /** Release only after allocation is complete, or all anonymous file descriptors have closed. */
  release(): Promise<void>;
}
export class DerivedMediaSpaceError extends Error {
  constructor(
    readonly reason:
      | "unconfirmed-reservation"
      | "unsafe-storage"
      | "physical-capacity"
      | "filesystem-unknown",
  ) {
    super("Secure media allocation requires " + reason);
  }
}
const volumeTokens = new WeakMap<object, VolumeSpaceRecord>();
const volumeTerminalProofs = new WeakMap<
  object,
  {
    record: VolumeSpaceRecord;
    terminal: "committed" | "revoked-not-started" | "released-host-settled";
  }
>();
export interface LocalImageRecoveryAnchor {
  workspace: string;
  storage: string;
  projectId: string;
}
const capacityRoots = [
  "isolated-changes",
  "isolated-review-artifacts",
  "isolated-source-transfers",
  "isolated-reviews",
  "isolated-space-reservations",
  "image-originals",
  "image-preparations",
  "image-transactions",
  "space-reservations",
] as const;
type CapacityRoot = (typeof capacityRoots)[number];
export interface CapacityUsage {
  logicalBytes: number | null;
  entries: number | null;
  transactions: number | null;
}
export interface CapacityPromises {
  count: number | null;
  logicalBytes: number | null;
  diskBytes: number | null;
  hostInodes: number | null;
}
export interface RecoveryCapacityInspection {
  version: 1;
  status: "complete" | "incomplete";
  localImageStorage: "included" | "not-supplied";
  quota: {
    scope: "shared-history-and-active";
    limitBytes: number;
    usedBytes: number | null;
    remainingBytes: number | null;
    entries: number | null;
    entryLimit: number;
    transactions: number | null;
    transactionLimit: 2000;
  };
  breakdown: Partial<
    Record<CapacityRoot, CapacityUsage & { status: "complete" | "incomplete" }>
  >;
  filesystem: {
    status: "complete" | "incomplete";
    availableBytes: number | null;
    allocationUnitBytes: number | null;
    availableInodes?: number | null;
    floorBytes: number;
  };
  promises: {
    ledger: "known" | "uncertain";
    coverage: "known-ledger-and-inspected-project";
    sameDevice: CapacityPromises;
    own: CapacityPromises;
  };
  issues: {
    code:
      | "unavailable"
      | "unsafe-storage"
      | "changed"
      | "entry-limit"
      | "invalid-intent"
      | "ledger-uncertain"
      | "invalid-number";
    scope:
      CapacityRoot | "workspace" | "local-anchor" | "filesystem" | "ledger";
  }[];
}
const localAnchors = new Map<string, LocalImageRecoveryAnchor>();
const branded = new WeakMap<object, RecordState>();
const inputRefusals = new WeakSet<object>();
const scope = new AsyncLocalStorage<RecoverySpaceReservation>();
let pending: Promise<unknown> = Promise.resolve();
let uncertainLedger = false;
function physicalOutstanding(
  device: number,
  excluding?: RecordState | VolumeSpaceRecord,
): bigint {
  return (
    [...records.values()]
      .filter(
        (record) => record !== excluding && record.intent.device === device,
      )
      .reduce((sum, record) => sum + BigInt(record.intent.plan.diskBytes), 0n) +
    [...volumeRecords.values()]
      .filter(
        (record) => record !== excluding && record.intent.device === device,
      )
      .reduce((sum, record) => sum + BigInt(record.intent.physicalBytes), 0n) +
    [...derivedMediaRecords]
      .filter((record) => record.device === device)
      .reduce((sum, record) => sum + BigInt(record.physicalBytes), 0n)
  );
}
function inodeOutstanding(
  device: number,
  excluding?: RecordState | VolumeSpaceRecord,
): bigint {
  return (
    [...records.values()]
      .filter(
        (record) => record !== excluding && record.intent.device === device,
      )
      .reduce(
        (sum, record) => sum + BigInt(record.intent.plan.additionalEntries + 2),
        0n,
      ) +
    [...volumeRecords.values()]
      .filter(
        (record) => record !== excluding && record.intent.device === device,
      )
      .reduce((sum, record) => sum + BigInt(record.intent.hostInodes), 0n) +
    [...derivedMediaRecords]
      .filter((record) => record.device === device)
      .reduce((sum, record) => sum + BigInt(record.hostInodes), 0n)
  );
}

/** Host-derived temporary copies only. This has no source quota, workspace identity, or durable job authority. */
export function reserveDerivedMediaSpace(
  directory: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<DerivedMediaSpaceReservation> {
  return serial(async () => {
    try {
      signal?.throwIfAborted();
      if (uncertainLedger)
        throw new DerivedMediaSpaceError("unconfirmed-reservation");
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 256 * MiB)
        throw new DerivedMediaSpaceError("unsafe-storage");
      const canonical = await realpath(directory),
        info = await lstat(directory);
      if (
        canonical !== path.resolve(directory) ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw new DerivedMediaSpaceError("unsafe-storage");
      try {
        for (const record of [
          ...records.values(),
          ...volumeRecords.values(),
        ].filter((record) => record.intent.device === info.dev)) {
          const actual = JSON.parse(
            (
              await readSafeProjectFile(
                path.dirname(record.file),
                record.file,
                16384,
              )
            ).toString(),
          );
          if (JSON.stringify(actual) !== JSON.stringify(record.intent))
            throw refusal("a physical promise changed outside its owner");
        }
      } catch {
        uncertainLedger = true;
        throw new DerivedMediaSpaceError("unconfirmed-reservation");
      }
      const disk = await statfs(canonical, { bigint: true }),
        unit = Math.max(4096, Number(disk.bsize));
      if (
        disk.bsize <= 0n ||
        disk.bsize > BigInt(MiB) ||
        !Number.isSafeInteger(unit) ||
        (unit & (unit - 1)) !== 0 ||
        disk.ffree < 0n
      )
        throw new DerivedMediaSpaceError("filesystem-unknown");
      const physicalBytes = Math.ceil(bytes / unit) * unit + 2 * unit,
        hostInodes = 2;
      if (
        disk.bavail * disk.bsize <
          BigInt(physicalBytes + 2 * 1024 ** 3) +
            physicalOutstanding(info.dev) ||
        disk.ffree < BigInt(hostInodes) + inodeOutstanding(info.dev)
      )
        throw new DerivedMediaSpaceError("physical-capacity");
      signal?.throwIfAborted();
      const record = { device: info.dev, physicalBytes, hostInodes };
      derivedMediaRecords.add(record);
      return Object.freeze({
        physicalBytes,
        hostInodes,
        release: () =>
          serial(async () => {
            derivedMediaRecords.delete(record);
          }),
      });
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof DerivedMediaSpaceError) throw cause;
      throw new DerivedMediaSpaceError("filesystem-unknown");
    }
  });
}
function validVolumeOwner(owner: VolumeMigrationSpaceOwner): boolean {
  return (
    !!owner &&
    Object.keys(owner).length === 5 &&
    ["manual", "test"].includes(owner.namespace) &&
    uuid.test(owner.projectId) &&
    RUNTIME_CAPACITY_PROFILES.some(
      (profile) => profile.id === owner.profileId,
    ) &&
    (uuid.test(owner.planId) ||
      /^[a-f0-9]{32}$/.test(owner.planId) ||
      hash.test(owner.planId)) &&
    ["migration", "runtime"].includes(owner.purpose)
  );
}
function validVolumeIntent(
  intent: VolumeSpaceIntent,
  canonical: string,
  device: number,
  filename: string,
): boolean {
  return (
    !!intent &&
    Object.keys(intent).length === 10 &&
    intent.version === 1 &&
    intent.kind === "volume-physical" &&
    uuid.test(intent.id) &&
    filename === `volume-${intent.id}.json` &&
    intent.workspace === canonical &&
    intent.device === device &&
    validVolumeOwner(intent.owner) &&
    Number.isSafeInteger(intent.requestedBytes) &&
    intent.requestedBytes >=
      getRuntimeCapacityProfile(intent.owner.profileId).volumeBytes &&
    intent.requestedBytes <= 64 * 1024 ** 3 &&
    Number.isSafeInteger(intent.metadataBytes) &&
    intent.metadataBytes >= 3 * 4096 &&
    intent.metadataBytes <= 3 * MiB &&
    ((intent.metadataBytes / 3) & (intent.metadataBytes / 3 - 1)) === 0 &&
    intent.physicalBytes === intent.requestedBytes + intent.metadataBytes &&
    Number.isSafeInteger(intent.hostInodes) &&
    intent.hostInodes >= 8 &&
    intent.hostInodes <= RECOVERY_ENTRY_LIMIT + 16
  );
}
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}
function refusal(message: string): Error {
  return Object.assign(
    new Error(
      `Recovery space requires review: ${message}. Retained results were not discarded.`,
    ),
    { code: "RECOVERY_SPACE_REQUIRED" },
  );
}
/** Only two known pre-intent admission failures receive this host-only brand. */
export function isRecoverySpaceInputRefusal(value: unknown): boolean {
  return (
    value !== null && typeof value === "object" && inputRefusals.has(value)
  );
}
function inputRefusal(message: string, diagnostics: string): Error {
  const error = refusal(
    message +
      "; " +
      diagnostics +
      "; keep original dimensions and quality and arrange storage",
  );
  inputRefusals.add(error);
  return error;
}
const bounded = (value: unknown, maximum: number) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
function ownerValid(owner: RecoverySpaceOwner): boolean {
  return (
    !!owner &&
    /^[a-f0-9]{32}$/.test(owner.ownerKey) &&
    ["manual", "test", "local-image"].includes(owner.namespace) &&
    /^[a-z0-9-]{1,128}$/i.test(owner.projectId) &&
    (owner.generation === undefined ||
      (Number.isSafeInteger(owner.generation) && owner.generation > 0)) &&
    (owner.rawSnapshotId === undefined || hash.test(owner.rawSnapshotId)) &&
    (owner.sourceManifestVersion === undefined
      ? owner.sourceProfileId === undefined &&
        owner.sourceBaseManifestId === undefined &&
        owner.sourceResultManifestId === undefined
      : [1, 2].includes(owner.sourceManifestVersion) &&
        (owner.sourceManifestVersion === 1
          ? owner.sourceProfileId === undefined
          : RUNTIME_CAPACITY_PROFILES.some(
              (profile) => profile.id === owner.sourceProfileId,
            )) &&
        owner.namespace !== "local-image" &&
        typeof owner.sourceBaseManifestId === "string" &&
        hash.test(owner.sourceBaseManifestId) &&
        (owner.sourceResultManifestId === undefined ||
          (hash.test(owner.sourceResultManifestId) &&
            owner.generation !== undefined &&
            owner.rawSnapshotId !== undefined)))
  );
}
function intentVersionValid(intent: Intent): boolean {
  return (
    intent.version ===
      (intent.owner?.sourceManifestVersion === 2
        ? 3
        : intent.owner?.sourceManifestVersion === 1
          ? 2
          : 1) &&
    (intent.owner?.sourceManifestVersion === 2
      ? intent.plan?.version === 2 &&
        intent.plan.profileId === intent.owner.sourceProfileId
      : intent.plan?.version === 1)
  );
}
function sameSourceIdentity(
  a: SourceReservationIdentity,
  b: SourceReservationIdentity,
): boolean {
  return (
    a.sourceManifestVersion === b.sourceManifestVersion &&
    a.sourceProfileId === b.sourceProfileId &&
    a.sourceBaseManifestId === b.sourceBaseManifestId &&
    a.sourceResultManifestId === b.sourceResultManifestId
  );
}

export function planRecoverySpace(
  inputs: RecoverySpaceInputs,
  existingRawBytes = 0,
  existingWorkingBytes = 0,
): RecoverySpacePlan {
  const profile =
      inputs.profileId === undefined
        ? undefined
        : getRuntimeCapacityProfile(inputs.profileId),
    limitBytes = profile?.recoveryBytes ?? RECOVERY_LIMIT_BYTES;
  if (
    !bounded(inputs.rawBytes, 72 * MiB) ||
    !bounded(inputs.workingBytes, 64 * MiB) ||
    !bounded(
      inputs.beforeBytes,
      profile ? profile.mediaBytes + profile.sourceBytes : 72 * MiB,
    ) ||
    !bounded(inputs.afterBytes, 72 * MiB) ||
    !bounded(inputs.manifestBytes, 2 * MiB) ||
    !bounded(inputs.reviewBytes ?? 0, 8 * MiB) ||
    !bounded(
      inputs.additionalEntries ??
        (inputs.rawBytes || inputs.workingBytes ? 20032 : 0),
      RECOVERY_ENTRY_LIMIT,
    ) ||
    !bounded(inputs.allocationUnitBytes ?? 4096, MiB) ||
    (inputs.allocationUnitBytes ?? 4096) < 4096 ||
    ((inputs.allocationUnitBytes ?? 4096) &
      ((inputs.allocationUnitBytes ?? 4096) - 1)) !==
      0 ||
    !bounded(existingRawBytes, inputs.rawBytes) ||
    !bounded(existingWorkingBytes, inputs.workingBytes)
  )
    throw refusal("invalid complete transaction plan");
  const raw = inputs.rawBytes - existingRawBytes,
    working = inputs.workingBytes - existingWorkingBytes;
  const metadata =
    3 * inputs.manifestBytes +
    (inputs.reviewBytes ?? 0) +
    RECOVERY_ENTRY_ALLOWANCE_BYTES;
  const allocationUnitBytes = inputs.allocationUnitBytes ?? 4096;
  const entryAllocationBytes = Math.max(
    RECOVERY_ENTRY_ALLOWANCE_BYTES,
    (inputs.additionalEntries ??
      (inputs.rawBytes || inputs.workingBytes ? 20032 : 0)) *
      allocationUnitBytes,
  );
  const plan: RecoverySpacePlan = {
    version: profile ? 2 : 1,
    ...(profile ? { profileId: profile.id } : {}),
    ...(profile ? { guestVolumeGrowthBytes: profile.volumeBytes } : {}),
    limitBytes,
    rawBytes: inputs.rawBytes,
    workingBytes: inputs.workingBytes,
    existingRawBytes,
    existingWorkingBytes,
    beforeBytes: inputs.beforeBytes,
    afterBytes: inputs.afterBytes,
    manifestBytes: inputs.manifestBytes,
    reviewBytes: inputs.reviewBytes ?? 0,
    additionalEntries:
      inputs.additionalEntries ??
      (inputs.rawBytes || inputs.workingBytes ? 20032 : 0),
    entryLimit: RECOVERY_ENTRY_LIMIT,
    entryAllowanceBytes: RECOVERY_ENTRY_ALLOWANCE_BYTES,
    allocationUnitBytes,
    entryAllocationBytes,
    requiredBytes:
      raw + working + 2 * (inputs.beforeBytes + inputs.afterBytes) + metadata,
    diskBytes:
      raw +
      working +
      inputs.beforeBytes +
      2 * inputs.afterBytes +
      metadata -
      RECOVERY_ENTRY_ALLOWANCE_BYTES +
      entryAllocationBytes +
      (profile?.volumeBytes ?? 0),
  };
  if (plan.requiredBytes > limitBytes)
    throw refusal(
      "the complete transaction exceeds its versioned recovery envelope",
    );
  return plan;
}
export function validRecoverySpacePlan(
  value: unknown,
): value is RecoverySpacePlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as RecoverySpacePlan;
  try {
    const expected = planRecoverySpace(
      plan,
      plan.existingRawBytes,
      plan.existingWorkingBytes,
    );
    return (
      plan.version === expected.version &&
      Object.keys(expected).length === Object.keys(plan).length &&
      Object.keys(expected).every(
        (key) =>
          expected[key as keyof RecoverySpacePlan] ===
          plan[key as keyof RecoverySpacePlan],
      )
    );
  } catch {
    return false;
  }
}

/** Counts logical bytes and entries, never follows links or creates a directory. */
export async function inspectRecoverySpace(
  workspace: string,
  required = 0,
  profileId?: RuntimeCapacityProfileId,
): Promise<{
  used: number;
  limit: number;
  fits: boolean;
  entries: number;
  transactions: number;
}> {
  const canonical = await realpath(workspace),
    parent = path.dirname(canonical);
  const limitBytes =
    profileId === undefined
      ? RECOVERY_LIMIT_BYTES
      : getRuntimeCapacityProfile(profileId).recoveryBytes;
  let used = 0,
    entries = 0,
    transactions = 0;
  const measure = async (directory: string) => {
    for await (const item of await opendir(directory)) {
      if (++entries > RECOVERY_ENTRY_LIMIT || item.isSymbolicLink())
        throw refusal("recovery entry capacity is full or linked");
      const target = path.join(directory, item.name),
        info = await lstat(target);
      if (info.isDirectory()) {
        if (info.isSymbolicLink()) throw refusal("linked recovery directory");
        await measure(target);
      } else {
        if (!info.isFile() || info.nlink !== 1)
          throw refusal("unknown linked recovery file");
        used += info.size;
        if (!Number.isSafeInteger(used) || used < 0)
          throw refusal("recovery storage size cannot be established safely");
      }
    }
  };
  for (const name of [
    "isolated-changes",
    "isolated-review-artifacts",
    "isolated-source-transfers",
    "isolated-reviews",
    "isolated-space-reservations",
  ]) {
    const root = path.join(parent, name);
    try {
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw refusal("linked recovery storage");
      if (name === "isolated-changes") {
        transactions = (await readdir(root)).length;
        if (transactions > 2000)
          throw refusal("publication history exceeds 2000 transactions");
      }
      await measure(root);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const local = localAnchors.get(canonical);
  if (local)
    for (const name of [
      "image-originals",
      "image-preparations",
      "image-transactions",
      "space-reservations",
    ]) {
      const root = path.join(local.storage, name);
      try {
        if (
          (await realpath(root)) !== root ||
          !(await lstat(root)).isDirectory()
        )
          throw refusal("linked local image recovery storage");
        if (name === "image-transactions") {
          transactions += (await readdir(root)).length;
          if (transactions > 2000)
            throw refusal(
              "combined publication history exceeds 2000 transactions",
            );
        }
        await measure(root);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  return {
    used,
    limit: limitBytes,
    fits: bounded(required, limitBytes) && used + required <= limitBytes,
    entries,
    transactions,
  };
}

/** A bounded metadata snapshot, never an admission decision or a ledger restore. */
export function inspectRecoveryCapacity(
  workspace: string,
  localAnchor?: LocalImageRecoveryAnchor,
  signal?: AbortSignal,
  profileId?: RuntimeCapacityProfileId,
): Promise<RecoveryCapacityInspection> {
  return serial(async () => {
    signal?.throwIfAborted();
    const limitBytes =
      profileId === undefined
        ? RECOVERY_LIMIT_BYTES
        : getRuntimeCapacityProfile(profileId).recoveryBytes;
    const unknownUsage = (): CapacityUsage => ({
      logicalBytes: null,
      entries: null,
      transactions: null,
    });
    const unknownPromises = (): CapacityPromises => ({
      count: null,
      logicalBytes: null,
      diskBytes: null,
      hostInodes: null,
    });
    const result: RecoveryCapacityInspection = {
      version: 1,
      status: "complete",
      localImageStorage: "not-supplied",
      quota: {
        scope: "shared-history-and-active",
        limitBytes,
        usedBytes: null,
        remainingBytes: null,
        entries: null,
        entryLimit: RECOVERY_ENTRY_LIMIT,
        transactions: null,
        transactionLimit: 2000,
      },
      breakdown: {},
      filesystem: {
        status: "incomplete",
        availableBytes: null,
        allocationUnitBytes: null,
        availableInodes: null,
        floorBytes: RECOVERY_DISK_FLOOR_BYTES,
      },
      promises: {
        ledger: "uncertain",
        coverage: "known-ledger-and-inspected-project",
        sameDevice: unknownPromises(),
        own: unknownPromises(),
      },
      issues: [],
    };
    type Issue = RecoveryCapacityInspection["issues"][number];
    const issue = (code: Issue["code"], scope: Issue["scope"]) => {
      result.status = "incomplete";
      if (
        !result.issues.some(
          (value) => value.code === code && value.scope === scope,
        )
      )
        result.issues.push({ code, scope });
    };
    const fail = (code: Issue["code"]): never => {
      throw Object.assign(new Error("Incomplete recovery capacity snapshot"), {
        capacityCode: code,
      });
    };
    const failureCode = (cause: unknown): Issue["code"] => {
      const code = (cause as { capacityCode?: Issue["code"] })?.capacityCode;
      return code &&
        [
          "unsafe-storage",
          "changed",
          "entry-limit",
          "invalid-intent",
          "invalid-number",
        ].includes(code)
        ? code
        : "unavailable";
    };
    const integer = (value: bigint | number): number => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) fail("invalid-number");
      return number;
    };
    let canonical: string, device: number;
    try {
      canonical = await realpath(workspace);
      const info = await lstat(canonical);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe-storage");
      device = info.dev;
    } catch (cause) {
      signal?.throwIfAborted();
      issue(failureCode(cause), "workspace");
      return result;
    }
    let local = localAnchor ?? localAnchors.get(canonical);
    if (local) {
      result.localImageStorage = "included";
      try {
        local = await validateLocalAnchor(local, true);
        if (local.workspace !== canonical) fail("unsafe-storage");
      } catch (cause) {
        signal?.throwIfAborted();
        issue(failureCode(cause), "local-anchor");
        local = undefined;
      }
    }
    try {
      const disk = await statfs(canonical, { bigint: true }),
        unit = integer(disk.bsize);
      if (unit <= 0 || unit > MiB || (unit & (unit - 1)) !== 0)
        fail("invalid-number");
      result.filesystem = {
        status: "complete",
        availableBytes: integer(disk.bavail * disk.bsize),
        allocationUnitBytes: Math.max(4096, unit),
        availableInodes: integer(disk.ffree),
        floorBytes: RECOVERY_DISK_FLOOR_BYTES,
      };
    } catch (cause) {
      signal?.throwIfAborted();
      issue(failureCode(cause), "filesystem");
    }
    const stamps = new Map<string, string | null>();
    const stamp = (info: Awaited<ReturnType<typeof lstat>>) =>
      [
        info.dev,
        info.ino,
        info.mode,
        info.uid,
        info.nlink,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ].join(":");
    const checkedStat = async (target: string) => {
      signal?.throwIfAborted();
      const info = await lstat(target);
      if (
        info.isSymbolicLink() ||
        info.dev !== device ||
        info.uid !== process.getuid?.() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
        (await realpath(target)) !== target
      )
        fail("unsafe-storage");
      if (stamps.has(target) && stamps.get(target) !== stamp(info))
        fail("changed");
      stamps.set(target, stamp(info));
      return info;
    };
    let totalEntries = 0;
    const roots = capacityRoots.slice(0, 5).map((name) => ({
      name,
      root: path.join(path.dirname(canonical), name),
    }));
    if (local)
      roots.push(
        ...capacityRoots
          .slice(5)
          .map((name) => ({ name, root: path.join(local!.storage, name) })),
      );
    const rootPaths = new Map(roots.map((value) => [value.name, value.root]));
    for (const { name, root } of roots) {
      const usage = { logicalBytes: 0, entries: 0, transactions: 0 };
      const measure = async (
        directory: string,
        top: boolean,
      ): Promise<void> => {
        const info = await checkedStat(directory);
        if (!info.isDirectory()) fail("unsafe-storage");
        for await (const entry of await opendir(directory)) {
          signal?.throwIfAborted();
          if (++totalEntries > RECOVERY_ENTRY_LIMIT) fail("entry-limit");
          usage.entries++;
          if (
            top &&
            (name === "isolated-changes" || name === "image-transactions")
          )
            usage.transactions++;
          const target = path.join(directory, entry.name),
            child = await checkedStat(target);
          if (child.isDirectory()) await measure(target, false);
          else
            usage.logicalBytes = integer(
              usage.logicalBytes + integer(child.size),
            );
        }
        if (stamp(await lstat(directory)) !== stamp(info)) fail("changed");
      };
      try {
        try {
          await lstat(root);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          stamps.set(root, null);
          result.breakdown[name] = { status: "complete", ...usage };
          continue;
        }
        await measure(root, true);
        result.breakdown[name] = { status: "complete", ...usage };
      } catch (cause) {
        signal?.throwIfAborted();
        issue(failureCode(cause), name);
        result.breakdown[name] = { status: "incomplete", ...unknownUsage() };
      }
    }
    let ledgerKnown =
      !uncertainLedger &&
      !result.issues.some((value) => value.scope === "local-anchor");
    if (uncertainLedger) issue("ledger-uncertain", "ledger");
    const own = new Map<string, Intent>();
    const ownVolumes = new Map<string, VolumeSpaceIntent>();
    for (const name of [
      "isolated-space-reservations",
      "space-reservations",
    ] as const) {
      const root = rootPaths.get(name);
      if (!root) continue;
      try {
        if (result.breakdown[name]?.status !== "complete")
          fail("invalid-intent");
        if (stamps.get(root) === null) continue;
        const info = await lstat(root);
        if (info.mode & 0o077) fail("unsafe-storage");
        const entries = await readdir(root);
        if (entries.length > 16) fail("invalid-intent");
        for (const filename of entries) {
          signal?.throwIfAborted();
          if (
            name === "isolated-space-reservations" &&
            /^volume-[a-f0-9-]+\.json$/.test(filename)
          ) {
            const target = path.join(root, filename),
              info = await checkedStat(target);
            if (!info.isFile() || info.mode & 0o077) fail("unsafe-storage");
            const intent = JSON.parse(
              (await readSafeProjectFile(root, target, 16384)).toString(),
            ) as VolumeSpaceIntent;
            if (
              !validVolumeIntent(intent, canonical, device, filename) ||
              ownVolumes.has(intent.id)
            )
              fail("invalid-intent");
            const current = volumeRecords.get(intent.id);
            if (
              current &&
              (current.file !== target ||
                JSON.stringify(current.intent) !== JSON.stringify(intent))
            )
              fail("invalid-intent");
            ownVolumes.set(intent.id, intent);
            continue;
          }
          if (!filename.endsWith(".json") || !uuid.test(filename.slice(0, -5)))
            fail("invalid-intent");
          const target = path.join(root, filename),
            info = await checkedStat(target);
          if (!info.isFile() || info.mode & 0o077) fail("unsafe-storage");
          let intent!: Intent;
          try {
            intent = JSON.parse(
              (await readSafeProjectFile(root, target, 16384)).toString(),
            ) as Intent;
          } catch {
            fail("invalid-intent");
          }
          if (
            !intent ||
            !intentVersionValid(intent) ||
            intent.id + ".json" !== filename ||
            intent.workspace !== canonical ||
            intent.device !== device ||
            !ownerValid(intent.owner) ||
            !validRecoverySpacePlan(intent.plan) ||
            own.has(intent.id)
          )
            fail("invalid-intent");
          if (
            name === "space-reservations"
              ? intent.kind !== "local-image" ||
                intent.storage !== local?.storage ||
                intent.owner.namespace !== "local-image" ||
                intent.owner.projectId !== local?.projectId
              : (intent.kind !== undefined && intent.kind !== "source") ||
                intent.storage !== undefined ||
                intent.owner.namespace === "local-image"
          )
            fail("invalid-intent");
          const current = records.get(intent.id);
          if (
            current &&
            (current.file !== target ||
              JSON.stringify(current.intent) !== JSON.stringify(intent))
          )
            fail("invalid-intent");
          own.set(intent.id, intent);
        }
      } catch (cause) {
        signal?.throwIfAborted();
        ledgerKnown = false;
        issue(failureCode(cause), name);
      }
    }
    for (const record of records.values())
      if (record.intent.workspace === canonical && !own.has(record.intent.id)) {
        ledgerKnown = false;
        issue("invalid-intent", "ledger");
      }
    for (const record of volumeRecords.values())
      if (
        record.intent.workspace === canonical &&
        !ownVolumes.has(record.intent.id)
      ) {
        ledgerKnown = false;
        issue("invalid-intent", "ledger");
      }
    // A memory-only promise after a failed write/fsync must not be reported as
    // established durable metadata, including promises belonging to other projects.
    if (ledgerKnown)
      for (const record of [...records.values(), ...volumeRecords.values()]) {
        if (
          record.intent.device !== device ||
          ("plan" in record.intent
            ? own.has(record.intent.id)
            : ownVolumes.has(record.intent.id))
        )
          continue;
        try {
          signal?.throwIfAborted();
          const root = path.dirname(record.file),
            beforeRoot = await lstat(root),
            before = await lstat(record.file);
          if (
            !beforeRoot.isDirectory() ||
            beforeRoot.uid !== process.getuid?.() ||
            beforeRoot.mode & 0o077 ||
            (await realpath(root)) !== root ||
            !before.isFile() ||
            before.nlink !== 1 ||
            before.uid !== process.getuid?.() ||
            before.mode & 0o077 ||
            before.dev !== device
          )
            fail("invalid-intent");
          const intent = JSON.parse(
            (await readSafeProjectFile(root, record.file, 16384)).toString(),
          ) as Intent;
          if (
            JSON.stringify(intent) !== JSON.stringify(record.intent) ||
            stamp(await lstat(record.file)) !== stamp(before) ||
            stamp(await lstat(root)) !== stamp(beforeRoot)
          )
            fail("invalid-intent");
        } catch (cause) {
          signal?.throwIfAborted();
          ledgerKnown = false;
          issue(failureCode(cause), "ledger");
          break;
        }
      }
    // Recheck all observed metadata, including absent roots, before publishing totals.
    for (const [target, before] of stamps) {
      try {
        signal?.throwIfAborted();
        let after: string | null;
        try {
          after = stamp(await lstat(target));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          after = null;
        }
        if (before !== after) fail("changed");
      } catch (cause) {
        signal?.throwIfAborted();
        ledgerKnown = false;
        issue(failureCode(cause), "ledger");
        for (const usage of Object.values(result.breakdown))
          Object.assign(usage, { status: "incomplete", ...unknownUsage() });
        break;
      }
    }
    if (
      !result.issues.some((value) => value.scope === "local-anchor") &&
      Object.values(result.breakdown).every(
        (value) => value.status === "complete",
      )
    ) {
      try {
        const values = Object.values(result.breakdown),
          used = integer(
            values.reduce((sum, value) => sum + value.logicalBytes!, 0),
          );
        Object.assign(result.quota, {
          usedBytes: used,
          remainingBytes: Math.max(0, limitBytes - used),
          entries: values.reduce((sum, value) => sum + value.entries!, 0),
          transactions: values.reduce(
            (sum, value) => sum + value.transactions!,
            0,
          ),
        });
      } catch (cause) {
        issue(failureCode(cause), "workspace");
      }
    }
    if (ledgerKnown) {
      const all = new Map(
        [...records.values()].map((record) => [
          record.intent.id,
          record.intent,
        ]),
      );
      for (const [id, intent] of own) all.set(id, intent);
      const allVolumes = new Map(
        [...volumeRecords.values()].map((record) => [
          record.intent.id,
          record.intent,
        ]),
      );
      for (const [id, intent] of ownVolumes) allVolumes.set(id, intent);
      const summarize = (
        intents: readonly Intent[],
        volumes: readonly VolumeSpaceIntent[],
        derived: readonly DerivedMediaSpaceRecord[] = [],
      ): CapacityPromises => ({
        count: intents.length + volumes.length + derived.length,
        logicalBytes: integer(
          intents.reduce((sum, value) => sum + value.plan.requiredBytes, 0),
        ),
        diskBytes: integer(
          intents.reduce((sum, value) => sum + value.plan.diskBytes, 0) +
            volumes.reduce((sum, value) => sum + value.physicalBytes, 0) +
            derived.reduce((sum, value) => sum + value.physicalBytes, 0),
        ),
        hostInodes: integer(
          intents.reduce(
            (sum, value) => sum + value.plan.additionalEntries + 2,
            0,
          ) +
            volumes.reduce((sum, value) => sum + value.hostInodes, 0) +
            derived.reduce((sum, value) => sum + value.hostInodes, 0),
        ),
      });
      try {
        result.promises = {
          ...result.promises,
          ledger: "known",
          own: summarize([...own.values()], [...ownVolumes.values()]),
          sameDevice: summarize(
            [...all.values()].filter((value) => value.device === device),
            [...allVolumes.values()].filter((value) => value.device === device),
            [...derivedMediaRecords].filter((value) => value.device === device),
          ),
        };
      } catch (cause) {
        issue(failureCode(cause), "ledger");
      }
    }
    signal?.throwIfAborted();
    return result;
  });
}

async function privateRoot(
  workspace: string,
  create: boolean,
): Promise<string> {
  const root = path.join(
    path.dirname(await realpath(workspace)),
    "isolated-space-reservations",
  );
  if (create) {
    try {
      await mkdir(root, { mode: 0o700 });
      await sync(path.dirname(root));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw refusal("reservation storage is not private");
  return root;
}
async function sync(directory: string): Promise<void> {
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
async function writeIntent(
  record: RecordState | VolumeSpaceRecord,
): Promise<void> {
  const temporary = path.join(
      path.dirname(record.file),
      `.intent-${randomUUID()}.tmp`,
    ),
    bytes = Buffer.from(JSON.stringify(record.intent));
  let created = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, record.file);
    created = false;
    await sync(path.dirname(record.file));
  } catch (cause) {
    if (created) await rm(temporary).catch(() => {});
    throw cause;
  }
}
function sameOwner(a: RecoverySpaceOwner, b: RecoverySpaceOwner): boolean {
  return (
    a.ownerKey === b.ownerKey &&
    a.namespace === b.namespace &&
    a.projectId === b.projectId &&
    a.generation === b.generation &&
    a.rawSnapshotId === b.rawSnapshotId &&
    sameSourceIdentity(a, b)
  );
}
async function loadWorkspace(workspace: string): Promise<void> {
  try {
    await loadWorkspaceIntents(workspace);
  } catch (cause) {
    uncertainLedger = true;
    throw cause;
  }
}
async function loadWorkspaceIntents(workspace: string): Promise<void> {
  const canonical = await realpath(workspace);
  let root: string;
  try {
    root = await privateRoot(canonical, false);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      if (
        [...records.values(), ...volumeRecords.values()].some(
          (record) =>
            record.intent.workspace === canonical &&
            path.dirname(record.file) ===
              path.join(path.dirname(canonical), "isolated-space-reservations"),
        )
      )
        throw refusal("an outstanding reservation root disappeared");
      return;
    }
    throw cause;
  }
  const entries = await readdir(root);
  if (entries.length > 16)
    throw refusal("unresolved reservation history is full");
  if (
    [...records.values()].some(
      (record) =>
        record.intent.workspace === canonical &&
        path.dirname(record.file) === root &&
        !entries.includes(record.intent.id + ".json"),
    )
  )
    throw refusal("an active reservation intent disappeared");
  if (
    [...volumeRecords.values()].some(
      (record) =>
        record.intent.workspace === canonical &&
        !entries.includes(path.basename(record.file)),
    )
  )
    throw refusal("an active volume physical promise disappeared");
  for (const name of entries) {
    if (/^volume-[a-f0-9-]+\.json$/.test(name)) {
      const file = path.join(root, name),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw refusal("unsafe volume physical promise");
      const intent = JSON.parse(
        (await readSafeProjectFile(root, file, 16384)).toString(),
      ) as VolumeSpaceIntent;
      if (
        !validVolumeIntent(
          intent,
          canonical,
          (await lstat(canonical)).dev,
          name,
        )
      )
        throw refusal("invalid volume physical promise binding");
      const previous = volumeRecords.get(intent.id);
      if (
        previous &&
        (previous.file !== file ||
          JSON.stringify(previous.intent) !== JSON.stringify(intent))
      )
        throw refusal("volume physical promise changed outside its owner");
      if (!previous) volumeRecords.set(intent.id, { intent, file });
      continue;
    }
    if (!uuid.test(name.replace(/\.json$/, "")) || !name.endsWith(".json"))
      throw refusal("unknown unfinished reservation metadata");
    const file = path.join(root, name),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw refusal("unsafe reservation intent");
    const intent = JSON.parse(
      (await readSafeProjectFile(root, file, 16384)).toString(),
    ) as Intent;
    if (
      !intentVersionValid(intent) ||
      intent.id + ".json" !== name ||
      !uuid.test(intent.id) ||
      intent.workspace !== canonical ||
      (intent.kind !== undefined && intent.kind !== "source") ||
      intent.storage !== undefined ||
      intent.owner?.namespace === "local-image" ||
      intent.device !== (await lstat(canonical)).dev ||
      !ownerValid(intent.owner) ||
      !validRecoverySpacePlan(intent.plan)
    )
      throw refusal("invalid reservation binding or complete plan");
    const current = records.get(intent.id);
    if (current && JSON.stringify(current.intent) !== JSON.stringify(intent))
      throw refusal("reservation changed outside its owner");
    if (!current) records.set(intent.id, { intent, file, restored: true });
  }
}

/** Startup reconciliation only: no operation or publication is replayed and no timeout releases an unknown intent. */
export function restoreRecoverySpaceReservations(
  workspaces: readonly string[],
): Promise<void> {
  return serial(async () => {
    try {
      for (const workspace of workspaces) await loadWorkspace(workspace);
    } catch (cause) {
      uncertainLedger = true;
      throw cause;
    }
  });
}

function sameVolumeOwner(
  a: VolumeMigrationSpaceOwner,
  b: VolumeMigrationSpaceOwner,
): boolean {
  return (
    a.namespace === b.namespace &&
    a.projectId === b.projectId &&
    a.profileId === b.profileId &&
    a.planId === b.planId &&
    a.purpose === b.purpose
  );
}
function volumeToken(
  record: VolumeSpaceRecord,
): VolumeMigrationSpaceReservation {
  if (record.token) return record.token;
  const token: VolumeMigrationSpaceReservation = Object.freeze({
    id: record.intent.id,
    physicalBytes: record.intent.physicalBytes,
    hostInodes: record.intent.hostInodes,
    release: async (proof: VolumeMigrationSpaceTerminalProof) =>
      serial(async () => {
        const verified = volumeTerminalProofs.get(proof);
        if (!verified || verified.record !== record)
          throw refusal(
            "a host-verified exact volume terminal proof is required",
          );
        if (volumeRecords.get(record.intent.id) !== record) return;
        const actual = JSON.parse(
          (
            await readSafeProjectFile(
              path.dirname(record.file),
              record.file,
              16384,
            )
          ).toString(),
        );
        if (JSON.stringify(actual) !== JSON.stringify(record.intent))
          throw refusal(
            "volume physical promise changed before verified release",
          );
        await rm(record.file);
        await sync(path.dirname(record.file));
        volumeRecords.delete(record.intent.id);
      }),
  });
  volumeTokens.set(token, record);
  record.token = token;
  return token;
}

/** Host-native coordinator only, after fresh exact guest terminal validation. Never expose this mint as an Agent tool. */
export function createVolumeMigrationSpaceTerminalProof(
  reservation: VolumeMigrationSpaceReservation,
  terminal: "committed" | "revoked-not-started" | "released-host-settled",
): VolumeMigrationSpaceTerminalProof {
  const record = volumeTokens.get(reservation);
  if (
    !record ||
    volumeRecords.get(record.intent.id) !== record ||
    (record.intent.owner.purpose === "migration"
      ? !["committed", "revoked-not-started"].includes(terminal)
      : !["released-host-settled", "revoked-not-started"].includes(terminal))
  )
    throw refusal("invalid or unverified volume terminal state");
  const proof = Object.freeze({ kind: "volume-space-terminal" as const });
  volumeTerminalProofs.set(proof, { record, terminal });
  return proof;
}

/** Physical-only reservation. The guest's image bytes never become source recovery quota. */
export function reserveVolumeMigrationSpace(
  workspace: string,
  inputs: VolumeMigrationSpaceInputs,
  owner: VolumeMigrationSpaceOwner,
  signal?: AbortSignal,
): Promise<VolumeMigrationSpaceReservation> {
  return serial(async () => {
    signal?.throwIfAborted();
    if (uncertainLedger)
      throw refusal("outstanding physical reservations are unknown");
    if (
      !validVolumeOwner(owner) ||
      !Number.isSafeInteger(inputs.backingDevice) ||
      inputs.backingDevice < 0 ||
      !Number.isSafeInteger(inputs.physicalBytes) ||
      inputs.physicalBytes <
        getRuntimeCapacityProfile(owner.profileId).volumeBytes ||
      inputs.physicalBytes > 64 * 1024 ** 3 ||
      !Number.isSafeInteger(inputs.hostInodes) ||
      inputs.hostInodes < 8 ||
      inputs.hostInodes > RECOVERY_ENTRY_LIMIT + 16
    )
      throw refusal("invalid host volume physical plan");
    const canonical = await realpath(workspace);
    await loadWorkspace(canonical);
    if (
      inputs.backingDevice !== undefined &&
      inputs.backingDevice !== (await lstat(canonical)).dev
    )
      throw refusal(
        "volume backing storage and project control storage are on different devices",
      );
    if (
      [...records.values()].some(
        (record) => record.intent.workspace === canonical,
      )
    )
      throw refusal(
        "the original source operation still owns this workspace reservation",
      );
    const active = [...volumeRecords.values()].filter(
      (record) => record.intent.workspace === canonical,
    );
    if (active.length) {
      if (
        active.length !== 1 ||
        !sameVolumeOwner(active[0]!.intent.owner, owner) ||
        active[0]!.intent.requestedBytes !== inputs.physicalBytes ||
        active[0]!.intent.hostInodes !== inputs.hostInodes
      )
        throw refusal(
          "another exact native volume operation owns the physical promise",
        );
      return volumeToken(active[0]!);
    }
    const device = (await lstat(canonical)).dev,
      disk = await statfs(canonical, { bigint: true }),
      unit = Math.max(4096, Number(disk.bsize));
    if (inputs.backingDevice !== undefined && inputs.backingDevice !== device)
      throw refusal(
        "volume backing storage and project control storage are on different devices",
      );
    if (
      disk.bsize <= 0n ||
      !bounded(unit, MiB) ||
      (unit & (unit - 1)) !== 0 ||
      disk.ffree < 0n
    )
      throw refusal("filesystem physical capacity cannot be established");
    const physicalBytes = inputs.physicalBytes + 3 * unit;
    if (
      disk.bavail * disk.bsize <
      BigInt(physicalBytes + RECOVERY_DISK_FLOOR_BYTES) +
        physicalOutstanding(device)
    )
      throw refusal(
        "insufficient unreserved physical bytes for the volume operation and safety floor",
      );
    if (disk.ffree < BigInt(inputs.hostInodes) + inodeOutstanding(device))
      throw refusal(
        "insufficient unreserved filesystem inodes for the volume operation",
      );
    signal?.throwIfAborted();
    const root = await privateRoot(canonical, true),
      id = randomUUID();
    const record: VolumeSpaceRecord = {
      file: path.join(root, `volume-${id}.json`),
      intent: {
        version: 1,
        kind: "volume-physical",
        id,
        workspace: canonical,
        device,
        owner: {
          namespace: owner.namespace,
          projectId: owner.projectId,
          profileId: owner.profileId,
          planId: owner.planId,
          purpose: owner.purpose,
        },
        requestedBytes: inputs.physicalBytes,
        physicalBytes,
        metadataBytes: 3 * unit,
        hostInodes: inputs.hostInodes,
      },
    };
    volumeRecords.set(id, record);
    await writeIntent(record);
    return volumeToken(record);
  });
}
/** Reconnect the same durable owner only. This performs no guest action or terminal inference. */
export function reconnectVolumeMigrationSpace(
  workspace: string,
  owner: VolumeMigrationSpaceOwner,
  backingDevice: number,
): Promise<VolumeMigrationSpaceReservation | undefined> {
  return serial(async () => {
    if (uncertainLedger || !validVolumeOwner(owner))
      throw refusal("volume physical ledger or owner is unknown");
    const canonical = await realpath(workspace);
    if (
      !Number.isSafeInteger(backingDevice) ||
      backingDevice !== (await lstat(canonical)).dev
    )
      throw refusal(
        "the current backing device does not match the original physical promise",
      );
    try {
      await loadWorkspace(canonical);
    } catch (cause) {
      uncertainLedger = true;
      throw cause;
    }
    const candidates = [...volumeRecords.values()].filter(
      (record) => record.intent.workspace === canonical,
    );
    if (!candidates.length) return undefined;
    if (
      candidates.length !== 1 ||
      !sameVolumeOwner(candidates[0]!.intent.owner, owner)
    )
      throw refusal(
        "the original volume physical promise has another exact owner",
      );
    return volumeToken(candidates[0]!);
  });
}
export function inspectVolumeMigrationSpaces(workspace: string): Promise<{
  state: "known" | "uncertain";
  reservations:
    | readonly {
        id: string;
        owner: VolumeMigrationSpaceOwner;
        physicalBytes: number;
        hostInodes: number;
      }[]
    | null;
}> {
  return serial(async () => {
    if (uncertainLedger) return { state: "uncertain", reservations: null };
    try {
      const canonical = await realpath(workspace);
      await loadWorkspace(canonical);
      return {
        state: "known",
        reservations: [...volumeRecords.values()]
          .filter((record) => record.intent.workspace === canonical)
          .map((record) => ({
            id: record.intent.id,
            owner: { ...record.intent.owner },
            physicalBytes: record.intent.physicalBytes,
            hostInodes: record.intent.hostInodes,
          })),
      };
    } catch {
      uncertainLedger = true;
      return { state: "uncertain", reservations: null };
    }
  });
}
export function checkVolumeMigrationSpaceHeadroom(
  reservation: VolumeMigrationSpaceReservation,
): Promise<void> {
  return serial(async () => {
    const record = volumeTokens.get(reservation);
    if (
      !record ||
      volumeRecords.get(record.intent.id) !== record ||
      uncertainLedger
    )
      throw refusal("untrusted or unknown volume physical reservation");
    await loadWorkspace(record.intent.workspace);
    const disk = await statfs(record.intent.workspace, { bigint: true });
    if (
      disk.bsize <= 0n ||
      disk.bavail * disk.bsize <
        BigInt(record.intent.physicalBytes + RECOVERY_DISK_FLOOR_BYTES) +
          physicalOutstanding(record.intent.device, record) ||
      disk.ffree <
        BigInt(record.intent.hostInodes) +
          inodeOutstanding(record.intent.device, record)
    )
      throw refusal(
        "physical bytes or inodes changed before the volume operation",
      );
  });
}
/** Caller must check this before guest retirement/deletion, not after destructive guest work. */
export function assertNoVolumeMigrationSpace(workspace: string): Promise<void> {
  return serial(async () => {
    const canonical = await realpath(workspace);
    await loadWorkspace(canonical);
    if (
      [...volumeRecords.values()].some(
        (record) => record.intent.workspace === canonical,
      )
    )
      throw refusal(
        "the native volume operation must reach an exact verified terminal state first",
      );
  });
}

export function inspectVolumeMigrationHeadroom(
  workspace: string,
  signal?: AbortSignal,
): Promise<{
  status: "complete" | "unknown";
  availableBytes: number | null;
  availableInodes: number | null;
  allocationUnitBytes: number | null;
  physicalOutstandingBytes: number | null;
  inodeOutstanding: number | null;
  floorBytes: number;
}> {
  return serial(async () => {
    const unknown = {
      status: "unknown" as const,
      availableBytes: null,
      availableInodes: null,
      allocationUnitBytes: null,
      physicalOutstandingBytes: null,
      inodeOutstanding: null,
      floorBytes: RECOVERY_DISK_FLOOR_BYTES,
    };
    signal?.throwIfAborted();
    if (uncertainLedger) return unknown;
    try {
      const canonical = await realpath(workspace);
      await loadWorkspace(canonical);
      const device = (await lstat(canonical)).dev;
      for (const record of [
        ...records.values(),
        ...volumeRecords.values(),
      ].filter((record) => record.intent.device === device)) {
        signal?.throwIfAborted();
        const actual = JSON.parse(
          (
            await readSafeProjectFile(
              path.dirname(record.file),
              record.file,
              16384,
            )
          ).toString(),
        );
        if (JSON.stringify(actual) !== JSON.stringify(record.intent))
          throw refusal("a physical promise changed outside its owner");
      }
      const disk = await statfs(canonical, { bigint: true });
      const values = [
        disk.bavail * disk.bsize,
        disk.ffree,
        BigInt(Math.max(4096, Number(disk.bsize))),
        physicalOutstanding(device),
        inodeOutstanding(device),
      ];
      if (
        disk.bsize <= 0n ||
        disk.bsize > BigInt(MiB) ||
        values.some(
          (value) => value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER),
        )
      )
        throw refusal("filesystem physical headroom is unknown");
      signal?.throwIfAborted();
      return {
        status: "complete" as const,
        availableBytes: Number(values[0]),
        availableInodes: Number(values[1]),
        allocationUnitBytes: Number(values[2]),
        physicalOutstandingBytes: Number(values[3]),
        inodeOutstanding: Number(values[4]),
        floorBytes: RECOVERY_DISK_FLOOR_BYTES,
      };
    } catch {
      signal?.throwIfAborted();
      uncertainLedger = true;
      return unknown;
    }
  });
}

async function existingArtifacts(
  workspace: string,
  inputs: RecoverySpaceInputs,
  local?: LocalImageRecoveryAnchor,
): Promise<[number, number]> {
  let raw = 0,
    working = 0;
  const seen = new Set<string>();
  if ((inputs.existingArtifacts?.length ?? 0) > 2000)
    throw refusal("too many existing artifact bindings");
  for (const artifact of inputs.existingArtifacts ?? []) {
    if (
      !["raw", "working"].includes(artifact.kind) ||
      !hash.test(artifact.sha256) ||
      !bounded(artifact.size, (local ? 64 : 32) * MiB) ||
      (local && artifact.kind !== "raw")
    )
      throw refusal("invalid existing artifact binding");
    const key = artifact.kind + "/" + artifact.sha256;
    if (seen.has(key)) continue;
    seen.add(key);
    const root =
        local?.storage ??
        path.join(path.dirname(workspace), "isolated-review-artifacts"),
      file = local
        ? path.join(root, "image-originals", artifact.sha256)
        : path.join(root, key);
    const actual = await inspectSafeProjectMedia(
      root,
      file,
      (local ? 64 : 32) * MiB,
    );
    if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
      throw refusal("existing artifact changed");
    if (artifact.kind === "raw") raw += actual.size;
    else working += actual.size;
  }
  return [raw, working];
}

function tokenFor(record: RecordState): RecoverySpaceReservation {
  if (record.token) return record.token;
  const token: RecoverySpaceReservation = Object.freeze({
    id: record.intent.id,
    get plan() {
      return Object.freeze({ ...record.intent.plan });
    },
    bind: async (
      binding: {
        generation?: number;
        rawSnapshotId?: string;
      } & SourceReservationIdentity,
    ) =>
      serial(async () => {
        if (records.get(record.intent.id) !== record)
          throw refusal("reservation is no longer active");
        const next = { ...record.intent.owner, ...binding };
        if (
          Object.keys(binding).some(
            (key) =>
              ![
                "generation",
                "rawSnapshotId",
                "sourceManifestVersion",
                "sourceProfileId",
                "sourceBaseManifestId",
                "sourceResultManifestId",
              ].includes(key),
          ) ||
          !ownerValid(next) ||
          next.sourceManifestVersion !==
            record.intent.owner.sourceManifestVersion ||
          next.sourceProfileId !== record.intent.owner.sourceProfileId ||
          next.sourceBaseManifestId !==
            record.intent.owner.sourceBaseManifestId ||
          (record.intent.owner.sourceResultManifestId !== undefined &&
            next.sourceResultManifestId !==
              record.intent.owner.sourceResultManifestId) ||
          (record.intent.owner.generation !== undefined &&
            next.generation !== record.intent.owner.generation) ||
          (record.intent.owner.rawSnapshotId !== undefined &&
            next.rawSnapshotId !== record.intent.owner.rawSnapshotId)
        )
          throw refusal("reservation generation or raw snapshot changed");
        const previous = record.intent;
        record.intent = { ...previous, owner: next };
        try {
          await writeIntent(record);
        } catch (cause) {
          record.intent = previous;
          throw cause;
        }
      }),
    release: async () =>
      serial(async () => {
        if (records.get(record.intent.id) !== record) return;
        const actual = JSON.parse(
          (
            await readSafeProjectFile(
              path.dirname(record.file),
              record.file,
              16384,
            )
          ).toString(),
        );
        if (JSON.stringify(actual) !== JSON.stringify(record.intent))
          throw refusal("reservation changed before release");
        await rm(record.file);
        await sync(path.dirname(record.file));
        records.delete(record.intent.id);
      }),
  });
  branded.set(token, record);
  record.token = token;
  return token;
}

/** Must be acquired before submission/allocation; options come from the host operation, never model arguments. */
export function reserveRecoverySpace(
  workspace: string,
  inputs: RecoverySpaceInputs,
  options: RecoverySpaceOwner & { reuse?: boolean; signal?: AbortSignal },
): Promise<RecoverySpaceReservation> {
  if (!["manual", "test"].includes(options.namespace))
    return Promise.reject(refusal("invalid source reservation namespace"));
  return reserveSpace(workspace, inputs, options);
}
function reserveSpace(
  workspace: string,
  inputs: RecoverySpaceInputs,
  options: RecoverySpaceOwner & { reuse?: boolean; signal?: AbortSignal },
  local?: LocalImageRecoveryAnchor,
): Promise<RecoverySpaceReservation> {
  return serial(async () => {
    options.signal?.throwIfAborted();
    if (uncertainLedger)
      throw refusal(
        "startup could not establish all outstanding disk reservations",
      );
    if (!ownerValid(options)) throw refusal("invalid host reservation owner");
    if (options.sourceManifestVersion === 2) {
      if (
        inputs.profileId !== undefined &&
        inputs.profileId !== options.sourceProfileId
      )
        throw refusal("recovery profile differs from its original operation");
      inputs = { ...inputs, profileId: options.sourceProfileId };
    } else if (inputs.profileId !== undefined)
      throw refusal("legacy operation cannot claim a newer recovery profile");
    const canonical = await realpath(workspace);
    if (
      options.sourceManifestVersion === 2 &&
      (!Number.isSafeInteger(inputs.backingDevice) ||
        inputs.backingDevice !== (await lstat(canonical)).dev)
    )
      throw refusal(
        "the runtime backing device must match the project recovery device",
      );
    if (local) {
      local = await validateLocalAnchor(local, true);
      localAnchors.set(canonical, local);
      await loadLocalAnchor(local);
    }
    const imageAnchor = localAnchors.get(canonical);
    if (imageAnchor) await assertLocalImagePublicationsSettled(imageAnchor);
    const disk = await statfs(canonical, { bigint: true });
    if (disk.bsize > BigInt(MiB) || disk.bsize <= 0n)
      throw refusal("unsupported filesystem allocation unit");
    inputs = {
      ...inputs,
      allocationUnitBytes: Math.max(4096, Number(disk.bsize)),
    };
    await loadWorkspace(canonical);
    if (
      [...volumeRecords.values()].some(
        (record) => record.intent.workspace === canonical,
      )
    )
      throw refusal(
        "the native volume operation still owns the workspace physical promise",
      );
    const active = [...records.values()].filter(
      (record) => record.intent.workspace === canonical,
    );
    if (active.length) {
      if (
        active.length !== 1 ||
        !options.reuse ||
        !sameOwner(active[0]!.intent.owner, options)
      )
        throw refusal("another operation has an unresolved reservation");
      const [raw, working] = await existingArtifacts(canonical, inputs, local),
        desired = planRecoverySpace(inputs, raw, working),
        plan = active[0]!.intent.plan;
      if (
        desired.version !== plan.version ||
        desired.profileId !== plan.profileId ||
        desired.rawBytes > plan.rawBytes ||
        desired.workingBytes > plan.workingBytes ||
        desired.beforeBytes > plan.beforeBytes ||
        desired.afterBytes > plan.afterBytes ||
        desired.manifestBytes > plan.manifestBytes ||
        desired.reviewBytes > plan.reviewBytes ||
        desired.additionalEntries > plan.additionalEntries ||
        desired.requiredBytes > plan.requiredBytes ||
        desired.diskBytes > plan.diskBytes
      )
        throw refusal(
          "the original reservation does not cover this transaction",
        );
      return tokenFor(active[0]!);
    }
    const [raw, working] = await existingArtifacts(canonical, inputs, local),
      plan = planRecoverySpace(inputs, raw, working);
    const capacity = await inspectRecoverySpace(
      canonical,
      plan.requiredBytes + 16384,
      plan.profileId,
    );
    const device = (await lstat(canonical)).dev;
    const reserved = physicalOutstanding(device),
      reservedInodes = inodeOutstanding(device);
    const diagnostics = `quotaRequiredBytes=${plan.requiredBytes + 16384}, quotaRemainingBytes=${Math.max(0, capacity.limit - capacity.used)}, quotaLimitBytes=${capacity.limit}, entriesRequired=${plan.additionalEntries + 2}, entriesUsed=${capacity.entries}, entryLimit=${RECOVERY_ENTRY_LIMIT}, transactionsUsed=${capacity.transactions}, transactionLimit=2000, diskRequiredBytes=${plan.diskBytes}, bavailBytes=${disk.bavail * disk.bsize}, outstandingBytes=${reserved}, floorBytes=${RECOVERY_DISK_FLOOR_BYTES}`;
    if (
      !capacity.fits ||
      capacity.transactions >= 2000 ||
      capacity.entries + plan.additionalEntries + 2 > RECOVERY_ENTRY_LIMIT
    )
      throw inputRefusal(
        "the complete transaction exceeds available recovery capacity",
        diagnostics,
      );
    if (
      disk.bavail * disk.bsize <
        BigInt(plan.diskBytes + RECOVERY_DISK_FLOOR_BYTES) + reserved ||
      disk.ffree < BigInt(plan.additionalEntries + 2) + reservedInodes
    )
      throw inputRefusal(
        disk.ffree < BigInt(plan.additionalEntries + 2) + reservedInodes
          ? "insufficient unreserved filesystem inodes"
          : "insufficient unreserved disk space",
        diagnostics +
          `, availableInodes=${disk.ffree}, outstandingInodes=${reservedInodes}`,
      );
    options.signal?.throwIfAborted();
    const root = local
        ? await localIntentRoot(local, true)
        : await privateRoot(canonical, true),
      id = randomUUID();
    const owner: RecoverySpaceOwner = {
      ownerKey: options.ownerKey,
      namespace: options.namespace,
      projectId: options.projectId,
      ...(options.generation === undefined
        ? {}
        : { generation: options.generation }),
      ...(options.rawSnapshotId === undefined
        ? {}
        : { rawSnapshotId: options.rawSnapshotId }),
      ...(options.sourceManifestVersion === undefined
        ? {}
        : {
            sourceManifestVersion: options.sourceManifestVersion,
            ...(options.sourceProfileId === undefined
              ? {}
              : { sourceProfileId: options.sourceProfileId }),
            sourceBaseManifestId: options.sourceBaseManifestId,
            ...(options.sourceResultManifestId === undefined
              ? {}
              : { sourceResultManifestId: options.sourceResultManifestId }),
          }),
    };
    const record: RecordState = {
      intent: {
        version:
          owner.sourceManifestVersion === 2
            ? 3
            : owner.sourceManifestVersion === 1
              ? 2
              : 1,
        id,
        workspace: canonical,
        device,
        owner,
        plan,
        ...(local
          ? { kind: "local-image" as const, storage: local.storage }
          : { kind: "source" as const }),
      },
      file: path.join(root, id + ".json"),
    };
    // Keep the promise in memory even when final intent fsync has an uncertain outcome.
    records.set(id, record);
    await writeIntent(record);
    return tokenFor(record);
  });
}

export function withRecoverySpaceReservation<T>(
  reservation: RecoverySpaceReservation,
  operation: () => Promise<T>,
): Promise<T> {
  const record = branded.get(reservation);
  if (!record || records.get(record.intent.id) !== record)
    throw refusal("untrusted or released reservation");
  record.activeScopes = (record.activeScopes ?? 0) + 1;
  return (async () => {
    try {
      const actual = JSON.parse(
        (
          await readSafeProjectFile(
            path.dirname(record.file),
            record.file,
            16384,
          )
        ).toString(),
      );
      if (
        records.get(record.intent.id) !== record ||
        JSON.stringify(actual) !== JSON.stringify(record.intent)
      )
        throw refusal("reservation changed before the operation");
      return await scope.run(reservation, operation);
    } finally {
      record.activeScopes!--;
    }
  })();
}
export function currentRecoverySpaceReservation(
  workspace: string,
): RecoverySpaceReservation | undefined {
  const token = scope.getStore(),
    record = token && branded.get(token);
  if (
    !record ||
    records.get(record.intent.id) !== record ||
    record.intent.kind === "local-image" ||
    record.intent.workspace !== workspace
  )
    return undefined;
  return token;
}
export function assertRecoverySpaceReservation(
  reservation: RecoverySpaceReservation,
  workspace: string,
  inputs: RecoverySpaceInputs,
): void {
  const record = branded.get(reservation),
    desired = planRecoverySpace(inputs);
  if (
    !record ||
    records.get(record.intent.id) !== record ||
    record.intent.workspace !== workspace ||
    desired.version !== record.intent.plan.version ||
    desired.profileId !== record.intent.plan.profileId ||
    desired.beforeBytes > record.intent.plan.beforeBytes ||
    desired.afterBytes > record.intent.plan.afterBytes ||
    desired.manifestBytes > record.intent.plan.manifestBytes ||
    desired.reviewBytes > record.intent.plan.reviewBytes ||
    desired.additionalEntries > record.intent.plan.additionalEntries
  )
    throw refusal("the active reservation does not cover publication");
}

/** Recheck the emergency metadata margin after payload staging, before any live inode is moved. */
export function checkRecoverySpaceHeadroom(
  reservation: RecoverySpaceReservation,
): Promise<void> {
  return serial(async () => {
    const record = branded.get(reservation);
    if (!record || records.get(record.intent.id) !== record)
      throw refusal("untrusted or released reservation");
    const disk = await statfs(record.intent.workspace, { bigint: true });
    if (disk.bsize <= 0n || disk.bsize > BigInt(MiB))
      throw refusal("unsupported filesystem allocation unit");
    if (
      Math.max(4096, Number(disk.bsize)) >
      record.intent.plan.allocationUnitBytes
    )
      throw refusal("filesystem allocation unit changed after reservation");
    const others = physicalOutstanding(record.intent.device, record),
      otherInodes = inodeOutstanding(record.intent.device, record);
    const plan = record.intent.plan,
      metadata =
        3 * plan.manifestBytes + plan.reviewBytes + plan.entryAllocationBytes;
    if (
      disk.bavail * disk.bsize <
        others + BigInt(RECOVERY_DISK_FLOOR_BYTES + metadata) ||
      disk.ffree < otherInodes + 2n
    )
      throw refusal(
        "disk headroom changed before publication; retained bytes remain available for review",
      );
  });
}

/** Explicit publication recovery only, using the exact reservation ID and context from its host-written journal. */
export function reservationForPublication(
  workspace: string,
  id: string,
  context: {
    namespace: "manual" | "test";
    projectId: string;
    generation: number;
    snapshotId: string;
    sourceContract?: SourceContract;
  },
): Promise<RecoverySpaceReservation> {
  return serial(async () => {
    if (uncertainLedger)
      throw refusal("outstanding disk reservations are unknown");
    const canonical = await realpath(workspace);
    await loadWorkspace(canonical);
    const record = records.get(id),
      owner = record?.intent.owner;
    if (
      !record ||
      record.intent.workspace !== canonical ||
      owner?.namespace !== context.namespace ||
      owner.projectId !== context.projectId ||
      owner.generation !== context.generation ||
      owner.rawSnapshotId !== context.snapshotId ||
      !sameSourceIdentity(
        owner,
        context.sourceContract
          ? {
              sourceManifestVersion: context.sourceContract.version,
              ...(context.sourceContract.version === 2
                ? { sourceProfileId: context.sourceContract.profileId }
                : {}),
              sourceBaseManifestId: context.sourceContract.baseManifestId,
              sourceResultManifestId: context.sourceContract.rawManifestId,
            }
          : {},
      )
    )
      throw refusal(
        "publication and original reservation are not exactly bound",
      );
    return tokenFor(record);
  });
}

export interface RetainedRecoverySpaceContext extends SourceReservationIdentity {
  namespace: "manual" | "test";
  projectId: string;
  generation: number;
  rawSnapshotId: string;
  originOperations: readonly {
    operationId: string;
    mode: string;
    phase: string;
    snapshotId: string | null;
  }[];
}

/** Capacity only. A real released source operation can reconnect its cold promise; it grants no publication or result authority. */
export function reconnectRetainedRecoverySpace(
  workspace: string,
  context: RetainedRecoverySpaceContext,
): Promise<RecoverySpaceReservation | undefined> {
  return serial(async () => {
    if (uncertainLedger)
      throw refusal("outstanding disk reservations are unknown");
    if (
      !ownerValid({ ownerKey: "0".repeat(32), ...context }) ||
      !Number.isSafeInteger(context.generation) ||
      context.generation < 1 ||
      !hash.test(context.rawSnapshotId) ||
      ([1, 2].includes(context.sourceManifestVersion ?? 0) &&
        (typeof context.sourceResultManifestId !== "string" ||
          !hash.test(context.sourceResultManifestId))) ||
      !Array.isArray(context.originOperations) ||
      context.originOperations.length > 32
    )
      throw refusal("invalid retained recovery reservation context");
    const seen = new Set<string>();
    for (const operation of context.originOperations) {
      if (
        !operation ||
        !/^[a-f0-9]{32}$/.test(operation.operationId) ||
        seen.has(operation.operationId) ||
        !["shell", "build", "install", "recovery"].includes(operation.mode) ||
        !["finished", "released"].includes(operation.phase) ||
        operation.snapshotId !== context.rawSnapshotId
      )
        throw refusal("invalid retained source operation projection");
      seen.add(operation.operationId);
    }
    const canonical = await realpath(workspace);
    await loadWorkspace(canonical);
    const candidates = [...records.values()].filter(
      (record) => record.intent.workspace === canonical,
    );
    if (!candidates.length) return undefined;
    if (candidates.length !== 1)
      throw refusal("retained recovery has multiple unresolved promises");
    const record = candidates[0]!,
      owner = record.intent.owner;
    const origin = context.originOperations.find(
      (operation) =>
        operation.operationId === owner.ownerKey &&
        ["shell", "build", "install"].includes(operation.mode) &&
        operation.phase === "released" &&
        operation.snapshotId === context.rawSnapshotId,
    );
    if (
      !record.restored ||
      owner.namespace !== context.namespace ||
      owner.projectId !== context.projectId ||
      (owner.generation !== undefined &&
        owner.generation !== context.generation) ||
      (owner.rawSnapshotId !== undefined &&
        owner.rawSnapshotId !== context.rawSnapshotId) ||
      !sameSourceIdentity(owner, context) ||
      !origin
    )
      throw refusal(
        "the original released source operation does not establish this retained promise",
      );
    const binding = {
      namespace: context.namespace,
      projectId: context.projectId,
      generation: context.generation,
      rawSnapshotId: context.rawSnapshotId,
      ...(context.sourceManifestVersion === undefined
        ? {}
        : {
            sourceManifestVersion: context.sourceManifestVersion,
            ...(context.sourceProfileId === undefined
              ? {}
              : { sourceProfileId: context.sourceProfileId }),
            sourceBaseManifestId: context.sourceBaseManifestId,
            sourceResultManifestId: context.sourceResultManifestId,
          }),
    };
    if (
      record.token &&
      (!record.retainedConnection ||
        JSON.stringify(record.retainedConnection) !== JSON.stringify(binding))
    )
      throw refusal(
        "the retained promise is already owned by an active host operation",
      );
    if (owner.generation === undefined || owner.rawSnapshotId === undefined) {
      const previous = record.intent;
      record.intent = {
        ...previous,
        owner: {
          ...owner,
          generation: context.generation,
          rawSnapshotId: context.rawSnapshotId,
        },
      };
      try {
        await writeIntent(record);
      } catch (cause) {
        record.intent = previous;
        throw cause;
      }
    }
    record.retainedConnection = binding;
    return tokenFor(record);
  });
}

async function validateLocalAnchor(
  anchor: LocalImageRecoveryAnchor,
  sameFilesystem: boolean,
): Promise<LocalImageRecoveryAnchor> {
  if (!uuid.test(anchor.projectId))
    throw refusal("invalid local image project identity");
  const workspace = await realpath(anchor.workspace),
    storage = path.resolve(anchor.storage);
  if (
    path.basename(storage) !== anchor.projectId ||
    path.basename(path.dirname(storage)) !== "image-recovery"
  )
    throw refusal(
      "local image recovery root is not the registered project anchor",
    );
  let parent = storage;
  while (true) {
    try {
      const info = await lstat(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (await realpath(parent)) !== parent
      )
        throw refusal("unsafe local image recovery anchor");
      if (sameFilesystem && info.dev !== (await lstat(workspace)).dev)
        throw refusal(
          "local image recovery and workspace are on different filesystems; no project files were changed",
        );
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const next = path.dirname(parent);
      if (next === parent) throw cause;
      parent = next;
    }
  }
  return { workspace, storage, projectId: anchor.projectId };
}

async function localIntentRoot(
  anchor: LocalImageRecoveryAnchor,
  create: boolean,
): Promise<string> {
  const root = path.join(anchor.storage, "space-reservations");
  if (create)
    for (const directory of [
      path.dirname(anchor.storage),
      anchor.storage,
      root,
    ]) {
      try {
        await mkdir(directory, { mode: 0o700 });
        await sync(path.dirname(directory));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (await realpath(directory)) !== directory
      )
        throw refusal("linked local image reservation storage");
    }
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw refusal("local image reservations are not private");
  return root;
}

async function loadLocalAnchor(
  anchor: LocalImageRecoveryAnchor,
): Promise<void> {
  let root: string;
  try {
    root = await localIntentRoot(anchor, false);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  const entries = await readdir(root);
  if (entries.length > 16)
    throw refusal("unresolved local image promises need inspection");
  if (
    [...records.values()].some(
      (record) =>
        path.dirname(record.file) === root &&
        !entries.includes(record.intent.id + ".json"),
    )
  )
    throw refusal("an active local image promise disappeared");
  for (const name of entries) {
    if (!uuid.test(name.replace(/\.json$/, "")) || !name.endsWith(".json"))
      throw refusal("unknown local image promise metadata");
    const file = path.join(root, name),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw refusal("unsafe local image promise");
    const intent = JSON.parse(
      (await readSafeProjectFile(root, file, 16384)).toString(),
    ) as Intent;
    if (
      intent.version !== 1 ||
      intent.plan?.version !== 1 ||
      intent.kind !== "local-image" ||
      intent.id + ".json" !== name ||
      intent.workspace !== anchor.workspace ||
      intent.storage !== anchor.storage ||
      intent.device !== (await lstat(anchor.storage)).dev ||
      intent.owner?.namespace !== "local-image" ||
      intent.owner.projectId !== anchor.projectId ||
      !ownerValid(intent.owner) ||
      !validRecoverySpacePlan(intent.plan)
    )
      throw refusal("invalid local image promise binding");
    const current = records.get(intent.id);
    if (current && JSON.stringify(current.intent) !== JSON.stringify(intent))
      throw refusal("local image promise changed outside its owner");
    if (!current) records.set(intent.id, { intent, file, restored: true });
  }
}

/** Root loader errors are latched inside the capacity boundary, including errors before an anchor list exists. */
export function restoreLocalImageRecoverySpaces(
  anchorsOrLoader:
    | readonly LocalImageRecoveryAnchor[]
    | Promise<readonly LocalImageRecoveryAnchor[]>
    | (() => Promise<readonly LocalImageRecoveryAnchor[]>),
): Promise<void> {
  return serial(async () => {
    try {
      const anchors = await (typeof anchorsOrLoader === "function"
        ? anchorsOrLoader()
        : anchorsOrLoader);
      for (const input of anchors) {
        const anchor = await validateLocalAnchor(input, false);
        localAnchors.set(anchor.workspace, anchor);
        await loadLocalAnchor(anchor);
      }
    } catch (cause) {
      uncertainLedger = true;
      throw cause;
    }
  });
}

export function reserveLocalImageRecoverySpace(
  anchor: LocalImageRecoveryAnchor,
  inputs: RecoverySpaceInputs,
  options: { ownerKey: string; signal?: AbortSignal },
): Promise<RecoverySpaceReservation> {
  const current = currentLocalImageRecoverySpace(anchor),
    record = current && branded.get(current);
  return reserveSpace(
    anchor.workspace,
    inputs,
    {
      ...options,
      ...(record
        ? { ownerKey: record.intent.owner.ownerKey, reuse: true }
        : {}),
      namespace: "local-image",
      projectId: anchor.projectId,
    },
    anchor,
  );
}

export async function assertLocalImagePublicationsSettled(
  input: LocalImageRecoveryAnchor,
): Promise<void> {
  const anchor = await validateLocalAnchor(input, false),
    root = path.join(anchor.storage, "image-transactions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  if (entries.length > 2000 || (await realpath(root)) !== root)
    throw refusal("local image transaction history needs inspection");
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw refusal("unknown local image transaction entry");
    const directory = path.join(root, entry.name);
    let manifest: {
      version?: number;
      kind?: string;
      state?: string;
      localWorkspace?: string;
      localProjectId?: string;
      spacePlan?: RecoverySpacePlan;
      files?: unknown[];
      versions?: unknown[];
      workspace?: string;
    };
    try {
      manifest = JSON.parse(
        (
          await readSafeProjectFile(
            root,
            path.join(directory, "manifest.json"),
            2 * MiB,
          )
        ).toString(),
      );
    } catch {
      throw refusal(
        "a local image publication has no readable terminal receipt",
      );
    }
    if (manifest.version === 1) {
      if (
        manifest.workspace !== anchor.workspace ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 16
      )
        throw refusal("unknown legacy image transaction binding");
      let marker: { version?: number; status?: string };
      try {
        marker = JSON.parse(
          (
            await readSafeProjectFile(
              root,
              path.join(directory, "committed.json"),
              512,
            )
          ).toString(),
        );
      } catch {
        throw refusal(
          "an older local image publication is unconfirmed; retained versions need inspection",
        );
      }
      if (marker.version !== 1 || marker.status !== "committed")
        throw refusal("unknown legacy image transaction outcome");
    } else if (
      manifest.version !== 3 ||
      manifest.kind !== "local-image" ||
      manifest.localWorkspace !== anchor.workspace ||
      manifest.localProjectId !== anchor.projectId ||
      !validRecoverySpacePlan(manifest.spacePlan) ||
      manifest.spacePlan.version !== 1 ||
      !["committed", "rolled-back"].includes(manifest.state ?? "") ||
      !Array.isArray(manifest.versions) ||
      manifest.versions.length > 16
    )
      throw refusal(
        "a local image publication is unconfirmed; retained versions need inspection",
      );
  }
}

/** Explicit user deletion only: caller has closed admission, drained writes and verified guest retirement/absence. No payload is removed. */
export function releaseRetiredProjectRecoverySpace(
  workspace: string,
  context: {
    namespace: "manual" | "test";
    projectId: string;
    imageStorage?: string;
    sourceRetired: boolean;
  },
): Promise<void> {
  return serial(async () => {
    const canonical = await realpath(workspace);
    const { assertSourcePublicationSettled } =
      await import("./isolated-publication-journal.js");
    await assertSourcePublicationSettled(canonical);
    await loadWorkspace(canonical);
    if (context.imageStorage) {
      const anchor = await validateLocalAnchor(
        {
          workspace: canonical,
          storage: context.imageStorage,
          projectId: context.projectId,
        },
        false,
      );
      localAnchors.set(canonical, anchor);
      await loadLocalAnchor(anchor);
      await assertLocalImagePublicationsSettled(anchor);
    }
    if (
      [...volumeRecords.values()].some(
        (record) => record.intent.workspace === canonical,
      )
    )
      throw refusal(
        "the native volume operation requires verified terminal cleanup before project deletion",
      );
    const selected = [...records.values()].filter(
      (record) => record.intent.workspace === canonical,
    );
    for (const record of selected) {
      if (
        record.intent.kind !== "local-image" &&
        context.sourceRetired !== true
      )
        throw refusal(
          "isolated source retirement was not verified; its original promise remains protected",
        );
      const sameProject = record.intent.owner.projectId === context.projectId;
      const sameScope =
        record.intent.kind === "local-image"
          ? record.intent.storage === context.imageStorage &&
            record.intent.owner.namespace === "local-image"
          : record.intent.owner.namespace === context.namespace;
      if (!sameProject || !sameScope)
        throw refusal("retired project and resource promise ownership differ");
      if (record.activeScopes)
        throw refusal(
          "a resource owner is still finishing; project data was not removed",
        );
      const actual = JSON.parse(
        (
          await readSafeProjectFile(
            path.dirname(record.file),
            record.file,
            16384,
          )
        ).toString(),
      );
      if (JSON.stringify(actual) !== JSON.stringify(record.intent))
        throw refusal("retired project promise changed before release");
    }
    for (const record of selected) {
      await rm(record.file);
      await sync(path.dirname(record.file));
      records.delete(record.intent.id);
    }
    localAnchors.delete(canonical);
  });
}

export function currentLocalImageRecoverySpace(
  anchor: LocalImageRecoveryAnchor,
): RecoverySpaceReservation | undefined {
  const token = scope.getStore(),
    record = token && branded.get(token);
  if (
    !record ||
    records.get(record.intent.id) !== record ||
    record.intent.kind !== "local-image" ||
    record.intent.workspace !== anchor.workspace ||
    record.intent.storage !== anchor.storage ||
    record.intent.owner.projectId !== anchor.projectId
  )
    return undefined;
  return token;
}
