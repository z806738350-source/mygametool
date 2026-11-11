import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  link,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWrites } from "../src/daemon/project-writes.js";

const hooks = vi.hoisted(() => ({
  read: undefined as undefined | ((file: string) => Promise<void> | void),
  write: undefined as
    | undefined
    | ((
        file: string,
        bytes: Buffer,
        write: (bytes: Buffer) => Promise<unknown>,
      ) => Promise<void>),
  available: undefined as bigint | undefined,
  unit: undefined as bigint | undefined,
  inodes: undefined as bigint | undefined,
  sourceReads: 0,
  close: undefined as undefined | ((file: string, fd: number) => void),
  handles: [] as Array<{
    file: string;
    handle: import("node:fs/promises").FileHandle;
    close: () => Promise<void>;
  }>,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    statfs: async (...args: Parameters<typeof fs.statfs>) => {
      const value = await fs.statfs(...args),
        bsize = hooks.unit ?? BigInt(value.bsize);
      return {
        ...value,
        bsize,
        bavail:
          hooks.available === undefined
            ? value.bavail
            : hooks.available / bsize,
        ffree: hooks.inodes ?? value.ffree,
      };
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args),
        filename = String(args[0]);
      const read = handle.read.bind(handle),
        write = handle.write.bind(handle),
        close = handle.close.bind(handle);
      hooks.handles.push({ file: filename, handle, close });
      handle.close = async () => {
        hooks.close?.(filename, handle.fd);
        await close();
      };
      handle.read = (async (...input: unknown[]) => {
        await hooks.read?.(filename);
        if (filename.endsWith("source.mp4")) hooks.sourceReads++;
        return (read as (...args: unknown[]) => Promise<unknown>)(...input);
      }) as typeof handle.read;
      handle.write = (async (...input: unknown[]) => {
        if (hooks.write && filename.endsWith("payload")) {
          const bytes = (input[0] as Buffer).subarray(
            input[1] as number,
            (input[1] as number) + (input[2] as number),
          );
          await hooks.write(filename, bytes, (bytes) =>
            write(bytes, 0, bytes.length, input[3] as number),
          );
        }
        return (write as (...args: unknown[]) => Promise<unknown>)(...input);
      }) as typeof handle.write;
      return handle;
    },
  };
});

let api: typeof import("../src/daemon/checked-media-snapshot.js");
let secrets: typeof import("../src/shared/sensitive-values.js");
let space: typeof import("../src/daemon/recovery-space.js");
let root: string, cache: string;
const stores: import("../src/daemon/checked-media-snapshot.js").CheckedMediaSnapshotStore[] =
  [];
beforeEach(async () => {
  vi.resetModules();
  hooks.read = undefined;
  hooks.write = undefined;
  hooks.close = undefined;
  hooks.handles = [];
  hooks.available = undefined;
  hooks.unit = undefined;
  hooks.inodes = undefined;
  hooks.sourceReads = 0;
  [api, secrets, space] = await Promise.all([
    import("../src/daemon/checked-media-snapshot.js"),
    import("../src/shared/sensitive-values.js"),
    import("../src/daemon/recovery-space.js"),
  ]);
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-checked-media-")),
  );
  cache = path.join(root, "cache");
});
afterEach(async () => {
  hooks.read = undefined;
  hooks.write = undefined;
  hooks.close = undefined;
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.allSettled(
    hooks.handles
      .filter((value) => value.handle.fd >= 0)
      .map((value) => value.close()),
  );
  await rm(root, { recursive: true, force: true });
});
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function file(
  name = "source.mp4",
  bytes = Buffer.from("ordinary immutable media"),
) {
  const namePath = path.join(root, name);
  await writeFile(namePath, bytes, { mode: 0o600 });
  return namePath;
}
function store(
  options?: ConstructorParameters<typeof api.CheckedMediaSnapshotStore>[1],
) {
  const result = new api.CheckedMediaSnapshotStore(cache, options);
  stores.push(result);
  return result;
}
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const owner = {
  ownerKey: "a".repeat(32),
  namespace: "test" as const,
  projectId: "6e849fb8-9236-4f0e-a58a-76cb223b8a74",
  sourceManifestVersion: 2 as const,
  sourceProfileId: "capacity-128-v2" as const,
  sourceBaseManifestId: "c".repeat(64),
};

describe("checked anonymous media snapshots", () => {
  it("unlinks the copy before any payload read and serves checked bytes despite later source mutation", async () => {
    const bytes = Buffer.alloc(130000, 42),
      filename = await file(undefined, bytes),
      snapshots = store();
    hooks.read = async (name) => {
      if (name === filename) expect(await readdir(cache)).toEqual([]);
    };
    const lease = await snapshots.acquire(root, filename, {
      maxBytes: bytes.length,
    });
    hooks.read = undefined;
    expect(lease).toMatchObject({
      size: bytes.length,
      sha256: hash(bytes),
      scannerRevision: 0,
    });
    expect(await readdir(cache)).toEqual([]);
    await writeFile(filename, "changed after inspection");
    expect(await collect(lease.stream({ start: 2, end: 11 }))).toEqual(
      bytes.subarray(2, 12),
    );
    await lease.release();
    await lease.release();
    lease.assertCurrentPolicy();
    expect(() => lease.stream()).toThrow();
    expect(snapshots.stats()).toMatchObject({
      leases: 0,
      entries: 1,
      bytes: bytes.length,
    });
    await snapshots.close();
    expect(snapshots.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("shares one complete scan but maintains separate single-use range leases", async () => {
    const bytes = Buffer.alloc(150000, 25),
      filename = await file(undefined, bytes),
      snapshots = store();
    const [first, second] = await Promise.all([
      snapshots.acquire(root, filename, {
        maxBytes: bytes.length,
        scope: "project-a",
      }),
      snapshots.acquire(root, filename, {
        maxBytes: bytes.length,
        scope: "project-a",
      }),
    ]);
    expect(hooks.sourceReads).toBe(3);
    expect(await collect(first.stream({ start: 0, end: 15 }))).toEqual(
      bytes.subarray(0, 16),
    );
    expect(
      await collect(
        second.stream({ start: bytes.length - 10, end: bytes.length - 1 }),
      ),
    ).toEqual(bytes.subarray(-10));
    const cached = await snapshots.acquire(root, filename, {
      maxBytes: bytes.length,
      scope: "project-a",
    });
    expect(hooks.sourceReads).toBe(3);
    await cached.release();
    await snapshots.evictScope("project-a");
    expect(snapshots.stats().entries).toBe(0);
  });

  it("checks source identity again and rejects an in-place write during the copy", async () => {
    const filename = await file(undefined, Buffer.alloc(130000, 3)),
      snapshots = store();
    let changed = false;
    hooks.read = async (name) => {
      if (name === filename && !changed) {
        changed = true;
        await writeFile(filename, Buffer.alloc(130000, 4));
      }
    };
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 130000 }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CHECKED_MEDIA_CHANGED" });
    expect(await readdir(cache)).toEqual([]);
    expect(snapshots.stats().entries).toBe(0);
  });

  it("refuses symlinks, hardlinks, non-files and outside paths before serving bytes", async () => {
    const filename = await file(),
      snapshots = store();
    await symlink(filename, path.join(root, "linked.mp4"));
    await expect(
      snapshots.acquire(root, path.join(root, "linked.mp4"), { maxBytes: 200 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await link(filename, path.join(root, "hard.mp4"));
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 200 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      snapshots.acquire(root, root, { maxBytes: 200 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(snapshots.stats()).toMatchObject({ entries: 0, pendingBytes: 0 });
  });

  it("allows a trusted root prefix alias while still refusing linked file components", async () => {
    const filename = await file(),
      alias = path.join(root, "root-alias");
    await symlink(root, alias);
    const lease = await store().acquire(
      alias,
      path.join(alias, path.basename(filename)),
      { maxBytes: 200 },
    );
    expect((await collect(lease.stream())).toString()).toBe(
      "ordinary immutable media",
    );
  });

  it.each(["tail", "boundary"])(
    "scans the whole file before returning any lease, including a protected %s",
    async (placement) => {
      const secret = "checked-media-protected-canary-0123456789";
      secrets.registerSensitiveValue(secret);
      const bytes = Buffer.concat([
          Buffer.alloc(placement === "tail" ? 130000 : 65530, 0),
          Buffer.from(secret),
        ]),
        filename = await file(undefined, bytes),
        snapshots = store();
      await expect(
        snapshots.acquire(root, filename, { maxBytes: bytes.length }),
      ).rejects.toMatchObject({
        code: "CHECKED_MEDIA_PROTECTED",
        statusCode: 403,
      });
      expect(snapshots.stats()).toMatchObject({ entries: 0, pendingBytes: 0 });
      expect(await readdir(cache)).toEqual([]);
    },
  );

  it("increments policy revision only for new forms and invalidates a scan immediately", async () => {
    secrets.registerSensitiveValue("existing-canary");
    const revision = secrets.knownSensitiveValueRevision();
    secrets.registerSensitiveValue("existing-canary");
    expect(secrets.knownSensitiveValueRevision()).toBe(revision);
    const filename = await file(undefined, Buffer.alloc(150000, 0)),
      snapshots = store();
    let registered = false;
    hooks.read = (name) => {
      if (name === filename && !registered) {
        registered = true;
        secrets.registerSensitiveValue("new-during-scan-canary");
      }
    };
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 150000 }),
    ).rejects.toMatchObject({
      code: "CHECKED_MEDIA_POLICY_CHANGED",
      statusCode: 409,
    });
    expect(snapshots.stats().entries).toBe(0);
  });

  it("invalidates an already checked lease before headers and stops subsequent streamed chunks", async () => {
    const filename = await file(undefined, Buffer.alloc(200000, 0)),
      snapshots = store(),
      lease = await snapshots.acquire(root, filename, { maxBytes: 200000 });
    let received = 0;
    const body = lease.stream();
    body.once("data", (chunk) => {
      received += chunk.length;
      secrets.registerSensitiveValue("policy-changed-after-first-chunk");
    });
    await expect(collect(body)).rejects.toMatchObject({
      code: "CHECKED_MEDIA_POLICY_CHANGED",
    });
    expect(received).toBeLessThanOrEqual(65536);
    await lease.release();
    expect(() => lease.assertCurrentPolicy()).toThrow("policy changed");
  });

  it("enforces each caller limit and expected hash, including cache hits and the hard ceiling", async () => {
    const bytes = Buffer.alloc(1000, 0),
      filename = await file(undefined, bytes),
      snapshots = store(),
      first = await snapshots.acquire(root, filename, { maxBytes: 1000 });
    await first.release();
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 999 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      snapshots.acquire(root, filename, {
        maxBytes: 1000,
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 256 * 1024 ** 2 + 1 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(hooks.sourceReads).toBe(1);
  });

  it.each(["bytes", "entries"])(
    "atomically reserves the %s cache limit across different concurrent keys",
    async (boundary) => {
      const first = await file("first.mp4", Buffer.alloc(100, 0)),
        second = await file("second.mp4", Buffer.alloc(100, 1));
      const snapshots = store(
        boundary === "bytes" ? { maxBytes: 150 } : { maxEntries: 1 },
      );
      const results = await Promise.allSettled([
        snapshots.acquire(root, first, { maxBytes: 100 }),
        snapshots.acquire(root, second, { maxBytes: 100 }),
      ]);
      expect(
        results.filter((value) => value.status === "fulfilled"),
      ).toHaveLength(1);
      const refused = results.find(
        (value) => value.status === "rejected",
      ) as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: "CHECKED_MEDIA_CAPACITY" });
      for (const result of results)
        if (result.status === "fulfilled") await result.value.release();
      expect(snapshots.stats().bytes).toBe(100);
      expect(snapshots.stats().entries).toBe(1);
    },
  );

  it("does not cancel a shared producer when only one of its callers leaves", async () => {
    const filename = await file(undefined, Buffer.alloc(1000, 2)),
      snapshots = store();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    hooks.read = async (name) => {
      if (name === filename && !held) {
        held = true;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const abort = new AbortController(),
      first = snapshots.acquire(root, filename, {
        maxBytes: 1000,
        signal: abort.signal,
      }),
      second = snapshots.acquire(root, filename, { maxBytes: 1000 });
    await ready;
    await vi.waitFor(() => expect(snapshots.stats().pending).toBe(2));
    abort.abort(new Error("one caller cancelled"));
    await expect(first).rejects.toThrow("one caller cancelled");
    release();
    const other = await second;
    expect((await collect(other.stream())).length).toBe(1000);
  });

  it("cancels queued work and closes active streams without retaining a named payload", async () => {
    const first = await file(),
      second = await file("second.mp4"),
      snapshots = store({ scanConcurrency: 1 });
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    hooks.read = async (name) => {
      if (name === first && !held) {
        held = true;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const pending = snapshots.acquire(root, first, { maxBytes: 1000 });
    await ready;
    const cancellation = new AbortController(),
      queued = snapshots.acquire(root, second, {
        maxBytes: 1000,
        signal: cancellation.signal,
      });
    cancellation.abort(new Error("queued cancellation"));
    await expect(queued).rejects.toThrow("queued cancellation");
    release();
    const lease = await pending;
    const body = lease.stream();
    await snapshots.close();
    expect(body.destroyed).toBe(true);
    expect(snapshots.stats()).toMatchObject({
      entries: 0,
      leases: 0,
      pendingBytes: 0,
    });
    expect(await readdir(cache)).toEqual([]);
  });

  it("retains active old entries in the entry budget after scope eviction", async () => {
    const filename = await file(),
      snapshots = store({ maxEntries: 1 }),
      lease = await snapshots.acquire(root, filename, {
        maxBytes: 1000,
        scope: "preview",
      });
    await snapshots.evictScope("preview");
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 1000, scope: "other" }),
    ).rejects.toMatchObject({ code: "CHECKED_MEDIA_CAPACITY" });
    expect(snapshots.stats().entries).toBe(1);
    await lease.release();
    expect(snapshots.stats().entries).toBe(0);
  });

  it("closes a partial failed anonymous write before releasing its allocation promise", async () => {
    const filename = await file(undefined, Buffer.alloc(130000, 6)),
      snapshots = store();
    hooks.write = async (_name, bytes, write) => {
      await write(bytes.subarray(0, 3));
      throw Object.assign(new Error("synthetic partial ENOSPC"), {
        code: "ENOSPC",
      });
    };
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 130000 }),
    ).rejects.toMatchObject({
      code: "CHECKED_MEDIA_CAPACITY",
      statusCode: 507,
      reason: "physical-capacity",
    });
    hooks.write = undefined;
    expect(await readdir(cache)).toEqual([]);
    expect(await readFile(filename)).toEqual(Buffer.alloc(130000, 6));
    expect(
      (await space.inspectVolumeMigrationHeadroom(root))
        .physicalOutstandingBytes,
    ).toBe(0);
  });

  it("evicts idle copies and keeps metadata assertions usable after release", async () => {
    const filename = await file(),
      snapshots = store({ idleMs: 10 }),
      lease = await snapshots.acquire(root, filename, { maxBytes: 1000 });
    await lease.release();
    await vi.waitFor(() => expect(snapshots.stats().entries).toBe(0));
    lease.assertCurrentPolicy();
    expect(lease.size).toBeGreaterThan(0);
  });

  it("closes unrelated idle descriptors even when one active lease close fails", async () => {
    const snapshots = store(),
      first = await file("first.mp4"),
      second = await file("second.mp4"),
      third = await file("third.mp4");
    const a = await snapshots.acquire(root, first, { maxBytes: 1000 }),
      b = await snapshots.acquire(root, second, { maxBytes: 1000 }),
      c = await snapshots.acquire(root, third, { maxBytes: 1000 });
    await a.release();
    await c.release();
    const anonymous = hooks.handles.filter(
      (value) => value.file.endsWith("payload") && value.handle.fd >= 0,
    );
    expect(anonymous).toHaveLength(3);
    const failing = anonymous[1]!.handle.fd;
    hooks.close = (_file, fd) => {
      if (fd === failing)
        throw new Error("synthetic close failure with private-path-canary");
    };
    const failure = await snapshots.close().catch((cause) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).not.toContain("private-path-canary");
    expect(anonymous[0]!.handle.fd).toBe(-1);
    expect(anonymous[2]!.handle.fd).toBe(-1);
    expect(anonymous[1]!.handle.fd).toBe(failing);
    expect(snapshots.stats()).toMatchObject({
      entries: 1,
      bytes: b.size,
      leases: 0,
    });
  });

  it("uses fixed actionable capacity messages instead of exposing injected filesystem errors", async () => {
    hooks.available = 0n;
    const filename = await file(),
      snapshots = store();
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      code: "CHECKED_MEDIA_CAPACITY",
      reason: "physical-capacity",
      statusCode: 507,
    });
    hooks.available = undefined;
    hooks.inodes = 0n;
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 1000 }),
    ).rejects.toMatchObject({ reason: "physical-capacity" });
    expect(await readdir(cache)).toEqual([]);
  });

  it("blocks further allocation after an anonymous builder close becomes unconfirmed", async () => {
    const first = await file("retained.mp4"),
      second = await file("failed.mp4"),
      third = await file("next.mp4"),
      snapshots = store();
    const old = await snapshots.acquire(root, first, { maxBytes: 1000 });
    await old.release();
    hooks.close = (name, _fd) => {
      if (
        name.endsWith("payload") &&
        !hooks.handles.some(
          (value) => value.file === name && value.handle.fd < 0,
        )
      )
        throw new Error("synthetic close EIO");
    };
    await expect(
      snapshots.acquire(root, second, { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      code: "CHECKED_MEDIA_CAPACITY",
      reason: "cleanup-unknown",
    });
    expect(snapshots.stats()).toMatchObject({
      uncertain: true,
      unknownBytes: null,
      pendingBytes: 0,
    });
    const handlesBefore = hooks.handles.length;
    await expect(
      snapshots.acquire(root, third, { maxBytes: 1000 }),
    ).rejects.toMatchObject({ reason: "cleanup-unknown" });
    expect(hooks.handles.length).toBe(handlesBefore);
    expect(
      (await space.inspectVolumeMigrationHeadroom(root))
        .physicalOutstandingBytes,
    ).toBeGreaterThan(0);
    hooks.close = undefined;
    await snapshots.close().catch(() => {});
    expect(snapshots.stats().entries).toBe(0);
    expect(snapshots.stats().uncertain).toBe(true);
    expect(await readdir(cache)).toEqual([]);
  });

  it("never mints an unreachable lease when the caller's source descriptor close fails", async () => {
    const filename = await file(),
      snapshots = store();
    let originalFd: number | undefined;
    hooks.close = (name, fd) => {
      if (name !== filename) return;
      originalFd ??= hooks.handles.find((value) => value.file === filename)!
        .handle.fd;
      if (fd === originalFd)
        throw new Error("source-close private-path-canary");
    };
    const failure = await snapshots
      .acquire(root, filename, { maxBytes: 1000 })
      .catch((cause) => cause);
    expect(failure).toMatchObject({
      code: "CHECKED_MEDIA_CAPACITY",
      reason: "cleanup-unknown",
    });
    expect(String(failure)).not.toContain("private-path-canary");
    expect(snapshots.stats()).toMatchObject({ leases: 0, uncertain: true });
    hooks.close = undefined;
    await snapshots.close();
    expect(snapshots.stats().entries).toBe(0);
  });
  it("rechecks a policy change during final source close before handing out a lease", async () => {
    const filename = await file(),
      snapshots = store();
    let changed = false;
    hooks.close = (name, fd) => {
      if (
        name === filename &&
        fd ===
          hooks.handles.find((value) => value.file === filename)!.handle.fd &&
        !changed
      ) {
        changed = true;
        secrets.registerSensitiveValue("policy-registered-during-final-close");
      }
    };
    await expect(
      snapshots.acquire(root, filename, { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      code: "CHECKED_MEDIA_POLICY_CHANGED",
      statusCode: 409,
    });
    expect(snapshots.stats()).toMatchObject({ leases: 0, uncertain: false });
  });

  it("closes paused checked-media reads before checkpoint shutdown can finish", async () => {
    const filename = await file(undefined, Buffer.alloc(1024 ** 2, 1)),
      snapshots = store(),
      writes = new ProjectWrites();
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sink = new Writable({
      highWaterMark: 1,
      write() {
        started();
      },
    });
    const lease = await snapshots.acquire(root, filename, {
        maxBytes: 1024 ** 2,
      }),
      body = lease.stream(),
      release = await writes.enter("synthetic-project", true);
    const piping = pipeline(body, sink)
      .catch(() => {})
      .finally(release);
    let checkpointRan = false,
      mediaCloseReached = false;
    let checkpoint: Promise<void> | undefined,
      closing: Promise<void> | undefined;
    try {
      await paused;
      checkpoint = writes.snapshot("synthetic-project", async () => {
        checkpointRan = true;
      });
      closing = (async () => {
        await checkpoint;
        mediaCloseReached = true;
        await snapshots.close();
      })();
      await Promise.resolve();
      await Promise.resolve();
      expect(checkpointRan).toBe(false);
      expect(mediaCloseReached).toBe(false);
      expect(snapshots.stats().leases).toBe(1);
      await snapshots.close();
      await piping;
      await closing;
      expect(checkpointRan).toBe(true);
      expect(mediaCloseReached).toBe(true);
      expect(snapshots.stats()).toMatchObject({
        leases: 0,
        entries: 0,
        closed: true,
      });
    } finally {
      sink.destroy();
      body.destroy();
      await snapshots.close();
      await piping;
      await checkpoint;
      await closing;
    }
  });
});

describe("derived media physical reservations", () => {
  it.each(["source-first", "derived-first"])(
    "shares same-device future physical promises bidirectionally: %s",
    async (order) => {
      await mkdir(cache, { mode: 0o700 });
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const device = (await stat(workspace)).dev;
      const input = {
        profileId: "capacity-128-v2" as const,
        backingDevice: device,
        rawBytes: 72 * 1024 ** 2,
        workingBytes: 64 * 1024 ** 2,
        beforeBytes: 136 * 1024 ** 2,
        afterBytes: 72 * 1024 ** 2,
        manifestBytes: 2 * 1024 ** 2,
        reviewBytes: 8 * 1024 ** 2,
        allocationUnitBytes: 32768,
      };
      hooks.unit = 32768n;
      const plan = space.planRecoverySpace(input);
      hooks.available = BigInt(
        plan.diskBytes + space.RECOVERY_DISK_FLOOR_BYTES,
      );
      hooks.inodes = 1000000n;
      if (order === "source-first") {
        const lease = await space.reserveRecoverySpace(workspace, input, owner);
        await expect(
          space.reserveDerivedMediaSpace(cache, 1024 ** 2),
        ).rejects.toMatchObject({ reason: "physical-capacity" });
        await lease.release();
      } else {
        const lease = await space.reserveDerivedMediaSpace(cache, 1024 ** 2);
        await expect(
          space.reserveRecoverySpace(workspace, input, owner),
        ).rejects.toThrow("unreserved disk");
        expect(
          (await space.inspectVolumeMigrationHeadroom(workspace))
            .physicalOutstandingBytes,
        ).toBe(lease.physicalBytes);
        await lease.release();
      }
    },
  );

  it("blocks allocation for unknown durable promises without clearing or recreating them", async () => {
    await mkdir(cache, { mode: 0o700 });
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const input = {
      rawBytes: 0,
      workingBytes: 0,
      beforeBytes: 0,
      afterBytes: 0,
      manifestBytes: 1024,
      additionalEntries: 8,
    };
    const lease = await space.reserveRecoverySpace(workspace, input, {
      ...owner,
      sourceManifestVersion: undefined,
      sourceProfileId: undefined,
      sourceBaseManifestId: undefined,
    });
    await rm(
      path.join(root, "isolated-space-reservations", lease.id + ".json"),
    );
    await expect(space.reserveDerivedMediaSpace(cache, 1)).rejects.toThrow();
    await expect(
      space.reserveDerivedMediaSpace(cache, 1),
    ).rejects.toMatchObject({ reason: "unconfirmed-reservation" });
  });
});
