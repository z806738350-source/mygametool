import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  containsKnownSensitiveValue,
  knownSensitiveValueOverlap,
  knownSensitiveValueRevision,
  onSensitiveValueRevision,
} from "../shared/sensitive-values.js";
import {
  DerivedMediaSpaceError,
  reserveDerivedMediaSpace,
  type DerivedMediaSpaceReservation,
} from "./recovery-space.js";

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_FILE = 256 * MiB;
const defaults = {
  maxBytes: 512 * MiB,
  maxEntries: 32,
  idleMs: 60_000,
  scanConcurrency: 2,
  maxPending: 64,
};
type ErrorCode =
  | "CHECKED_MEDIA_PROTECTED"
  | "CHECKED_MEDIA_CHANGED"
  | "CHECKED_MEDIA_POLICY_CHANGED"
  | "CHECKED_MEDIA_LIMIT"
  | "CHECKED_MEDIA_UNSAFE"
  | "CHECKED_MEDIA_MISSING"
  | "CHECKED_MEDIA_CAPACITY"
  | "CHECKED_MEDIA_CLOSED";
export class CheckedMediaSnapshotError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: ErrorCode,
    readonly reason?:
      | "cache-busy"
      | "physical-capacity"
      | "unconfirmed-reservation"
      | "unsafe-storage"
      | "filesystem-unknown"
      | "cleanup-unknown",
  ) {
    super(message);
  }
}
const changed = () =>
  new CheckedMediaSnapshotError(
    "Media changed during secure inspection; retry the request",
    409,
    "CHECKED_MEDIA_CHANGED",
  );
const policyChanged = () =>
  new CheckedMediaSnapshotError(
    "The protected-data policy changed; inspect the media again",
    409,
    "CHECKED_MEDIA_POLICY_CHANGED",
  );
const closed = () =>
  new CheckedMediaSnapshotError(
    "Secure media inspection is closed",
    503,
    "CHECKED_MEDIA_CLOSED",
  );
const capacity = () =>
  new CheckedMediaSnapshotError(
    "The secure media cache is busy; close an existing preview and try again",
    503,
    "CHECKED_MEDIA_CAPACITY",
    "cache-busy",
  );
const diskCapacity = () =>
  new CheckedMediaSnapshotError(
    "The host disk has insufficient unreserved bytes or inodes. Free your own non-project temporary files; retain project originals and recovery records",
    507,
    "CHECKED_MEDIA_CAPACITY",
    "physical-capacity",
  );
const unknownCapacity = (cleanup = false) =>
  new CheckedMediaSnapshotError(
    cleanup
      ? "Media inspection cleanup is unconfirmed. Use storage diagnostics before retrying; do not delete retained project data"
      : "Secure media filesystem checks could not be completed. Check storage diagnostics and permissions before retrying",
    503,
    "CHECKED_MEDIA_CAPACITY",
    cleanup ? "cleanup-unknown" : "filesystem-unknown",
  );
function allocationFailure(cause: unknown): CheckedMediaSnapshotError {
  if (cause instanceof DerivedMediaSpaceError) {
    if (cause.reason === "physical-capacity") return diskCapacity();
    if (cause.reason === "unconfirmed-reservation")
      return new CheckedMediaSnapshotError(
        "Outstanding disk reservations are unconfirmed. Run storage diagnostics or Review before retrying; do not delete recovery records",
        507,
        "CHECKED_MEDIA_CAPACITY",
        cause.reason,
      );
    if (cause.reason === "unsafe-storage")
      return new CheckedMediaSnapshotError(
        "Secure media storage is unsafe or its permissions changed; inspect the storage configuration before retrying",
        403,
        "CHECKED_MEDIA_UNSAFE",
        cause.reason,
      );
  }
  return unknownCapacity();
}
const unsafe = () =>
  new CheckedMediaSnapshotError(
    "Only ordinary non-linked media within the permitted directory can be inspected",
    403,
    "CHECKED_MEDIA_UNSAFE",
  );
export interface CheckedMediaSnapshot {
  readonly size: number;
  readonly sha256: string;
  readonly scannerRevision: number;
  assertCurrentPolicy(): void;
  /** Inclusive single range. One stream per lease; all terminal paths release it. */
  stream(
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Readable;
  release(): Promise<void>;
}
interface Entry {
  key: string;
  scope: string;
  handle: FileHandle;
  size: number;
  sha256: string;
  revision: number;
  refs: number;
  lastUsed: number;
  evicted: boolean;
  closing?: Promise<void>;
}
interface Job {
  key: string;
  scope: string;
  size: number;
  controller: AbortController;
  waiters: number;
  promise: Promise<Entry>;
}
const identityKeys = [
  "dev",
  "ino",
  "size",
  "mtimeNs",
  "ctimeNs",
  "mode",
  "uid",
  "gid",
  "nlink",
] as const;
const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  identityKeys.every((key) => a[key] === b[key]);
const identity = (value: BigIntStats) =>
  identityKeys.map((key) => value[key].toString());
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
async function verifySource(
  handle: FileHandle,
  filename: string,
  initial: BigIntStats,
): Promise<void> {
  const final = await handle.stat({ bigint: true }),
    current = await lstat(filename, { bigint: true });
  if (
    !sameIdentity(initial, final) ||
    !sameIdentity(final, current) ||
    !current.isFile() ||
    current.nlink !== 1n ||
    (await realpath(filename)) !== filename
  )
    throw changed();
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Checked anonymous copies only. No user original or paid artifact is ever owned by this cache. */
export class CheckedMediaSnapshotStore {
  readonly #options: typeof defaults;
  readonly #entries = new Map<string, Entry>();
  readonly #allEntries = new Set<Entry>();
  readonly #jobs = new Map<string, Job>();
  readonly #acquires = new Set<Promise<CheckedMediaSnapshot>>();
  readonly #leases = new Set<CheckedMediaSnapshot>();
  readonly #streams = new Set<Readable>();
  readonly #uncertainHandles = new Set<FileHandle>();
  readonly #unsubscribe: () => void;
  readonly #shutdown = new AbortController();
  readonly #scanWaiters: Array<() => void> = [];
  #activeScans = 0;
  #bytes = 0;
  #pendingBytes = 0;
  #closed = false;
  #uncertain = false;
  #directory?: Promise<string>;
  #rootIdentity?: { dev: number; ino: number };
  #timer?: ReturnType<typeof setTimeout>;
  #closing?: Promise<void>;
  constructor(
    readonly directory: string,
    options: Partial<typeof defaults> = {},
  ) {
    this.#options = { ...defaults, ...options };
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>)
      if (
        !Number.isSafeInteger(this.#options[key]) ||
        this.#options[key] < (key === "idleMs" ? 0 : 1) ||
        this.#options[key] > defaults[key]
      )
        throw new Error("Invalid secure media inspection limits");
    this.#unsubscribe = onSensitiveValueRevision(() => {
      for (const job of this.#jobs.values())
        job.controller.abort(policyChanged());
      for (const stream of this.#streams) stream.destroy(policyChanged());
      void this.#prune().catch(() => {});
    });
  }
  stats() {
    return {
      entries: this.#allEntries.size,
      bytes: this.#bytes,
      pendingBytes: this.#pendingBytes,
      scans: this.#activeScans,
      pending: this.#acquires.size,
      leases: this.#leases.size,
      closed: this.#closed,
      uncertain: this.#uncertain,
      unknownBytes: this.#uncertain ? null : 0,
    };
  }
  acquire(
    root: string,
    filename: string,
    options: {
      maxBytes: number;
      signal?: AbortSignal;
      expectedSha256?: string;
      scope?: string;
    },
  ): Promise<CheckedMediaSnapshot> {
    if (this.#closed) return Promise.reject(closed());
    if (this.#uncertain) return Promise.reject(unknownCapacity(true));
    if (this.#acquires.size >= this.#options.maxPending)
      return Promise.reject(capacity());
    const task = this.#acquire(root, filename, options);
    this.#acquires.add(task);
    void task.finally(() => this.#acquires.delete(task)).catch(() => {});
    return task;
  }
  async #root(): Promise<string> {
    const root = await (this.#directory ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory),
        canonical = await realpath(this.directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw unsafe();
      this.#rootIdentity = { dev: info.dev, ino: info.ino };
      return canonical;
    })());
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== process.getuid?.() ||
      current.mode & 0o077 ||
      current.dev !== this.#rootIdentity?.dev ||
      current.ino !== this.#rootIdentity?.ino ||
      (await realpath(root)) !== root
    )
      throw unsafe();
    return root;
  }
  async #acquire(
    root: string,
    filename: string,
    options: {
      maxBytes: number;
      signal?: AbortSignal;
      expectedSha256?: string;
      scope?: string;
    },
  ): Promise<CheckedMediaSnapshot> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#shutdown.signal])
      : this.#shutdown.signal;
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 0 ||
      options.maxBytes > MAX_FILE
    )
      throw new CheckedMediaSnapshotError(
        "Media exceeds the secure inspection limit",
        413,
        "CHECKED_MEDIA_LIMIT",
      );
    if (
      options.expectedSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.expectedSha256)
    )
      throw changed();
    const scope = options.scope ?? "";
    if (scope.length > 2000 || !path.isAbsolute(filename)) throw unsafe();
    let source: FileHandle | undefined,
      pin: Entry | undefined,
      job: Job | undefined;
    try {
      const canonicalRoot = await realpath(root),
        suppliedRoot = path.resolve(root),
        suppliedFile = path.resolve(filename);
      const candidate = inside(suppliedRoot, suppliedFile)
        ? path.resolve(canonicalRoot, path.relative(suppliedRoot, suppliedFile))
        : inside(canonicalRoot, suppliedFile)
          ? suppliedFile
          : undefined;
      if (!candidate || (await realpath(candidate)) !== candidate)
        throw unsafe();
      source = await open(
        candidate,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const initial = await source.stat({ bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n) throw unsafe();
      if (initial.size > BigInt(options.maxBytes))
        throw new CheckedMediaSnapshotError(
          "Media exceeds the secure inspection limit",
          413,
          "CHECKED_MEDIA_LIMIT",
        );
      signal.throwIfAborted();
      const revision = knownSensitiveValueRevision(),
        key = JSON.stringify([
          scope,
          canonicalRoot,
          candidate,
          identity(initial),
          revision,
        ]);
      await this.#prune();
      signal.throwIfAborted();
      if (this.#uncertain) throw unknownCapacity(true);
      let entry = this.#entries.get(key);
      if (entry?.evicted) entry = undefined;
      if (!entry) {
        job = this.#jobs.get(key);
        if (!job) {
          await this.#room(Number(initial.size));
          signal.throwIfAborted();
          // Another requester may have joined while idle descriptors were closing.
          job = this.#jobs.get(key);
          entry = this.#entries.get(key);
          if (entry?.evicted) entry = undefined;
          if (!job && !entry) {
            if (this.#uncertain) throw unknownCapacity(true);
            this.#assertRoom(Number(initial.size));
            const controller = new AbortController();
            job = {
              key,
              scope,
              size: Number(initial.size),
              controller,
              waiters: 0,
              promise: undefined!,
            };
            this.#jobs.set(key, job);
            this.#pendingBytes += job.size;
            const current = job;
            job.promise = this.#produce(
              current,
              candidate,
              initial,
              revision,
            ).finally(() => {
              this.#jobs.delete(key);
              this.#pendingBytes -= current.size;
            });
            void job.promise.catch(() => {});
          }
        }
        if (job) {
          job.waiters++;
          entry = await raceAbort(job.promise, signal);
        }
      }
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      if (!entry || entry.evicted || this.#closed) throw closed();
      entry.refs++;
      pin = entry;
      await verifySource(source, candidate, initial);
      signal.throwIfAborted();
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      if (
        options.expectedSha256 !== undefined &&
        entry.sha256 !== options.expectedSha256
      )
        throw changed();
      const closingSource = source;
      try {
        await closingSource.close();
        source = undefined;
      } catch {
        this.#uncertain = true;
        this.#uncertainHandles.add(closingSource);
        source = undefined;
        throw unknownCapacity(true);
      }
      signal.throwIfAborted();
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      if (this.#uncertain) throw unknownCapacity(true);
      const lease = this.#lease(entry);
      pin = undefined;
      return lease;
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (cause instanceof CheckedMediaSnapshotError) throw cause;
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT")
        throw new CheckedMediaSnapshotError(
          "Media is unavailable",
          404,
          "CHECKED_MEDIA_MISSING",
        );
      if (["ELOOP", "ENOTDIR"].includes(code ?? "")) throw unsafe();
      if (["ENOSPC", "EDQUOT"].includes(code ?? "")) throw diskCapacity();
      if (["EACCES", "EPERM"].includes(code ?? "")) throw unsafe();
      throw unknownCapacity();
    } finally {
      if (job && --job.waiters === 0 && this.#jobs.get(job.key) === job)
        job.controller.abort(closed());
      const cleanup = await Promise.allSettled([
        pin ? this.#unpin(pin) : undefined,
        source?.close(),
      ]);
      if (cleanup.some((value) => value.status === "rejected")) {
        this.#uncertain = true;
        if (source && cleanup[1]?.status === "rejected")
          this.#uncertainHandles.add(source);
        throw unknownCapacity(true);
      }
    }
  }
  async #slot(signal: AbortSignal): Promise<() => void> {
    while (this.#activeScans >= this.#options.scanConcurrency) {
      let wake!: () => void;
      const waiting = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.#scanWaiters.push(wake);
      try {
        await raceAbort(waiting, signal);
      } finally {
        const index = this.#scanWaiters.indexOf(wake);
        if (index >= 0) this.#scanWaiters.splice(index, 1);
      }
    }
    signal.throwIfAborted();
    this.#activeScans++;
    return () => {
      this.#activeScans--;
      this.#scanWaiters.shift()?.();
    };
  }
  async #produce(
    job: Job,
    filename: string,
    initial: BigIntStats,
    revision: number,
  ): Promise<Entry> {
    const signal = job.controller.signal,
      leave = await this.#slot(signal);
    let source: FileHandle | undefined,
      writer: FileHandle | undefined,
      reader: FileHandle | undefined;
    let temporary: string | undefined,
      payload: string | undefined,
      space: DerivedMediaSpaceReservation | undefined;
    try {
      signal.throwIfAborted();
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      const directory = await this.#root();
      signal.throwIfAborted();
      try {
        space = await reserveDerivedMediaSpace(directory, job.size, signal);
      } catch (cause) {
        signal.throwIfAborted();
        throw allocationFailure(cause);
      }
      source = await open(
        filename,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      if (!sameIdentity(initial, await source.stat({ bigint: true })))
        throw changed();
      temporary = await mkdtemp(path.join(directory, "checked-"));
      payload = path.join(temporary, "payload");
      writer = await open(
        payload,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      reader = await open(
        payload,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const written = await writer.stat({ bigint: true }),
        readonly = await reader.stat({ bigint: true });
      if (
        !written.isFile() ||
        written.nlink !== 1n ||
        !sameIdentity(written, readonly) ||
        !sameIdentity(written, await lstat(payload, { bigint: true }))
      )
        throw unsafe();
      // There is never named payload after the first source byte is read.
      await unlink(payload);
      payload = undefined;
      await rmdir(temporary);
      temporary = undefined;
      const hash = createHash("sha256"),
        chunk = Buffer.allocUnsafe(CHUNK),
        overlap = knownSensitiveValueOverlap() * 4;
      let tail: Buffer = Buffer.alloc(0),
        offset = 0;
      while (offset < job.size) {
        signal.throwIfAborted();
        if (revision !== knownSensitiveValueRevision()) throw policyChanged();
        const { bytesRead } = await source.read(
          chunk,
          0,
          Math.min(CHUNK, job.size - offset),
          offset,
        );
        if (!bytesRead) throw changed();
        const bytes = chunk.subarray(0, bytesRead),
          span = tail.length ? Buffer.concat([tail, bytes]) : bytes;
        if (containsKnownSensitiveValue(span.toString("utf8")))
          throw new CheckedMediaSnapshotError(
            "Protected credential data cannot be served",
            403,
            "CHECKED_MEDIA_PROTECTED",
          );
        tail = overlap
          ? Buffer.from(span.subarray(Math.max(0, span.length - overlap)))
          : Buffer.alloc(0);
        hash.update(bytes);
        let copied = 0;
        while (copied < bytesRead) {
          signal.throwIfAborted();
          const result = await writer.write(
            bytes,
            copied,
            bytesRead - copied,
            offset + copied,
          );
          if (!result.bytesWritten) throw capacity();
          copied += result.bytesWritten;
        }
        offset += bytesRead;
      }
      signal.throwIfAborted();
      await verifySource(source, filename, initial);
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      await writer.sync();
      await writer.close();
      writer = undefined;
      const sealed = await reader.stat({ bigint: true });
      if (
        sealed.size !== initial.size ||
        sealed.nlink !== 0n ||
        !sealed.isFile()
      )
        throw changed();
      signal.throwIfAborted();
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      await space.release();
      space = undefined;
      signal.throwIfAborted();
      if (revision !== knownSensitiveValueRevision()) throw policyChanged();
      const entry: Entry = {
        key: job.key,
        scope: job.scope,
        handle: reader,
        size: job.size,
        sha256: hash.digest("hex"),
        revision,
        refs: 0,
        lastUsed: Date.now(),
        evicted: false,
      };
      reader = undefined;
      this.#entries.set(job.key, entry);
      this.#allEntries.add(entry);
      this.#bytes += entry.size;
      this.#schedule();
      return entry;
    } finally {
      try {
        const handles = [source, writer, reader],
          cleanup = await Promise.allSettled(
            handles.map((handle) => handle?.close()),
          );
        const removal = await Promise.allSettled([
          payload ? unlink(payload) : undefined,
        ]);
        let directoryFailed = false;
        if (
          temporary &&
          !removal.some((value) => value.status === "rejected")
        ) {
          try {
            await rmdir(temporary);
          } catch {
            directoryFailed = true;
          }
        }
        if (
          !directoryFailed &&
          !cleanup.some((value) => value.status === "rejected") &&
          !removal.some((value) => value.status === "rejected")
        )
          await space?.release();
        const failure = [...cleanup, ...removal].find(
          (value) => value.status === "rejected",
        ) as PromiseRejectedResult | undefined;
        if (failure || directoryFailed) {
          this.#uncertain = true;
          handles.forEach((handle, index) => {
            if (handle && cleanup[index]?.status === "rejected")
              this.#uncertainHandles.add(handle);
          });
          throw unknownCapacity(true);
        }
      } finally {
        leave();
      }
    }
  }
  #lease(entry: Entry): CheckedMediaSnapshot {
    let released = false,
      used = false,
      stream: Readable | undefined,
      done: Promise<void> | undefined;
    const finish = async () => {
      if (!released) {
        released = true;
        this.#leases.delete(lease);
        await this.#unpin(entry);
      }
    };
    const assertCurrentPolicy = () => {
      if (entry.revision !== knownSensitiveValueRevision())
        throw policyChanged();
    };
    const lease: CheckedMediaSnapshot = Object.freeze({
      size: entry.size,
      sha256: entry.sha256,
      scannerRevision: entry.revision,
      assertCurrentPolicy,
      stream: (
        range?: { start: number; end: number },
        signal?: AbortSignal,
      ): Readable => {
        assertCurrentPolicy();
        signal?.throwIfAborted();
        if (used || released || this.#closed) throw closed();
        if (
          range &&
          (!Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.end) ||
            range.start < 0 ||
            range.end < range.start ||
            range.end >= entry.size)
        )
          throw new RangeError("Invalid checked media byte range");
        used = true;
        let position = range?.start ?? 0,
          reading = false;
        const end = range?.end ?? entry.size - 1;
        const abort = () =>
          stream!.destroy(
            signal!.reason instanceof Error
              ? signal!.reason
              : new Error("Media streaming was cancelled"),
          );
        stream = new Readable({
          highWaterMark: CHUNK,
          autoDestroy: true,
          read() {
            if (reading) return;
            reading = true;
            void (async () => {
              assertCurrentPolicy();
              signal?.throwIfAborted();
              if (position > end) {
                this.push(null);
                return;
              }
              const chunk = Buffer.allocUnsafe(
                  Math.min(CHUNK, end - position + 1),
                ),
                result = await entry.handle.read(
                  chunk,
                  0,
                  chunk.length,
                  position,
                );
              assertCurrentPolicy();
              signal?.throwIfAborted();
              if (this.destroyed) return;
              if (!result.bytesRead) throw changed();
              position += result.bytesRead;
              reading = false;
              this.push(chunk.subarray(0, result.bytesRead));
            })().catch((cause) =>
              this.destroy(
                cause instanceof Error
                  ? cause
                  : new Error("Media streaming stopped"),
              ),
            );
          },
          destroy(error, callback) {
            signal?.removeEventListener("abort", abort);
            void finish().then(
              () => callback(error),
              (cause) => callback(error ?? cause),
            );
          },
        });
        this.#streams.add(stream);
        stream.once("close", () => this.#streams.delete(stream!));
        stream.on("error", () => {});
        done = new Promise((resolve) => stream!.once("close", resolve));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        return stream;
      },
      release: async () => {
        if (stream) {
          if (!stream.destroyed) stream.destroy();
          await done;
        } else await finish();
      },
    });
    this.#leases.add(lease);
    return lease;
  }
  async #unpin(entry: Entry): Promise<void> {
    entry.refs--;
    entry.lastUsed = Date.now();
    if (entry.evicted || this.#closed) await this.#dispose(entry);
    this.#schedule();
  }
  async #dispose(entry: Entry): Promise<void> {
    entry.evicted = true;
    if (entry.refs || entry.closing) return entry.closing;
    return (entry.closing = entry.handle.close().then(
      () => {
        if (this.#entries.get(entry.key) === entry)
          this.#entries.delete(entry.key);
        this.#allEntries.delete(entry);
        this.#bytes -= entry.size;
      },
      () => {
        this.#uncertain = true;
        this.#uncertainHandles.add(entry.handle);
        throw unknownCapacity(true);
      },
    ));
  }
  async #prune(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#allEntries]
        .filter(
          (entry) =>
            entry.revision !== knownSensitiveValueRevision() ||
            (!entry.refs &&
              Date.now() - entry.lastUsed >= this.#options.idleMs),
        )
        .map((entry) => this.#dispose(entry)),
    );
    if (results.some((value) => value.status === "rejected"))
      throw unknownCapacity(true);
  }
  async #room(size: number): Promise<void> {
    for (const entry of [...this.#allEntries].sort(
      (a, b) => a.lastUsed - b.lastUsed,
    )) {
      if (
        this.#bytes + this.#pendingBytes + size <= this.#options.maxBytes &&
        this.#allEntries.size + this.#jobs.size < this.#options.maxEntries
      )
        break;
      if (!entry.refs) await this.#dispose(entry);
    }
    this.#assertRoom(size);
  }
  #assertRoom(size: number): void {
    if (
      this.#bytes + this.#pendingBytes + size > this.#options.maxBytes ||
      this.#allEntries.size + this.#jobs.size >= this.#options.maxEntries
    )
      throw capacity();
  }
  #schedule(): void {
    clearTimeout(this.#timer);
    if (
      !this.#closed &&
      !this.#uncertain &&
      [...this.#allEntries].some((entry) => !entry.refs)
    ) {
      this.#timer = setTimeout(() => {
        void this.#prune()
          .catch(() => {})
          .finally(() => this.#schedule());
      }, this.#options.idleMs);
      this.#timer.unref();
    }
  }
  async evictScope(scope: string): Promise<void> {
    for (const job of this.#jobs.values())
      if (job.scope === scope) job.controller.abort(closed());
    await Promise.all(
      [...this.#allEntries]
        .filter((entry) => entry.scope === scope)
        .map((entry) => this.#dispose(entry)),
    );
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true;
      this.#unsubscribe();
      clearTimeout(this.#timer);
      this.#shutdown.abort(closed());
      for (const job of this.#jobs.values()) job.controller.abort(closed());
      await Promise.allSettled([...this.#acquires]);
      const builders = await Promise.allSettled(
        [...this.#jobs.values()].map((job) => job.promise),
      );
      const leases = await Promise.allSettled(
        [...this.#leases].map((lease) => lease.release()),
      );
      // One failed close must not skip unrelated anonymous descriptors.
      const entries = await Promise.allSettled(
        [...this.#allEntries].map((entry) => this.#dispose(entry)),
      );
      const uncertain = await Promise.allSettled(
        [...this.#uncertainHandles].map((handle) => handle.close()),
      );
      const failures = [
        ...builders,
        ...leases,
        ...entries,
        ...uncertain,
      ].filter(
        (value): value is PromiseRejectedResult =>
          value.status === "rejected" &&
          !(
            value.reason instanceof CheckedMediaSnapshotError &&
            value.reason.code === "CHECKED_MEDIA_CLOSED"
          ),
      );
      if (failures.length)
        throw new AggregateError(
          failures.map(() => unknownCapacity(true)),
          "Some secure media descriptors could not be confirmed closed",
        );
    })());
  }
}
