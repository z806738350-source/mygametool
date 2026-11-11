import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { Model3DGenerationError, type Model3DExecution } from "./model3d.js";
import {
  durablePublicationDirectory,
  durablePublicationFile,
  syncPublicationDirectory,
} from "./isolated-publication-journal.js";

type Entry = { fingerprint: string; credentials?: Record<string, string> };
// Original and copied jobs may share a recovery ID. Serialize only submission,
// not polling or downloads, across journal instances in the daemon.
const submissions = new Map<string, Promise<unknown>>();
const results = new Map<string, Promise<unknown>>();

const storageUncertain = () =>
  new Model3DGenerationError(
    "Local 3D task storage could not be confirmed. Existing receipts and results are retained; this attempt did not submit a subsequent stage. Inspect the original operation before retrying.",
    503,
  );

/** Publish without a model-sized concatenation; remove only our exact private staging inode. */
async function saveJournalFile(
  file: string,
  chunks: readonly Buffer[],
  noReplace = false,
): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`,
    directory = path.dirname(file);
  let identity: { dev: number; ino: number } | undefined,
    linked = false;
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  try {
    try {
      await durablePublicationFile(temporary, async (handle) => {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1)
          throw new Error("Invalid private task staging file");
        identity = { dev: info.dev, ino: info.ino };
        for (const chunk of chunks) await handle.writeFile(chunk);
      });
      const current = await lstat(temporary);
      if (
        !identity ||
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.size !== length ||
        (process.platform !== "win32" &&
          (current.uid !== process.getuid?.() ||
            (current.mode & 0o7777) !== 0o600))
      )
        throw new Error("Private task staging identity changed");
      if (noReplace) {
        try {
          await link(temporary, file);
          linked = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      } else {
        await rename(temporary, file);
        identity = undefined;
      }
      await syncPublicationDirectory(directory);
      return true;
    } finally {
      if (identity) {
        const current = await lstat(temporary).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current) {
          if (
            !current.isFile() ||
            current.nlink !== (linked ? 2 : 1) ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino
          )
            throw new Error("Private task staging cleanup is unconfirmed");
          if (linked) {
            const published = await lstat(file);
            if (
              !published.isFile() ||
              published.dev !== identity.dev ||
              published.ino !== identity.ino
            )
              throw new Error("Private result publication changed");
          }
          await rm(temporary);
          await syncPublicationDirectory(directory);
        }
      }
    }
  } catch {
    throw storageUncertain();
  }
}

/** A stale/foreign lock is evidence, not permission to repeat an unknown paid submission. */
async function submissionLease(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.submission-lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      throw new Model3DGenerationError(
        "Another process or an unfinished submission owns this 3D task. Inspect the original operation; no new task was submitted.",
        409,
      );
    throw storageUncertain();
  }
  let identity;
  try {
    identity = await lstat(lock);
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (identity.uid !== process.getuid?.() ||
          (identity.mode & 0o7777) !== 0o700))
    )
      throw new Error();
    await syncPublicationDirectory(path.dirname(file));
  } catch {
    throw storageUncertain();
  }
  return async () => {
    try {
      const current = await lstat(lock);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        (process.platform !== "win32" &&
          (current.uid !== process.getuid?.() ||
            (current.mode & 0o7777) !== 0o700)) ||
        (await readdir(lock)).length
      )
        throw new Error();
      await rmdir(lock);
      await syncPublicationDirectory(path.dirname(file));
    } catch {
      throw storageUncertain();
    }
  };
}

async function readResult(
  cache: string,
  taskId: string,
): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(
      cache,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size > 100n * 1024n * 1024n + 1024n ||
      info.size < 4n ||
      (process.platform !== "win32" &&
        (Number(info.mode) & 0o077 || Number(info.uid) !== process.getuid?.()))
    )
      throw new Error();
    const stored = await handle.readFile(),
      final = await handle.stat({ bigint: true }),
      length = stored.readUInt32LE(0);
    if (
      final.size !== info.size ||
      final.mtimeNs !== info.mtimeNs ||
      final.ctimeNs !== info.ctimeNs ||
      length > 1024 ||
      length + 4 >= stored.length
    )
      throw new Error();
    const metadata = JSON.parse(stored.toString("utf8", 4, length + 4)),
      bytes = stored.subarray(length + 4);
    if (
      metadata.taskId !== taskId ||
      metadata.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error();
    // Old envelopes remain readable even when their variable-length header is unaligned.
    return bytes.byteOffset % 4 ? Buffer.from(bytes) : bytes;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Model3DGenerationError(
      "The retained 3D result could not be read safely. No new task was submitted.",
      409,
    );
  } finally {
    await handle?.close();
  }
}

async function readEntries(file: string): Promise<Record<string, Entry>> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024 ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error();
    const entries: Record<string, Entry> = JSON.parse(
      await handle.readFile("utf8"),
    );
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      Object.values(entries).some(
        (entry) =>
          !entry ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          (entry.credentials !== undefined &&
            (!entry.credentials ||
              typeof entry.credentials !== "object" ||
              Array.isArray(entry.credentials) ||
              !Object.keys(entry.credentials).length ||
              Object.values(entry.credentials).some(
                (value) =>
                  typeof value !== "string" || !value || value.length > 4096,
              ))),
      )
    )
      throw new Error();
    return entries;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Model3DGenerationError(
      "The saved 3D task could not be read safely. No new task was submitted.",
      409,
    );
  } finally {
    await handle?.close();
  }
}

/** Unreadable evidence is uncertain; callers must not turn it into a fresh paid submission. */
export async function hasAttempted3DTask(
  directory: string,
  id: string,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) return true;
  try {
    if (!(await lstat(directory)).isDirectory()) return true;
    const entries = await readEntries(path.resolve(directory, `${id}.json`));
    return Object.keys(entries).length > 0;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** A recorded upload alone cannot be polled as a model generation, rig or animation. */
export async function hasSaved3DTask(
  directory: string,
  id: string,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) return false;
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const entries = await readEntries(path.resolve(directory, `${id}.json`));
    return Object.values(entries).some(({ credentials }) =>
      Boolean(
        credentials?.taskId ||
        (credentials?.uuid && credentials.subscriptionKey),
      ),
    );
  } catch {
    return false;
  }
}

/** Persist before and immediately after every paid submission. A lost POST response cannot safely be resubmitted. */
export async function model3DJournal(
  directory: string,
  id: string,
  recoveryOnly = false,
): Promise<Model3DExecution> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id))
    throw new Model3DGenerationError("Invalid task recovery ID", 400);
  if (!recoveryOnly) await durablePublicationDirectory(directory);
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error();
  } catch (cause) {
    if (!recoveryOnly || (cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Model3DGenerationError(
        "The saved 3D task directory is unavailable",
        409,
      );
  }
  const file = path.resolve(directory, `${id}.json`);
  recoveryOnly ||= Object.keys(await readEntries(file)).length > 0;
  const createdStages = new Set<string>();
  return {
    get recoveryOnly() {
      return recoveryOnly;
    },
    async result(stage, taskId, download) {
      if (
        !/^[a-z-]{1,60}$/.test(stage) ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(taskId)
      )
        throw new Model3DGenerationError("Invalid 3D result identity", 409);
      const cache = `${file}.${stage}.result`;
      const pending = (results.get(cache) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const retained = await readResult(cache, taskId);
          if (retained) return retained;
          if (!download) return undefined;
          const bytes = await download();
          if (!bytes.length || bytes.length > 100 * 1024 * 1024)
            throw new Model3DGenerationError("Invalid 3D result size", 413);
          const text = Buffer.from(
            JSON.stringify({
              taskId,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            }),
          );
          // JSON whitespace keeps the existing envelope readable and aligns new cached GLBs without copying their full bodies.
          const metadata = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20),
            header = Buffer.alloc(4);
          text.copy(metadata);
          header.writeUInt32LE(metadata.length);
          if (await saveJournalFile(cache, [header, metadata, bytes], true))
            return bytes;
          const existing = await readResult(cache, taskId);
          if (!existing) throw storageUncertain();
          if (
            existing.length !== bytes.length ||
            createHash("sha256").update(existing).digest("hex") !==
              createHash("sha256").update(bytes).digest("hex")
          )
            throw new Model3DGenerationError(
              "A different original 3D result was already retained for this task. The first result is preserved; inspect the original operation.",
              409,
            );
          return existing;
        });
      results.set(cache, pending);
      try {
        return await pending;
      } finally {
        if (results.get(cache) === pending) results.delete(cache);
      }
    },
    async submitted<T extends Record<string, string>>(
      stage: string,
      scope: string,
      input: unknown,
      create: () => Promise<T>,
    ): Promise<T> {
      const pending = (submissions.get(file) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const fingerprint = createHash("sha256")
            .update(scope)
            .update(JSON.stringify(input))
            .digest("hex");
          const recorded = (entries: Record<string, Entry>): T | undefined => {
            if (!createdStages.size && Object.keys(entries).length)
              recoveryOnly = true;
            const previous = entries[stage];
            if (previous) {
              if (previous.fingerprint !== fingerprint)
                throw new Model3DGenerationError(
                  "Provider connection or input changed. Restore the original settings to resume, or start a new generation.",
                  409,
                );
              if (!previous.credentials)
                throw new Model3DGenerationError(
                  "Submission could not be confirmed. Check the provider dashboard before starting a new generation; retry will not submit another paid task.",
                  409,
                );
              return previous.credentials as T;
            }
            if (recoveryOnly)
              throw new Model3DGenerationError(
                "3D recovery stopped at an unrecorded stage. No new task was submitted. Start a new generation only if you intend another paid workflow.",
                409,
              );
            return undefined;
          };
          // Confirmed receipts can be read even if a crashed process left its lock.
          const previous = recorded(await readEntries(file));
          if (previous) return previous;
          const release = await submissionLease(file);
          try {
            // A different daemon may have published between our first read and mkdir.
            const entries = await readEntries(file),
              existing = recorded(entries);
            if (existing) return existing;
            const save = async () => {
              const bytes = Buffer.from(JSON.stringify(entries));
              if (bytes.length > 1024 * 1024)
                throw new Model3DGenerationError(
                  "The local 3D task journal exceeds its existing readable bound; no further stage was submitted.",
                  409,
                );
              await saveJournalFile(file, [bytes]);
            };
            entries[stage] = { fingerprint };
            await save();
            let credentials: T;
            try {
              credentials = await create();
            } catch (cause) {
              // Only definite validation/rate-limit rejection permits another submission.
              if (
                cause instanceof Model3DGenerationError &&
                (cause.notSubmitted || [400, 429].includes(cause.statusCode))
              ) {
                delete entries[stage];
                await save();
              }
              throw cause;
            }
            entries[stage] = { fingerprint, credentials };
            await save();
            createdStages.add(stage);
            return credentials;
          } finally {
            try {
              await release();
            } catch (cause) {
              recoveryOnly = true;
              throw cause;
            }
          }
        });
      submissions.set(file, pending);
      try {
        return await pending;
      } finally {
        if (submissions.get(file) === pending) submissions.delete(file);
      }
    },
  };
}
