import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  getCapacityProfile,
  type CapacityProfileId,
} from "../shared/execution-capacity-profiles.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import {
  runtimeMediaPath,
  mediaHeaderMatches,
} from "./isolated-project-files.js";
import {
  assertSourceManifestPath,
  canonicalSourceManifestRows,
  type SourceManifestEntryV1,
} from "./isolated-source-manifest.js";
import {
  durablePublicationFile,
  syncPublicationDirectory,
} from "./isolated-publication-journal.js";

type Profile = NonNullable<ReturnType<typeof getCapacityProfile>>;
export interface CapacityManifestV2 {
  version: 2;
  profile: CapacityProfileId;
  limits: Profile;
  permissionSemantics: "executable-only";
  manifestId: string;
  files: readonly SourceManifestEntryV1[];
}
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-f0-9]{32}$/;
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): never => {
  throw new Error(`Capacity seed: ${message}`);
};
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
function profileFor(value: unknown): Profile {
  if (typeof value !== "string") return fail("invalid profile");
  const profile = getCapacityProfile(value as CapacityProfileId);
  if (
    !profile ||
    profile.id !== value ||
    profile.runtimeEnabled !== false ||
    profile.simulationOnly !== true
  )
    return fail("unknown simulation profile");
  return profile;
}

/** This metadata describes a candidate; it does not authorize a copy, publication or execution. */
export function createCapacityManifest(
  profileId: CapacityProfileId,
  entries: readonly SourceManifestEntryV1[],
): CapacityManifestV2 {
  const profile = profileFor(profileId);
  if (!Array.isArray(entries) || entries.length > profile.fileCount)
    return fail("invalid file count");
  const seen = new Set<string>();
  let source = 0,
    media = 0;
  for (const entry of entries) {
    if (!exact(entry, ["path", "kind", "size", "sha256", "executable"]))
      return fail("invalid manifest entry");
    assertSourceManifestPath(entry.path);
    if (
      /[\u0000-\u001f]/.test(entry.path) ||
      containsKnownSensitiveValue(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !hashPattern.test(entry.sha256) ||
      typeof entry.executable !== "boolean"
    )
      return fail("invalid manifest identity");
    seen.add(entry.path);
    if (entry.kind === "source") {
      if (entry.size > profile.sourceFileBytes)
        return fail("source file limit exceeded");
      source += entry.size;
    } else if (entry.kind === "media") {
      if (
        !runtimeMediaPath(entry.path) ||
        entry.executable ||
        entry.size < 1 ||
        entry.size > profile.mediaFileBytes
      )
        return fail("media file limit exceeded");
      media += entry.size;
    } else return fail("invalid file kind");
    if (source > profile.sourceBytes || media > profile.mediaBytes)
      return fail("complete manifest limit exceeded");
  }
  for (const name of seen) {
    const parts = name.split("/");
    for (let count = 1; count < parts.length; count++)
      if (seen.has(parts.slice(0, count).join("/")))
        return fail("conflicting parent path");
  }
  const rows = canonicalSourceManifestRows(entries);
  const files = (
    JSON.parse(rows) as Array<
      [string, "source" | "media", number, string, boolean]
    >
  ).map(([path, kind, size, sha256, executable]) =>
    Object.freeze({ path, kind, size, sha256, executable }),
  );
  const manifestId = digest(
    `ohmygame-capacity-manifest-v2\n${JSON.stringify(profile)}\n${rows}`,
  );
  return Object.freeze({
    version: 2,
    profile: profile.id,
    limits: profile,
    permissionSemantics: "executable-only",
    manifestId,
    files: Object.freeze(files),
  });
}
export function parseCapacityManifest(value: unknown): CapacityManifestV2 {
  if (
    !exact(value, [
      "version",
      "profile",
      "limits",
      "permissionSemantics",
      "manifestId",
      "files",
    ]) ||
    value.version !== 2 ||
    value.permissionSemantics !== "executable-only" ||
    !Array.isArray(value.files)
  )
    return fail("invalid manifest contract");
  const profile = profileFor(value.profile),
    supplied = value.limits;
  if (
    !exact(supplied, Object.keys(profile)) ||
    Object.entries(profile).some(([key, item]) => supplied[key] !== item)
  )
    return fail("manifest limits differ from profile");
  const manifest = createCapacityManifest(
    profile.id,
    value.files as SourceManifestEntryV1[],
  );
  if (manifest.manifestId !== value.manifestId)
    return fail("manifest digest mismatch");
  return manifest;
}
export interface SeedScope {
  transactionId: string;
  namespace: "manual" | "test";
  projectId: string;
  operationId: string;
  generation: number;
  profile: CapacityProfileId;
  manifestId: string;
  baselineManifestId: string;
}
export interface SeedSource {
  path: string;
  data: string;
}
export interface SeedBegin {
  scope: SeedScope;
  manifest: CapacityManifestV2;
  sources: SeedSource[];
}
interface SeedRecord {
  version: 1;
  phase: "initializing" | "receiving" | "committed";
  scope: SeedScope;
  manifest: CapacityManifestV2;
  nextWindow: number;
  windows: string[][];
}
function scopeValid(scope: SeedScope): void {
  if (
    !exact(scope, [
      "transactionId",
      "namespace",
      "projectId",
      "operationId",
      "generation",
      "profile",
      "manifestId",
      "baselineManifestId",
    ]) ||
    typeof scope.transactionId !== "string" ||
    !identifier.test(scope.transactionId) ||
    typeof scope.operationId !== "string" ||
    !identifier.test(scope.operationId) ||
    !["manual", "test"].includes(scope.namespace) ||
    typeof scope.projectId !== "string" ||
    !/^[a-z0-9-]{1,128}$/i.test(scope.projectId) ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1 ||
    typeof scope.manifestId !== "string" ||
    !hashPattern.test(scope.manifestId) ||
    typeof scope.baselineManifestId !== "string" ||
    !hashPattern.test(scope.baselineManifestId)
  )
    fail("invalid transaction scope");
  profileFor(scope.profile);
}
function windowsFor(manifest: CapacityManifestV2): string[][] {
  const result: string[][] = [];
  let size = 0;
  for (const file of manifest.files.filter((file) => file.kind === "media")) {
    if (!result.length || size + file.size > manifest.limits.mediaWindowBytes) {
      result.push([]);
      size = 0;
    }
    result.at(-1)!.push(file.path);
    size += file.size;
  }
  return result;
}
async function privateDirectory(directory: string): Promise<string> {
  const actual = await realpath(directory),
    info = await lstat(directory);
  if (
    actual !== path.resolve(directory) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    return fail("unsafe private staging directory");
  return actual;
}
const fileName = (index: number) => `item-${String(index).padStart(4, "0")}`;
async function readRecord(directory: string): Promise<SeedRecord> {
  const recordPath = path.join(directory, "state.json"),
    info = await lstat(recordPath);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    info.size > 2 * 1024 * 1024
  )
    return fail("unsafe transaction state");
  const value = JSON.parse(
    (
      await readSafeProjectFile(directory, recordPath, 2 * 1024 * 1024)
    ).toString("utf8"),
  ) as SeedRecord;
  if (
    !exact(value, [
      "version",
      "phase",
      "scope",
      "manifest",
      "nextWindow",
      "windows",
    ]) ||
    value.version !== 1 ||
    !["initializing", "receiving", "committed"].includes(value.phase) ||
    !Number.isSafeInteger(value.nextWindow)
  )
    return fail("invalid transaction state");
  scopeValid(value.scope);
  const manifest = parseCapacityManifest(value.manifest);
  const windows = windowsFor(manifest);
  if (
    manifest.profile !== value.scope.profile ||
    manifest.manifestId !== value.scope.manifestId ||
    value.scope.baselineManifestId !==
      createCapacityManifest(manifest.profile, []).manifestId ||
    value.nextWindow < 0 ||
    value.nextWindow > windows.length ||
    JSON.stringify(value.windows) !== JSON.stringify(windows) ||
    (value.phase === "committed" && value.nextWindow !== windows.length)
  )
    return fail("inconsistent transaction state");
  return { ...value, manifest };
}
async function putRecord(directory: string, record: SeedRecord): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > 2 * 1024 * 1024)
    return fail("transaction metadata exceeds bound");
  const temporary = path.join(directory, `.state-${randomUUID()}`);
  await durablePublicationFile(temporary, bytes);
  await rename(temporary, path.join(directory, "state.json"));
  await syncPublicationDirectory(directory);
}
async function lock(directory: string): Promise<void> {
  await durablePublicationFile(
    path.join(directory, ".active"),
    Buffer.from("capacity seed operation\n"),
  );
}
async function unlock(directory: string): Promise<void> {
  await unlink(path.join(directory, ".active"));
  await syncPublicationDirectory(directory);
}
async function transactionDirectory(
  root: string,
  scope: SeedScope,
): Promise<string> {
  scopeValid(scope);
  const base = await privateDirectory(root);
  return privateDirectory(path.join(base, scope.transactionId));
}
function matchScope(expected: SeedScope, actual: SeedScope): void {
  if (
    Object.keys(expected).some(
      (key) =>
        expected[key as keyof SeedScope] !== actual[key as keyof SeedScope],
    )
  )
    fail("transaction identity changed");
}
async function nextWindowChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (!signal) return iterator.next();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    if (signal.aborted) abort();
  });
}
async function stageBytes(
  directory: string,
  index: number,
  bytes: Buffer,
): Promise<void> {
  await durablePublicationFile(path.join(directory, fileName(index)), bytes);
}

/** Begin only stages a first seed against an empty baseline. No project data is modified. */
export async function beginSeedTransaction(
  root: string,
  request: SeedBegin,
  signal?: AbortSignal,
): Promise<{ windows: readonly (readonly string[])[] }> {
  signal?.throwIfAborted();
  if (!exact(request, ["scope", "manifest", "sources"]))
    return fail("invalid begin request");
  scopeValid(request.scope);
  const manifest = parseCapacityManifest(request.manifest);
  if (
    request.scope.profile !== manifest.profile ||
    request.scope.manifestId !== manifest.manifestId ||
    request.scope.baselineManifestId !==
      createCapacityManifest(manifest.profile, []).manifestId ||
    !Array.isArray(request.sources)
  )
    return fail("invalid first-seed binding");
  if (
    Buffer.byteLength(JSON.stringify(request), "utf8") + 1 >
    manifest.limits.requestHeaderBytes
  )
    return fail("seed header limit exceeded");
  const sources = manifest.files.filter((file) => file.kind === "source"),
    supplied = new Map<string, Buffer>();
  for (const item of request.sources) {
    if (
      !exact(item, ["path", "data"]) ||
      typeof item.path !== "string" ||
      typeof item.data !== "string" ||
      supplied.has(item.path) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        item.data,
      )
    )
      return fail("invalid source payload");
    const bytes = Buffer.from(item.data, "base64"),
      expected = sources.find((file) => file.path === item.path);
    if (
      !expected ||
      bytes.toString("base64") !== item.data ||
      bytes.length !== expected.size ||
      digest(bytes) !== expected.sha256 ||
      containsKnownSensitiveValue(bytes.toString("utf8"))
    )
      return fail("source bytes do not match manifest");
    supplied.set(item.path, bytes);
  }
  if (supplied.size !== sources.length)
    return fail("incomplete source payload");
  const windows = windowsFor(manifest);
  if (
    Buffer.byteLength(JSON.stringify({ windows }), "utf8") + 1 >
    manifest.limits.responseHeaderBytes
  )
    return fail("seed response header limit exceeded");
  const base = await privateDirectory(root),
    directory = path.join(base, request.scope.transactionId);
  await mkdir(directory, { mode: 0o700 });
  await syncPublicationDirectory(base);
  await lock(directory);
  const record: SeedRecord = {
    version: 1,
    phase: "initializing",
    scope: request.scope,
    manifest,
    nextWindow: 0,
    windows,
  };
  await putRecord(directory, record);
  for (const [index, item] of manifest.files.entries()) {
    signal?.throwIfAborted();
    if (item.kind === "source")
      await stageBytes(directory, index, supplied.get(item.path)!);
  }
  signal?.throwIfAborted();
  record.phase = "receiving";
  await putRecord(directory, record);
  await unlock(directory);
  return { windows: record.windows };
}

/** One exact ordered window; failed or interrupted windows are retained for explicit inspection. */
export async function writeSeedWindow(
  root: string,
  scope: SeedScope,
  index: number,
  paths: readonly string[],
  stream: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directory = await transactionDirectory(root, scope);
  const before = await readRecord(directory);
  matchScope(before.scope, scope);
  if (
    Buffer.byteLength(JSON.stringify({ scope, index, paths }), "utf8") + 1 >
    before.manifest.limits.requestHeaderBytes
  )
    return fail("window header limit exceeded");
  if (
    before.phase !== "receiving" ||
    index !== before.nextWindow ||
    JSON.stringify(paths) !== JSON.stringify(before.windows[index])
  )
    return fail("unexpected or repeated window");
  await lock(directory);
  const record = await readRecord(directory);
  matchScope(record.scope, scope);
  if (
    record.phase !== "receiving" ||
    index !== record.nextWindow ||
    JSON.stringify(paths) !== JSON.stringify(record.windows[index])
  )
    return fail("unexpected or repeated window");
  const entries = record.windows[index]!.map((name) =>
    record.manifest.files.find((file) => file.path === name)!,
  );
  let current = 0,
    received = 0,
    handle: Awaited<ReturnType<typeof open>> | undefined,
    fileHash = createHash("sha256"),
    header = Buffer.alloc(0);
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await nextWindowChunk(iterator, signal);
      if (result.done) break;
      const value = result.value;
      signal?.throwIfAborted();
      if (!(value instanceof Uint8Array)) return fail("invalid window bytes");
      let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        offset = 0;
      while (offset < chunk.length) {
        const entry = entries[current];
        if (!entry) return fail("trailing window bytes");
        if (!handle)
          handle = await open(
            path.join(
              directory,
              fileName(record.manifest.files.indexOf(entry)),
            ),
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              constants.O_NOFOLLOW,
            0o600,
          );
        const length = Math.min(chunk.length - offset, entry.size - received),
          part = chunk.subarray(offset, offset + length);
        await handle.writeFile(part);
        fileHash.update(part);
        if (header.length < 16)
          header = Buffer.concat([
            header,
            part.subarray(0, 16 - header.length),
          ]);
        received += length;
        offset += length;
        if (received === entry.size) {
          await handle.sync();
          await handle.close();
          handle = undefined;
          if (
            fileHash.digest("hex") !== entry.sha256 ||
            !mediaHeaderMatches(entry.path, header, entry.size)
          )
            return fail("media digest or header mismatch");
          current++;
          received = 0;
          fileHash = createHash("sha256");
          header = Buffer.alloc(0);
        }
      }
    }
    signal?.throwIfAborted();
    if (current !== entries.length || received !== 0)
      return fail("truncated window");
    await syncPublicationDirectory(directory);
    record.nextWindow++;
    await putRecord(directory, record);
    await unlock(directory);
  } finally {
    await handle?.close();
    if (signal?.aborted && iterator.return)
      void Promise.resolve(iterator.return()).catch(() => {});
  }
}

async function verifyStagedFile(
  directory: string,
  index: number,
  expected: SourceManifestEntryV1,
  signal?: AbortSignal,
): Promise<void> {
  const stagedPath = path.join(directory, fileName(index));
  const handle = await open(
    stagedPath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n ||
      before.size !== BigInt(expected.size)
    )
      return fail("staged file identity changed");
    const h = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > expected.size) return fail("staged file grew");
      h.update(bytes);
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(stagedPath, { bigint: true });
    if (
      size !== expected.size ||
      h.digest("hex") !== expected.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode ||
      after.nlink !== 1n ||
      !current.isFile() ||
      current.nlink !== 1n ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.size !== after.size ||
      current.mode !== after.mode ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs
    )
      return fail("staged file changed before commit");
  } finally {
    await handle.close();
  }
}

/** Commit is a single durable staging receipt; publishing or running requires a separate authority. */
export async function commitSeedTransaction(
  root: string,
  scope: SeedScope,
  signal?: AbortSignal,
): Promise<{ transactionId: string; manifestId: string; committed: true }> {
  signal?.throwIfAborted();
  const directory = await transactionDirectory(root, scope);
  const before = await readRecord(directory);
  matchScope(before.scope, scope);
  if (
    before.phase !== "receiving" ||
    before.nextWindow !== before.windows.length
  )
    return fail("seed is incomplete or already committed");
  await lock(directory);
  const record = await readRecord(directory);
  matchScope(record.scope, scope);
  if (
    record.phase !== "receiving" ||
    record.nextWindow !== record.windows.length
  )
    return fail("seed is incomplete or already committed");
  const allowed = new Set([
    ".active",
    "state.json",
    ...record.manifest.files.map((_, index) => fileName(index)),
  ]);
  const actual = await readdir(directory);
  if (
    actual.length !== allowed.size ||
    actual.some((name) => !allowed.has(name))
  )
    return fail("staged files are missing or unknown");
  for (const [index, entry] of record.manifest.files.entries()) {
    signal?.throwIfAborted();
    await verifyStagedFile(directory, index, entry, signal);
  }
  signal?.throwIfAborted();
  record.phase = "committed";
  await putRecord(directory, record);
  await unlock(directory);
  return {
    transactionId: scope.transactionId,
    manifestId: scope.manifestId,
    committed: true,
  };
}

/** Read-only recovery evidence. An active marker means busy or interrupted, never permission to retry. */
export async function inspectSeedTransaction(
  root: string,
  scope: SeedScope,
): Promise<{
  phase: SeedRecord["phase"] | "unknown";
  activeOrInterrupted: boolean;
  nextWindow: number | null;
  windowCount: number | null;
  manifestId: string | null;
}> {
  const directory = await transactionDirectory(root, scope);
  let record: SeedRecord;
  try {
    record = await readRecord(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      phase: "unknown",
      activeOrInterrupted: true,
      nextWindow: null,
      windowCount: null,
      manifestId: null,
    };
  }
  matchScope(record.scope, scope);
  const entries = await readdir(directory);
  return {
    phase: record.phase,
    activeOrInterrupted:
      entries.includes(".active") ||
      entries.some((name) => name.startsWith(".state-")),
    nextWindow: record.nextWindow,
    windowCount: record.windows.length,
    manifestId: record.manifest.manifestId,
  };
}
