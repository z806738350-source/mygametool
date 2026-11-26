import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { cp, lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ClassicLevel } from "classic-level";
import { PROJECT_BROWSER_CLEANUP_DIRECTORY, storedBrowserProjectId } from "../shared/project-browser-storage.js";

const PROJECT_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const RENDERER_KEY = Buffer.from("_file://\0");
const LOG_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const MAX_LOG_CLEANUP_BYTES = 32 * 1024 * 1024;
const DESKTOP_LOGS = ["daemon.log", "daemon.1.log", "daemon.2.log", "main.log", "main.1.log", "main.2.log"];

async function entry(file: string) {
  const info = await lstat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
  });
  if (info && !info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    throw new Error("Unexpected link or special file in project browser storage");
  return info;
}

async function directory(file: string): Promise<boolean> {
  const info = await entry(file);
  if (info && !info.isDirectory()) throw new Error("Invalid browser storage directory");
  return !!info;
}

async function databaseDirectory(file: string): Promise<boolean> {
  if (!(await directory(file))) return false;
  for (const name of await readdir(file)) {
    if (!(await entry(path.join(file, name)))?.isFile())
      throw new Error("Invalid browser storage database file");
  }
  return true;
}

async function syncDirectory(file: string): Promise<void> {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function projectOwner(key: Buffer): string | undefined {
  if (!key.subarray(0, RENDERER_KEY.length).equals(RENDERER_KEY)) return;
  const encoding = key[RENDERER_KEY.length];
  const text = key.subarray(RENDERER_KEY.length + 1);
  if (encoding === 1) return storedBrowserProjectId(text.toString("latin1"));
  if (encoding === 0 && text.length % 2 === 0) return storedBrowserProjectId(text.toString("utf16le"));
}

async function rewriteDatabase(source: string, target: string, deleted: ReadonlySet<string>): Promise<void> {
  const options = { keyEncoding: "buffer", valueEncoding: "buffer", paranoidChecks: true } as const;
  const original = new ClassicLevel<Buffer, Buffer>(source, { ...options, createIfMissing: false });
  const replacement = new ClassicLevel<Buffer, Buffer>(target, { ...options, errorIfExists: true });
  try {
    await original.open();
    await replacement.open();
    const batch: { type: "put"; key: Buffer; value: Buffer }[] = [];
    for await (const [key, value] of original.iterator()) {
      const owner = projectOwner(key);
      if (owner && deleted.has(owner)) continue;
      batch.push({ type: "put", key, value });
      if (batch.length >= 128) await replacement.batch(batch.splice(0), { sync: true });
    }
    if (batch.length) await replacement.batch(batch, { sync: true });
  } finally {
    await Promise.all([original.close(), replacement.close()]);
  }
}

function retiredLogRecord(line: Buffer, deleted: ReadonlySet<string>): boolean {
  if (!isUtf8(line)) return false;
  const text = line.toString("utf8");
  const prefix = LOG_PREFIX.exec(text);
  if (!prefix) return false;
  try {
    const row: unknown = JSON.parse(text.slice(prefix[0].length));
    if (!row || typeof row !== "object" || !Object.hasOwn(row, "projectId")) return false;
    const { projectId } = row as { projectId: unknown };
    return typeof projectId === "string" && deleted.has(projectId);
  } catch { return false; }
}

/** The launcher holds its lock and Electron's append handles are closed. */
async function pruneDesktopLogs(desktop: string, deleted: ReadonlySet<string>): Promise<void> {
  const logs = path.join(desktop, "logs");
  if (!(await directory(logs))) return;
  for (const name of DESKTOP_LOGS) {
    const file = path.join(logs, name);
    const staged = file + ".project-cleanup-new";
    const stale = await entry(staged);
    if (stale && !stale.isFile()) throw new Error("Invalid diagnostic cleanup staging file");
    if (stale) await rm(staged);
    const listed = await entry(file);
    if (!listed) continue;
    if (!listed.isFile() || listed.size > MAX_LOG_CLEANUP_BYTES)
      throw new Error("Invalid or oversized diagnostic log");
    const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.nlink !== 1 || before.dev !== listed.dev || before.ino !== listed.ino || before.size !== listed.size)
        throw new Error("Diagnostic log changed before cleanup");
      const bytes = Buffer.allocUnsafe(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await source.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== before.size) throw new Error("Diagnostic log changed during cleanup");
      const input = bytes.subarray(0, size);
      const kept = Buffer.allocUnsafe(size);
      let written = 0;
      for (let start = 0; start < size;) {
        const newline = input.indexOf(10, start);
        const end = newline < 0 ? size : newline + 1;
        if (!retiredLogRecord(input.subarray(start, end), deleted)) {
          input.copy(kept, written, start, end);
          written += end - start;
        }
        start = end;
      }
      if (written === size) continue;
      const replacement = await open(staged, "wx", 0o600);
      try {
        try {
          await replacement.writeFile(kept.subarray(0, written));
          await replacement.sync();
        } finally { await replacement.close(); }
        const current = await entry(file);
        if (!current || current.dev !== before.dev || current.ino !== before.ino ||
          current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs)
          throw new Error("Diagnostic log changed during cleanup");
        await rename(staged, file);
        await syncDirectory(logs);
      } finally { await rm(staged, { force: true }); }
    } finally { await source.close(); }
  }
}

/** Run under the local launcher lock, before Electron starts or after it exits. */
export async function compactProjectBrowserStorage(data: string): Promise<void> {
  const queue = path.join(data, PROJECT_BROWSER_CLEANUP_DIRECTORY);
  if (!(await directory(queue))) return;
  const projects = path.join(data, "projects");
  if (!(await directory(projects))) return;
  const deleted = new Set<string>();
  for (const id of await readdir(queue)) {
    if (!PROJECT_ID.test(id) || !(await entry(path.join(queue, id)))?.isFile()) continue;
    if (!(await entry(path.join(projects, id)))) deleted.add(id);
  }
  if (!deleted.size) return;

  const desktop = path.join(data, "desktop");
  const browser = path.join(desktop, "browser");
  const storage = path.join(browser, "Local Storage");
  if (!(await directory(desktop))) return;
  await pruneDesktopLogs(desktop, deleted);
  const hasBrowser = await directory(browser);
  if (hasBrowser && await entry(path.join(browser, "LocalStorage"))) throw new Error("Unsupported browser storage backend");
  if (hasBrowser && await directory(storage)) {
    const live = path.join(storage, "leveldb");
    const previous = live + ".project-cleanup-previous";
    const snapshot = live + ".project-cleanup-source";
    const staged = live + ".project-cleanup-new";
    if (await databaseDirectory(previous)) {
      if (!(await databaseDirectory(live))) await rename(previous, live);
      else {
        if (!(await entry(path.join(live, "CURRENT")))?.isFile()) throw new Error("Browser storage replacement is incomplete");
        await rm(previous, { recursive: true });
      }
      await syncDirectory(storage);
    }
    for (const leftover of [snapshot, staged]) {
      if (await databaseDirectory(leftover)) await rm(leftover, { recursive: true });
    }
    if (await databaseDirectory(live)) {
      // Work from a copy so LevelDB recovery cannot alter the original store.
      await cp(live, snapshot, { recursive: true, errorOnExist: true, force: false });
      try {
        await rewriteDatabase(snapshot, staged, deleted);
        await syncDirectory(staged);
        await rename(live, previous);
        try { await rename(staged, live); }
        catch (cause) { await rename(previous, live); throw cause; }
        await syncDirectory(storage);
        await rm(previous, { recursive: true });
        await syncDirectory(storage);
      } finally {
        await rm(snapshot, { recursive: true, force: true });
        await rm(staged, { recursive: true, force: true });
      }
    }
  }
  for (const id of deleted) await rm(path.join(queue, id));
}
