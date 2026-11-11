import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VideoGenerationError, videoReferenceTransport, type VideoExecution } from "./video-generation.js";
import { parseVideoReferencePreparation, type VideoReferencePreparation } from "../shared/video-reference-preparation.js";

type Entry = { fingerprint: string; task?: Record<string, string> };
const submissions = new Map<string, Promise<unknown>>();

async function readEntries(file: string): Promise<Record<string, Entry>> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error();
    const entries: Record<string, Entry> = JSON.parse(await handle.readFile("utf8"));
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some((entry) =>
      !entry || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || entry.task !== undefined &&
      (typeof entry.task !== "object" || Array.isArray(entry.task) || Object.keys(entry.task).some((key) => !["taskId", "pngPreparation", "referenceUrlCount", "referenceLocalCount"].includes(key)) ||
        typeof entry.task.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(entry.task.taskId) ||
        (entry.task.referenceUrlCount !== undefined || entry.task.referenceLocalCount !== undefined) && !videoReferenceTransport(entry.task) ||
        entry.task.pngPreparation !== undefined && (typeof entry.task.pngPreparation !== "string" || !parseVideoReferencePreparation(entry.task.pngPreparation))))) throw new Error();
    return entries;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new VideoGenerationError("The saved video task could not be read safely", 409);
  } finally { await handle?.close(); }
}

/** Unreadable evidence is uncertain; callers must not turn it into a fresh paid submission. */
export async function hasAttemptedVideoTask(directory: string, id: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) return true;
  try {
    if (!(await lstat(directory)).isDirectory()) return true;
    const entries = await readEntries(path.resolve(directory, `${id}.json`));
    return Object.hasOwn(entries, "generate");
  } catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Capability only; never returns a task ID, reads credentials, or creates a record. */
export async function hasSavedVideoTask(directory: string, id: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) return false;
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    return Boolean((await readEntries(path.resolve(directory, `${id}.json`))).generate?.task);
  } catch { return false; }
}

/** An interrupted submission is ambiguous; retry only a known task, never its paid POST. */
export async function videoTaskJournal(directory: string, id: string, recoveryOnly = false, referencePrepared?: (summary: VideoReferencePreparation) => Promise<void>, submissionStarted?: () => Promise<void>): Promise<VideoExecution> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new VideoGenerationError("Invalid video recovery ID", 400);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new VideoGenerationError("Linked video recovery directories are unavailable", 409);
  const file = path.resolve(directory, `${id}.json`);
  return {
    recoveryOnly,
    referencePrepared,
    submissionStarted,
    async submitted<T extends Record<string, string>>(stage: string, scope: string, input: unknown, create: () => Promise<T>): Promise<T> {
      const pending = (submissions.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const entries = await readEntries(file);
        const save = async () => {
          const temporary = `${file}.tmp`;
          try { await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 }); await rename(temporary, file); }
          finally { await rm(temporary, { force: true }).catch(() => undefined); }
        };
        const fingerprint = createHash("sha256").update(scope).update(JSON.stringify(input)).digest("hex");
        const previous = entries[stage];
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new VideoGenerationError("Video provider or parameters changed. Restore the original settings to resume, or start a new generation.", 409);
          if (!previous.task) throw new VideoGenerationError("Video submission could not be confirmed. Check the provider before starting another generation; retry will not submit another paid task.", 409);
          return previous.task as T;
        }
        if (recoveryOnly) throw new VideoGenerationError("No saved video task is available. Recovery never submits a new generation.", 409);
        entries[stage] = { fingerprint };
        await save();
        let task: T;
        try { task = await create(); }
        catch (cause) {
          if (cause instanceof VideoGenerationError && (cause.notSubmitted || [400, 401, 403, 429].includes(cause.statusCode))) { delete entries[stage]; await save(); }
          throw cause;
        }
        entries[stage] = { fingerprint, task };
        await save();
        return task;
      });
      submissions.set(file, pending);
      try { return await pending; }
      finally { if (submissions.get(file) === pending) submissions.delete(file); }
    },
  };
}
