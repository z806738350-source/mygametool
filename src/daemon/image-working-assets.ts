import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PromptImage } from "../shared/contracts.js";
import { sniffImageType } from "./image-format.js";
import {
  assertNoKnownSecretBytes,
  readSafeProjectFile,
} from "./safe-project-file.js";
import { localAgentPath } from "./agent-local-files.js";
import { validateRasterReturn } from "./isolated-raster-returns.js";
import { rasterImageCost, serializeRasterDecoding } from "./raster-policy.js";
import {
  assertLocalImagePublicationsSettled,
  checkRecoverySpaceHeadroom,
  currentLocalImageRecoverySpace,
  reserveLocalImageRecoverySpace,
  withRecoverySpaceReservation,
  type LocalImageRecoveryAnchor,
  type RecoverySpaceInputs,
  type RecoverySpaceReservation,
} from "./recovery-space.js";
import {
  durablePublicationDirectory,
  initializePublicationManifest,
  savePublicationManifest,
  syncPublicationDirectory,
  type PublicationManifest,
} from "./isolated-publication-journal.js";
import { inspectProjectSourceBudget, type ProjectSourceProfile } from "./isolated-project-files.js";

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const rasterOptions = {
  failOn: "warning" as const,
  limitInputPixels: MAX_PIXELS,
  limitInputChannels: 4,
  sequentialRead: true,
};
export const imageDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Convert just the in-memory WebP copy; its original provider URL cannot identify the resulting PNG. */
export async function readWebpModelReference(
  workspace: string,
  source: { absolutePath: string; size: number },
): Promise<PromptImage> {
  if (!source.size || source.size > MAX_INPUT)
    throw new Error("Image inputs must be between 1 byte and 32 MiB");
  const bytes = await readSafeProjectFile(workspace, source.absolutePath);
  if (!bytes.length || bytes.length > MAX_INPUT)
    throw new Error("Image inputs must be between 1 byte and 32 MiB");
  let png: Buffer;
  try {
    if (sniffImageType(bytes) !== "image/webp") throw new Error();
    png = await sharp(bytes, rasterOptions)
      .autoOrient()
      .png()
      .timeout({ seconds: 5 })
      .toBuffer();
  } catch {
    throw new Error(
      "Could not convert the WebP reference image to PNG. Provide a valid WebP within the 32 megapixel limit.",
    );
  }
  if (png.length > MAX_INPUT)
    throw new Error(
      "The converted PNG exceeds 32 MiB. Resize a copy of the reference before modeling.",
    );
  return { mediaType: "image/png", data: png.toString("base64") };
}

/** Compare independent views without counting compression or metadata changes as new artwork. */
export async function decodedReferenceIdentity(input: Buffer): Promise<string> {
  if (!input.length || input.length > MAX_INPUT)
    throw new Error("Reference image exceeds the 32 MiB local decode limit");
  const { data, info } = await sharp(input, rasterOptions)
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .timeout({ seconds: 5 })
    .toBuffer({ resolveWithObject: true });
  return `${info.width}x${info.height}:${imageDigest(data)}`;
}

/** Verify that the original can be decoded without creating a game asset or changing the vision input. */
export async function validateConversationRaster(input: Buffer): Promise<void> {
  if (!input.length || input.length > MAX_INPUT)
    throw new Error("Reference image exceeds the 32 MiB local decode limit");
  assertNoKnownSecretBytes(input);
  await sharp(input, rasterOptions)
    .resize(1, 1)
    .raw()
    .timeout({ seconds: 5 })
    .toBuffer();
}

/** Preserve pixels by default. Resizing is explicit and never falls back to a smaller edge. */
export async function prepareWorkingImage(
  input: Buffer,
  maxEdge?: number,
  _policy?: "preserve-dimensions",
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (maxEdge !== undefined && ![256, 512, 1024, 1536, 2048].includes(maxEdge))
    throw new Error("Choose maxEdge 256, 512, 1024, 1536 or 2048");
  if (!input.length || input.length > MAX_INPUT)
    throw new Error(
      "Working image input exceeds the 32 MiB local decode limit",
    );
  assertNoKnownSecretBytes(input);
  const mediaType = sniffImageType(input);
  if (!mediaType)
    throw new Error(
      "Only verified PNG, JPEG and WebP images can be prepared locally",
    );
  const format =
    mediaType === "image/jpeg"
      ? "jpeg"
      : mediaType === "image/png"
        ? "png"
        : "webp";
  const metadata = await sharp(input, rasterOptions).metadata();
  if (
    metadata.orientation &&
    metadata.orientation !== 1 &&
    maxEdge === undefined
  )
    throw new Error(
      "Image orientation needs explicit preparation; keep the original",
    );
  const relative = `image.${format === "jpeg" ? "jpg" : format}`;
  const original = await validateRasterReturn(
    relative,
    input,
    undefined,
    2,
    signal,
  );
  let bytes = input,
    width = original.width,
    height = original.height,
    hasTransparency = original.hasTransparency === true;
  if (maxEdge !== undefined) {
    const pipeline = sharp(input, rasterOptions)
      .autoOrient()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .timeout({ seconds: 5 });
    const prepared = await serializeRasterDecoding(() => {
      signal?.throwIfAborted();
      return (
        format === "png"
          ? pipeline.png({ compressionLevel: 9 })
          : format === "webp"
            ? pipeline.webp({ lossless: true })
            : pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      ).toBuffer({ resolveWithObject: true });
    });
    signal?.throwIfAborted();
    bytes = prepared.data;
    const receipt = await validateRasterReturn(
      relative,
      bytes,
      input,
      2,
      signal,
    );
    width = receipt.width;
    height = receipt.height;
    hasTransparency = receipt.hasTransparency === true;
  }
  signal?.throwIfAborted();
  return {
    bytes,
    mediaType,
    width,
    height,
    hasAlpha: original.hasAlpha,
    hasTransparency,
    originalSha256: imageDigest(input),
    workingSha256: imageDigest(bytes),
    imageCost: rasterImageCost(bytes.length, width, height),
  };
}

export async function retainImageOriginal(
  storage: string,
  bytes: Buffer,
): Promise<string> {
  assertNoKnownSecretBytes(bytes);
  if (bytes.length > 64 * 1024 * 1024)
    throw new Error("Original exceeds the 64 MiB secure retention limit");
  const root = await lstat(storage);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error(
      "Image storage must be an ordinary project storage directory",
    );
  storage = await realpath(storage);
  const folder = path.join(storage, "image-originals");
  await mkdir(folder).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await syncPublicationDirectory(storage);
  const entry = await lstat(folder);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Linked image storage is unavailable");
  const id = imageDigest(bytes),
    file = path.join(folder, id);
  await retainImmutableFile(file, bytes);
  if (!(await readSafeProjectFile(storage, file)).equals(bytes))
    throw new Error("Retained original verification failed; source unchanged");
  return id;
}

/** Immutable provenance receipt is private application data, never a game source file. */
export async function retainImagePreparation(
  storage: string,
  resource: {
    path: string;
    originalId: string;
    workingSha256: string;
    width: number;
    height: number;
    originalBytes: number;
    bytes: Buffer;
    mediaType: string;
  },
) {
  storage = await realpath(storage);
  const folder = path.join(storage, "image-preparations");
  await mkdir(folder).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await syncPublicationDirectory(storage);
  const entry = await lstat(folder);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Linked image provenance storage is unavailable");
  const receipt = Buffer.from(
    JSON.stringify({
      version: 1,
      status: "prepared",
      requestedPath: resource.path,
      originalId: resource.originalId,
      originalSha256: resource.originalId,
      workingSha256: resource.workingSha256,
      width: resource.width,
      height: resource.height,
      originalBytes: resource.originalBytes,
      workingBytes: resource.bytes.length,
      mediaType: resource.mediaType,
    }),
  );
  assertNoKnownSecretBytes(receipt);
  const file = path.join(folder, `${imageDigest(receipt)}.json`);
  await retainImmutableFile(file, receipt);
  if (!(await readSafeProjectFile(storage, file)).equals(receipt))
    throw new Error("Image provenance verification failed");
}

let queue: Promise<void> = Promise.resolve();
export function serializeWorkingImages<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const pending = queue.catch(() => {}).then(operation);
  queue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

async function durableFile(file: string, bytes: Buffer, mode = 0o600) {
  const handle = await open(file, "wx", mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncPublicationDirectory(path.dirname(file));
}

async function retainImmutableFile(file: string, bytes: Buffer) {
  try {
    const existing = await readSafeProjectFile(path.dirname(file), file);
    if (!existing.equals(bytes))
      throw new Error(
        "Retained image identity conflicts; original was not replaced",
      );
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await durableFile(temporary, bytes);
    try {
      await link(temporary, file);
      await syncPublicationDirectory(path.dirname(file));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  } finally {
    await rm(temporary, { force: true });
    await syncPublicationDirectory(path.dirname(file));
  }
}

/** Uses the same volume ledger as isolated recovery, on the real application image store. */
export async function withLocalImageRecovery<T>(
  anchor: LocalImageRecoveryAnchor,
  inputs: RecoverySpaceInputs,
  operation: (lease: RecoverySpaceReservation) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const existing = currentLocalImageRecoverySpace(anchor);
  const lease = await reserveLocalImageRecoverySpace(anchor, inputs, {
    ownerKey: randomUUID().replaceAll("-", ""),
    signal,
  });
  let failed = false;
  try {
    return await withRecoverySpaceReservation(lease, () => operation(lease));
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    if (!existing) {
      let settled = false;
      try {
        await assertLocalImagePublicationsSettled(anchor);
        settled = true;
      } catch {}
      if (settled) {
        try {
          await lease.release();
        } catch (cause) {
          if (!failed) throw cause;
        }
      }
    }
  }
}

/** New local image publications retain the existing image store and use versioned durable phases. */
export async function replaceWorkingImages(
  workspace: string,
  files: Array<{ path: string; before?: Buffer; bytes: Buffer }>,
  storage: string,
  signal?: AbortSignal,
  profile?: ProjectSourceProfile,
) {
  workspace = await realpath(workspace);
  storage = path.resolve(storage);
  const anchor: LocalImageRecoveryAnchor = {
    workspace,
    storage,
    projectId: path.basename(storage),
  };
  if (
    !files.length ||
    files.length > 16 ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    throw new Error("Choose 1–16 distinct working images");
  const beforeBytes = files.reduce(
      (sum, file) => sum + (file.before?.length ?? 0),
      0,
    ),
    afterBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (
    beforeBytes > 64 * 1024 * 1024 ||
    afterBytes > 72 * 1024 * 1024 ||
    files.some(
      (file) =>
        file.bytes.length > 32 * 1024 * 1024 ||
        (file.before?.length ?? 0) > 32 * 1024 * 1024,
    )
  )
    throw new Error(
      "Local image publication exceeds its existing bounded batch",
    );
  return withLocalImageRecovery(
    anchor,
    {
      rawBytes: 0,
      workingBytes: 0,
      beforeBytes,
      afterBytes,
      manifestBytes: 2 * 1024 * 1024,
      additionalEntries: 256,
    },
    async (lease) => {
      signal?.throwIfAborted();
      const prepared: Array<
        (typeof files)[number] & { destination: string; mode: number }
      > = [];
      for (const file of files) {
        const destination = await localAgentPath(workspace, file.path, true);
        if (file.before) {
          if (
            !(await readSafeProjectFile(workspace, destination)).equals(
              file.before,
            )
          )
            throw new Error(
              "Image changed during preparation; original unchanged",
            );
        } else {
          try {
            await lstat(destination);
            throw new Error("Working image destination already exists");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        }
        const mode = file.before
          ? (await lstat(destination)).mode & 0o777
          : 0o600;
        if (mode & 0o111)
          throw new Error(
            "Executable images require explicit review; no working source was replaced",
          );
        prepared.push({ ...file, destination, mode });
      }
      const changed = prepared.filter(
        (file) => !file.before || !file.before.equals(file.bytes),
      );
      // Identity preparation already has an immutable provenance receipt from its caller; it never rewrites live inodes.
      if (!changed.length) return;
      const budget = await inspectProjectSourceBudget(
        workspace,
        changed.map((file) => ({ path: file.path, size: file.bytes.length })), true, signal, profile ? { profile } : undefined,
      );
      if (!budget.complete || Object.values(budget.overage).some(Boolean))
        throw new Error(
          "Working images exceed the existing source/media limits; retain originals and arrange storage or choose an explicit derivative",
        );
      const root = path.join(storage, "image-transactions");
      await durablePublicationDirectory(root);
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error("Linked image transaction storage is unavailable");
      const recovery = path.join(root, randomUUID());
      await mkdir(recovery, { mode: 0o700 });
      await syncPublicationDirectory(root);
      const manifest: PublicationManifest = {
        version: 3,
        kind: "local-image",
        localWorkspace: workspace,
        localProjectId: anchor.projectId,
        state: "staging",
        reservationId: lease.id,
        spacePlan: { ...lease.plan },
        versions: changed.map((file) => ({
          path: file.path,
          ...(file.before
            ? {
                beforeSha256: imageDigest(file.before),
                beforeSize: file.before.length,
                beforeMode: file.mode,
              }
            : {}),
          afterSha256: imageDigest(file.bytes),
          afterSize: file.bytes.length,
          afterMode: file.mode,
        })),
        published: [],
        steps: Object.fromEntries(
          changed.map((file) => [file.path, "staged" as const]),
        ),
      };
      await initializePublicationManifest(recovery, manifest);
      const moved: Array<{
          path: string;
          destination: string;
          backup: string;
        }> = [],
        published: Array<{ destination: string; ino: number; index: number }> =
          [];
      try {
        await durablePublicationDirectory(path.join(recovery, "before"));
        await durablePublicationDirectory(path.join(recovery, "after"));
        for (const [index, file] of changed.entries()) {
          signal?.throwIfAborted();
          await durableFile(
            path.join(recovery, "after", String(index)),
            file.bytes,
            file.mode,
          );
          if (file.before)
            await durableFile(
              path.join(recovery, `original-${index}`),
              file.before,
            );
        }
        signal?.throwIfAborted();
        await checkRecoverySpaceHeadroom(lease);
        manifest.state = "publishing";
        await savePublicationManifest(recovery, manifest);
        for (const [index, file] of changed.entries()) {
          signal?.throwIfAborted();
          const destination = await localAgentPath(workspace, file.path, true),
            backup = path.join(recovery, "before", String(index));
          if (file.before) {
            if (
              ((await lstat(destination)).mode & 0o777) !== file.mode ||
              !(await readSafeProjectFile(workspace, destination)).equals(
                file.before,
              )
            )
              throw new Error(
                "Image changed before commit; both versions retained",
              );
            manifest.steps[file.path] = "moving";
            await savePublicationManifest(recovery, manifest);
            await rename(destination, backup);
            moved.push({ path: file.path, destination, backup });
            await syncPublicationDirectory(path.dirname(destination));
            await syncPublicationDirectory(path.dirname(backup));
            if (
              ((await lstat(backup)).mode & 0o777) !== file.mode ||
              !(await readSafeProjectFile(recovery, backup)).equals(file.before)
            )
              throw new Error(
                "Image changed before commit; both versions retained",
              );
            manifest.steps[file.path] = "moved";
            await savePublicationManifest(recovery, manifest);
          }
          await durablePublicationDirectory(path.dirname(destination), 0o755);
          await localAgentPath(workspace, file.path, true);
          const temporary = path.join(recovery, "after", String(index)),
            ino = (await lstat(temporary)).ino;
          manifest.steps[file.path] = "linking";
          await savePublicationManifest(recovery, manifest);
          await link(temporary, destination);
          published.push({ destination, ino, index });
          await syncPublicationDirectory(path.dirname(destination));
          await rm(temporary);
          await syncPublicationDirectory(path.dirname(temporary));
          manifest.published.push(file.path);
          manifest.steps[file.path] = "published";
          await savePublicationManifest(recovery, manifest);
        }
        for (const file of changed)
          if (
            ((await lstat(file.destination)).mode & 0o777) !== file.mode ||
            !(await readSafeProjectFile(workspace, file.destination)).equals(
              file.bytes,
            )
          )
            throw new Error(
              "Working image changed before commit; versions retained",
            );
        manifest.state = "committed";
        await savePublicationManifest(recovery, manifest);
      } catch (cause) {
        let complete = true;
        for (const file of published.reverse()) {
          try {
            if ((await lstat(file.destination)).ino === file.ino) {
              const expected = changed[file.index]!;
              if (
                ((await lstat(file.destination)).mode & 0o777) !==
                  expected.mode ||
                !(
                  await readSafeProjectFile(workspace, file.destination)
                ).equals(expected.bytes)
              ) {
                complete = false;
                continue;
              }
              await rename(
                file.destination,
                path.join(recovery, `unpublished-${file.index}`),
              );
              await syncPublicationDirectory(path.dirname(file.destination));
              await syncPublicationDirectory(recovery);
            }
          } catch {
            complete = false;
          }
        }
        for (const file of moved.reverse()) {
          try {
            await localAgentPath(workspace, file.path, true);
            await link(file.backup, file.destination);
            await rm(file.backup);
            await syncPublicationDirectory(path.dirname(file.destination));
            await syncPublicationDirectory(path.dirname(file.backup));
          } catch {
            complete = false;
          }
        }
        for (const file of changed) {
          try {
            const current = await readSafeProjectFile(
              workspace,
              file.destination,
            );
            if (
              !file.before ||
              !current.equals(file.before) ||
              ((await lstat(file.destination)).mode & 0o777) !== file.mode
            )
              complete = false;
          } catch (failure) {
            if (
              (failure as NodeJS.ErrnoException).code !== "ENOENT" ||
              file.before
            )
              complete = false;
          }
        }
        manifest.state = complete ? "rolled-back" : "needs-review";
        try {
          await savePublicationManifest(recovery, manifest);
        } catch {}
        throw new Error(
          `Image publication stopped; recovery retained at ${recovery}. ${cause instanceof Error ? cause.message : "Publication failed"}`,
        );
      }
    },
    signal,
  );
}
