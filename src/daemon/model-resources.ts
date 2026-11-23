import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { LibraryAsset, Model3DMetadata } from "../shared/contracts.js";
import {
  readSafeProjectFile,
  assertNoKnownSecretBytes,
} from "./safe-project-file.js";
import {
  inspectAndSplitModel3D,
  inspectModel3D,
  isModel3DParserUncertain,
} from "./model3d-inspect.js";
import { FBX_MEDIA_TYPE } from "./fbx-preview.js";

const FILE_LIMIT = 2 * 1024 * 1024,
  TOTAL_LIMIT = 8 * 1024 * 1024;
const MEDIA_FILE_LIMIT = 32 * 1024 * 1024;
class ModelResourceBudgetError extends Error {}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export interface ModelResources {
  assetId: string;
  originalPath: string;
  originalSha256: string;
  previewPath?: string;
  previewSha256?: string;
  runtimePath?: string;
  resources: Array<{ path: string; sha256: string; size: number }>;
  ready: boolean;
  error?: string;
  runtimeMode?: "split" | "media";
  model?: Model3DMetadata;
}

async function directory(root: string, relative: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let current = root;
  for (const part of relative.split("/")) {
    signal?.throwIfAborted();
    current = path.join(current, part);
    await mkdir(current).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Linked model directories are unavailable");
  }
}
async function immutable(
  root: string,
  relative: string,
  bytes: Buffer,
  repair = false,
  retainedDirectory?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  assertNoKnownSecretBytes(bytes);
  await directory(root, path.posix.dirname(relative), signal);
  signal?.throwIfAborted();
  try {
    await writeFile(path.join(root, relative), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      !(await readSafeProjectFile(root, path.join(root, relative))).equals(
        bytes,
      )
    ) {
      if (!repair)
        throw new Error(
          "An existing model resource changed; the original was not overwritten",
        );
      const file = path.join(root, relative);
      if (retainedDirectory) await directory(root, retainedDirectory, signal);
      signal?.throwIfAborted();
      await rename(
        file,
        retainedDirectory
          ? path.join(
              root,
              retainedDirectory,
              `${path.basename(file)}-${randomUUID()}`,
            )
          : `${file}.retained-${randomUUID()}`,
      );
      signal?.throwIfAborted();
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    }
  }
}

/** Split embedded GLB buffer views into standard glTF resources. VM per-file and aggregate limits stay unchanged. */
export async function splitModelResources(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Map<string, Buffer>> {
  const inspected = await inspectAndSplitModel3D(bytes, signal);
  if (inspected.resources) return inspected.resources;
  if (inspected.resourceFailure?.code === "budget")
    throw new ModelResourceBudgetError(inspected.resourceFailure.message);
  throw new Error(
    inspected.resourceFailure?.message ??
      "Local model resources are unavailable; the original is retained",
  );
}

export function modelOriginalPath(sha256: string, contentType: string): string {
  const name = contentType === FBX_MEDIA_TYPE ? "original.fbx" : `${sha256}.glb`;
  return `.data/model-assets/${sha256}/${name}`;
}

/** Retain originals; use split resources or the existing verified runtime-media channel. */
export async function storeModelResources(
  workspace: string,
  asset: LibraryAsset,
  original: Buffer,
  preview?: Buffer,
  rebuild = false,
  signal?: AbortSignal,
): Promise<ModelResources> {
  signal?.throwIfAborted();
  const root = await lstat(workspace);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("A linked project root is unavailable");
  workspace = await realpath(workspace);
  const sha = digest(original),
    originalPath = modelOriginalPath(sha, asset.contentType);
  const retained = `.data/model-assets/${sha}/runtime-retained`;
  await immutable(workspace, originalPath, original, false, undefined, signal);
  const result: ModelResources = {
    assetId: asset.id,
    originalPath,
    originalSha256: sha,
    resources: [],
    ready: false,
  };
  if (asset.contentType !== FBX_MEDIA_TYPE) preview = original;
  if (preview) {
    const previewSha = digest(preview),
      previewPath = `.data/model-assets/${sha}/${previewSha}.glb`;
    await immutable(
      workspace,
      previewPath,
      preview,
      rebuild && previewPath !== originalPath,
      undefined,
      signal,
    );
    Object.assign(result, { previewPath, previewSha256: previewSha });
    try {
      const inspected = await inspectAndSplitModel3D(preview, signal);
      signal?.throwIfAborted();
      result.model = inspected.metadata;
      let files: Map<string, Buffer>;
      try {
        if (inspected.resources) files = inspected.resources;
        else if (inspected.resourceFailure?.code === "budget")
          throw new ModelResourceBudgetError(inspected.resourceFailure.message);
        else
          throw new Error(
            inspected.resourceFailure?.message ??
              "Local model resources are unavailable",
          );
      } catch (error) {
        if (!(error instanceof ModelResourceBudgetError)) throw error;
        if (preview.length > MEDIA_FILE_LIMIT)
          throw new Error(
            "The validated GLB exceeds the existing 32 MiB runtime media file limit; the original is retained",
          );
        // The splitter has already inspected the GLB; only its resource budget failed.
        const relative = `assets/files/models/${previewSha}.glb`;
        await immutable(workspace, relative, preview, true, retained, signal);
        result.resources.push({
          path: relative,
          sha256: previewSha,
          size: preview.length,
        });
        Object.assign(result, {
          ready: true,
          runtimePath: relative,
          runtimeMode: "media" as const,
        });
        files = new Map();
      }
      if (!result.ready) {
        const folder = `assets/models/${sha}`;
        for (const [name, bytes] of files) {
          signal?.throwIfAborted();
          const relative = `${folder}/${name}`;
          await immutable(workspace, relative, bytes, true, retained, signal);
          result.resources.push({
            path: relative,
            sha256: digest(bytes),
            size: bytes.length,
          });
        }
        Object.assign(result, {
          ready: true,
          runtimePath: `${folder}/model.gltf`,
          runtimeMode: "split" as const,
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (isModel3DParserUncertain(error)) throw error;
      result.error =
        error instanceof Error
          ? error.message
          : "Local model resources are unavailable";
    }
  } else
    result.error =
      "The FBX original is retained; its local preview is unavailable. Rebuild locally, never regenerate to repair a preview.";
  signal?.throwIfAborted();
  await directory(workspace, "assets/models", signal);
  const file = path.join(workspace, "assets/models", `${asset.id}.model.json`),
    temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const before = await readSafeProjectFile(workspace, file);
    await immutable(
      workspace,
      `${retained}/${asset.id}-${randomUUID()}.json`,
      before,
      false,
      undefined,
      signal,
    );
    let old: ModelResources | undefined;
    try {
      old = JSON.parse(before.toString("utf8"));
    } catch {
      /* Retain damaged derived metadata before replacing it. */
    }
    const oldFolder = old?.runtimePath
      ? path.posix.dirname(old.runtimePath)
      : undefined;
    // Retire only the earlier generated cache naming scheme; preserve every byte outside the VM source set.
    const legacyPrefix = `assets/models/${sha.slice(0, 12)}-${old?.previewSha256?.slice(0, 12)}`;
    if (
      result.ready &&
      old?.originalSha256 === sha &&
      oldFolder &&
      (oldFolder === legacyPrefix ||
        new RegExp(`^${legacyPrefix}-[a-f0-9]{8}$`).test(oldFolder))
    ) {
      const source = path.join(workspace, oldFolder),
        info = await lstat(source);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Linked model cache cannot be retired");
      await directory(workspace, retained, signal);
      signal?.throwIfAborted();
      await rename(
        source,
        path.join(workspace, retained, `legacy-${randomUUID()}`),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  signal?.throwIfAborted();
  let handle: import("node:fs/promises").FileHandle | undefined;
  let owned: { dev: number; ino: number } | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Invalid private model metadata staging file");
    owned = { dev: info.dev, ino: info.ino };
    const payload = Buffer.from(JSON.stringify(result, null, 2));
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    const current = await lstat(temporary);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      current.size !== payload.length
    )
      throw new Error(
        "Private model metadata staging file changed before publication",
      );
    signal?.throwIfAborted();
    await rename(temporary, file);
    owned = undefined;
  } finally {
    try {
      await handle?.close();
    } finally {
      if (owned) {
        const current = await lstat(temporary).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current) {
          if (
            !current.isFile() ||
            current.nlink !== 1 ||
            current.dev !== owned.dev ||
            current.ino !== owned.ino
          )
            throw new Error(
              "Private model metadata cleanup identity is unconfirmed",
            );
          await rm(temporary);
        }
      }
    }
  }
  return result;
}

export async function readModelResources(
  workspace: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ModelResources | undefined> {
  signal?.throwIfAborted();
  workspace = await realpath(workspace);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(assetId))
    throw new Error("Invalid model asset ID");
  const file = path.join(workspace, "assets/models", `${assetId}.model.json`);
  try {
    const value = JSON.parse(
      (await readSafeProjectFile(workspace, file)).toString("utf8"),
    ) as ModelResources;
    if (
      value.assetId !== assetId ||
      typeof value.ready !== "boolean" ||
      !Array.isArray(value.resources) ||
      value.resources.length > 1901
    )
      throw new Error("Invalid model resource binding");
    const media = value.runtimeMode === "media";
    const safePath = (name: string) =>
      typeof name === "string" &&
      /^(?:assets\/models\/|assets\/files\/models\/|\.data\/model-assets\/)[A-Za-z0-9_./-]+$/.test(
        name,
      ) &&
      !name.split("/").includes("..");
    for (const item of [
      { path: value.originalPath, sha256: value.originalSha256 },
      ...(value.previewPath
        ? [{ path: value.previewPath, sha256: value.previewSha256 }]
        : []),
      ...value.resources,
    ]) {
      if (!safePath(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ""))
        throw new Error("Invalid model resource binding");
      signal?.throwIfAborted();
      const bytes = await readSafeProjectFile(
        workspace,
        path.join(workspace, item.path),
      );
      signal?.throwIfAborted();
      if (
        digest(bytes) !== item.sha256 ||
        ("size" in item &&
          (item.size !== bytes.length ||
            bytes.length > (media ? MEDIA_FILE_LIMIT : FILE_LIMIT)))
      )
        throw new Error(
          "A model resource failed its integrity check; rebuild local resources",
        );
    }
    if (
      value.ready &&
      !value.resources.some((item) => item.path === value.runtimePath)
    )
      throw new Error("Model runtime path is not bound to its resources");
    if (value.ready && media) {
      if (
        value.runtimePath !==
          `assets/files/models/${value.previewSha256}.glb` ||
        value.resources.length !== 1 ||
        value.resources[0]!.sha256 !== value.previewSha256 ||
        value.resources[0]!.size < 1
      )
        throw new Error("Invalid runtime media model binding");
      await inspectModel3D(
        await readSafeProjectFile(
          workspace,
          path.join(workspace, value.runtimePath),
        ),
        signal,
      );
    } else if (value.ready) {
      if (
        !/^assets\/models\/[a-zA-Z0-9_-]+\/model\.gltf$/.test(
          value.runtimePath!,
        )
      )
        throw new Error("Invalid runtime model path");
      if (
        value.runtimePath !== `assets/models/${value.originalSha256}/model.gltf`
      )
        throw new Error("Rebuild the legacy model runtime cache locally");
      const folder = path.posix.dirname(value.runtimePath!),
        names = new Map<string, number>();
      let total = 0;
      for (const item of value.resources) {
        if (
          path.posix.dirname(item.path) !== folder ||
          !/^(?:model\.gltf|buffer-\d+\.bin|texture-\d+\.(?:jpg|png|webp))$/.test(
            path.posix.basename(item.path),
          ) ||
          item.size > FILE_LIMIT ||
          item.size < 1 ||
          names.has(path.posix.basename(item.path))
        )
          throw new Error("Invalid runtime model resource");
        names.set(path.posix.basename(item.path), item.size);
        total += item.size;
      }
      if (total > TOTAL_LIMIT)
        throw new Error("Model resources exceed the isolated transfer budget");
      const json = JSON.parse(
        (
          await readSafeProjectFile(
            workspace,
            path.join(workspace, value.runtimePath!),
          )
        ).toString("utf8"),
      );
      if (
        !Array.isArray(json.buffers) ||
        json.buffers.some(
          (buffer: { uri?: string; byteLength: number }) =>
            !buffer.uri ||
            !/^(?:buffer-\d+\.bin|texture-\d+\.(?:jpg|png|webp))$/.test(
              buffer.uri,
            ) ||
            names.get(buffer.uri) !== buffer.byteLength,
        ) ||
        json.images?.some(
          (image: { uri?: string; bufferView?: number }) =>
            image.bufferView !== undefined ||
            !image.uri ||
            !/^texture-\d+\.(?:jpg|png|webp)$/.test(image.uri) ||
            !names.has(image.uri),
        )
      )
        throw new Error("Runtime model resources must stay local and bound");
    }
    signal?.throwIfAborted();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
