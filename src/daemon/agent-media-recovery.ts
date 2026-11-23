import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";

export interface AgentMediaCall {
  scope: string;
  callId: string;
  projectId?: string;
}
export interface ProjectMediaRecord { recoveryId: string; runIds: string[]; scopes: string[] }
interface Receipt {
  callId: string;
  runId?: string;
  canvasJobId?: string;
  missingOriginalId?: true;
}
export type ConfirmPaidMedia = (callIds: readonly string[]) => Promise<boolean>;

export class MediaAlreadyDelivered extends Error {
  constructor(readonly callId: string) { super("This media call already completed. Use the existing project asset; no new generation was sent."); }
}

// Provider journals identify a single call. A model can change the prompt and call ID after
// a failed download. Keep unresolved calls outside the workspace until delivered or reviewed.
export class AgentMediaRecovery {
  private readonly active = new Set<string>();
  private readonly creating = new Set<string>();
  private readonly runReceipts = new Map<string, string>();
  private readonly projectWrites = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  /** Keep ownership beyond the bounded job history, including failed requests. */
  async trackProject(projectId: string, recoveryId: string, update: { runId?: string; scope?: string } = {}): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId) || !/^[a-zA-Z0-9_-]{1,120}$/.test(recoveryId) ||
      update.runId !== undefined && !validUuid(update.runId) || update.scope !== undefined && !/^[a-f0-9]{64}$/.test(update.scope)) throw new Error("Invalid project media ownership");
    const directory = path.join(this.root, "projects", projectId), file = path.join(directory, recoveryId + ".json");
    const pending = (this.projectWrites.get(file) ?? Promise.resolve()).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const folder of [this.root, path.join(this.root, "projects"), directory]) if (!(await lstat(folder)).isDirectory()) throw new Error("Invalid project media ownership directory");
      const previous = await this.projectRecord(file, recoveryId);
      const record = { recoveryId, runIds: [...new Set([...previous.runIds, ...(update.runId ? [update.runId] : [])])], scopes: [...new Set([...previous.scopes, ...(update.scope ? [update.scope] : [])])] };
      const temporary = file + "." + randomUUID() + ".tmp";
      try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    });
    this.projectWrites.set(file, pending);
    try { await pending; } finally { if (this.projectWrites.get(file) === pending) this.projectWrites.delete(file); }
  }

  private async projectRecord(file: string, recoveryId: string): Promise<ProjectMediaRecord> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("Invalid project media ownership");
      const value = JSON.parse(await handle.readFile("utf8")) as ProjectMediaRecord;
      if (value.recoveryId !== recoveryId || !Array.isArray(value.runIds) || value.runIds.some(id => !validUuid(id)) ||
        !Array.isArray(value.scopes) || value.scopes.some(scope => !/^[a-f0-9]{64}$/.test(scope))) throw new Error("Invalid project media ownership");
      return value;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { recoveryId, runIds: [], scopes: [] }; throw cause; }
    finally { await handle?.close(); }
  }

  async projectRecords(projectId: string): Promise<ProjectMediaRecord[]> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) throw new Error("Invalid project media ownership");
    const directory = path.join(this.root, "projects", projectId);
    await Promise.all([...this.projectWrites].filter(([file]) => path.dirname(file) === directory).map(([, pending]) => pending));
    const names = await ordinaryNames(directory);
    return Promise.all(names.filter(name => /^[a-zA-Z0-9_-]{1,120}\.json$/.test(name)).map(name => this.projectRecord(path.join(directory, name), name.slice(0, -5))));
  }

  async otherProjectRecords(projectId: string): Promise<ProjectMediaRecord[]> {
    const names = await ordinaryNames(path.join(this.root, "projects"));
    return (await Promise.all(names.filter(name => name !== projectId && /^[a-zA-Z0-9_-]{1,120}$/.test(name)).map(name => this.projectRecords(name)))).flat();
  }

  async scopeRecords(scope: string): Promise<ProjectMediaRecord[]> {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid media recovery scope");
    const directory = path.join(this.root, scope), records: ProjectMediaRecord[] = [];
    for (const child of ["", "completed", "canvas-observations"]) {
      const folder = path.join(directory, child);
      const names = await ordinaryNames(folder);
      for (const name of names) {
        const recoveryId = child ? name : name.replace(/\.(json|reviewed)$/, "");
        if (!/^[a-f0-9]{64}$/.test(recoveryId)) continue;
        const receipt = await this.read(path.join(folder, name));
        records.push({ recoveryId, runIds: receipt.runId ? [receipt.runId] : [], scopes: [scope] });
      }
    }
    return records;
  }

  assertScopesIdle(scopes: readonly string[]): void {
    if (scopes.some(scope => !/^[a-f0-9]{64}$/.test(scope))) throw new Error("Invalid media recovery scope");
    const folders = scopes.map(scope => path.join(this.root, scope));
    if ([...this.active].some(file => folders.includes(path.dirname(file)))) throw new Error("Project media is still running");
  }

  async removeProject(projectId: string, scopes: readonly string[]): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) throw new Error("Invalid project media ownership");
    this.assertScopesIdle(scopes);
    const folders = scopes.map(scope => path.join(this.root, scope));
    for (const [runId, receipt] of this.runReceipts) if (folders.includes(path.dirname(receipt))) this.runReceipts.delete(runId);
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
    await rm(path.join(this.root, "projects", projectId), { recursive: true, force: true });
  }

  private async directory(call: AgentMediaCall, recoveryId: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(call.scope) || !/^[a-f0-9]{64}$/.test(recoveryId) || !validCallId(call.callId)) throw new Error("Invalid media recovery identity");
    if (call.projectId) await this.trackProject(call.projectId, recoveryId, { scope: call.scope });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("Invalid media recovery directory");
    const directory = path.join(this.root, call.scope);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid media recovery directory");
    const completed = path.join(directory, "completed");
    await mkdir(completed, { recursive: true, mode: 0o700 });
    if (!(await lstat(completed)).isDirectory()) throw new Error("Invalid completed media directory");
    return directory;
  }

  private async isCompleted(directory: string, recoveryId: string): Promise<boolean> {
    try { await lstat(path.join(directory, "completed", recoveryId)); return true; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
  }

  /** Move the small receipt out of the pending set while remembering a replayed call ID. */
  private async complete(file: string): Promise<void> {
    const directory = path.dirname(file), recoveryId = path.parse(file).name;
    try { await rename(file, path.join(directory, "completed", recoveryId)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || !await this.isCompleted(directory, recoveryId)) throw cause; }
  }

  async adopt(call: AgentMediaCall, recoveryId: string, missingOriginalId = false): Promise<void> {
    const directory = await this.directory(call, recoveryId);
    if (await this.isCompleted(directory, recoveryId) || (await readdir(directory)).includes(recoveryId + ".reviewed")) return;
    try { await writeFile(path.join(directory, recoveryId + ".json"), JSON.stringify({ callId: call.callId, ...(missingOriginalId ? { missingOriginalId: true } : {}) }), { flag: "wx", mode: 0o600 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  }

  /** Discard only a legacy, inferred receipt for a call proven to have stopped in local validation. */
  async dismissRejectedPlaceholder(call: AgentMediaCall, recoveryId: string): Promise<void> {
    const file = path.join(await this.directory(call, recoveryId), recoveryId + ".json");
    try {
      const receipt = await this.read(file);
      if (receipt.callId === call.callId && receipt.missingOriginalId === true && !receipt.runId && !receipt.canvasJobId && !this.active.has(file)) {
        await rm(file, { force: true });
      }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }

  async canvasCall(scope: string, jobId: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{64}$/.test(scope) || !validUuid(jobId)) return undefined;
    const directory = path.join(this.root, scope);
    try {
      if (!(await lstat(this.root)).isDirectory() || !(await lstat(directory)).isDirectory()) throw new Error("Invalid media recovery directory");
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const entry = await this.read(path.join(directory, name));
        if (entry.canvasJobId === jobId) return entry.callId;
      }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    return undefined;
  }

  async canvasJob(call: AgentMediaCall, recoveryId: string): Promise<string | undefined> {
    const directory = await this.directory(call, recoveryId);
    for (const file of [path.join(directory, recoveryId + ".json"), path.join(directory, recoveryId + ".reviewed"), path.join(directory, "completed", recoveryId), path.join(directory, "canvas-observations", recoveryId)]) {
      try {
        const receipt = await this.read(file);
        if (receipt.callId !== call.callId) throw new Error("Media recovery identity mismatch");
        if (receipt.canvasJobId) return receipt.canvasJobId;
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
  }

  /** Bind a recovery observer to an exact existing job without acknowledging a paid request. */
  async observeCanvas(call: AgentMediaCall, recoveryId: string, jobId: string): Promise<void> {
    if (!validUuid(jobId)) throw new Error("Invalid original Canvas job ID");
    const directory = path.join(await this.directory(call, recoveryId), "canvas-observations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid Canvas observation directory");
    const file = path.join(directory, recoveryId);
    try { await writeFile(file, JSON.stringify({ callId: call.callId, canvasJobId: jobId }), { flag: "wx", mode: 0o600 }); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const saved = await this.read(file);
      if (saved.callId !== call.callId || saved.canvasJobId !== jobId) throw new Error("The original Canvas observation cannot be rebound");
    }
  }

  private async read(file: string): Promise<Receipt> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error("Invalid media recovery record");
      const value = JSON.parse(await handle.readFile("utf8")) as Receipt;
      if (!validCallId(value.callId) || value.runId !== undefined && !validUuid(value.runId)
        || value.canvasJobId !== undefined && !validUuid(value.canvasJobId)) throw new Error("Invalid media recovery record");
      return value;
    } finally { await handle.close(); }
  }

  async use<T>(call: AgentMediaCall, recoveryId: string, recovering: boolean,
    confirm: ConfirmPaidMedia | undefined,
    operation: (receipt: Receipt, save: (update: Partial<Receipt>) => Promise<void>) => Promise<T>,
    dismissOnError: (cause: unknown) => boolean | Promise<boolean> = () => false,
    additionalPaidRequest?: string,
    beforeNewSubmission?: () => Promise<void>,
  ): Promise<T> {
    const directory = await this.directory(call, recoveryId);
    const file = path.join(directory, recoveryId + ".json");
    if (this.active.has(file)) throw new Error("This media request is already running");
    this.active.add(file);
    try {
      if (await this.isCompleted(directory, recoveryId)) throw new MediaAlreadyDelivered(call.callId);
      const entries = await readdir(directory);
      const acknowledged = entries.includes(recoveryId + ".reviewed");
      const existing = entries.includes(recoveryId + ".json") || acknowledged;
      const target = acknowledged ? path.join(directory, recoveryId + ".reviewed") : file;
      const approved = new Map<string, Receipt>();
      if (!recovering) {
        if (existing) throw new Error(`This call was already attempted. Recover the original call ${JSON.stringify(call.callId)}. No new generation was sent.`);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          const blocked = path.join(directory, entry);
          if (this.creating.has(blocked)) continue;
          let previous;
          try { previous = await this.read(blocked); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
          approved.set(blocked, previous);
        }
        const priorIds = new Set([...approved.values()].map((previous) => previous.callId));
        if (additionalPaidRequest) priorIds.add(additionalPaidRequest);
        if (priorIds.size && !await confirm?.([...priorIds])) {
          const [previous] = approved.values();
          const action = previous?.missingOriginalId ? "Find the original request in the conversation or node history before recovering it"
            : previous?.canvasJobId ? `Use recover_canvas_media with the saved board, node and recoverJobId ${JSON.stringify(previous.canvasJobId)}`
              : previous ? `Use recover_media with the original tool and recoverCallId ${JSON.stringify(previous.callId)}` : "Check the original Canvas job before authorizing a replacement";
          throw new Error(`A previous media request may already have been billed. ${action}. No new generation was sent.`);
        }
        // While the user reviews artwork, the in-memory call lock prevents reentry.
        // A crash here must not leave a durable claim that a paid task was attempted.
        await beforeNewSubmission?.();
        if (approved.size || beforeNewSubmission) {
          const stillPending = new Set(await readdir(directory));
          if ([...approved.keys()].some((prior) => !stillPending.has(path.basename(prior)) || this.active.has(prior))) throw new Error("The previous media request changed during confirmation. Check the existing result before starting another generation.");
          if (beforeNewSubmission && [...stillPending].some(name => name.endsWith(".json") && !this.creating.has(path.join(directory, name)) && !approved.has(path.join(directory, name))))
            throw new Error("A new unresolved media request appeared during review. Check its outcome before starting another generation.");
        }
      }
      const receipt: Receipt = existing ? await this.read(target) : { callId: call.callId };
      if (receipt.callId !== call.callId) throw new Error("Media recovery identity mismatch");
      if (!existing) {
        if (!recovering) this.creating.add(file);
        await writeFile(target, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
      }
      const save = async (update: Partial<Receipt>) => {
        Object.assign(receipt, update);
        const temporary = target + "." + randomUUID() + ".tmp";
        try {
          await writeFile(temporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
          await rename(temporary, target);
        } finally { await rm(temporary, { force: true }); }
      };
      try {
        const result = await operation(receipt, save);
        // An unused or cancelled approval must not release the earlier receipt.
        for (const prior of approved.keys()) {
          try { await rename(prior, prior.slice(0, -5) + ".reviewed"); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
        }
        if (receipt.runId) this.runReceipts.set(receipt.runId, target);
        else await this.complete(target);
        return result;
      } catch (cause) {
        if (!recovering && !existing && !receipt.runId && await dismissOnError(cause)) await rm(target, { force: true });
        else if (!recovering && cause instanceof Error) {
          cause.message += receipt.canvasJobId ? ` Use recover_canvas_media with the saved board, node and recoverJobId ${JSON.stringify(receipt.canvasJobId)}; do not resubmit.` : ` Use recover_media with the original tool and recoverCallId ${JSON.stringify(call.callId)}; do not resubmit.`;
        }
        throw cause;
      }
    } finally { this.creating.delete(file); this.active.delete(file); }
  }

  async delivered(runId: string): Promise<void> {
    const target = this.runReceipts.get(runId);
    if (target) {
      await this.complete(target);
      this.runReceipts.delete(runId);
    }
  }
}

async function ordinaryNames(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid media recovery directory");
    return await readdir(directory);
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
}

function validCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) && !containsKnownSensitiveValue(value);
}
function validUuid(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
