import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getCapacityProfile } from "../src/shared/execution-capacity-profiles.js";
import {
  IsolatedVolumeMigrationStore,
  mintNativeVolumeMigrationAuthorization,
  type VolumeMigrationRegistry,
  type VolumeMigrationVolume,
  type VolumeMigrationPlan,
} from "../src/daemon/isolated-volume-migration.js";

const roots: string[] = [];
const reads = vi.hoisted(() => ({ flags: [] as number[] }));
const fault = vi.hoisted(() => ({
  bytes: undefined as bigint | undefined,
  inodes: undefined as bigint | undefined,
  write: undefined as
    ((file: string, partial: () => Promise<void>) => Promise<void>) | undefined,
  writeFile: undefined as
    | ((
        file: string,
        bytes: Uint8Array,
        partial: () => Promise<void>,
      ) => Promise<void>)
    | undefined,
  sync: undefined as ((file: string) => Promise<void>) | undefined,
  rename: undefined as
    ((source: string, target: string) => Promise<void>) | undefined,
  truncate: undefined as ((file: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (...args: Parameters<typeof actual.statfs>) => {
      const value = await actual.statfs(...args);
      return {
        ...value,
        ...(fault.bytes === undefined
          ? {}
          : { bsize: 1n, bavail: fault.bytes }),
        ...(fault.inodes === undefined ? {} : { ffree: fault.inodes }),
      };
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await fault.rename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        file = String(args[0]);
      if (
        typeof args[1] === "number" &&
        !(args[1] & constants.O_CREAT) &&
        /\.(?:json|img)$/.test(file)
      )
        reads.flags.push(args[1]);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "write")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              await fault.write?.(file, async () => {
                await target.write(
                  buffer,
                  offset,
                  Math.min(2, length),
                  position,
                );
              });
              return target.write(buffer, offset, length, position);
            };
          if (key === "writeFile")
            return async (bytes: Uint8Array) => {
              await fault.writeFile?.(file, bytes, async () => {
                await target.writeFile(bytes.subarray(0, 5));
              });
              return target.writeFile(bytes);
            };
          if (key === "sync")
            return async () => {
              await fault.sync?.(file);
              return target.sync();
            };
          if (key === "truncate")
            return async (length: number) => {
              await target.truncate(length);
              await fault.truncate?.(file);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
afterEach(async () => {
  reads.flags.length = 0;
  for (const key of Object.keys(fault))
    fault[key as keyof typeof fault] = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function fixtureHash(header: Buffer, size: number): string {
  const hash = createHash("sha256").update(header),
    zero = Buffer.alloc(1024 * 1024);
  for (let left = size - header.length; left > 0; left -= zero.length)
    hash.update(zero.subarray(0, Math.min(left, zero.length)));
  return hash.digest("hex");
}
async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-volume-migration-")),
  );
  roots.push(directory);
  for (const name of ["images", "migrations"])
    await mkdir(path.join(directory, name), { mode: 0o700 });
  const profile = getCapacityProfile("capacity-64-v1"),
    imageId = randomUUID(),
    header = Buffer.from("synthetic ordinary file image; no filesystem\n"),
    image = path.join(directory, "images", imageId + ".img"),
    handle = await open(image, "wx", 0o600);
  try {
    await handle.writeFile(header);
    await handle.truncate(profile.volumeBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const source: VolumeMigrationVolume = {
    namespace: "test",
    projectId: randomUUID(),
    imageId,
    profileId: profile.id,
    generation: 1,
    sha256: fixtureHash(header, profile.volumeBytes),
    clean: true,
    pending: false,
    running: false,
    complete: true,
    usedInodes: 1,
    retainedImages: [],
  };
  const registry: VolumeMigrationRegistry = {
    version: 1,
    revision: randomUUID(),
    volumes: [source],
  };
  await writeFile(
    path.join(directory, "registry.json"),
    JSON.stringify(registry),
    { mode: 0o600 },
  );
  const store = new IsolatedVolumeMigrationStore({
    directory,
    runtime: { kind: "local-fixture", supported: true },
  });
  const request = {
    namespace: source.namespace,
    projectId: source.projectId,
    targetProfileId: "capacity-128-v1" as const,
    expectedGeneration: source.generation,
    expectedSourceSha256: source.sha256,
  };
  return { directory, image, source, registry, store, request, header };
}
async function approved() {
  const value = await fixture(),
    plan = await value.store.prepare(value.request),
    grant = await mintNativeVolumeMigrationAuthorization(value.store, plan);
  return {
    ...value,
    plan,
    grant,
    target: path.join(value.directory, "images", plan.targetImageId + ".img"),
    migration: path.join(value.directory, "migrations", plan.id),
  };
}
async function registryAt(directory: string): Promise<VolumeMigrationRegistry> {
  return JSON.parse(
    await readFile(path.join(directory, "registry.json"), "utf8"),
  );
}

it.each([
  { kind: "controlled-backend", supported: false },
  { kind: "controlled-backend", supported: true },
  { kind: "local-fixture", supported: false },
] as const)(
  "refuses unsupported runtime $kind/$supported before reading, claiming or creating storage",
  async (runtime) => {
    const directory = path.join(
        tmpdir(),
        "nonexistent-migration-" + randomUUID(),
      ),
      store = new IsolatedVolumeMigrationStore({ directory, runtime });
    await expect(
      store.prepare({
        namespace: "test",
        projectId: randomUUID(),
        targetProfileId: "capacity-128-v1",
        expectedGeneration: 1,
        expectedSourceSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "VOLUME_MIGRATION_UNSUPPORTED" });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("copies and verifies a synthetic ordinary image, atomically switches its pointer, and retains the exact old image", async () => {
  const { directory, store, plan, grant, source, image, target, header } =
      await approved(),
    old = await lstat(image);
  const status = await store.start(plan, grant);
  expect(status).toMatchObject({
    status: "committed",
    confirmed: true,
    simulationOnly: true,
    reservationRetained: false,
    mutationLease: "absent",
    sourceState: "original-retained-verified",
    targetCopy: "verified",
    interruptedCopyContinuation: "unsupported",
    automaticRollback: "unsupported",
  });
  const registry = await registryAt(directory),
    current = registry.volumes[0]!;
  expect(current).toMatchObject({
    imageId: plan.targetImageId,
    profileId: "capacity-128-v1",
    generation: 2,
    retainedImages: [
      {
        imageId: source.imageId,
        profileId: source.profileId,
        generation: 1,
        sha256: source.sha256,
      },
    ],
  });
  expect((await lstat(image)).ino).toBe(old.ino);
  expect((await lstat(image)).size).toBe(256 * 1024 * 1024);
  const handle = await open(target, "r");
  try {
    const bytes = Buffer.alloc(header.length);
    await handle.read(bytes, 0, bytes.length, 0);
    expect(bytes).toEqual(header);
  } finally {
    await handle.close();
  }
  expect((await lstat(target)).size).toBe(512 * 1024 * 1024);
  const before = await lstat(target),
    fresh = new IsolatedVolumeMigrationStore({
      directory,
      runtime: { kind: "local-fixture", supported: true },
    });
  expect(await fresh.reconcile(plan.id)).toMatchObject({
    confirmed: true,
    reservationRetained: false,
  });
  expect(await store.start(plan, grant)).toMatchObject({ confirmed: true });
  const after = await lstat(target);
  expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
    before.ino,
    before.mtimeMs,
    before.ctimeMs,
  ]);
  expect(
    (
      await stat(
        path.join(directory, "migrations", plan.id, "authorization.json"),
      )
    ).mode & 0o777,
  ).toBe(0o600);
  expect(reads.flags.length).toBeGreaterThan(0);
  expect(reads.flags.every((flags) => !!(flags & constants.O_NONBLOCK))).toBe(
    true,
  );
  await rm(path.join(directory, "migrations", plan.id, "authorization.json"));
  await expect(fresh.inspect(plan.id)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fresh.reconcile(plan.id)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    fresh.prepare({
      namespace: current.namespace,
      projectId: current.projectId,
      targetProfileId: "capacity-256-v1",
      expectedGeneration: current.generation,
      expectedSourceSha256: current.sha256,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(path.join(directory, "images"))).toHaveLength(2);
}, 60000);

it("requires the host-native plan and opaque grant, never a model boolean, JSON grant or cloned plan", async () => {
  const { directory, store, plan, grant } = await approved();
  for (const fake of [
    true,
    { approved: true },
    JSON.parse(JSON.stringify(grant)),
  ])
    await expect(store.start(plan, fake as never)).rejects.toMatchObject({
      code: "VOLUME_MIGRATION_NATIVE_APPROVAL_REQUIRED",
    });
  await expect(
    mintNativeVolumeMigrationAuthorization(
      store,
      JSON.parse(JSON.stringify(plan)),
    ),
  ).rejects.toMatchObject({
    code: "VOLUME_MIGRATION_NATIVE_APPROVAL_REQUIRED",
  });
  await expect(
    store.start(JSON.parse(JSON.stringify(plan)), grant),
  ).rejects.toMatchObject({
    code: "VOLUME_MIGRATION_NATIVE_APPROVAL_REQUIRED",
  });
  expect(await readdir(path.join(directory, "images"))).toHaveLength(1);
  expect(await store.inspectMutationLease()).toEqual({
    state: "absent",
    canReclaim: false,
  });
});

it.each([
  "dirty",
  "pending",
  "running",
  "incomplete",
  "generation",
  "hash",
  "legacy",
])("refuses a %s source before staging any target", async (issue) => {
  const value = await fixture(),
    original = await readFile(
      path.join(value.directory, "registry.json"),
      "utf8",
    );
  if (issue === "dirty") value.registry.volumes[0]!.clean = false;
  if (issue === "pending") value.registry.volumes[0]!.pending = true;
  if (issue === "running") value.registry.volumes[0]!.running = true;
  if (issue === "incomplete") value.registry.volumes[0]!.complete = false;
  if (issue === "legacy") (value.registry as { version: number }).version = 2;
  await writeFile(
    path.join(value.directory, "registry.json"),
    JSON.stringify(value.registry),
  );
  const request = {
    ...value.request,
    ...(issue === "generation" ? { expectedGeneration: 2 } : {}),
    ...(issue === "hash" ? { expectedSourceSha256: "b".repeat(64) } : {}),
  };
  await expect(value.store.prepare(request)).rejects.toThrow();
  expect(await readdir(path.join(value.directory, "images"))).toHaveLength(1);
  expect(await readdir(path.join(value.directory, "migrations"))).toEqual([]);
  expect(await value.store.inspectMutationLease()).toMatchObject({
    state: "absent",
  });
  expect(original).not.toContain("authorizedAt");
});

it.each(["symlink", "hardlink", "mode"])(
  "rejects a %s original image instead of following or copying it",
  async (issue) => {
    const value = await fixture();
    if (issue === "symlink") {
      const actual = path.join(value.directory, "original.img");
      await renameFile(value.image, actual);
      await symlink(actual, value.image);
    }
    if (issue === "hardlink")
      await link(value.image, path.join(value.directory, "second.img"));
    if (issue === "mode") await chmod(value.image, 0o644);
    await expect(value.store.prepare(value.request)).rejects.toThrow();
    expect(await readdir(path.join(value.directory, "migrations"))).toEqual([]);
  },
);
async function renameFile(source: string, target: string) {
  const fs = await import("node:fs/promises");
  await fs.rename(source, target);
}

it.each(["source", "generation", "plan"])(
  "rejects %s drift after durable approval without overwriting the source",
  async (issue) => {
    const value = await approved();
    if (issue === "source") {
      const handle = await open(value.image, "r+");
      try {
        await handle.write(Buffer.from("later source save"), 0, 17, 0);
      } finally {
        await handle.close();
      }
    }
    if (issue === "generation") {
      const registry = await registryAt(value.directory);
      registry.volumes[0]!.generation++;
      await writeFile(
        path.join(value.directory, "registry.json"),
        JSON.stringify(registry),
      );
    }
    if (issue === "plan") {
      const file = path.join(value.migration, "plan.json"),
        plan = JSON.parse(await readFile(file, "utf8"));
      plan.targetGeneration++;
      await writeFile(file, JSON.stringify(plan));
    }
    await expect(value.store.start(value.plan, value.grant)).rejects.toThrow();
    await expect(stat(value.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await registryAt(value.directory)).volumes[0]!.imageId).toBe(
      value.source.imageId,
    );
  },
);

it.each(["bytes", "inodes"])(
  "rechecks fresh physical %s after approval and before claiming a target",
  async (resource) => {
    const value = await approved();
    if (resource === "bytes") fault.bytes = 0n;
    else fault.inodes = 0n;
    await expect(
      value.store.start(value.plan, value.grant),
    ).rejects.toMatchObject({
      code:
        resource === "bytes"
          ? "VOLUME_MIGRATION_FREE_BYTES"
          : "VOLUME_MIGRATION_INODES",
    });
    expect(await value.store.inspectMutationLease()).toMatchObject({
      state: "absent",
    });
    await expect(stat(value.target)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([13, 15])(
  "counts %i retained old volumes at their full weighted logical capacity before adding the entire new volume",
  async (retainedCount) => {
    const value = await fixture();
    value.registry.volumes[0]!.retainedImages = Array.from(
      { length: retainedCount },
      () => ({
        imageId: randomUUID(),
        profileId: "capacity-64-v1" as const,
        generation: 1,
        sha256: value.source.sha256,
      }),
    );
    for (const image of value.registry.volumes[0]!.retainedImages) {
      const handle = await open(
        path.join(value.directory, "images", image.imageId + ".img"),
        "wx",
        0o600,
      );
      try {
        await handle.writeFile(value.header);
        await handle.truncate(getCapacityProfile(image.profileId).volumeBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await writeFile(
      path.join(value.directory, "registry.json"),
      JSON.stringify(value.registry),
    );
    if (retainedCount === 15) {
      await expect(value.store.prepare(value.request)).rejects.toMatchObject({
        code: "VOLUME_MIGRATION_GLOBAL_QUOTA",
      });
      expect(await readdir(path.join(value.directory, "migrations"))).toEqual(
        [],
      );
    } else {
      const plan = await value.store.prepare(value.request);
      expect(
        plan.resources.additionalLogicalBytes +
          (retainedCount + 1) *
            getCapacityProfile("capacity-64-v1").volumeBytes,
      ).toBe(getCapacityProfile("capacity-128-v1").globalVolumeBytes);
    }
  },
);

it.each(["ENOSPC", "EDQUOT", "cancel"])(
  "keeps the original active and a partial new copy after %s, without replaying the copy or pointer",
  async (issue) => {
    const value = await approved(),
      controller = new AbortController();
    let writes = 0;
    fault.write = async (file, partial) => {
      if (file !== value.target) return;
      writes++;
      await partial();
      if (issue === "cancel") {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      throw Object.assign(new Error("injected partial image failure"), {
        code: issue,
      });
    };
    await expect(
      value.store.start(value.plan, value.grant, controller.signal),
    ).rejects.toThrow();
    fault.write = undefined;
    const target = await lstat(value.target),
      original = await value.store.inspect(value.plan.id);
    expect(original).toMatchObject({
      confirmed: false,
      reservationRetained: true,
      mutationLease: "held",
      sourceState: "original-active-verified",
      targetCopy: "unverified",
      interruptedCopyContinuation: "unsupported",
      automaticRollback: "unsupported",
    });
    expect(target.size).toBe(2);
    expect(writes).toBe(1);
    expect(await value.store.start(value.plan, value.grant)).toMatchObject({
      status: "retained",
      confirmed: false,
    });
    const after = await lstat(value.target);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      target.ino,
      target.size,
      target.mtimeMs,
    ]);
    await expect(value.store.prepare(value.request)).rejects.toMatchObject({
      code: "VOLUME_MIGRATION_MUTATION_LEASE",
    });
    expect((await registryAt(value.directory)).volumes[0]!.imageId).toBe(
      value.source.imageId,
    );
  },
  60000,
);

it.each(["partial-intent", "intent-fsync"])(
  "retains an uncertain %s and its durable mutation barrier without creating a replacement request",
  async (issue) => {
    const value = await approved();
    if (issue === "partial-intent")
      fault.writeFile = async (file, _bytes, partial) => {
        if (path.basename(file).startsWith(".intent.json-")) {
          await partial();
          throw Object.assign(new Error("initial intent full"), {
            code: "ENOSPC",
          });
        }
      };
    else
      fault.sync = async (file) => {
        if (path.basename(file).startsWith(".intent.json-"))
          throw Object.assign(new Error("initial intent fsync"), {
            code: "EIO",
          });
      };
    await expect(value.store.start(value.plan, value.grant)).rejects.toThrow();
    fault.writeFile = undefined;
    fault.sync = undefined;
    expect(await value.store.inspectMutationLease()).toMatchObject({
      state: "held",
      migrationId: value.plan.id,
      canReclaim: false,
    });
    expect(await value.store.inspect(value.plan.id)).toMatchObject({
      sourceState: "original-active-verified",
      targetCopy: "absent",
      reservationRetained: true,
    });
    await expect(
      value.store.start(value.plan, value.grant),
    ).rejects.toMatchObject({ code: "VOLUME_MIGRATION_MUTATION_LEASE" });
    expect(await readdir(path.join(value.directory, "migrations"))).toEqual([
      value.plan.id,
    ]);
  },
  60000,
);

it("verifies a lost switch acknowledgement by the original ID and only the live owner can finalize its own lease", async () => {
  const value = await approved();
  let failed = false;
  fault.sync = async (file) => {
    if (
      !failed &&
      file === value.directory &&
      (await registryAt(value.directory)).volumes[0]!.imageId ===
        value.plan.targetImageId
    ) {
      failed = true;
      throw Object.assign(new Error("lost registry fsync acknowledgement"), {
        code: "EIO",
      });
    }
  };
  await expect(value.store.start(value.plan, value.grant)).rejects.toThrow(
    "lost registry",
  );
  fault.sync = undefined;
  const fresh = new IsolatedVolumeMigrationStore({
      directory: value.directory,
      runtime: { kind: "local-fixture", supported: true },
    }),
    target = await lstat(value.target);
  expect(await fresh.reconcile(value.plan.id)).toMatchObject({
    status: "committed",
    confirmed: true,
    reservationRetained: true,
    mutationLease: "held",
  });
  expect(await value.store.reconcile(value.plan.id)).toMatchObject({
    confirmed: true,
    reservationRetained: false,
    mutationLease: "absent",
  });
  expect((await lstat(value.target)).ino).toBe(target.ino);
  expect((await lstat(value.image)).size).toBe(256 * 1024 * 1024);
}, 60000);

function child(directory: string, mode: string) {
  const process = spawn(
    globalThis.process.execPath,
    [
      "--import",
      "tsx",
      "test/fixtures/isolated-volume-migration-child.ts",
      directory,
      mode,
    ],
    { cwd: globalThis.process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  const held = new Promise<void>((resolve) => {
    process.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("lease-held")) resolve();
    });
  });
  process.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { process, held, done };
}

it("serializes two actual processes with a durable exclusive lease and never loses a registry switch", async () => {
  const value = await fixture(),
    first = child(value.directory, "hold");
  await first.held;
  const second = child(value.directory, "success"),
    [a, b] = await Promise.all([first.done, second.done]);
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(75);
  expect(b.stdout).toContain("VOLUME_MIGRATION_MUTATION_LEASE");
  expect((await registryAt(value.directory)).volumes[0]).toMatchObject({
    generation: 2,
    retainedImages: [{ imageId: value.source.imageId }],
  });
  expect(await readdir(path.join(value.directory, "images"))).toHaveLength(2);
  expect(await readdir(path.join(value.directory, "migrations"))).toHaveLength(
    1,
  );
}, 60000);

it("reads an actual post-switch process crash without expiring its stale lease, recopying or pretending cleanup completed", async () => {
  const value = await fixture(),
    result = await child(value.directory, "crash").done;
  expect(result.code, result.stderr).toBe(42);
  const id = JSON.parse(
      result.stdout
        .trim()
        .split("\n")
        .find((line) => line.includes('"id"'))!,
    ).id as string,
    registry = await registryAt(value.directory),
    target = path.join(
      value.directory,
      "images",
      registry.volumes[0]!.imageId + ".img",
    ),
    before = await lstat(target),
    marker = path.join(value.directory, "migrations", id, "intent.json"),
    metadata = await readFile(marker, "utf8");
  expect(await value.store.reconcile(id)).toMatchObject({
    confirmed: true,
    reservationRetained: true,
    mutationLease: "held",
    sourceState: "original-retained-verified",
    targetCopy: "verified",
    interruptedCopyContinuation: "unsupported",
  });
  expect(await readFile(marker, "utf8")).toBe(metadata);
  expect((await lstat(target)).ino).toBe(before.ino);
  await expect(
    value.store.prepare({
      ...value.request,
      expectedGeneration: 2,
      expectedSourceSha256: registry.volumes[0]!.sha256,
      targetProfileId: "capacity-256-v1",
    }),
  ).rejects.toMatchObject({ code: "VOLUME_MIGRATION_MUTATION_LEASE" });
  expect(await readdir(path.join(value.directory, "images"))).toHaveLength(2);
}, 60000);

it.each(["content", "inode"])(
  "refuses %s drift of the verified target before the atomic switch",
  async (issue) => {
    const value = await approved();
    let injected = false;
    fault.writeFile = async (file, bytes) => {
      if (
        injected ||
        !path.basename(file).startsWith(".intent.json-") ||
        JSON.parse(Buffer.from(bytes).toString()).phase !== "verified"
      )
        return;
      injected = true;
      if (issue === "content") {
        const handle = await open(value.target, "r+");
        try {
          await handle.write(Buffer.from("changed"), 0, 7, 0);
        } finally {
          await handle.close();
        }
      } else {
        const copy = path.join(value.directory, "same-bytes-new-inode.img");
        await copyFile(value.target, copy, constants.COPYFILE_FICLONE);
        await renameFile(copy, value.target);
      }
    };
    await expect(value.store.start(value.plan, value.grant)).rejects.toThrow(
      "images changed",
    );
    fault.writeFile = undefined;
    expect(injected).toBe(true);
    expect((await registryAt(value.directory)).volumes[0]!.imageId).toBe(
      value.source.imageId,
    );
    expect(await value.store.inspect(value.plan.id)).toMatchObject({
      confirmed: false,
      sourceState: "original-active-verified",
      targetCopy: "unverified",
      reservationRetained: true,
    });
  },
  60000,
);

it("checks the entire zero-extended target rather than accepting only an unchanged old prefix", async () => {
  const value = await approved();
  fault.truncate = async (file) => {
    if (file === value.target) {
      const handle = await open(file, "r+");
      try {
        await handle.write(
          Buffer.from([1]),
          0,
          1,
          value.plan.targetProfile.volumeBytes - 1,
        );
      } finally {
        await handle.close();
      }
    }
  };
  await expect(value.store.start(value.plan, value.grant)).rejects.toThrow(
    "copy-and-zero-extension",
  );
  fault.truncate = undefined;
  expect((await registryAt(value.directory)).volumes[0]!.imageId).toBe(
    value.source.imageId,
  );
  expect(await value.store.inspect(value.plan.id)).toMatchObject({
    confirmed: false,
    sourceState: "original-active-verified",
    reservationRetained: true,
  });
}, 60000);

it("keeps an actual pre-switch crash as an active original plus a verified retained copy without replaying the pointer switch", async () => {
  const value = await fixture(),
    result = await child(value.directory, "pre-switch-crash").done;
  expect(result.code, result.stderr).toBe(43);
  const id = JSON.parse(
      result.stdout
        .trim()
        .split("\n")
        .find((line) => line.includes('"id"'))!,
    ).id as string,
    before = await readFile(
      path.join(value.directory, "registry.json"),
      "utf8",
    );
  expect(await value.store.reconcile(id)).toMatchObject({
    confirmed: false,
    status: "retained",
    sourceState: "original-active-verified",
    targetCopy: "verified",
    reservationRetained: true,
    mutationLease: "held",
    interruptedCopyContinuation: "unsupported",
    automaticRollback: "unsupported",
  });
  expect(
    await readFile(path.join(value.directory, "registry.json"), "utf8"),
  ).toBe(before);
  expect(await readdir(path.join(value.directory, "images"))).toHaveLength(2);
}, 60000);

it("refuses the 97th plan before making its own history unreadable and never deletes the 96 existing plans", async () => {
  const value = await approved();
  for (let index = 1; index < 96; index++) {
    const id = randomUUID(),
      directory = path.join(value.directory, "migrations", id);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      path.join(directory, "plan.json"),
      JSON.stringify({ ...value.plan, id, targetImageId: randomUUID() }),
      { mode: 0o600 },
    );
  }
  const before = await readdir(path.join(value.directory, "migrations"));
  await expect(value.store.prepare(value.request)).rejects.toMatchObject({
    code: "VOLUME_MIGRATION_HISTORY_LIMIT",
  });
  expect(await readdir(path.join(value.directory, "migrations"))).toEqual(
    before,
  );
  expect(await value.store.inspectMutationLease()).toEqual({
    state: "absent",
    canReclaim: false,
  });
  expect(await value.store.inspect(value.plan.id)).toMatchObject({
    status: "prepared",
    sourceState: "original-active-verified",
    targetCopy: "absent",
    reservationRetained: false,
  });
});
