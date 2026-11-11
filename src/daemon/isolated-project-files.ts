import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import {
  getRuntimeCapacityProfile,
  runtimeLargeMediaSupported,
  runtimeMediaFileLimit,
  type RuntimeCapacityProfileId,
} from "../shared/execution-capacity-profiles.js";
import { CheckedMediaSnapshotStore } from "./checked-media-snapshot.js";
import { canvasCandidatePaths } from "./canvas-assets.js";
import { sniffImageType } from "./image-format.js";
import { isFbxArtifact } from "./fbx-preview.js";
import {
  assertNoKnownSecretBytes,
  inspectSafeProjectMedia,
  readSafeProjectFile,
} from "./safe-project-file.js";
import { isolatedInputBudgetError } from "./isolated-tool-receipts.js";
import type { SourceManifestEntryV1 } from "./isolated-source-manifest.js";

export const PROJECT_SOURCE_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  fileCount: 2000,
  entries: 4000,
  mediaFileBytes: 32 * 1024 * 1024,
  mediaBytes: 64 * 1024 * 1024,
});
const LIMIT = PROJECT_SOURCE_LIMITS.totalBytes;
const MEDIA_FILE_LIMIT = PROJECT_SOURCE_LIMITS.mediaFileBytes;
const MEDIA_LIMIT = PROJECT_SOURCE_LIMITS.mediaBytes;
export type ProjectSourceProfile = RuntimeCapacityProfileId;
export interface ProjectSourceOptions {
  profile?: ProjectSourceProfile;
  signal?: AbortSignal;
}
function projectSourceLimits(
  profile?: ProjectSourceProfile,
): ProjectSourceBudget["limits"] {
  if (profile === undefined) return PROJECT_SOURCE_LIMITS;
  const selected = getRuntimeCapacityProfile(profile);
  return {
    fileBytes: selected.sourceFileBytes,
    totalBytes: selected.sourceBytes,
    fileCount: selected.fileCount,
    entries: selected.entryCount,
    mediaFileBytes: selected.mediaFileBytes,
    mediaBytes: selected.mediaBytes,
    ...(selected.id === "capacity-128-media64-v3"
      ? {
          largeMediaFileBytes: selected.largeMediaFileBytes,
          largeMediaFilePolicy: selected.largeMediaFilePolicy,
        }
      : {}),
  };
}
export interface RuntimeMedia {
  path: string;
  size: number;
  sha256: string;
}

let runtimeStoreClosing: Promise<void> | undefined;
let checkedRuntimeStore:
  Promise<{ directory: string; store: CheckedMediaSnapshotStore }> | undefined;
function runtimeStore() {
  if (runtimeStoreClosing) throw new Error("Checked transfer cache is closing");
  return (checkedRuntimeStore ??= (async () => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "ohmygame-isolated-media-")),
    );
    return {
      directory,
      store: new CheckedMediaSnapshotStore(directory, {
        maxBytes: 128 * 1024 * 1024,
        maxEntries: 8,
        scanConcurrency: 2,
      }),
    };
  })());
}
/** Only anonymous checked copies belong to this process-local cache. */
export async function closeRuntimeMediaSnapshots(): Promise<void> {
  if (runtimeStoreClosing) return runtimeStoreClosing;
  const owned = checkedRuntimeStore;
  if (!owned) return;
  const closing = (async () => {
    const { store, directory } = await owned;
    await store.close();
    await rmdir(directory);
  })();
  runtimeStoreClosing = closing;
  await closing;
  checkedRuntimeStore = undefined;
  runtimeStoreClosing = undefined;
}

/** Full scan and sealing precede the first payload byte; no full media Buffer is returned. */
export async function withCheckedFileStream<T>(
  root: string,
  filename: string,
  options: {
    maxBytes: number;
    expectedSha256?: string;
    expectedSize?: number;
    signal?: AbortSignal;
  },
  consume: (
    stream: Readable,
    info: {
      size: number;
      sha256: string;
      prefix: Buffer;
      scannerRevision: number;
    },
  ) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.maxBytes > 64 * 1024 * 1024
  )
    throw new Error("Invalid checked transfer bound");
  const { store } = await runtimeStore();
  const scope = `isolated-transfer:${randomUUID()}`;
  let first: Awaited<ReturnType<typeof store.acquire>> | undefined,
    snapshot: Awaited<ReturnType<typeof store.acquire>> | undefined,
    stream: Readable | undefined;
  let primary: unknown;
  try {
    first = await store.acquire(root, filename, { ...options, scope });
    if (
      options.expectedSize !== undefined &&
      first.size !== options.expectedSize
    )
      throw new Error("Checked transfer size changed");
    let prefix = Buffer.alloc(0);
    if (first.size) {
      const pieces: Buffer[] = [];
      for await (const chunk of first.stream(
        { start: 0, end: Math.min(255, first.size - 1) },
        options.signal,
      ))
        pieces.push(chunk);
      prefix = Buffer.concat(pieces);
    }
    await first.release();
    snapshot = await store.acquire(root, filename, {
      ...options,
      expectedSha256: first.sha256,
      scope,
    });
    if (snapshot.size !== first.size)
      throw new Error("Checked transfer size changed");
    snapshot.assertCurrentPolicy();
    stream = snapshot.stream(undefined, options.signal);
    const result = await consume(stream, {
      size: snapshot.size,
      sha256: snapshot.sha256,
      prefix,
      scannerRevision: snapshot.scannerRevision,
    });
    options.signal?.throwIfAborted();
    snapshot.assertCurrentPolicy();
    return result;
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    stream?.destroy();
    const cleanup = await Promise.allSettled([
      first?.release(),
      snapshot?.release(),
    ]);
    try {
      await store.evictScope(scope);
    } catch (cause) {
      throw new Error("Checked transfer cleanup could not be confirmed", {
        cause:
          primary === undefined ? cause : new AggregateError([primary, cause]),
      });
    }
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected")
      throw new Error("Checked transfer cleanup could not be confirmed", {
        cause:
          primary === undefined
            ? failure.reason
            : new AggregateError([primary, failure.reason]),
      });
  }
}

async function withRuntimeMedia<T>(
  workspace: string,
  entry: RuntimeMedia,
  options: {
    profile?: RuntimeCapacityProfileId;
    signal?: AbortSignal;
    formatPath?: string;
  },
  consume: Parameters<typeof withCheckedFileStream<T>>[3],
): Promise<T> {
  transferPath(entry.path);
  const limit = runtimeMediaFileLimit(entry.path, options.profile);
  if (
    !runtimeMediaPath(entry.path) ||
    containsKnownSensitiveValue(entry.path) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > limit ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("Invalid isolated runtime media reference");
  const target = path.join(await realpath(workspace), entry.path),
    info = await lstat(target);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size !== entry.size ||
    info.mode & 0o111
  )
    throw new Error("Isolated runtime media changed since preparation");
  return withCheckedFileStream(
    workspace,
    target,
    {
      maxBytes: limit,
      expectedSize: entry.size,
      expectedSha256: entry.sha256,
      signal: options.signal,
    },
    async (stream, checked) => {
      const current = await lstat(target);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size !== info.size ||
        current.mode !== info.mode ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs
      )
        throw new Error("Isolated runtime media changed since preparation");
      if (
        !mediaHeaderMatches(
          options.formatPath ?? entry.path,
          checked.prefix,
          checked.size,
          options.profile,
        )
      )
        throw new Error("Invalid isolated runtime media copy format");
      return consume(stream, checked);
    },
  );
}
export function inspectRuntimeMedia(
  workspace: string,
  entry: RuntimeMedia,
  options: {
    profile?: RuntimeCapacityProfileId;
    signal?: AbortSignal;
    formatPath?: string;
  } = {},
) {
  return withRuntimeMedia(
    workspace,
    entry,
    options,
    async (_stream, checked) => checked,
  );
}
export async function copyRuntimeMedia(
  workspace: string,
  entry: RuntimeMedia,
  destination: Writable | FileHandle,
  options: {
    profile?: RuntimeCapacityProfileId;
    signal?: AbortSignal;
    formatPath?: string;
  } = {},
): Promise<void> {
  await withRuntimeMedia(workspace, entry, options, async (stream) => {
    for await (const chunk of stream) {
      options.signal?.throwIfAborted();
      if ("writeFile" in destination) await destination.writeFile(chunk);
      else
        await new Promise<void>((resolve, reject) =>
          destination.write(chunk, (cause: Error | null | undefined) =>
            cause ? reject(cause) : resolve(),
          ),
        );
    }
  });
}

export function runtimeMediaPath(relative: string): boolean {
  return (
    /(?:^|\/)(?:public|src)\/|^assets\/(?:imported|generated|files)\//.test(
      relative,
    ) &&
    /\.(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|m4a|mp3|wav|ogg|glb)$/i.test(
      relative,
    )
  );
}

export function mediaHeaderMatches(
  relative: string,
  bytes: Buffer,
  size = bytes.length,
  profile?: RuntimeCapacityProfileId,
): boolean {
  const extension = path.extname(relative).toLowerCase();
  if (profile === "capacity-128-media64-v3" && size > MEDIA_FILE_LIMIT && [".mp4", ".m4a", ".mov"].includes(extension) && bytes.toString("latin1", 4, 8) === "ftyp") {
    if (bytes.length < 16) return false;
    let boxSize = bytes.readUInt32BE(0), header = 8;
    if (boxSize === 1) { const extended = bytes.readBigUInt64BE(8); if (extended > 256n) return false; boxSize = Number(extended); header = 16; }
    if (boxSize < header + 8 || boxSize > 256 || boxSize > bytes.length || boxSize % 4) return false;
    const imageBrands = new Set(["avif", "avis", "mif1", "msf1", "miaf", "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "heif"]);
    for (let offset = header; offset < boxSize; offset += 4) if (offset !== header + 4 && imageBrands.has(bytes.toString("latin1", offset, offset + 4))) return false;
  }
  const start = bytes.toString("latin1", 0, 4);
  switch (extension) {
    case ".png":
      return sniffImageType(bytes) === "image/png";
    case ".jpg":
    case ".jpeg":
      return sniffImageType(bytes) === "image/jpeg";
    case ".webp":
      return sniffImageType(bytes) === "image/webp";
    case ".gif":
      return ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6));
    case ".avif":
      return (
        bytes.toString("latin1", 4, 8) === "ftyp" &&
        /^(avif|avis|mif1)$/.test(bytes.toString("latin1", 8, 12))
      );
    case ".m4a":
    case ".mp4":
      return bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp";
    case ".mov":
      return (
        bytes.length >= 12 &&
        ["ftyp", "moov", "mdat", "wide"].includes(
          bytes.toString("latin1", 4, 8),
        )
      );
    case ".webm":
      return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
    case ".mp3":
      return (
        bytes.toString("latin1", 0, 3) === "ID3" ||
        (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      );
    case ".wav":
      return start === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE";
    case ".ogg":
      return start === "OggS";
    case ".glb":
      return (
        start === "glTF" &&
        bytes.length >= 12 &&
        bytes.readUInt32LE(4) === 2 &&
        bytes.readUInt32LE(8) === size
      );
    default:
      return false;
  }
}

async function isCanvasMediaSnapshot(
  target: string,
  relative: string,
): Promise<boolean> {
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.mode & 0o111n ||
      (await realpath(target)) !== target
    )
      throw new Error(
        "Only ordinary non-executable Canvas media can be retained outside execution",
      );
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const prefix = header.subarray(0, bytesRead);
    const current = await lstat(target, { bigint: true });
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.ctimeNs !== stat.ctimeNs
    )
      throw new Error("Canvas media changed during isolated preparation");
    return path.extname(relative).toLowerCase() === ".fbx"
      ? isFbxArtifact(prefix)
      : mediaHeaderMatches(relative, prefix, Number(stat.size));
  } finally {
    await handle.close();
  }
}

/** Read a bounded, secret-checked snapshot again on a cache miss or an artifact return. */
export async function readRuntimeMedia(
  workspace: string,
  entry: RuntimeMedia,
): Promise<Buffer> {
  transferPath(entry.path);
  if (
    !runtimeMediaPath(entry.path) ||
    containsKnownSensitiveValue(entry.path) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > MEDIA_FILE_LIMIT ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("Invalid isolated runtime media reference");
  const target = path.join(await realpath(workspace), entry.path);
  const stat = await lstat(target);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size !== entry.size ||
    stat.mode & 0o111
  )
    throw new Error("Isolated runtime media changed since preparation");
  const bytes = await readSafeProjectFile(workspace, target, MEDIA_FILE_LIMIT);
  if (
    bytes.length !== entry.size ||
    !mediaHeaderMatches(entry.path, bytes) ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  )
    throw new Error("Isolated runtime media changed since preparation");
  return bytes;
}
export interface TransferFile {
  path: string;
  data: string;
  sha256: string;
  executable?: boolean;
  mode?: number;
  /** Guest proposal only; the host must validate the bound original and decode the raster. */
  rasterBaseSha256?: string;
}

/** Build seed metadata from projectFiles(workspace, media). Media descriptors are not verified or authorized here. Byte totals are decoded source bytes and declared media bytes. */
export function sourceManifestEntries(
  input: readonly (TransferFile | RuntimeMedia)[],
  options?: Pick<ProjectSourceOptions, "profile">,
): {
  files: SourceManifestEntryV1[];
  ordinaryInlineBytes: number;
  binaryDeclaredBytes: number;
} {
  const limits = projectSourceLimits(options?.profile);
  if (!Array.isArray(input) || input.length > limits.fileCount)
    throw new Error("Invalid source manifest transfer count");
  const seen = new Set<string>();
  const files: SourceManifestEntryV1[] = [];
  let ordinaryInlineBytes = 0,
    binaryDeclaredBytes = 0;
  for (const value of input) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.path !== "string" ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new Error("Invalid source manifest transfer entry");
    transferPath(value.path);
    if (
      containsKnownSensitiveValue(value.path) ||
      seen.has(value.path) ||
      value.path
        .split("/")
        .some((part: string) =>
          ["node_modules", "dist", "build", "out"].includes(part),
        )
    )
      throw new Error("Private, duplicate or generated source manifest path");
    seen.add(value.path);
    const keys = Object.keys(value);
    if ("data" in value) {
      if (
        keys.some(
          (key) =>
            !["path", "data", "sha256", "executable", "mode"].includes(key),
        ) ||
        typeof value.data !== "string" ||
        value.data.length >
          Math.ceil(PROJECT_SOURCE_LIMITS.fileBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value.data,
        ) ||
        (value.executable !== undefined &&
          typeof value.executable !== "boolean") ||
        (value.mode !== undefined &&
          (!Number.isInteger(value.mode) ||
            value.mode < 0 ||
            value.mode > 0o777 ||
            Boolean(value.mode & 0o111) !== (value.executable === true)))
      )
        throw new Error("Invalid source manifest inline source");
      const bytes = Buffer.from(value.data, "base64");
      if (
        bytes.toString("base64") !== value.data ||
        bytes.length > PROJECT_SOURCE_LIMITS.fileBytes ||
        createHash("sha256").update(bytes).digest("hex") !== value.sha256
      )
        throw new Error("Invalid source manifest inline source bytes");
      assertNoKnownSecretBytes(bytes);
      ordinaryInlineBytes += bytes.length;
      if (ordinaryInlineBytes > PROJECT_SOURCE_LIMITS.totalBytes)
        throw new Error("Source manifest ordinary source budget exceeded");
      files.push({
        path: value.path,
        kind: "source",
        size: bytes.length,
        sha256: value.sha256,
        executable: value.executable === true,
      });
    } else {
      if (
        keys.some((key) => !["path", "size", "sha256"].includes(key)) ||
        !runtimeMediaPath(value.path) ||
        !("size" in value) ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        value.size > runtimeMediaFileLimit(value.path, options?.profile)
      )
        throw new Error("Invalid source manifest media descriptor");
      binaryDeclaredBytes += value.size;
      if (binaryDeclaredBytes > limits.mediaBytes)
        throw new Error("Source manifest media budget exceeded");
      files.push({
        path: value.path,
        kind: "media",
        size: value.size,
        sha256: value.sha256,
        executable: false,
      });
    }
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++)
      if (seen.has(parts.slice(0, index).join("/")))
        throw new Error("Source manifest path has a file parent");
  }
  return { files, ordinaryInlineBytes, binaryDeclaredBytes };
}
export interface PublicPackage {
  name: string;
  version: string;
  sha512: string;
  data: string;
}

export function transferPath(value: string): void {
  if (
    !value ||
    value.length > 1000 ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part.startsWith(".")) ||
    isPrivateProjectPath(value)
  ) {
    throw new Error("Private or invalid isolated transfer path");
  }
}

function oversizedFileError(
  relative: string | undefined,
  size: number,
  limit: number,
  growing = false,
): Error {
  if (relative === undefined)
    return new Error("Isolated file exceeded its limit");
  transferPath(relative);
  const name = containsKnownSensitiveValue(relative)
    ? "[redacted project file]"
    : JSON.stringify(relative);
  return isolatedInputBudgetError(
    `Isolated project file ${name} is ${growing ? "at least " : ""}${size} bytes; the per-file limit is ${limit} bytes (2 MiB). ` +
      "Preserve the original outside the execution workspace; use a smaller working asset if needed. For PNG/JPEG/WebP images, use optimize_image_asset locally and preserve alpha; never regenerate to repair this transfer limit. Do not delete or overwrite the original.",
  );
}

export interface ProjectSourceBudget {
  totalBytes: number;
  fileCount: number;
  entryCount: number;
  /** True means traversal completed, not that the live workspace was an atomic snapshot. */
  complete: boolean;
  /** Metadata scope excludes hidden/private paths, build outputs, node_modules and unverified registered Canvas candidates. */
  scope: {
    kind: "eligible-workspace-metadata";
    separateMedia: boolean;
    canvasCandidates: "excluded-unverified";
    /** Missing on older reports; never interpret absence as zero. */
    unverifiedCanvasCandidateCount?: number;
    mediaClassMaximaVersion?: 1;
  };
  limits: {
    totalBytes: number;
    fileCount: number;
    fileBytes: number;
    entries: number;
    mediaFileBytes: number;
    mediaBytes: number;
    largeMediaFileBytes?: number;
    largeMediaFilePolicy?: "video-audio-glb-v1";
  };
  mediaBytes: number;
  largestMedia?: { path: string; size: number };
  largestBaseMedia?: { path: string; size: number };
  largestLargeMedia?: { path: string; size: number };
  overage: {
    totalBytes: number;
    fileCount: number;
    fileBytes: number;
    entries: number;
    mediaBytes?: number;
    mediaFileBytes?: number;
  };
  largestFiles: { path: string; size: number }[];
}

/** Metadata-only estimate, not authorization to transfer bytes or skip content checks.
 * Projections are caller-validated replacements/additions/removals, never filesystem writes.
 * entryCount remains a conservative scan bound, including removed and excluded entries.
 * An incomplete traversal gives lower bounds and does not apply unvisited projections.
 */
export async function inspectProjectSourceBudget(
  workspace: string,
  projections: { path: string; size: number | null }[] = [],
  separateMedia = true,
  signal?: AbortSignal,
  options?: Pick<ProjectSourceOptions, "profile">,
): Promise<ProjectSourceBudget> {
  signal?.throwIfAborted();
  const candidates = await canvasCandidatePaths(workspace);
  signal?.throwIfAborted();
  return inspectBudget(
    workspace,
    projections,
    candidates,
    separateMedia,
    undefined,
    signal,
    options?.profile,
  );
}

async function inspectBudget(
  workspace: string,
  projections: { path: string; size: number | null }[],
  candidates: Set<string>,
  separateMedia: boolean,
  ignored?: ReadonlySet<string>,
  signal?: AbortSignal,
  profile?: ProjectSourceProfile,
): Promise<ProjectSourceBudget> {
  signal?.throwIfAborted();
  const limits = projectSourceLimits(profile);
  if (projections.length > PROJECT_SOURCE_LIMITS.fileCount)
    throw new Error("Too many isolated source projections");
  const pending = new Map<string, number | null>();
  for (const projection of projections) {
    signal?.throwIfAborted();
    transferPath(projection.path);
    if (
      containsKnownSensitiveValue(projection.path) ||
      projection.path
        .split("/")
        .some((part) =>
          ["node_modules", "dist", "build", "out"].includes(part),
        ) ||
      pending.has(projection.path) ||
      (projection.size !== null &&
        (!Number.isSafeInteger(projection.size) || projection.size < 0))
    )
      throw new Error("Private or invalid isolated source projection");
    pending.set(projection.path, projection.size);
  }
  const result: ProjectSourceBudget = {
    totalBytes: 0,
    mediaBytes: 0,
    fileCount: 0,
    entryCount: 0,
    complete: true,
    scope: {
      kind: "eligible-workspace-metadata",
      separateMedia,
      canvasCandidates: "excluded-unverified",
      unverifiedCanvasCandidateCount: candidates.size,
      mediaClassMaximaVersion: 1,
    },
    limits: { ...limits },
    overage: { totalBytes: 0, fileCount: 0, fileBytes: 0, entries: 0 },
    largestFiles: [],
  };
  const directories = new Set<string>();
  const ordinaryFiles = new Set<string>();
  const account = (relative: string, size: number, executable: boolean) => {
    if (candidates.has(relative)) return;
    result.fileCount++;
    if (separateMedia && !executable && runtimeMediaPath(relative)) {
      result.mediaBytes += size;
      if (!Number.isSafeInteger(result.mediaBytes))
        throw new Error("Isolated runtime media size is out of range");
      if (!result.largestMedia || size > result.largestMedia.size)
        result.largestMedia = {
          path: containsKnownSensitiveValue(relative)
            ? "[redacted project file]"
            : relative,
          size,
        };
      const category = runtimeLargeMediaSupported(relative) ? "largestLargeMedia" : "largestBaseMedia";
      if (!result[category] || size > result[category]!.size) result[category] = {
        path: containsKnownSensitiveValue(relative) ? "[redacted project file]" : relative,
        size,
      };
      if (result.mediaBytes > result.limits.mediaBytes)
        result.overage.mediaBytes =
          result.mediaBytes - result.limits.mediaBytes;
      const mediaLimit = runtimeMediaFileLimit(relative, profile);
      if (size > mediaLimit)
        result.overage.mediaFileBytes = Math.max(
          size - mediaLimit,
          result.overage.mediaFileBytes ?? 0,
        );
      return;
    }
    result.totalBytes += size;
    if (!Number.isSafeInteger(result.totalBytes))
      throw new Error("Isolated source size is out of range");
    result.overage.fileBytes = Math.max(
      result.overage.fileBytes,
      size - result.limits.fileBytes,
    );
    result.largestFiles.push({
      path: containsKnownSensitiveValue(relative)
        ? "[redacted project file]"
        : relative,
      size,
    });
    result.largestFiles.sort(
      (a, b) => b.size - a.size || a.path.localeCompare(b.path),
    );
    result.largestFiles.length = Math.min(result.largestFiles.length, 5);
  };
  const root = await realpath(workspace);
  const visit = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    if ((await realpath(directory)) !== directory)
      throw new Error("Project links cannot enter isolated execution");
    for await (const item of await opendir(directory)) {
      signal?.throwIfAborted();
      if (++result.entryCount > result.limits.entries) {
        result.complete = false;
        return;
      }
      if (
        item.name.startsWith(".") ||
        ["node_modules", "dist", "build", "out"].includes(item.name)
      )
        continue;
      const relative = prefix + item.name;
      if (isPrivateProjectPath(relative)) continue;
      transferPath(relative);
      if (ignored?.has(relative)) continue;
      const stat = await lstat(path.join(directory, item.name));
      signal?.throwIfAborted();
      if (stat.isSymbolicLink())
        throw new Error(
          `Project links cannot enter isolated execution: ${JSON.stringify(relative)}`,
        );
      if (stat.isDirectory()) {
        if (pending.has(relative))
          throw new Error("Isolated source projection targets a directory");
        directories.add(relative);
        await visit(path.join(directory, item.name), relative + "/");
        if (!result.complete) return;
      } else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error(
            `Only ordinary unlinked project files can enter isolated execution: ${JSON.stringify(relative)}. If source publication was interrupted, inspect retained isolated-changes originals before recovery.`,
          );
        ordinaryFiles.add(relative);
        const size = pending.has(relative) ? pending.get(relative)! : stat.size;
        pending.delete(relative);
        if (size !== null) account(relative, size, Boolean(stat.mode & 0o111));
      }
    }
  };
  await visit(root, "");
  if (result.complete) {
    for (const [relative, size] of pending) {
      signal?.throwIfAborted();
      if (size === null) continue;
      const parts = relative.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        if (ordinaryFiles.has(parent) || pending.has(parent))
          throw new Error("Isolated source projection has a file parent");
        if (!directories.has(parent)) {
          directories.add(parent);
          result.entryCount++;
        }
      }
      result.entryCount++;
      account(relative, size, false);
    }
  }
  result.overage.totalBytes = Math.max(
    0,
    result.totalBytes - result.limits.totalBytes,
  );
  result.overage.fileCount = Math.max(
    0,
    result.fileCount - result.limits.fileCount,
  );
  result.overage.entries = Math.max(
    0,
    result.entryCount - result.limits.entries,
  );
  signal?.throwIfAborted();
  return result;
}

function sourceBudgetError(budget: ProjectSourceBudget): Error {
  const lowerBound = budget.complete ? "" : "at least ";
  if (budget.overage.mediaBytes || budget.overage.mediaFileBytes)
    return isolatedInputBudgetError(
      `Isolated runtime media exceeds its ${budget.limits.largeMediaFileBytes ? "32 MiB raster/base and 64 MiB video/audio/GLB per-file" : "32 MiB per-file"} or ${budget.limits.mediaBytes / (1024 * 1024)} MiB total limit for the entire eligible workspace media set, not a per-batch allowance. ` +
        `Eligible media: ${lowerBound}${budget.mediaBytes} bytes; total limit ${budget.limits.mediaBytes} bytes (${budget.limits.mediaBytes / (1024 * 1024)} MiB); total overage ${lowerBound}${budget.overage.mediaBytes ?? 0} bytes. ` +
        `Base/raster per-file limit ${budget.limits.mediaFileBytes} bytes (32 MiB)${budget.limits.largeMediaFileBytes ? `; ${budget.limits.largeMediaFilePolicy} limit ${budget.limits.largeMediaFileBytes} bytes (64 MiB)` : ""}; largest observed runtime file ${JSON.stringify(budget.largestMedia?.path)} (${budget.largestMedia?.size} bytes); largest per-file overage ${budget.overage.mediaFileBytes ?? 0} bytes. ` +
        (budget.complete
          ? ""
          : `Inspection stopped at the ${budget.limits.entries}-entry budget; totals and overages are lower bounds, not a complete inventory. `) +
        "Preserve originals. Inspect the project capacity diagnostic, then explicitly choose suitable runtime derivatives and update references, or use another supported workflow. Do not blindly shrink, delete, overwrite or regenerate originals.",
    );
  const largest = budget.largestFiles
    .map(
      (file) =>
        `${JSON.stringify(file.path)}: ${file.size} bytes (per-file overage ${Math.max(0, file.size - budget.limits.fileBytes)} bytes)`,
    )
    .join("; ");
  return isolatedInputBudgetError(
    `Isolated source transfer budget exceeded. Eligible source: ${lowerBound}${budget.totalBytes} bytes / ${budget.fileCount} files; ` +
      `limits ${budget.limits.totalBytes} bytes (8 MiB) / ${budget.limits.fileCount} files; ` +
      `overage ${lowerBound}${budget.overage.totalBytes} bytes / ${budget.overage.fileCount} files. ` +
      `Per-file limit: ${budget.limits.fileBytes} bytes (2 MiB); largest per-file overage ${budget.overage.fileBytes} bytes. ` +
      (budget.complete
        ? ""
        : `Inspection stopped at the ${budget.limits.entries}-entry budget; totals are lower bounds, not a complete inventory. `) +
      `Largest eligible files (up to 5): ${largest || "none"}. ` +
      "Preserve the original outside the execution workspace; use smaller working derivatives and update project references before retrying. " +
      "For PNG/JPEG/WebP images, use optimize_image_asset locally on all affected paths together and preserve alpha; never regenerate or switch transparent assets to JPEG to repair this transfer limit. " +
      "Do not delete or overwrite the original, skip arbitrary source files, or increase the isolation limits.",
  );
}

async function readBounded(
  file: string,
  limit: number,
  relative?: string,
): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Isolated file exceeded its limit");
    if (stat.size > limit) throw oversizedFileError(relative, stat.size, limit);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await handle.read(buffer, size, buffer.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const data = buffer.subarray(0, size);
    if (data.length > limit)
      throw oversizedFileError(relative, data.length, limit, true);
    const after = await handle.stat();
    if (
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      data.length !== stat.size
    )
      throw new Error("Isolated file changed while reading");
    if (containsKnownSensitiveValue(data.toString("utf8")))
      throw new Error("Private or oversized isolated file");
    return data;
  } finally {
    await handle.close();
  }
}

export async function projectFiles(
  workspace: string,
  runtimeMedia?: RuntimeMedia[],
  ignored?: ReadonlySet<string>,
  options?: ProjectSourceOptions,
): Promise<TransferFile[]> {
  options?.signal?.throwIfAborted();
  const limits = projectSourceLimits(options?.profile);
  workspace = await realpath(workspace);
  const candidates = await canvasCandidatePaths(workspace);
  const budget = await inspectBudget(
    workspace,
    [],
    candidates,
    runtimeMedia !== undefined,
    ignored,
    options?.signal,
    options?.profile,
  );
  if (
    !budget.complete ||
    Object.values(budget.overage).some((value) => value > 0)
  )
    throw sourceBudgetError(budget);
  const files: TransferFile[] = [];
  let total = 0;
  let mediaBytes = 0;
  const media: RuntimeMedia[] = [];
  let entries = 0;
  const visit = async (directory: string, prefix: string) => {
    options?.signal?.throwIfAborted();
    if ((await realpath(directory)) !== directory)
      throw new Error("Project links cannot enter isolated execution");
    for await (const item of await opendir(directory)) {
      options?.signal?.throwIfAborted();
      if (++entries > PROJECT_SOURCE_LIMITS.entries)
        throw isolatedInputBudgetError("Isolated source entry budget exceeded");
      if (
        item.name.startsWith(".") ||
        ["node_modules", "dist", "build", "out"].includes(item.name)
      )
        continue;
      const relative = prefix + item.name;
      if (isPrivateProjectPath(relative)) continue;
      transferPath(relative);
      if (ignored?.has(relative)) continue;
      if (item.isSymbolicLink())
        throw new Error(
          `Project links cannot enter isolated execution: ${JSON.stringify(relative)}`,
        );
      if (item.isDirectory())
        await visit(path.join(directory, item.name), relative + "/");
      else {
        const target = path.join(directory, item.name);
        const info = await lstat(target);
        if (!info.isFile() || info.nlink !== 1)
          throw new Error(
            `Only ordinary unlinked project files can enter isolated execution: ${JSON.stringify(relative)}. If source publication was interrupted, inspect retained isolated-changes originals before recovery.`,
          );
        if (
          candidates.has(relative) &&
          !(info.mode & 0o111) &&
          (await isCanvasMediaSnapshot(target, relative))
        )
          continue;
        if (files.length + media.length >= PROJECT_SOURCE_LIMITS.fileCount)
          throw isolatedInputBudgetError("Isolated source file count exceeded");
        if (
          runtimeMedia &&
          runtimeMediaPath(relative) &&
          !(info.mode & 0o111)
        ) {
          if (
            info.size > runtimeMediaFileLimit(relative, options?.profile) ||
            mediaBytes + info.size > limits.mediaBytes
          )
            throw isolatedInputBudgetError(
              `Isolated runtime media exceeds its ${runtimeMediaFileLimit(relative, options?.profile) / (1024 * 1024)} MiB per-file or ${limits.mediaBytes / (1024 * 1024)} MiB total limit`,
            );
          if (containsKnownSensitiveValue(relative))
            throw new Error("Private runtime media path");
          const snapshot = await inspectSafeProjectMedia(
            workspace,
            target,
            runtimeMediaFileLimit(relative, options?.profile),
            options?.profile === "capacity-128-media64-v3" ? 256 : 16,
            options?.signal,
          );
          if (snapshot.size !== info.size)
            throw new Error("Runtime media changed while preparing");
          if (!mediaHeaderMatches(relative, snapshot.prefix, snapshot.size, options?.profile))
            throw new Error(
              `Runtime media ${JSON.stringify(relative)} does not match its extension or is incomplete; no isolated preparation was sent. Preserve the original and use a verified working copy.`,
            );
          mediaBytes += snapshot.size;
          media.push({
            path: relative,
            size: snapshot.size,
            sha256: snapshot.sha256,
          });
          continue;
        }
        const data = await readBounded(
          target,
          PROJECT_SOURCE_LIMITS.fileBytes,
          relative,
        );
        total += data.length;
        if (total > LIMIT || files.length >= PROJECT_SOURCE_LIMITS.fileCount)
          throw isolatedInputBudgetError(
            "Isolated source transfer budget exceeded",
          );
        const mode = info.mode & 0o777;
        files.push({
          path: relative,
          data: data.toString("base64"),
          sha256: createHash("sha256").update(data).digest("hex"),
          executable: Boolean(mode & 0o111),
          mode,
        });
      }
    }
  };
  await visit(workspace, "");
  options?.signal?.throwIfAborted();
  runtimeMedia?.push(...media);
  return files;
}

type LockedPackage = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  hasInstallScript?: boolean;
};
export function lockedPackages(
  manifest: Record<string, unknown>,
  lock: { lockfileVersion?: number; packages?: Record<string, LockedPackage> },
): { name: string; version: string; url: string; integrity: string }[] {
  if (lock.lockfileVersion !== 3 || !lock.packages || manifest.workspaces)
    throw new Error(
      "Only public npm v3 locks without workspaces are supported",
    );
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  if (["preinstall", "install", "postinstall"].some((name) => scripts?.[name]))
    throw new Error("Installation lifecycle scripts are unsupported");
  const dependencies = {
    ...(manifest.dependencies as object),
    ...(manifest.devDependencies as object),
  } as Record<string, unknown>;
  for (const [name, version] of Object.entries(dependencies)) {
    if (
      typeof version !== "string" ||
      lock.packages["node_modules/" + name]?.version !== version
    )
      throw new Error("Direct dependencies must use exact locked versions");
  }
  const output = Object.entries(lock.packages)
    .filter(([key]) => key !== "")
    .map(([key, value]) => {
      transferPath(key);
      const name = key.split("node_modules/").at(-1)!;
      if (
        !key.startsWith("node_modules/") ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
        value.link ||
        value.inBundle ||
        value.hasInstallScript ||
        !value.version ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version) ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity ?? "")
      ) {
        throw new Error("Unsupported public locked package");
      }
      const expected = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${value.version}.tgz`;
      if (value.resolved !== expected)
        throw new Error(
          "Only exact official public npm tarball URLs are allowed",
        );
      return {
        name,
        version: value.version,
        url: expected,
        integrity: value.integrity!,
      };
    });
  if (output.length > 32)
    throw new Error("The public package count exceeded its budget");
  return output;
}

let preparing: Promise<unknown> = Promise.resolve();
export function publicPackages(
  workspace: string,
  cache: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicPackage[]> {
  const operation = preparing
    .catch(() => {})
    .then(() => preparePublicPackages(workspace, cache, fetcher));
  preparing = operation;
  return operation;
}
async function preparePublicPackages(
  workspace: string,
  cache: string,
  fetcher: typeof fetch,
): Promise<PublicPackage[]> {
  const manifest = JSON.parse(
    (
      await readBounded(path.join(workspace, "package.json"), 128 * 1024)
    ).toString(),
  );
  const lock = JSON.parse(
    (
      await readBounded(path.join(workspace, "package-lock.json"), 1024 * 1024)
    ).toString(),
  );
  const packages = lockedPackages(manifest, lock);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  let total = 0;
  const result: PublicPackage[] = [];
  for (const item of packages) {
    const digest = Buffer.from(item.integrity.slice(7), "base64").toString(
      "hex",
    );
    const filename = path.join(cache, digest + ".tgz");
    let data: Buffer;
    try {
      data = await readBounded(filename, 4 * 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const response = await fetcher(item.url, {
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/octet-stream" },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error("Public package download was refused");
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4 * 1024 * 1024)
            throw new Error("Public package download exceeded its limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      data = Buffer.concat(chunks);
      if (createHash("sha512").update(data).digest("hex") !== digest)
        throw new Error("Public package integrity failed");
      let used = 0;
      for (const name of await readdir(cache)) {
        const handle = await open(
          path.join(cache, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          used += (await handle.stat()).size;
        } finally {
          await handle.close();
        }
      }
      if (used + data.length > 64 * 1024 * 1024)
        throw new Error("Public package cache budget exceeded");
      const handle = await open(
        filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    }
    if (createHash("sha512").update(data).digest("hex") !== digest)
      throw new Error("Cached package integrity failed");
    total += data.length;
    if (total > LIMIT)
      throw new Error("Public dependency transfer budget exceeded");
    result.push({
      name: item.name,
      version: item.version,
      sha512: digest,
      data: data.toString("base64"),
    });
  }
  return result;
}

export interface RestoreArtifactOptions extends ProjectSourceOptions {
  /** Each copied output is independently reread from this host workspace. */
  sourceWorkspace?: string;
  verifiedCopies?: ReadonlyMap<string, RuntimeMedia>;
}

export async function restoreArtifacts(
  workspace: string,
  files: TransferFile[],
  media: RuntimeMedia[] = [],
  readMedia?: (entry: RuntimeMedia) => Promise<Buffer>,
  beforePublish?: () => Promise<void>,
  options?: RestoreArtifactOptions,
): Promise<void> {
  options?.signal?.throwIfAborted();
  const limits = projectSourceLimits(options?.profile);
  const verifiedCopies = options?.verifiedCopies;
  if (
    verifiedCopies &&
    (!options?.profile ||
      !options.sourceWorkspace ||
      !(verifiedCopies instanceof Map))
  )
    throw new Error("Invalid verified artifact source bindings");
  if (
    !Array.isArray(files) ||
    !Array.isArray(media) ||
    files.length + media.length > 2000
  )
    throw new Error("Invalid artifact response");
  let total = 0;
  const seen = new Set<string>();
  const claimPath = (file: { path: string }) => {
    transferPath(file.path);
    if (
      file.path.split("/").length < 2 ||
      seen.has(file.path) ||
      containsKnownSensitiveValue(file.path) ||
      !["dist", "build", "out"].includes(file.path.split("/")[0])
    )
      throw new Error("Invalid artifact destination");
    seen.add(file.path);
  };
  let mediaBytes = 0,
    copiedBytes = 0,
    generatedBytes = 0;
  const consumedCopies = new Set<string>();
  for (const entry of media) {
    options?.signal?.throwIfAborted();
    claimPath(entry);
    const source = verifiedCopies?.get(entry.path);
    if (
      (!source && !readMedia) ||
      Object.keys(entry).some(
        (key) => !["path", "size", "sha256"].includes(key),
      ) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > (source ? runtimeMediaFileLimit(entry.path, options?.profile) : limits.mediaFileBytes) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("Invalid isolated runtime media artifact");
    mediaBytes += entry.size;
    if (mediaBytes > limits.mediaBytes)
      throw new Error("Build media exceeds the complete-set limit");
    if (source) {
      if (source.sha256 !== entry.sha256 || source.size !== entry.size)
        throw new Error("Invalid verified artifact source binding");
      consumedCopies.add(entry.path);
      copiedBytes += entry.size;
      if (copiedBytes > limits.mediaBytes)
        throw new Error("Verified build media exceeds the complete-set limit");
    } else {
      generatedBytes += entry.size;
      if (generatedBytes > MEDIA_LIMIT)
        throw new Error(
          "Generated build media exceeds its 64 MiB transfer limit",
        );
    }
  }
  if (verifiedCopies && consumedCopies.size !== verifiedCopies.size)
    throw new Error("Unexpected verified artifact source binding");
  for (const file of files) {
    claimPath(file);
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (
      data.length > 2 * 1024 * 1024 ||
      total > LIMIT ||
      createHash("sha256").update(data).digest("hex") !== file.sha256 ||
      containsKnownSensitiveValue(data.toString("utf8"))
    )
      throw new Error("Private or oversized artifact");
  }
  const staging = path.join(workspace, ".omg-artifacts-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  let retainBackup = false;
  try {
    for (const file of [...files, ...media]) {
      options?.signal?.throwIfAborted();
      const parent = path.dirname(path.join(staging, ...file.path.split("/")));
      const relative = path.relative(staging, parent);
      let current = staging;
      for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        await mkdir(current, { recursive: true });
        if ((await realpath(current)) !== current)
          throw new Error("Artifact parent is a symbolic link");
      }
      const temporary = path.join(parent, ".omg-artifact-" + randomUUID());
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
          if ("data" in file)
            await handle.writeFile(Buffer.from(file.data, "base64"));
          else {
            const source = verifiedCopies?.get(file.path);
            if (source) {
              await copyRuntimeMedia(options!.sourceWorkspace!, source, handle, { profile: options?.profile, signal: options?.signal, formatPath: file.path });
            } else {
            const bytes = await readMedia!(file);
            options?.signal?.throwIfAborted();
            if (
              bytes.length !== file.size ||
              !mediaHeaderMatches(file.path, bytes) ||
              createHash("sha256").update(bytes).digest("hex") !== file.sha256
            )
              throw new Error(
                "Runtime media artifact does not match its declared format, size or digest",
              );
            assertNoKnownSecretBytes(bytes);
            await handle.writeFile(bytes);
            }
          }
        } finally {
          await handle.close();
        }
        await rename(temporary, path.join(staging, ...file.path.split("/")));
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await beforePublish?.();
    options?.signal?.throwIfAborted();
    const old = path.join(staging, "previous");
    await mkdir(old, { mode: 0o700 });
    const changes: Array<{
      name: string;
      hadOriginal: boolean;
      installed: boolean;
    }> = [];
    try {
      for (const name of ["dist", "build", "out"]) {
        const target = path.join(workspace, name);
        const change = { name, hadOriginal: false, installed: false };
        try {
          await rename(target, path.join(old, name));
          change.hadOriginal = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        changes.push(change);
        if ([...seen].some((file) => file.startsWith(name + "/"))) {
          await rename(path.join(staging, name), target);
          change.installed = true;
        }
      }
    } catch (cause) {
      retainBackup = true;
      for (const { name, hadOriginal, installed } of changes.reverse()) {
        const target = path.join(workspace, name);
        if (installed) await rename(target, path.join(staging, name));
        if (hadOriginal) await rename(path.join(old, name), target);
      }
      retainBackup = false;
      throw cause;
    }
  } finally {
    if (!retainBackup) await rm(staging, { recursive: true, force: true });
  }
}
