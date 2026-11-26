import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PROJECT_BROWSER_CLEANUP_DIRECTORY } from "../shared/project-browser-storage.js";

const PHASES = ["requested", "retiring-volume", "volume-retired", "deleting-host", "removing-project", "complete"] as const;
type Phase = typeof PHASES[number] | "aborted" | "unknown";
interface DeletionRecord { version: 1; projectId: string; phase: Phase; updatedAt: string }
const projectId = (id: string) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);

export class ProjectLifecycleError extends Error {
  readonly statusCode = 409;
  readonly code = "project_lifecycle_pending";
}

export class ProjectExecutionDiscardConflict extends ProjectLifecycleError {
  constructor(readonly generation?: string) {
    super(generation === undefined
      ? "The retained execution copy changed. Start project deletion again."
      : "Confirm discarding unreturned execution changes before deleting this project.");
  }
}

/** Admission closes synchronously; the journal survives a crash between guest and host deletion. */
export class ProjectLifecycle {
  readonly #active = new Set<string>();
  readonly #records = new Map<string, DeletionRecord>();
  constructor(private readonly dataDirectory: string) {}

  deletingHost(id: string): boolean {
    const phase = this.#records.get(id)?.phase;
    return phase === "deleting-host" || phase === "removing-project";
  }

  async scheduleBrowserCleanup(id: string): Promise<void> {
    if (!projectId(id)) throw new ProjectLifecycleError("Invalid project deletion identity.");
    const directory = await this.#directory(true, PROJECT_BROWSER_CLEANUP_DIRECTORY);
    const marker = await open(path.join(directory, id), "wx", 0o600).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if (!marker) return;
    try { await marker.sync(); } finally { await marker.close(); }
    if (process.platform !== "win32") {
      const folder = await open(directory, constants.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    }
  }

  pending(id: string): boolean {
    const phase = this.#records.get(id)?.phase;
    return this.#active.has(id) || !!phase && phase !== "complete" && phase !== "aborted";
  }
  assertAvailable(id: string): void {
    if (this.#active.has(id) || this.pending(id)) throw new ProjectLifecycleError(
      "Project deletion is pending. Retry deletion or recover the retained execution workspace before continuing.",
    );
  }
  async #directory(create: boolean, name = "project-lifecycle"): Promise<string> {
    const directory = path.join(await realpath(this.dataDirectory), name);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      throw new ProjectLifecycleError("Project deletion records require review.");
    return directory;
  }
  async load(): Promise<void> {
    let directory: string;
    try { directory = await this.#directory(false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const files = await readdir(directory);
    if (files.length > 4096) throw new ProjectLifecycleError("Project deletion record budget requires review.");
    for (const name of files) {
      const temporary = /^\.([^.]+)\.([^.]+)\.tmp$/.exec(name);
      if (temporary && projectId(temporary[1]!) && projectId(temporary[2]!)) {
        const file = path.join(directory, name);
        const info = await lstat(file);
        if (info.isFile() && info.nlink === 1) await rm(file, { force: true });
        continue;
      }
      if (!name.endsWith(".json") || !projectId(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      let record: DeletionRecord = { version: 1, projectId: id, phase: "unknown", updatedAt: "" };
      let handle;
      try {
        handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error("Invalid deletion record");
        const value = JSON.parse(await handle.readFile("utf8")) as DeletionRecord;
        if (value.version === 1 && value.projectId === id && [...PHASES, "aborted"].includes(value.phase as typeof PHASES[number])) record = value;
      } catch { /* A damaged record blocks this project, without deleting anything. */ }
      finally { await handle?.close(); }
      if (record.phase === "complete" || record.phase === "aborted" ||
        ((record.phase === "removing-project" || record.phase === "deleting-host") &&
          await this.#finishProjectRemoval(id, record.phase === "removing-project"))) {
        await this.#removeRecord(id);
        continue;
      }
      this.#records.set(id, record);
    }
  }
  async #finishProjectRemoval(id: string, resume: boolean): Promise<boolean> {
    const projects = path.join(await realpath(this.dataDirectory), "projects");
    const absent = (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    };
    try {
      const root = await lstat(projects).catch(absent);
      if (!root) return true;
      if (!root.isDirectory() || (process.platform !== "win32" && root.uid !== process.getuid?.())) return false;
      const target = path.join(projects, id);
      const info = await lstat(target).catch(absent);
      if (!info) return true;
      if (!resume || !info.isDirectory() || (process.platform !== "win32" && info.uid !== root.uid)) return false;
      await rm(target, { recursive: true, force: true });
      if (process.platform !== "win32") {
        const folder = await open(projects, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await folder.sync(); } finally { await folder.close(); }
      }
      return true;
    } catch {
      // Preserve the final journal so the next startup can retry.
      return false;
    }
  }
  async #write(id: string, phase: Phase): Promise<void> {
    if (!projectId(id)) throw new ProjectLifecycleError("Invalid project deletion identity.");
    const directory = await this.#directory(true), target = path.join(directory, id + ".json");
    const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
    const record: DeletionRecord = { version: 1, projectId: id, phase, updatedAt: new Date().toISOString() };
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    if (process.platform !== "win32") {
      const folder = await open(directory, constants.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    }
    this.#records.set(id, record);
  }
  async delete<T>(id: string, operation: (stage: (phase: typeof PHASES[number]) => Promise<void>) => Promise<T>): Promise<T> {
    if (this.#active.has(id)) throw new ProjectLifecycleError("Project deletion is already running.");
    this.#active.add(id);
    let phase = this.#records.get(id)?.phase ?? "requested";
    try {
      if (phase === "unknown") throw new ProjectLifecycleError("An interrupted project deletion requires review.");
      if (phase === "aborted" || phase === "complete") phase = "requested";
      await this.#write(id, phase);
      const result = await operation(async (next) => {
        if (PHASES.indexOf(next) < PHASES.indexOf(phase as typeof PHASES[number])) return;
        await this.#write(id, next); phase = next;
      });
      await this.#write(id, "complete");
      await this.#removeRecord(id);
      return result;
    } catch (error) {
      // Before requesting retirement, the project and its guest data are unchanged.
      if (phase === "requested") await this.#write(id, "aborted");
      throw error;
    } finally { this.#active.delete(id); }
  }
  async #removeRecord(id: string): Promise<void> {
    const directory = await this.#directory(false);
    await rm(path.join(directory, id + ".json"), { force: true });
    if (process.platform !== "win32") {
      const folder = await open(directory, constants.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    }
    this.#records.delete(id);
  }
  async recovered(id: string): Promise<void> {
    if (this.#active.has(id)) throw new ProjectLifecycleError("Project deletion is still running.");
    this.#assertRecoveryPhase(id);
    if (this.#records.has(id)) await this.#write(id, "aborted");
  }
  #assertRecoveryPhase(id: string): void {
    const phase = this.#records.get(id)?.phase;
    if (phase && !["requested", "retiring-volume", "aborted", "complete"].includes(phase))
      throw new ProjectLifecycleError("Host project deletion has already begun; review its recovery record.");
  }
  async recover<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#active.has(id)) throw new ProjectLifecycleError("Another project lifecycle operation is still running.");
    this.#assertRecoveryPhase(id);
    this.#active.add(id);
    try {
      const result = await operation();
      if (this.#records.has(id)) await this.#write(id, "aborted");
      return result;
    } finally { this.#active.delete(id); }
  }

  /** Hold deletion admission during inspection without changing a pending deletion record. */
  async inspectRecovery<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#active.has(id)) throw new ProjectLifecycleError("Another project lifecycle operation is still running.");
    this.#assertRecoveryPhase(id);
    this.#active.add(id);
    try { return await operation(); }
    finally { this.#active.delete(id); }
  }
}
