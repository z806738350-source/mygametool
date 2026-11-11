import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { localAgentPath } from "./agent-local-files.js";
import {
  isStaticRasterPath,
  validateRasterReturn,
  type RasterReturnReceipt,
} from "./isolated-raster-returns.js";
import { runtimeMediaPath, transferPath } from "./isolated-project-files.js";
import { readSafeProjectFile } from "./safe-project-file.js";

export interface ValidatedRasterArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly beforeSha256?: string;
}
interface ArtifactState {
  workspace: string;
  root: string;
  file: string;
  receipt: RasterReturnReceipt;
}
const states = new WeakMap<object, ArtifactState>();
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function refusal(): Error {
  return new Error(
    "The reviewed raster artifact is untrusted, changed, or outside private retention storage",
  );
}

/** Host-only factory. Plain receipts, copied objects and verified-media descriptors grant no authority. */
export async function validateRasterArtifact(
  workspace: string,
  input: {
    path: string;
    artifactPath: string;
    sha256: string;
    size: number;
    beforeSha256?: string;
  },
  signal?: AbortSignal,
): Promise<ValidatedRasterArtifact> {
  signal?.throwIfAborted();
  const canonical = await realpath(workspace),
    root = path.join(path.dirname(canonical), "isolated-review-artifacts"),
    file = path.resolve(input.artifactPath);
  transferPath(input.path);
  if (
    !runtimeMediaPath(input.path) ||
    !isStaticRasterPath(input.path) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > 32 * 1024 * 1024 ||
    (input.beforeSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(input.beforeSha256)) ||
    ![
      path.join(root, "raw", input.sha256),
      path.join(root, "working", input.sha256),
    ].includes(file)
  )
    throw refusal();
  for (const directory of [root, path.dirname(file)]) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      (await realpath(directory)) !== directory
    )
      throw refusal();
  }
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o177 ||
    info.size !== input.size
  )
    throw refusal();
  signal?.throwIfAborted();
  const bytes = await readSafeProjectFile(root, file, 32 * 1024 * 1024);
  signal?.throwIfAborted();
  if (digest(bytes) !== input.sha256 || bytes.length !== input.size)
    throw refusal();
  let before: Buffer | undefined;
  try {
    signal?.throwIfAborted();
    before = await readSafeProjectFile(
      canonical,
      await localAgentPath(canonical, input.path),
      32 * 1024 * 1024,
    );
    signal?.throwIfAborted();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (
    input.beforeSha256 !== undefined &&
    (!before || digest(before) !== input.beforeSha256)
  )
    throw refusal();
  const beforeSha256 = before && digest(before);
  signal?.throwIfAborted();
  const receipt = await validateRasterReturn(
    input.path,
    bytes,
    before,
    2,
    signal,
  );
  signal?.throwIfAborted();
  const artifact: ValidatedRasterArtifact = Object.freeze({
    path: input.path,
    sha256: input.sha256,
    size: input.size,
    ...(beforeSha256 ? { beforeSha256 } : {}),
  });
  states.set(artifact, { workspace: canonical, root, file, receipt });
  return artifact;
}

export function validatedRasterArtifactReceipt(
  workspace: string,
  artifact: ValidatedRasterArtifact,
): RasterReturnReceipt {
  const state = states.get(artifact);
  if (!state || state.workspace !== workspace) throw refusal();
  return state.receipt;
}

/** Rechecks immutable source bytes immediately before each independent staging write. One image buffer at a time. */
export async function readValidatedRasterArtifact(
  workspace: string,
  artifact: ValidatedRasterArtifact,
): Promise<Buffer> {
  const state = states.get(artifact);
  if (!state || state.workspace !== workspace) throw refusal();
  const info = await lstat(state.file);
  if (info.uid !== process.getuid?.() || info.mode & 0o177) throw refusal();
  const bytes = await readSafeProjectFile(
    state.root,
    state.file,
    32 * 1024 * 1024,
  );
  if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256)
    throw refusal();
  return bytes;
}
