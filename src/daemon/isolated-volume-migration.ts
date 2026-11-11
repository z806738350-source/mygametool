import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  getCapacityProfile,
  type CapacityProfile,
  type CapacityProfileId,
} from "../shared/execution-capacity-profiles.js";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const metadataLimit = 64 * 1024;
const metadataPromise = 2 * 1024 * 1024;
const inodePromise = 8;
const queues = new Map<string, Promise<unknown>>();
const live = new Set<string>();
const plans = new WeakMap<
  object,
  { store: IsolatedVolumeMigrationStore; id: string }
>();
const grants = new WeakMap<
  object,
  { store: IsolatedVolumeMigrationStore; id: string }
>();
interface MutationLease {
  store: IsolatedVolumeMigrationStore;
  root: string;
  id: string;
  nonce: string;
  device: bigint;
  inode: bigint;
}
const ownedLeases = new Map<string, MutationLease>();
export interface VolumeMigrationImage {
  imageId: string;
  profileId: CapacityProfileId;
  generation: number;
  sha256: string;
}
export interface VolumeMigrationVolume extends VolumeMigrationImage {
  namespace: "manual" | "test";
  projectId: string;
  clean: boolean;
  pending: boolean;
  running: boolean;
  complete: boolean;
  usedInodes: number;
  retainedImages: VolumeMigrationImage[];
}
/** A private experimental store, not the installed guest registry format. */
export interface VolumeMigrationRegistry {
  version: 1;
  revision: string;
  volumes: VolumeMigrationVolume[];
}
interface ImageIdentity {
  device: string;
  inode: string;
  size: number;
  mode: number;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}
export interface VolumeMigrationPlan {
  version: 1;
  id: string;
  simulationOnly: true;
  source: VolumeMigrationVolume;
  sourceIdentity: ImageIdentity;
  sourceProfile: CapacityProfile;
  targetProfile: CapacityProfile;
  targetImageId: string;
  targetGeneration: number;
  resources: {
    additionalLogicalBytes: number;
    physicalPromiseBytes: number;
    additionalInodes: number;
  };
}
interface Intent {
  version: 1;
  id: string;
  phase:
    "reserved" | "copying" | "verified" | "switch-submitting" | "committed";
  targetSha256?: string;
  targetIdentity?: ImageIdentity;
  failure?: "aborted" | "ENOSPC" | "EDQUOT" | "EIO" | "unknown";
}
export interface VolumeMigrationStatus {
  id: string;
  simulationOnly: true;
  status: "prepared" | "retained" | "committed";
  phase: "prepared" | Intent["phase"];
  confirmed: boolean;
  reservationRetained: boolean;
  sourceState:
    "original-active-verified" | "original-retained-verified" | "unverified";
  targetCopy: "absent" | "unverified" | "verified";
  mutationLease: "held" | "absent";
  interruptedCopyContinuation: "unsupported";
  automaticRollback: "unsupported";
}
export type NativeVolumeMigrationAuthorization = Readonly<{
  kind: "native-volume-migration-authorization";
}>;

function refuse(
  reason: string,
  code = "VOLUME_MIGRATION_REVIEW_REQUIRED",
): never {
  throw Object.assign(
    new Error(
      `Volume migration requires review: ${reason}. No original volume was discarded.`,
    ),
    { code },
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function serialized<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(operation);
  queues.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
async function sync(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(directory)) !== directory
  )
    refuse("unsafe private migration storage");
}
async function safeJson(file: string): Promise<unknown> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.mode & 0o077n ||
      before.size < 1n ||
      before.size > BigInt(metadataLimit)
    )
      refuse("unsafe migration metadata");
    const bytes = await handle.readFile(),
      after = await lstat(file, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.ctimeNs !== before.ctimeNs ||
      after.size !== before.size ||
      bytes.length !== Number(before.size)
    )
      refuse("migration metadata changed");
    return JSON.parse(bytes.toString());
  } finally {
    await handle.close();
  }
}
async function saveJson(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  await privateDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > metadataLimit)
    refuse("migration metadata exceeds its bound");
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`),
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path.join(directory, name));
  await sync(directory);
}
async function acquireLease(
  store: IsolatedVolumeMigrationStore,
  root: string,
  id: string,
): Promise<MutationLease> {
  const file = path.join(root, "mutation-lease.json"),
    nonce = randomUUID();
  let handle;
  try {
    handle = await open(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      refuse(
        "a durable mutation lease already exists; inspect its original migration, never expire or replace it",
        "VOLUME_MIGRATION_MUTATION_LEASE",
      );
    throw cause;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ version: 1, id, nonce, pid: process.pid }),
    );
    await handle.sync();
    const identity = await handle.stat({ bigint: true });
    await sync(root);
    const lease = {
      store,
      root,
      id,
      nonce,
      device: identity.dev,
      inode: identity.ino,
    };
    ownedLeases.set(root, lease);
    return lease;
  } finally {
    await handle.close();
  }
}
async function releaseLease(lease: MutationLease): Promise<void> {
  const file = path.join(lease.root, "mutation-lease.json"),
    info = await lstat(file, { bigint: true }),
    value = (await safeJson(file)) as {
      version: number;
      id: string;
      nonce: string;
    };
  if (
    ownedLeases.get(lease.root) !== lease ||
    info.dev !== lease.device ||
    info.ino !== lease.inode ||
    value.version !== 1 ||
    value.id !== lease.id ||
    value.nonce !== lease.nonce
  )
    refuse("the original mutation lease cannot be safely released");
  await unlink(file);
  await sync(lease.root);
  ownedLeases.delete(lease.root);
}
function imageValid(value: VolumeMigrationImage): boolean {
  try {
    return (
      !!value &&
      uuid.test(value.imageId) &&
      sha.test(value.sha256) &&
      integer(value.generation) &&
      value.generation > 0 &&
      getCapacityProfile(value.profileId).id === value.profileId
    );
  } catch {
    return false;
  }
}
function parseRegistry(value: unknown): VolumeMigrationRegistry {
  const registry = value as VolumeMigrationRegistry;
  if (
    !registry ||
    registry.version !== 1 ||
    !uuid.test(registry.revision) ||
    !Array.isArray(registry.volumes) ||
    registry.volumes.length > 96 ||
    Object.keys(registry).sort().join() !== "revision,version,volumes"
  )
    refuse("unknown migration registry");
  const identities = new Set(),
    images = new Set();
  for (const volume of registry.volumes) {
    if (
      !imageValid(volume) ||
      Object.keys(volume).sort().join() !==
        "clean,complete,generation,imageId,namespace,pending,profileId,projectId,retainedImages,running,sha256,usedInodes" ||
      !["manual", "test"].includes(volume.namespace) ||
      !uuid.test(volume.projectId) ||
      ![volume.clean, volume.pending, volume.running, volume.complete].every(
        (value) => typeof value === "boolean",
      ) ||
      !integer(volume.usedInodes) ||
      volume.usedInodes > getCapacityProfile(volume.profileId).inodeCount ||
      !Array.isArray(volume.retainedImages) ||
      volume.retainedImages.length > 16
    )
      refuse("invalid registered volume");
    const key = volume.namespace + ":" + volume.projectId;
    if (identities.has(key)) refuse("duplicate registered project");
    identities.add(key);
    for (const image of [volume, ...volume.retainedImages]) {
      if (
        !imageValid(image) ||
        images.has(image.imageId) ||
        (image !== volume &&
          Object.keys(image).sort().join() !==
            "generation,imageId,profileId,sha256")
      )
        refuse("duplicate or invalid registered image");
      images.add(image.imageId);
    }
  }
  return registry;
}
function parsePlan(value: unknown): VolumeMigrationPlan {
  const plan = value as VolumeMigrationPlan;
  if (
    !plan ||
    plan.version !== 1 ||
    !uuid.test(plan.id) ||
    plan.simulationOnly !== true ||
    !uuid.test(plan.targetImageId) ||
    !imageValid(plan.source) ||
    plan.targetGeneration !== plan.source.generation + 1 ||
    !equal(plan.sourceProfile, getCapacityProfile(plan.source.profileId)) ||
    !equal(plan.targetProfile, getCapacityProfile(plan.targetProfile?.id)) ||
    plan.targetProfile.volumeBytes <= plan.sourceProfile.volumeBytes ||
    !plan.sourceIdentity ||
    !sha.test(plan.sourceIdentity.sha256) ||
    plan.sourceIdentity.sha256 !== plan.source.sha256 ||
    plan.sourceIdentity.size !== plan.sourceProfile.volumeBytes ||
    !equal(plan.resources, {
      additionalLogicalBytes: plan.targetProfile.volumeBytes,
      physicalPromiseBytes: plan.targetProfile.volumeBytes + metadataPromise,
      additionalInodes: inodePromise,
    })
  )
    refuse("immutable migration plan is invalid or changed");
  return plan;
}
function parseIntent(value: unknown, id: string): Intent {
  const intent = value as Intent;
  if (
    !intent ||
    intent.version !== 1 ||
    intent.id !== id ||
    ![
      "reserved",
      "copying",
      "verified",
      "switch-submitting",
      "committed",
    ].includes(intent.phase) ||
    (intent.targetSha256 !== undefined && !sha.test(intent.targetSha256)) ||
    (["verified", "switch-submitting", "committed"].includes(intent.phase) &&
      (!intent.targetSha256 ||
        !intent.targetIdentity ||
        intent.targetIdentity.sha256 !== intent.targetSha256))
  )
    refuse("unknown migration phase");
  return intent;
}
async function imageIdentity(
  file: string,
  size: number,
  signal?: AbortSignal,
  prefix?: number,
): Promise<ImageIdentity> {
  signal?.throwIfAborted();
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.mode & 0o077n ||
      before.mode & 0o111n ||
      before.size !== BigInt(size) ||
      (await realpath(file)) !== file
    )
      refuse("image identity, size, mode or links are unsafe");
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(256 * 1024),
      length = prefix ?? size;
    for (let offset = 0; offset < length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, length - offset),
        offset,
      );
      if (!bytesRead) refuse("image became incomplete");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await lstat(file, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs ||
      after.nlink !== 1n ||
      after.size !== before.size ||
      after.mode !== before.mode
    )
      refuse("image changed during complete verification");
    return {
      device: String(before.dev),
      inode: String(before.ino),
      size,
      mode: Number(before.mode & 0o777n),
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      sha256: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}
/** Experimental ordinary-file transaction core. Installed guest/VM adapters are not enabled. */
export class IsolatedVolumeMigrationStore {
  private readonly options: {
    directory: string;
    runtime: {
      kind: "local-fixture" | "controlled-backend";
      supported: boolean;
    };
  };
  constructor(options: {
    directory: string;
    runtime: {
      kind: "local-fixture" | "controlled-backend";
      supported: boolean;
    };
  }) {
    this.options = Object.freeze({
      directory: options.directory,
      runtime: Object.freeze({ ...options.runtime }),
    });
  }
  private supported(): void {
    if (
      this.options.runtime.kind !== "local-fixture" ||
      this.options.runtime.supported !== true
    )
      refuse(
        "this runtime does not support reviewed volume migration",
        "VOLUME_MIGRATION_UNSUPPORTED",
      );
  }
  private async root(): Promise<string> {
    this.supported();
    const initial = await lstat(this.options.directory);
    if (initial.isSymbolicLink()) refuse("linked migration root");
    const root = await realpath(this.options.directory);
    await privateDirectory(root);
    await privateDirectory(path.join(root, "images"));
    await privateDirectory(path.join(root, "migrations"));
    return root;
  }
  private image(root: string, id: string): string {
    if (!uuid.test(id)) refuse("invalid image identity");
    return path.join(root, "images", id + ".img");
  }
  private directory(root: string, id: string): string {
    if (!uuid.test(id)) refuse("invalid migration identity");
    return path.join(root, "migrations", id);
  }
  private async registry(root: string): Promise<VolumeMigrationRegistry> {
    return parseRegistry(await safeJson(path.join(root, "registry.json")));
  }
  private async plan(root: string, id: string): Promise<VolumeMigrationPlan> {
    const directory = this.directory(root, id);
    await privateDirectory(directory);
    const plan = parsePlan(await safeJson(path.join(directory, "plan.json")));
    if (plan.id !== id) refuse("migration plan identity differs");
    return plan;
  }
  private current(
    registry: VolumeMigrationRegistry,
    plan: VolumeMigrationPlan,
  ): VolumeMigrationVolume {
    const current = registry.volumes.find(
      (value) =>
        value.namespace === plan.source.namespace &&
        value.projectId === plan.source.projectId,
    );
    if (
      !current ||
      !equal(current, plan.source) ||
      !current.clean ||
      current.pending ||
      current.running ||
      !current.complete
    )
      refuse("source project, profile, generation or clean state changed");
    return current;
  }
  private async intents(
    root: string,
  ): Promise<{ plan: VolumeMigrationPlan; intent: Intent }[]> {
    const result = [];
    const names = await readdir(path.join(root, "migrations"));
    if (names.length > 96) refuse("migration history reached its fixed bound");
    for (const id of names) {
      const plan = await this.plan(root, id);
      const entries = await readdir(this.directory(root, id));
      if (
        entries.some(
          (name) =>
            !["plan.json", "authorization.json", "intent.json"].includes(name),
        )
      )
        refuse("unknown or unfinished migration metadata");
      if (!entries.includes("intent.json")) continue;
      await this.authorization(root, plan);
      result.push({
        plan,
        intent: parseIntent(
          await safeJson(path.join(this.directory(root, id), "intent.json")),
          id,
        ),
      });
    }
    return result;
  }
  private async capacity(
    root: string,
    registry: VolumeMigrationRegistry,
    target: CapacityProfile,
    excluding?: string,
  ): Promise<void> {
    const allIntents = await this.intents(root),
      pending = allIntents.filter(
        (value) =>
          value.plan.id !== excluding && value.intent.phase !== "committed",
      ),
      images = registry.volumes.flatMap((value) => [
        value,
        ...value.retainedImages,
      ]),
      registered = new Set(images.map((image) => image.imageId));
    const known = new Set([
      ...registered,
      ...allIntents
        .filter((value) => value.intent.phase !== "committed")
        .map((value) => value.plan.targetImageId),
    ]);
    for (const name of await readdir(path.join(root, "images")))
      if (!name.endsWith(".img") || !known.has(name.slice(0, -4)))
        refuse("unmapped image bytes cannot be omitted from capacity");
    for (const value of allIntents)
      if (
        value.intent.phase === "committed" &&
        !registered.has(value.plan.targetImageId)
      )
        refuse("a committed target disappeared from the registry");
    const logical =
      images.reduce(
        (sum, image) => sum + getCapacityProfile(image.profileId).volumeBytes,
        0,
      ) +
      pending.reduce(
        (sum, value) => sum + value.plan.targetProfile.volumeBytes,
        0,
      );
    if (logical + target.volumeBytes > target.globalVolumeBytes)
      refuse(
        "both volumes and retained backups exceed the global logical quota",
        "VOLUME_MIGRATION_GLOBAL_QUOTA",
      );
    if (registry.volumes.length + pending.length + 1 > target.residentVolumes)
      refuse(
        "the staging volume has no resident slot",
        "VOLUME_MIGRATION_RESIDENT_LIMIT",
      );
    if (
      registry.volumes.filter((value) => value.running).length +
        pending.length +
        1 >
      target.globalOperations
    )
      refuse(
        "the global operation slots are occupied",
        "VOLUME_MIGRATION_OPERATION_LIMIT",
      );
    let potentialGrowth = 0n;
    for (const image of images) {
      const info = await lstat(this.image(root, image.imageId), {
        bigint: true,
      });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.uid !== BigInt(process.getuid?.() ?? -1) ||
        info.mode & 0o077n ||
        info.size !== BigInt(getCapacityProfile(image.profileId).volumeBytes) ||
        (await realpath(this.image(root, image.imageId))) !==
          this.image(root, image.imageId)
      )
        refuse("registered image inventory is incomplete or linked");
      potentialGrowth +=
        info.size > info.blocks * 512n ? info.size - info.blocks * 512n : 0n;
    }
    let ownAllocated = 0n;
    if (excluding) {
      const own = allIntents.find((value) => value.plan.id === excluding);
      if (!own) refuse("original migration promise is missing");
      const info = await lstat(this.image(root, own.plan.targetImageId), {
        bigint: true,
      });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.size !== BigInt(target.volumeBytes)
      )
        refuse("original target allocation changed");
      ownAllocated =
        info.blocks * 512n > info.size ? info.size : info.blocks * 512n;
    }
    const disk = await statfs(root, { bigint: true }),
      outstanding = pending.reduce(
        (sum, value) => sum + BigInt(value.plan.resources.physicalPromiseBytes),
        0n,
      ),
      required =
        BigInt(target.volumeBytes + metadataPromise + target.reserveBytes) -
        ownAllocated +
        potentialGrowth +
        outstanding;
    if (
      disk.bsize <= 0n ||
      disk.bavail < 0n ||
      disk.bavail * disk.bsize < required
    )
      refuse(
        "physical free bytes no longer cover both volumes, other promises and the safety floor",
        "VOLUME_MIGRATION_FREE_BYTES",
      );
    if (disk.ffree < BigInt((pending.length + 1) * inodePromise))
      refuse(
        "outer filesystem inode reservations are insufficient",
        "VOLUME_MIGRATION_INODES",
      );
  }
  async prepare(
    request: {
      namespace: "manual" | "test";
      projectId: string;
      targetProfileId: CapacityProfileId;
      expectedGeneration: number;
      expectedSourceSha256: string;
    },
    signal?: AbortSignal,
  ): Promise<VolumeMigrationPlan> {
    const root = await this.root();
    return serialized(root, async () => {
      signal?.throwIfAborted();
      const id = randomUUID(),
        lease = await acquireLease(this, root, id);
      let mutated = false;
      try {
        signal?.throwIfAborted();
        if (
          !request ||
          !["manual", "test"].includes(request.namespace) ||
          !uuid.test(request.projectId) ||
          !integer(request.expectedGeneration) ||
          !sha.test(request.expectedSourceSha256)
        )
          refuse("invalid migration request");
        const registry = await this.registry(root),
          source = registry.volumes.find(
            (value) =>
              value.namespace === request.namespace &&
              value.projectId === request.projectId,
          ),
          target = getCapacityProfile(request.targetProfileId);
        if (
          !source ||
          source.generation !== request.expectedGeneration ||
          source.sha256 !== request.expectedSourceSha256 ||
          !source.clean ||
          source.pending ||
          source.running ||
          !source.complete
        )
          refuse("source project is not an exact clean, idle, complete volume");
        if (
          target.volumeBytes <=
            getCapacityProfile(source.profileId).volumeBytes ||
          source.usedInodes > target.inodeCount
        )
          refuse(
            "shrinking, equal-size migration or insufficient target inodes is unsupported",
          );
        if (
          (await this.intents(root)).some(
            (value) =>
              value.intent.phase !== "committed" &&
              value.plan.source.namespace === source.namespace &&
              value.plan.source.projectId === source.projectId,
          )
        )
          refuse(
            "the original migration must be inspected by its existing ID",
            "VOLUME_MIGRATION_CONFLICT",
          );
        if ((await readdir(path.join(root, "migrations"))).length >= 96)
          refuse(
            "migration history reached its fixed bound; no existing plan was removed",
            "VOLUME_MIGRATION_HISTORY_LIMIT",
          );
        await this.capacity(root, registry, target);
        const sourceIdentity = await imageIdentity(
          this.image(root, source.imageId),
          getCapacityProfile(source.profileId).volumeBytes,
          signal,
        );
        if (sourceIdentity.sha256 !== source.sha256)
          refuse("complete source hash differs");
        const plan: VolumeMigrationPlan = {
          version: 1,
          id,
          simulationOnly: true,
          source,
          sourceIdentity,
          sourceProfile: getCapacityProfile(source.profileId),
          targetProfile: target,
          targetImageId: randomUUID(),
          targetGeneration: source.generation + 1,
          resources: {
            additionalLogicalBytes: target.volumeBytes,
            physicalPromiseBytes: target.volumeBytes + metadataPromise,
            additionalInodes: inodePromise,
          },
        };
        signal?.throwIfAborted();
        const directory = this.directory(root, plan.id);
        mutated = true;
        await mkdir(directory, { mode: 0o700 });
        await sync(path.dirname(directory));
        await saveJson(directory, "plan.json", plan);
        freeze(plan);
        plans.set(plan, { store: this, id: plan.id });
        await releaseLease(lease);
        return plan;
      } catch (cause) {
        if (!mutated) await releaseLease(lease).catch(() => {});
        throw cause;
      }
    });
  }
  /** Called only by mintNativeVolumeMigrationAuthorization, never by an Agent tool. */
  async authorizeFromNative(
    plan: VolumeMigrationPlan,
  ): Promise<NativeVolumeMigrationAuthorization> {
    const brand = plans.get(plan);
    if (!brand || brand.store !== this || brand.id !== plan.id)
      refuse(
        "a host-native plan confirmation is required",
        "VOLUME_MIGRATION_NATIVE_APPROVAL_REQUIRED",
      );
    const root = await this.root();
    return serialized(root, async () => {
      const lease = await acquireLease(this, root, plan.id);
      let mutated = false;
      try {
        const stored = await this.plan(root, plan.id);
        if (!equal(stored, plan)) refuse("the reviewed plan changed");
        const directory = this.directory(root, plan.id),
          file = path.join(directory, "authorization.json");
        try {
          const authorization = (await safeJson(file)) as {
            version: number;
            id: string;
            plan: VolumeMigrationPlan;
          };
          if (
            authorization.version !== 1 ||
            authorization.id !== plan.id ||
            !equal(authorization.plan, plan)
          )
            refuse("native authorization differs from its immutable plan");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          mutated = true;
          await saveJson(directory, "authorization.json", {
            version: 1,
            id: plan.id,
            plan,
            authorizedAt: new Date().toISOString(),
          });
        }
        const grant = Object.freeze({
          kind: "native-volume-migration-authorization" as const,
        });
        grants.set(grant, { store: this, id: plan.id });
        await releaseLease(lease);
        return grant;
      } catch (cause) {
        if (!mutated) await releaseLease(lease).catch(() => {});
        throw cause;
      }
    });
  }
  private async authorization(
    root: string,
    plan: VolumeMigrationPlan,
  ): Promise<void> {
    const value = (await safeJson(
      path.join(this.directory(root, plan.id), "authorization.json"),
    )) as { version: number; id: string; plan: VolumeMigrationPlan };
    if (value.version !== 1 || value.id !== plan.id || !equal(value.plan, plan))
      refuse("durable native authorization is not exactly bound");
  }
  async start(
    plan: VolumeMigrationPlan,
    grant: NativeVolumeMigrationAuthorization,
    signal?: AbortSignal,
  ): Promise<VolumeMigrationStatus> {
    const brand = grants.get(grant);
    if (
      !brand ||
      brand.store !== this ||
      brand.id !== plan.id ||
      plans.get(plan)?.store !== this
    )
      refuse(
        "a host-native authorization token is required",
        "VOLUME_MIGRATION_NATIVE_APPROVAL_REQUIRED",
      );
    const root = await this.root(),
      key = root + ":" + plan.id;
    let lease: MutationLease | undefined;
    const admitted = await serialized(root, async () => {
      signal?.throwIfAborted();
      const stored = await this.plan(root, plan.id);
      if (!equal(stored, plan)) refuse("the reviewed plan changed");
      await this.authorization(root, plan);
      try {
        await safeJson(path.join(this.directory(root, plan.id), "intent.json"));
        return false;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      lease = await acquireLease(this, root, plan.id);
      let mutated = false;
      try {
        const registry = await this.registry(root);
        this.current(registry, plan);
        if (
          !equal(
            await imageIdentity(
              this.image(root, plan.source.imageId),
              plan.sourceProfile.volumeBytes,
              signal,
            ),
            plan.sourceIdentity,
          )
        )
          refuse("the approved source identity changed");
        const pending = await this.intents(root);
        if (
          pending.some(
            (value) =>
              value.intent.phase !== "committed" &&
              value.plan.source.namespace === plan.source.namespace &&
              value.plan.source.projectId === plan.source.projectId,
          )
        )
          refuse(
            "a different original migration is still unresolved",
            "VOLUME_MIGRATION_CONFLICT",
          );
        await this.capacity(root, registry, plan.targetProfile);
        mutated = true;
        await saveJson(this.directory(root, plan.id), "intent.json", {
          version: 1,
          id: plan.id,
          phase: "reserved",
        });
        live.add(key);
        return true;
      } catch (cause) {
        if (!mutated) await releaseLease(lease).catch(() => {});
        throw cause;
      }
    });
    if (!admitted) return this.reconcile(plan.id, signal);
    let intent: Intent = { version: 1, id: plan.id, phase: "reserved" };
    try {
      intent.phase = "copying";
      await saveJson(this.directory(root, plan.id), "intent.json", intent);
      await privateDirectory(path.join(root, "images"));
      const input = await open(
        this.image(root, plan.source.imageId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let output: Awaited<ReturnType<typeof open>> | undefined;
      try {
        output = await open(
          this.image(root, plan.targetImageId),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW,
          0o600,
        );
        const buffer = Buffer.alloc(256 * 1024),
          expected = createHash("sha256");
        for (let position = 0; position < plan.sourceProfile.volumeBytes;) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, plan.sourceProfile.volumeBytes - position),
            position,
          );
          if (!bytesRead) refuse("source copy became incomplete");
          expected.update(buffer.subarray(0, bytesRead));
          for (let offset = 0; offset < bytesRead;) {
            const written = await output.write(
              buffer,
              offset,
              bytesRead - offset,
              position + offset,
            );
            if (!written.bytesWritten) refuse("target copy made no progress");
            offset += written.bytesWritten;
          }
          position += bytesRead;
        }
        signal?.throwIfAborted();
        await output.truncate(plan.targetProfile.volumeBytes);
        await output.sync();
        buffer.fill(0);
        for (
          let remaining =
            plan.targetProfile.volumeBytes - plan.sourceProfile.volumeBytes;
          remaining > 0;
          remaining -= buffer.length
        ) {
          signal?.throwIfAborted();
          expected.update(
            buffer.subarray(0, Math.min(buffer.length, remaining)),
          );
        }
        const actual = await imageIdentity(
          this.image(root, plan.targetImageId),
          plan.targetProfile.volumeBytes,
          signal,
        );
        if (actual.sha256 !== expected.digest("hex"))
          refuse(
            "the complete target differs from the approved copy-and-zero-extension recipe",
          );
      } finally {
        await input.close();
        await output?.close();
      }
      await sync(path.join(root, "images"));
      if (
        !equal(
          await imageIdentity(
            this.image(root, plan.source.imageId),
            plan.sourceProfile.volumeBytes,
            signal,
          ),
          plan.sourceIdentity,
        ) ||
        (
          await imageIdentity(
            this.image(root, plan.targetImageId),
            plan.targetProfile.volumeBytes,
            signal,
            plan.sourceProfile.volumeBytes,
          )
        ).sha256 !== plan.source.sha256
      )
        refuse("complete original bytes or target copy differ");
      const targetIdentity = await imageIdentity(
        this.image(root, plan.targetImageId),
        plan.targetProfile.volumeBytes,
        signal,
      );
      intent = {
        ...intent,
        phase: "verified",
        targetSha256: targetIdentity.sha256,
        targetIdentity,
      };
      await saveJson(this.directory(root, plan.id), "intent.json", intent);
      await serialized(root, async () => {
        signal?.throwIfAborted();
        const registry = await this.registry(root);
        this.current(registry, plan);
        if (!equal(await this.plan(root, plan.id), plan))
          refuse("the immutable plan changed before the pointer switch");
        await this.authorization(root, plan);
        await this.capacity(root, registry, plan.targetProfile, plan.id);
        if (
          !equal(
            await imageIdentity(
              this.image(root, plan.source.imageId),
              plan.sourceProfile.volumeBytes,
              signal,
            ),
            plan.sourceIdentity,
          ) ||
          !equal(
            await imageIdentity(
              this.image(root, plan.targetImageId),
              plan.targetProfile.volumeBytes,
              signal,
            ),
            intent.targetIdentity,
          )
        )
          refuse("verified migration images changed before the switch");
        intent.phase = "switch-submitting";
        await saveJson(this.directory(root, plan.id), "intent.json", intent);
        signal?.throwIfAborted();
        const next: VolumeMigrationRegistry = {
          ...registry,
          revision: randomUUID(),
          volumes: registry.volumes.map((volume) =>
            volume.namespace === plan.source.namespace &&
            volume.projectId === plan.source.projectId
              ? {
                  ...volume,
                  imageId: plan.targetImageId,
                  profileId: plan.targetProfile.id,
                  generation: plan.targetGeneration,
                  sha256: intent.targetSha256!,
                  retainedImages: [
                    ...volume.retainedImages,
                    {
                      imageId: volume.imageId,
                      profileId: volume.profileId,
                      generation: volume.generation,
                      sha256: volume.sha256,
                    },
                  ],
                }
              : volume,
          ),
        };
        if (!equal(await this.registry(root), registry))
          refuse("registry changed before the atomic pointer switch");
        await saveJson(root, "registry.json", next);
      });
      return await this.complete(plan.id, signal, lease);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      intent.failure = signal?.aborted
        ? "aborted"
        : code === "ENOSPC" || code === "EDQUOT" || code === "EIO"
          ? code
          : "unknown";
      try {
        await saveJson(this.directory(root, plan.id), "intent.json", intent);
      } catch {
        /* The last durable phase retains the original reservation. */
      }
      throw cause;
    } finally {
      live.delete(key);
    }
  }
  private async observation(
    root: string,
    plan: VolumeMigrationPlan,
    intent: Intent | undefined,
    signal?: AbortSignal,
  ): Promise<VolumeMigrationStatus> {
    signal?.throwIfAborted();
    const registry = await this.registry(root),
      current = registry.volumes.find(
        (volume) =>
          volume.namespace === plan.source.namespace &&
          volume.projectId === plan.source.projectId,
      );
    let sourceVerified = false,
      targetCopy: VolumeMigrationStatus["targetCopy"] = "absent",
      mutationLease: VolumeMigrationStatus["mutationLease"] = "absent";
    try {
      sourceVerified = equal(
        await imageIdentity(
          this.image(root, plan.source.imageId),
          plan.sourceProfile.volumeBytes,
          signal,
        ),
        plan.sourceIdentity,
      );
    } catch {
      signal?.throwIfAborted();
    }
    try {
      const info = await lstat(this.image(root, plan.targetImageId));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.mode & 0o077 ||
        info.uid !== process.getuid?.()
      )
        refuse("unsafe retained target copy");
      targetCopy = "unverified";
      if (
        info.size === plan.targetProfile.volumeBytes &&
        intent?.targetSha256 &&
        equal(
          await imageIdentity(
            this.image(root, plan.targetImageId),
            plan.targetProfile.volumeBytes,
            signal,
          ),
          intent.targetIdentity,
        )
      )
        targetCopy = "verified";
    } catch (cause) {
      signal?.throwIfAborted();
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    try {
      await lstat(path.join(root, "mutation-lease.json"));
      mutationLease = "held";
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const originalActive = !!current && equal(current, plan.source),
      switched =
        !!intent &&
        ["switch-submitting", "committed"].includes(intent.phase) &&
        sourceVerified &&
        targetCopy === "verified" &&
        current?.imageId === plan.targetImageId &&
        current.profileId === plan.targetProfile.id &&
        current.generation === plan.targetGeneration &&
        current.sha256 === intent.targetSha256 &&
        current.clean &&
        !current.pending &&
        !current.running &&
        current.complete &&
        current.retainedImages.some((image) =>
          equal(image, {
            imageId: plan.source.imageId,
            profileId: plan.source.profileId,
            generation: plan.source.generation,
            sha256: plan.source.sha256,
          }),
        );
    return {
      id: plan.id,
      simulationOnly: true,
      status: switched ? "committed" : intent ? "retained" : "prepared",
      phase: intent?.phase ?? "prepared",
      confirmed: switched,
      reservationRetained:
        mutationLease === "held" ||
        (!!intent && intent.phase !== "committed") ||
        (!!intent && !switched),
      sourceState:
        sourceVerified && originalActive
          ? "original-active-verified"
          : sourceVerified &&
              current?.retainedImages.some((image) =>
                equal(image, {
                  imageId: plan.source.imageId,
                  profileId: plan.source.profileId,
                  generation: plan.source.generation,
                  sha256: plan.source.sha256,
                }),
              )
            ? "original-retained-verified"
            : "unverified",
      targetCopy,
      mutationLease,
      interruptedCopyContinuation: "unsupported",
      automaticRollback: "unsupported",
    };
  }
  async inspect(
    id: string,
    signal?: AbortSignal,
  ): Promise<VolumeMigrationStatus> {
    const root = await this.root(),
      plan = await this.plan(root, id);
    let intent: Intent | undefined;
    try {
      intent = parseIntent(
        await safeJson(path.join(this.directory(root, id), "intent.json")),
        id,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (intent) await this.authorization(root, plan);
    return this.observation(root, plan, intent, signal);
  }
  async inspectMutationLease(): Promise<{
    state: "absent" | "held" | "unknown";
    migrationId?: string;
    canReclaim: false;
  }> {
    const root = await this.root();
    try {
      const value = (await safeJson(
        path.join(root, "mutation-lease.json"),
      )) as { version: number; id: string };
      return value.version === 1 && uuid.test(value.id)
        ? { state: "held", migrationId: value.id, canReclaim: false }
        : { state: "unknown", canReclaim: false };
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "absent", canReclaim: false }
        : { state: "unknown", canReclaim: false };
    }
  }
  private async complete(
    id: string,
    signal?: AbortSignal,
    lease?: MutationLease,
  ): Promise<VolumeMigrationStatus> {
    const root = await this.root();
    return serialized(root, async () => {
      signal?.throwIfAborted();
      const plan = await this.plan(root, id),
        directory = this.directory(root, id);
      await this.authorization(root, plan);
      let intent: Intent;
      try {
        intent = parseIntent(
          await safeJson(path.join(directory, "intent.json")),
          id,
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        return this.observation(root, plan, undefined, signal);
      }
      const status = await this.observation(root, plan, intent, signal);
      // A stale lease is never expired, stolen or removed by a new process.
      // It may report a verified switch while retaining the mutation barrier.
      if (
        !status.confirmed ||
        !lease ||
        lease.store !== this ||
        lease.id !== id ||
        ownedLeases.get(root) !== lease
      )
        return status;
      if (intent.phase !== "committed")
        await saveJson(directory, "intent.json", {
          ...intent,
          phase: "committed",
        });
      await releaseLease(lease);
      return {
        ...status,
        phase: "committed",
        reservationRetained: false,
        mutationLease: "absent",
      };
    });
  }
  /** No copy, growth, new target or pointer replay. New-process stale leases remain explicit. */
  async reconcile(
    id: string,
    signal?: AbortSignal,
  ): Promise<VolumeMigrationStatus> {
    const root = await this.root(),
      lease = ownedLeases.get(root);
    return this.complete(
      id,
      signal,
      lease?.store === this && lease.id === id && !live.has(root + ":" + id)
        ? lease
        : undefined,
    );
  }
}
/** Host-native handler only. Never expose this mint as an Agent tool or JSON approval argument. */
export function mintNativeVolumeMigrationAuthorization(
  store: IsolatedVolumeMigrationStore,
  plan: VolumeMigrationPlan,
): Promise<NativeVolumeMigrationAuthorization> {
  return store.authorizeFromNative(plan);
}
