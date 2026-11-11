import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  mkdir,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { localAgentPath } from "./agent-local-files.js";
import { inspectSafeProjectMedia } from "./safe-project-file.js";
import {
  isStaticRasterPath,
  validateRasterReturn,
  type RasterReturnReceipt,
} from "./isolated-raster-returns.js";
import {
  assertSourcePublicationSettled,
  durablePublicationDirectory,
  durablePublicationFile,
  hashPublicationHandle,
  initializePublicationManifest,
  savePublicationManifest,
  syncPublicationDirectory,
  sourcePublicationMetadata,
  type PublicationContext,
  type PublicationManifest,
} from "./isolated-publication-journal.js";
import {
  assertRecoverySpaceReservation,
  checkRecoverySpaceHeadroom,
  currentRecoverySpaceReservation,
  inspectRecoverySpace,
  reserveRecoverySpace,
  reservationForPublication,
  type RecoverySpaceInputs,
  type RecoverySpaceReservation,
} from "./recovery-space.js";
import {
  readValidatedRasterArtifact,
  validatedRasterArtifactReceipt,
  type ValidatedRasterArtifact,
} from "./validated-raster-artifact.js";
import {
  projectFiles,
  inspectRuntimeMedia,
  copyRuntimeMedia,
  readRuntimeMedia,
  runtimeMediaPath,
  mediaHeaderMatches,
  transferPath,
  type RuntimeMedia,
  type TransferFile,
} from "./isolated-project-files.js";
import {
  createSourceManifest,
  createSourceManifestV2,
  parseSourceContract,
  planSourceDelta,
  type SourceManifestEntryV1,
} from "./isolated-source-manifest.js";
import {
  getRuntimeCapacityProfile,
  runtimeMediaFileLimit,
  type RuntimeCapacityProfileId,
} from "../shared/execution-capacity-profiles.js";

export type WorkspaceGuard = <T>(operation: () => Promise<T>) => Promise<T>;
const fingerprint = (
  files: readonly Pick<TransferFile, "path" | "sha256" | "mode">[],
) =>
  JSON.stringify(
    files
      .map(({ path, sha256, mode }) => ({ path, sha256, mode }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );

/** Read-only capacity check shared by review and publication; never creates recovery folders. */
export async function sourceRecoveryBudget(
  workspace: string,
  required: number,
  profileId?: RuntimeCapacityProfileId,
): Promise<{ used: number; limit: number; fits: boolean }> {
  const { used, limit, fits } = await inspectRecoverySpace(
    workspace,
    required,
    profileId,
  );
  return { used, limit, fits };
}

export async function assertSourcePublicationCapacity(
  workspace: string,
): Promise<void> {
  const root = path.join(path.dirname(workspace), "isolated-changes");
  try {
    if ((await realpath(root)) !== root)
      throw new Error("Recovery storage must not be linked");
    if ((await readdir(root)).length >= 2000)
      throw new Error(
        "Source publication history reached its 2000-transaction limit; keep the retained results for review",
      );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

/** The caller holds the exclusive workspace write guard across capacity and creation. */
export async function createSourcePublication(
  workspace: string,
): Promise<{ id: string; directory: string }> {
  await assertSourcePublicationCapacity(workspace);
  const id = randomUUID(),
    directory = path.join(path.dirname(workspace), "isolated-changes", id);
  await durablePublicationDirectory(path.dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  try {
    await syncPublicationDirectory(path.dirname(directory));
  } catch (cause) {
    try {
      await rmdir(directory);
      await syncPublicationDirectory(path.dirname(directory));
    } catch {}
    throw cause;
  }
  return { id, directory };
}

/** Called inside the application's exclusive workspace write guard. Originals are retained, never overwritten. */
export async function applySourceChanges(
  workspace: string,
  baseline: TransferFile[],
  returned: Array<TransferFile | RuntimeMedia>,
  signal?: AbortSignal,
  runtimeMedia?: RuntimeMedia[],
  rasterReturnVersion: 0 | 1 | 2 = 0,
  publicationContext?: PublicationContext,
  options: {
    rasterArtifacts?: readonly ValidatedRasterArtifact[];
    backingDevice?: number;
  } = {},
): Promise<{ changed: string[]; recovery?: string }> {
  signal?.throwIfAborted();
  const sourceContract =
    publicationContext?.sourceContract === undefined
      ? undefined
      : parseSourceContract(publicationContext.sourceContract);
  const profile =
    sourceContract?.version === 2
      ? getRuntimeCapacityProfile(sourceContract.profileId)
      : undefined;
  const mediaLimit = profile?.mediaBytes ?? 64 * 1024 * 1024;
  const buildManifest = (entries: readonly SourceManifestEntryV1[]) =>
    profile
      ? createSourceManifestV2(profile.id, entries)
      : createSourceManifest(entries);
  await assertSourcePublicationSettled(workspace);
  if (!Array.isArray(returned) || returned.length > 2000)
    throw new Error("Invalid isolated source response");
  const artifacts = new Set(options.rasterArtifacts ?? []);
  returned = [...returned, ...artifacts];
  if (returned.length > 2000)
    throw new Error("Isolated source file count exceeded");
  const workspaceRoot = await realpath(workspace);
  let total = 0;
  let mediaBytes = runtimeMedia?.reduce((sum, file) => sum + file.size, 0) ?? 0;
  const seen = new Set<string>();
  const protectedMedia = new Set(runtimeMedia?.map((file) => file.path));
  const replacedMedia = new Set(
    returned
      .filter((file) => !("data" in file) && protectedMedia.has(file.path))
      .map((file) => file.path),
  );
  if (returned.length + protectedMedia.size - replacedMedia.size > 2000)
    throw new Error("Isolated source file count exceeded");
  const mediaByDigest = new Map(
    runtimeMedia?.map((file) => [file.sha256, file]),
  );
  const copied = new Map<string, RuntimeMedia>();
  const rasterReceipts: RasterReturnReceipt[] = [];
  for (const file of returned) {
    transferPath(file.path);
    if (
      seen.has(file.path) ||
      file.path
        .split("/")
        .some((part) => ["node_modules", "dist", "build", "out"].includes(part))
    )
      throw new Error("Invalid source destination");
    seen.add(file.path);
    if (artifacts.has(file as ValidatedRasterArtifact)) {
      const artifact = file as ValidatedRasterArtifact,
        receipt = validatedRasterArtifactReceipt(workspaceRoot, artifact);
      const before =
        runtimeMedia?.find((item) => item.path === artifact.path) ??
        baseline.find((item) => item.path === artifact.path);
      if (artifact.beforeSha256 !== before?.sha256)
        throw new Error(
          "The reviewed raster has no matching current host baseline",
        );
      mediaBytes +=
        artifact.size -
        (runtimeMedia?.find((item) => item.path === artifact.path)?.size ?? 0);
      if (mediaBytes > mediaLimit)
        throw new Error(
          `Reviewed raster media exceeds the existing ${mediaLimit / (1024 * 1024)} MiB bound`,
        );
      rasterReceipts.push(receipt);
      continue;
    }
    if (!("data" in file)) {
      const source = mediaByDigest.get(file.sha256);
      mediaBytes +=
        file.size -
        (runtimeMedia?.find((item) => item.path === file.path)?.size ?? 0);
      if (
        !runtimeMediaPath(file.path) ||
        !source ||
        source.size !== file.size ||
        mediaBytes > mediaLimit ||
        ("executable" in file && file.executable !== false) ||
        baseline.some((item) => item.path === file.path)
      )
        throw new Error(
          "Unverified isolated media copy; all versions are retained for review",
        );
      await inspectRuntimeMedia(workspace, source, { profile: profile?.id, signal, formatPath: file.path });
      copied.set(file.path, source);
      continue;
    }
    if (
      typeof file.data !== "string" ||
      file.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      )
    )
      throw new Error("Invalid or oversized isolated source encoding");
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (
      total > 8 * 1024 * 1024 ||
      data.length > 2 * 1024 * 1024 ||
      createHash("sha256").update(data).digest("hex") !== file.sha256 ||
      containsKnownSensitiveValue(data.toString("utf8"))
    )
      throw new Error("Private or oversized isolated source");
    const registered = runtimeMedia?.find((item) => item.path === file.path);
    if (
      registered &&
      (rasterReturnVersion !== 1 ||
        file.rasterBaseSha256 !== registered.sha256 ||
        !isStaticRasterPath(file.path))
    )
      throw new Error(
        "Unapproved runtime media change; originals and guest data are retained for review",
      );
    if (
      file.rasterBaseSha256 !== undefined &&
      (!registered || !/^[a-f0-9]{64}$/.test(file.rasterBaseSha256))
    )
      throw new Error("Raster return has no verified baseline");
    const sourceBefore = baseline.find((item) => item.path === file.path);
    if (
      rasterReturnVersion > 0 &&
      isStaticRasterPath(file.path) &&
      file.sha256 !== (registered ?? sourceBefore)?.sha256
    ) {
      if (file.executable)
        throw new Error(
          "Executable raster returns are unavailable; data retained for review",
        );
      const before = registered
        ? await readRuntimeMedia(workspace, registered)
        : sourceBefore
          ? Buffer.from(sourceBefore.data, "base64")
          : undefined;
      rasterReceipts.push(
        await validateRasterReturn(
          file.path,
          data,
          before,
          rasterReturnVersion as 1 | 2,
        ),
      );
      if (rasterReturnVersion === 2 && runtimeMediaPath(file.path)) {
        mediaBytes += data.length;
        if (mediaBytes > mediaLimit)
          throw new Error(
            `Reviewed raster media exceeds the existing ${mediaLimit / (1024 * 1024)} MiB bound`,
          );
      }
    }
  }
  const original = new Map<string, TransferFile | RuntimeMedia>(
    [...baseline, ...(runtimeMedia ?? [])].map((file) => [file.path, file]),
  );
  const deleted = baseline.filter((file) => !seen.has(file.path));
  if (deleted.length)
    throw new Error(
      "Source deletion requires review; no returned changes were applied: " +
        deleted
          .map((file) => file.path)
          .join(", ")
          .slice(0, 2000),
    );
  const matchesBaseline = async () => {
    const currentMedia: RuntimeMedia[] | undefined = runtimeMedia
      ? []
      : undefined;
    return (
      fingerprint(
        await projectFiles(workspace, currentMedia, undefined, {
          ...(profile ? { profile: profile.id } : {}),
          signal,
        }),
      ) === fingerprint(baseline) &&
      (!runtimeMedia ||
        fingerprint(currentMedia!) === fingerprint(runtimeMedia))
    );
  };
  if (!(await matchesBaseline()))
    throw new Error(
      "Source conflict: the host workspace changed; no returned changes were applied",
    );
  let changed = returned.filter((file) => {
    const before = original.get(file.path);
    return (
      file.sha256 !== before?.sha256 ||
      ("executable" in file && Boolean(file.executable)) !==
        Boolean(before && "executable" in before && before.executable)
    );
  });
  const size = (file: TransferFile | RuntimeMedia) =>
    "data" in file ? Buffer.byteLength(file.data, "base64") : file.size;
  // Execution/raw identity is distinct from this current-host -> approved target
  // delta. Unchanged host paths remain in both complete publication manifests.
  const toEntry = (
    file: TransferFile | RuntimeMedia,
    media: boolean,
  ): SourceManifestEntryV1 => ({
    path: file.path,
    kind: media ? "media" : "source",
    size: size(file),
    sha256: file.sha256,
    executable: "executable" in file && file.executable === true,
  });
  const publicationBefore = sourceContract
    ? buildManifest(
        [...original.values()].map((file) => toEntry(file, !("data" in file))),
      )
    : undefined;
  const targetEntries = new Map(
    publicationBefore?.files.map((file) => [file.path, file]),
  );
  if (sourceContract)
    for (const file of returned)
      targetEntries.set(
        file.path,
        toEntry(
          file,
          !("data" in file) ||
            protectedMedia.has(file.path) ||
            (runtimeMediaPath(file.path) &&
              rasterReceipts.some((receipt) => receipt.path === file.path)),
        ),
      );
  const publicationAfter = sourceContract
    ? buildManifest([...targetEntries.values()])
    : undefined;
  const publicationDelta =
    publicationBefore && publicationAfter
      ? planSourceDelta(publicationBefore, publicationAfter)
      : undefined;
  if (publicationDelta) {
    if (
      profile &&
      (publicationDelta.summary.afterMediaBytes > profile.mediaWindowBytes ||
        publicationDelta.summary.afterSourceBytes > profile.sourceBytes)
    )
      throw new Error(
        "The complete publication delta exceeds its 64 MiB media return window; all versions remain retained",
      );
    if (publicationDelta.summary.removedFiles)
      throw new Error(
        "Source deletion requires review; no returned changes were applied",
      );
    const paths = new Set(
      publicationDelta.changes
        .filter((file) => file.change !== "unchanged")
        .map((file) => file.path),
    );
    changed = returned.filter((file) => paths.has(file.path));
  }
  const writeVersion = async (
    target: string,
    file: TransferFile | RuntimeMedia,
    mode = 0o600,
    original = false,
  ) => {
    if (!artifacts.has(file as ValidatedRasterArtifact) && !("data" in file)) {
      const source = original ? file : copied.get(file.path)!;
      await durablePublicationFile(
        target,
        (handle) =>
          copyRuntimeMedia(workspaceRoot, source, handle, {
            profile: profile?.id,
            signal,
            formatPath: file.path,
          }),
        mode,
      );
    } else
      await durablePublicationFile(
        target,
        artifacts.has(file as ValidatedRasterArtifact)
          ? await readValidatedRasterArtifact(
              workspaceRoot,
              file as ValidatedRasterArtifact,
            )
          : Buffer.from((file as TransferFile).data, "base64"),
        mode,
      );
  };
  if (!changed.length) return { changed: [] };
  const manifest: PublicationManifest = {
    version: sourceContract?.version === 2 ? 5 : sourceContract ? 4 : 3,
    state: "staging",
    context: sourceContract
      ? { ...publicationContext!, sourceContract }
      : publicationContext,
    ...(publicationDelta
      ? sourcePublicationMetadata(
          publicationContext!,
          publicationBefore!,
          publicationAfter!,
        )
      : {}),
    versions: changed.map((file) => {
      const before = original.get(file.path);
      return {
        path: file.path,
        ...(before
          ? {
              beforeSha256: before.sha256,
              beforeSize:
                "data" in before
                  ? Buffer.byteLength(before.data, "base64")
                  : before.size,
              ...("mode" in before ? { beforeMode: before.mode } : {}),
            }
          : {}),
        afterSha256: file.sha256,
        afterSize: size(file),
        afterMode:
          ((before && "mode" in before ? (before.mode ?? 0o600) : 0o600) &
            0o666) |
          ("executable" in file && file.executable ? 0o100 : 0),
      };
    }),
    published: [],
    steps: Object.fromEntries(
      changed.map((file) => [file.path, "staged" as const]),
    ),
    rasterReceipts,
  };
  const largestManifestBytes =
    Buffer.byteLength(
      JSON.stringify({
        ...manifest,
        state: "needs-review",
        published: changed.map((file) => file.path),
        steps: Object.fromEntries(
          changed.map((file) => [file.path, "published"]),
        ),
      }),
    ) + 4096;
  if (largestManifestBytes > 2 * 1024 * 1024)
    throw new Error("Recovery transaction metadata exceeds its bound");
  const recoveryRoot = path.join(path.dirname(workspace), "isolated-changes");
  await durablePublicationDirectory(recoveryRoot);
  if ((await realpath(recoveryRoot)) !== recoveryRoot)
    throw new Error("Recovery storage must not be linked");
  const futureEntries = new Set<string>([
    "transaction",
    "transaction/manifest.json",
    "transaction/.manifest-1.tmp",
    "transaction/.manifest-2.tmp",
  ]);
  for (const name of ["before", "after", "original", "returned"])
    futureEntries.add("transaction/" + name);
  for (const file of changed)
    for (const name of [
      "after",
      "returned",
      ...(original.has(file.path) ? ["before", "original"] : []),
    ]) {
      const segments = file.path.split("/");
      for (let count = 1; count <= segments.length; count++)
        futureEntries.add(
          "transaction/" + name + "/" + segments.slice(0, count).join("/"),
        );
    }
  const spaceInputs: RecoverySpaceInputs = {
    ...(profile ? { profileId: profile.id } : {}),
    ...(options.backingDevice === undefined
      ? {}
      : { backingDevice: options.backingDevice }),
    rawBytes: 0,
    workingBytes: 0,
    additionalEntries: futureEntries.size,
    beforeBytes:
      publicationDelta?.summary.beforeBytes ??
      changed.reduce(
        (sum, file) =>
          sum + (original.get(file.path) ? size(original.get(file.path)!) : 0),
        0,
      ),
    afterBytes:
      publicationDelta?.summary.afterBytes ??
      changed.reduce((sum, file) => sum + size(file), 0),
    manifestBytes: largestManifestBytes,
  };
  await assertSourcePublicationCapacity(workspace);
  let reservation: RecoverySpaceReservation | undefined =
      currentRecoverySpaceReservation(workspaceRoot),
    ownedReservation = false;
  if (reservation) {
    assertRecoverySpaceReservation(reservation, workspaceRoot, spaceInputs);
    if (sourceContract)
      await reservationForPublication(
        workspaceRoot,
        reservation.id,
        publicationContext!,
      );
  } else {
    reservation = await reserveRecoverySpace(workspaceRoot, spaceInputs, {
      ownerKey: randomUUID().replaceAll("-", ""),
      namespace: publicationContext?.namespace ?? "test",
      projectId: publicationContext?.projectId ?? "local-publication",
      ...(sourceContract
        ? {
            sourceManifestVersion: sourceContract.version,
            ...(sourceContract.version === 2
              ? { sourceProfileId: sourceContract.profileId }
              : {}),
            sourceBaseManifestId: sourceContract.baseManifestId,
            sourceResultManifestId: sourceContract.rawManifestId,
          }
        : {}),
      ...(publicationContext
        ? {
            generation: publicationContext.generation,
            rawSnapshotId: publicationContext.snapshotId,
          }
        : {}),
      signal,
    });
    ownedReservation = true;
  }
  manifest.spacePlan = { ...reservation.plan };
  manifest.reservationId = reservation.id;
  let id = "",
    recovery = "";
  try {
    const created = await createSourcePublication(workspace);
    id = created.id;
    recovery = created.directory;
    await initializePublicationManifest(recovery, manifest);
  } catch (cause) {
    const absent =
      !recovery ||
      (await lstat(recovery).then(
        () => false,
        (failure) => (failure as NodeJS.ErrnoException).code === "ENOENT",
      ));
    if (ownedReservation && absent) await reservation.release().catch(() => {});
    throw cause;
  }
  const moved: string[] = [],
    published: { name: string; ino: number }[] = [];
  let committed = false;
  try {
    for (const folder of ["before", "after", "original", "returned"])
      await durablePublicationDirectory(path.join(recovery, folder));
    for (const file of changed) {
      const before = original.get(file.path);
      if (before) {
        const saved = path.join(recovery, "original", ...file.path.split("/"));
        await durablePublicationDirectory(path.dirname(saved));
        await writeVersion(saved, before, 0o600, true);
      }
      const target = path.join(recovery, "after", ...file.path.split("/"));
      await durablePublicationDirectory(path.dirname(target));
      await writeVersion(
        target,
        file,
        manifest.versions.find((v) => v.path === file.path)!.afterMode,
      );
      const retained = path.join(recovery, "returned", ...file.path.split("/"));
      await durablePublicationDirectory(path.dirname(retained));
      await writeVersion(retained, file);
    }
    signal?.throwIfAborted();
    if (!(await matchesBaseline()))
      throw new Error("Source conflict before publication");
    await checkRecoverySpaceHeadroom(reservation);
    // This durable barrier precedes every move of a live file, including on abrupt process death.
    manifest.state = "publishing";
    await savePublicationManifest(recovery, manifest);
    for (const file of changed) {
      if (!original.has(file.path)) continue;
      const before = original.get(file.path)!;
      const target = await localAgentPath(workspace, file.path);
      const backup = path.join(recovery, "before", ...file.path.split("/"));
      await durablePublicationDirectory(path.dirname(backup));
      manifest.steps[file.path] = "moving";
      await savePublicationManifest(recovery, manifest);
      await rename(target, backup);
      moved.push(file.path);
      await syncPublicationDirectory(path.dirname(target));
      await syncPublicationDirectory(path.dirname(backup));
      const handle = await open(
        backup,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          ("size" in before
            ? stat.size !== before.size || !!(stat.mode & 0o111)
            : stat.size > 2 * 1024 * 1024 ||
              (stat.mode & 0o777) !== before.mode)
        )
          throw new Error("Source conflict during publication");
        if (await hashPublicationHandle(handle, stat.size) !== before.sha256)
          throw new Error("Source conflict during publication");
      } finally {
        await handle.close();
      }
      manifest.steps[file.path] = "moved";
      await savePublicationManifest(recovery, manifest);
    }
    for (const file of changed) {
      signal?.throwIfAborted();
      const target = await localAgentPath(workspace, file.path, true);
      await durablePublicationDirectory(path.dirname(target), 0o755);
      await localAgentPath(workspace, file.path, true);
      const staged = path.join(recovery, "after", ...file.path.split("/"));
      const ino = (await lstat(staged)).ino;
      manifest.steps[file.path] = "linking";
      await savePublicationManifest(recovery, manifest);
      await link(staged, target); // Atomic no-replace publication: a concurrent new save wins.
      published.push({ name: file.path, ino });
      await syncPublicationDirectory(path.dirname(target));
      manifest.published.push(file.path);
      manifest.steps[file.path] = "published";
      await savePublicationManifest(recovery, manifest);
    }
    for (const file of changed) {
      await rm(path.join(recovery, "after", ...file.path.split("/")));
      await syncPublicationDirectory(
        path.dirname(path.join(recovery, "after", ...file.path.split("/"))),
      );
    }
    for (const version of manifest.versions) {
      const target = await localAgentPath(workspace, version.path);
      const saved = await inspectSafeProjectMedia(
        workspace,
        target,
        runtimeMediaFileLimit(version.path, profile?.id),
      );
      if (
        ((await lstat(target)).mode & 0o777) !== version.afterMode ||
        saved.size !== version.afterSize ||
        saved.sha256 !== version.afterSha256
      )
        throw new Error("Source changed before commit; all versions retained");
    }
    manifest.state = "committed";
    await savePublicationManifest(recovery, manifest);
    committed = true;
    if (ownedReservation) await reservation.release();
    return {
      changed: changed.map((file) => file.path),
      recovery: "isolated-changes/" + id,
    };
  } catch (error) {
    if (committed)
      throw new Error(
        `Source publication is committed but its space reservation needs inspection in isolated-changes/${id}; do not repeat publication`,
      );
    let rollbackComplete = true;
    // Move our published versions aside, preserving even edits through an already-open external file handle.
    for (const file of published.reverse()) {
      const target = path.join(workspace, ...file.name.split("/"));
      try {
        if ((await lstat(target)).ino === file.ino) {
          const version = manifest.versions.find((v) => v.path === file.name)!;
          const handle = await open(
            target,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const info = await handle.stat();
            if (info.size !== version.afterSize) {
              rollbackComplete = false;
              continue;
            }
            if (await hashPublicationHandle(handle, version.afterSize) !== version.afterSha256) {
              rollbackComplete = false;
              continue; // Preserve an external in-place edit at its live path.
            }
          } finally {
            await handle.close();
          }
          await rename(target, path.join(recovery, "failed-" + randomUUID()));
          const alias = path.join(recovery, "after", file.name);
          try {
            if ((await lstat(alias)).ino === file.ino) {
              await rm(alias);
              await syncPublicationDirectory(path.dirname(alias));
            }
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== "ENOENT")
              throw failure;
          }
        }
        await syncPublicationDirectory(path.dirname(target));
        await syncPublicationDirectory(recovery);
      } catch {
        rollbackComplete = false;
        /* A concurrent save is retained in place. */
      }
    }
    for (const name of moved) {
      const backup = path.join(recovery, "before", ...name.split("/"));
      try {
        const target = await localAgentPath(workspace, name, true);
        await link(backup, target);
        await rm(backup);
        await syncPublicationDirectory(path.dirname(target));
        await syncPublicationDirectory(path.dirname(backup));
      } catch {
        rollbackComplete = false;
        /* Never replace a concurrent save; the original remains in recovery. */
      }
    }
    for (const version of manifest.versions) {
      try {
        const handle = await open(
          await localAgentPath(workspace, version.path, true),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const saved = await hashPublicationHandle(handle, version.beforeSize ?? 0);
          if (
            !version.beforeSha256 ||
            saved !== version.beforeSha256
          )
            rollbackComplete = false;
        } finally {
          await handle.close();
        }
      } catch (failure) {
        if (
          (failure as NodeJS.ErrnoException).code !== "ENOENT" ||
          version.beforeSha256
        )
          rollbackComplete = false;
      }
    }
    manifest.state = rollbackComplete ? "rolled-back" : "needs-review";
    let rollbackRecorded = false;
    try {
      await savePublicationManifest(recovery, manifest);
      rollbackRecorded = true;
    } catch {
      /* The last durable phase continues to block unsafe new work. */
    }
    if (ownedReservation && rollbackComplete && rollbackRecorded)
      await reservation.release().catch(() => {});
    throw new Error(
      `Source publication stopped; originals and returned data are retained in isolated-changes/${id}. ${error instanceof Error ? error.message : "Conflict"}`,
    );
  }
}
