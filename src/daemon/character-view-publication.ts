import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { localAgentPath } from "./agent-local-files.js";
import { durablePublicationDirectory, durablePublicationFile, syncPublicationDirectory } from "./isolated-publication-journal.js";
import { assertNoKnownSecretBytes, inspectSafeProjectMedia, readSafeProjectFile } from "./safe-project-file.js";
import {
  findLocalImageRecoverySpace, reserveLocalImageRecoverySpace, validateLocalAnchor,
  type LocalImageRecoveryAnchor, type RecoverySpaceInputs,
} from "./recovery-space.js";

const MiB = 1024 * 1024;
const JOURNAL_LIMIT = 2 * MiB;
const MARKER_LIMIT = 512 * 1024;
const MAX_STAGES = 8;
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const STAGE_KEY = /^[a-zA-Z0-9_-]{1,32}$/;
const STAGED_MARKER = "commit-marker.json";

export interface CharacterViewOperationIdentity {
  operationId: string;
  fingerprint: string;
  action: "plan" | "publish";
  purpose: string;
}

export type CharacterViewPublicationReceipt =
  | { state: "committed"; result: unknown }
  | { state: "failed"; reason: string; effects?: unknown }
  | { state: "unknown"; reason: string; operationId: string };

interface FileEvidence { path: string; sha256: string }
interface CommitEvidence {
  marker: { path: string; before: Buffer | null; after: Buffer };
  files?: readonly FileEvidence[];
  result: unknown;
}
interface StagedImage { path: string; sha256: string; size: number }

export interface CharacterViewPublicationOperation {
  stagePng(key: string, bytes: Buffer): Promise<StagedImage>;
  markEffectsStarted(): Promise<void>;
  prepareCommit(evidence: CommitEvidence): Promise<void>;
  publishMarker(): Promise<void>;
  commit(): Promise<Extract<CharacterViewPublicationReceipt, { state: "committed" }>>;
  settleFailure(reason: string, effects?: unknown): Promise<CharacterViewPublicationReceipt>;
  detach(): void;
}

interface JournalRecord {
  version: 1;
  workspace: string;
  projectId: string;
  identity: CharacterViewOperationIdentity;
  phase: "preparing" | "effects";
  ownerKey: string;
  reservationId?: string;
  staged: { key: string; sha256: string; size: number }[];
  evidence?: {
    markerPath: string;
    before: string | null;
    after: string;
    markerStage?: { device: string; inode: string };
    files: readonly FileEvidence[];
    result: unknown;
  };
  terminal?: Exclude<CharacterViewPublicationReceipt, { state: "unknown" }>;
  cleaned?: true;
}

const tails = new Map<string, Promise<unknown>>();
const liveOperations = new Set<string>();
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isMissing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  tails.set(key, result);
  void result.finally(() => { if (tails.get(key) === result) tails.delete(key); }).catch(() => {});
  return result;
}

function assertIdentity(identity: CharacterViewOperationIdentity): void {
  if (!identity || typeof identity.operationId !== "string" || !identity.operationId || identity.operationId.length > 4096 ||
      !SHA256.test(identity.fingerprint) || (identity.action !== "plan" && identity.action !== "publish") ||
      typeof identity.purpose !== "string" || !identity.purpose || identity.purpose.length > 128)
    throw new Error("Invalid character view operation identity");
}

function privateFile(info: Stats, limit: number): boolean {
  return info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && !(info.mode & 0o177) && info.size <= limit;
}

function unknown(identity: CharacterViewOperationIdentity, reason: string): CharacterViewPublicationReceipt {
  return { state: "unknown", operationId: identity.operationId, reason };
}

/** Hosts serialize business writes separately. This journal never replays a workspace or Canvas write. */
export class CharacterViewPublicationJournal {
  readonly #root: string;

  constructor(private readonly anchor: LocalImageRecoveryAnchor) {
    this.#root = path.join(anchor.storage, "character-publications");
  }

  async begin(identity: CharacterViewOperationIdentity, options: { space?: RecoverySpaceInputs; signal?: AbortSignal } = {}): Promise<
    { state: "started"; operation: CharacterViewPublicationOperation } | CharacterViewPublicationReceipt
  > {
    assertIdentity(identity);
    return serialized(this.#root, async () => {
      options.signal?.throwIfAborted();
      await validateLocalAnchor(this.anchor, true);
      await durablePublicationDirectory(this.#root);
      await this.#checkRoot();
      const file = this.#journalPath(identity.operationId);
      const prior = await this.#read(file);
      if (prior) return this.#recoverMatching(file, prior, identity);
      await this.#assertSettled();

      const record: JournalRecord = {
        version: 1, workspace: this.anchor.workspace, projectId: this.anchor.projectId,
        identity: { ...identity }, phase: "preparing", staged: [], ownerKey: this.#ownerKey(identity),
      };
      // The exact private owner survives interruption between the shared intent write and this receipt update.
      await this.#save(file, record);
      if (options.space) {
        const reservation = await reserveLocalImageRecoverySpace(this.anchor, options.space, {
          ownerKey: record.ownerKey, signal: options.signal,
        });
        record.reservationId = reservation.id;
        await this.#save(file, record);
      }
      liveOperations.add(file);
      return { state: "started", operation: this.#operation(file, record) };
    });
  }

  async recover(identity: CharacterViewOperationIdentity): Promise<CharacterViewPublicationReceipt | { state: "missing" }> {
    assertIdentity(identity);
    return serialized(this.#root, async () => {
      if (!await this.#checkRoot()) return { state: "missing" };
      const file = this.#journalPath(identity.operationId);
      const record = await this.#read(file);
      return record ? this.#recoverMatching(file, record, identity) : { state: "missing" };
    });
  }

  async assertSettled(exceptLiveOperationId?: string): Promise<void> {
    return serialized(this.#root, () => this.#assertSettled(exceptLiveOperationId));
  }

  async #assertSettled(exceptLiveOperationId?: string): Promise<void> {
    if (!await this.#checkRoot()) return;
    const names = new Set(await readdir(this.#root));
    if (names.size > 4000) throw new Error("Character view publication history needs inspection");
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(?:json|stage|tmp)$/.test(name))
        throw new Error("Unknown character view publication entry");
      if (!name.endsWith(".json")) {
        if (name.endsWith(".stage") && !names.has(`${name.slice(0, -6)}.json`))
          throw new Error("Character view staging has no operation receipt");
        if (name.endsWith(".tmp")) await this.#removeTemporary(path.join(this.#root, name));
        continue;
      }
      const file = path.join(this.#root, name);
      const record = await this.#read(file);
      if (!record) throw new Error("Character view publication history changed during inspection");
      if (record.identity.operationId === exceptLiveOperationId && liveOperations.has(file)) continue;
      if (record.cleaned && record.terminal) continue;
      const receipt = await this.#recoverMatching(file, record, record.identity);
      if (receipt.state === "unknown") throw new Error(receipt.reason);
    }
  }

  #journalPath(operationId: string): string { return path.join(this.#root, `${sha256(operationId)}.json`); }
  #ownerKey(identity: CharacterViewOperationIdentity): string {
    return sha256(JSON.stringify([this.anchor.projectId, identity.operationId, identity.action, identity.purpose, identity.fingerprint])).slice(0, 32);
  }

  async #checkRoot(): Promise<boolean> {
    try {
      const info = await lstat(this.#root);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(this.#root) !== this.#root)
        throw new Error("Character view publication storage is not private");
      return true;
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }

  async #read(file: string): Promise<JournalRecord | undefined> {
    try {
      if (!privateFile(await lstat(file), JOURNAL_LIMIT)) throw new Error("Unsafe character view publication receipt");
      const record = JSON.parse((await readSafeProjectFile(this.#root, file, JOURNAL_LIMIT)).toString()) as JournalRecord;
      assertIdentity(record.identity);
      if (record.version !== 1 || record.workspace !== this.anchor.workspace || record.projectId !== this.anchor.projectId ||
          file !== this.#journalPath(record.identity.operationId) || record.ownerKey !== this.#ownerKey(record.identity) ||
          !["preparing", "effects"].includes(record.phase) || !Array.isArray(record.staged) || record.staged.length > MAX_STAGES ||
          record.staged.some(({ key, sha256, size }) => !STAGE_KEY.test(key) || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size < 8 || size > 32 * MiB) ||
          new Set(record.staged.map(item => item.key)).size !== record.staged.length ||
          (record.terminal && record.terminal.state !== "committed" && record.terminal.state !== "failed") ||
          (record.cleaned && !record.terminal)) throw new Error("Invalid character view publication receipt");
      return record;
    } catch (cause) {
      if (isMissing(cause)) return undefined;
      throw cause;
    }
  }

  async #save(file: string, record: JournalRecord): Promise<void> {
    await this.#checkRoot();
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > JOURNAL_LIMIT) throw new Error("Character view publication receipt exceeds its size limit");
    assertNoKnownSecretBytes(bytes);
    const temporary = `${file.slice(0, -5)}.tmp`;
    await this.#removeTemporary(temporary);
    await durablePublicationFile(temporary, bytes);
    await rename(temporary, file);
    await syncPublicationDirectory(this.#root);
  }

  async #removeTemporary(temporary: string): Promise<void> {
    try {
      if (!privateFile(await lstat(temporary), JOURNAL_LIMIT)) throw new Error("Unsafe character view temporary receipt");
      await unlink(temporary);
      await syncPublicationDirectory(this.#root);
    } catch (cause) { if (!isMissing(cause)) throw cause; }
  }

  async #recoverMatching(file: string, record: JournalRecord, identity: CharacterViewOperationIdentity): Promise<CharacterViewPublicationReceipt> {
    if (record.identity.fingerprint !== identity.fingerprint || record.identity.action !== identity.action || record.identity.purpose !== identity.purpose)
      throw new Error("The original character view operation has different input");
    if (liveOperations.has(file)) return unknown(identity, "The original character view operation is still running");
    try {
      if (record.terminal) return await this.#finish(file, record, record.terminal);
      if (record.phase === "preparing") return await this.#finish(file, record, { state: "failed", reason: "Preparation stopped before project changes." });
      if (record.evidence && await this.#commitProved(record)) {
        const marker = await localAgentPath(this.anchor.workspace, record.evidence.markerPath);
        await syncPublicationDirectory(path.dirname(marker));
        return await this.#finish(file, record, { state: "committed", result: record.evidence.result });
      }
      if (record.identity.action === "publish" && record.evidence?.markerStage) {
        const effects = await this.#unpublishedEffects(file, record.evidence);
        if (effects) return await this.#finish(file, record, { state: "failed", reason: "Publication stopped before switching the active marker.", effects });
      }
      return unknown(identity, "Cannot verify the original character view operation from its retained evidence");
    } catch {
      return unknown(identity, "Cannot settle the original character view operation from its retained files");
    }
  }

  #stageDirectory(file: string): string { return `${file.slice(0, -5)}.stage`; }

  async #ensureStageDirectory(file: string): Promise<string> {
    const directory = this.#stageDirectory(file);
    await durablePublicationDirectory(directory);
    const info = await lstat(directory);
    if (info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(directory) !== directory)
      throw new Error("Character view staging directory is not private");
    return directory;
  }

  async #cleanStaged(file: string, record: JournalRecord): Promise<void> {
    const directory = this.#stageDirectory(file);
    let entries: string[];
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(directory) !== directory)
        throw new Error("Unsafe character view staging directory");
      entries = await readdir(directory);
    } catch (cause) { if (isMissing(cause)) return; throw cause; }
    const staged = new Map(record.staged.map(item => [`${item.key}.png`, item]));
    if (record.reservationId && record.evidence) {
      const after = Buffer.from(record.evidence.after, "base64");
      staged.set(STAGED_MARKER, { key: STAGED_MARKER, sha256: sha256(after), size: after.length });
    }
    for (const entry of entries) {
      const intended = staged.get(entry);
      const filename = path.join(directory, entry);
      if (!intended) throw new Error("Character view staging contains unrecognized files");
      const info = await lstat(filename);
      if (!privateFile(info, intended.size) || (info.size === intended.size &&
          (await inspectSafeProjectMedia(directory, filename, intended.size)).sha256 !== intended.sha256))
        throw new Error("Character view staging contains unrecognized files");
    }
    for (const entry of entries) await unlink(path.join(directory, entry));
    await rmdir(directory);
    await syncPublicationDirectory(this.#root);
  }

  async #finish<T extends NonNullable<JournalRecord["terminal"]>>(file: string, record: JournalRecord, terminal: T): Promise<T> {
    if (record.cleaned) return terminal;
    if (!record.terminal) {
      record.terminal = terminal;
      await this.#save(file, record);
    }
    await this.#cleanStaged(file, record);
    const reservation = await findLocalImageRecoverySpace(this.anchor, record.ownerKey);
    if (reservation && record.reservationId && record.reservationId !== reservation.id)
      throw new Error("Character view reservation identity changed");
    await reservation?.release();
    record.cleaned = true;
    await this.#save(file, record);
    return terminal;
  }

  async #readMarker(relative: string): Promise<Buffer | null> {
    const filename = await localAgentPath(this.anchor.workspace, relative, true);
    try { return await readSafeProjectFile(this.anchor.workspace, filename, MARKER_LIMIT); }
    catch (cause) { if (isMissing(cause)) return null; throw cause; }
  }

  async #markerBeforeMatches(evidence: NonNullable<JournalRecord["evidence"]>): Promise<boolean> {
    const current = await this.#readMarker(evidence.markerPath);
    return evidence.before === null ? current === null : !!current?.equals(Buffer.from(evidence.before, "base64"));
  }

  async #hasMarkerIdentity(filename: string, expected: NonNullable<NonNullable<JournalRecord["evidence"]>["markerStage"]>): Promise<boolean> {
    try {
      const info = await lstat(filename, { bigint: true });
      return info.isFile() && info.nlink === 1n && info.dev.toString() === expected.device && info.ino.toString() === expected.inode;
    } catch (cause) { if (isMissing(cause)) return false; throw cause; }
  }

  async #stagedMarkerIntact(file: string, evidence: NonNullable<JournalRecord["evidence"]>): Promise<boolean> {
    const directory = this.#stageDirectory(file);
    const temporary = path.join(directory, STAGED_MARKER);
    if (!evidence.markerStage || !await this.#hasMarkerIdentity(temporary, evidence.markerStage)) return false;
    if (await realpath(directory) !== directory || !privateFile(await lstat(temporary), MARKER_LIMIT)) return false;
    return (await readSafeProjectFile(directory, temporary, MARKER_LIMIT)).equals(Buffer.from(evidence.after, "base64"));
  }

  async #unpublishedEffects(file: string, evidence: NonNullable<JournalRecord["evidence"]>): Promise<{ retainedFiles: FileEvidence[] } | undefined> {
    if (!await this.#markerBeforeMatches(evidence) || !await this.#stagedMarkerIntact(file, evidence)) return;
    const retainedFiles: FileEvidence[] = [];
    for (const proof of evidence.files) {
      const target = await localAgentPath(this.anchor.workspace, proof.path, true);
      try {
        if ((await inspectSafeProjectMedia(this.anchor.workspace, target, 64 * MiB)).sha256 !== proof.sha256) return;
        retainedFiles.push(proof);
      } catch (cause) { if (!isMissing(cause)) throw cause; }
    }
    // The reserved source inode still being staged proves its one-way rename never happened.
    if (await this.#markerBeforeMatches(evidence) && await this.#stagedMarkerIntact(file, evidence)) return { retainedFiles };
  }

  async #filesProved(files: readonly FileEvidence[]): Promise<boolean> {
    for (const proof of files) {
      const target = await localAgentPath(this.anchor.workspace, proof.path);
      if ((await inspectSafeProjectMedia(this.anchor.workspace, target, 64 * MiB)).sha256 !== proof.sha256) return false;
    }
    return true;
  }

  async #commitProved({ evidence, reservationId }: JournalRecord): Promise<boolean> {
    if (!evidence || reservationId && !evidence.markerStage) return false;
    const before = evidence.before;
    const after = Buffer.from(evidence.after, "base64");
    if (after.length === 0 || after.length > MARKER_LIMIT || (before !== null && after.equals(Buffer.from(before, "base64"))) ||
        !Array.isArray(evidence.files) || evidence.files.length > 64) return false;
    if (!(await this.#readMarker(evidence.markerPath))?.equals(after)) return false;
    if (evidence.markerStage && !await this.#hasMarkerIdentity(await localAgentPath(this.anchor.workspace, evidence.markerPath), evidence.markerStage)) return false;
    if (!await this.#filesProved(evidence.files)) return false;
    return !!(await this.#readMarker(evidence.markerPath))?.equals(after);
  }

  #operation(file: string, record: JournalRecord): CharacterViewPublicationOperation {
    const active = <T>(action: () => Promise<T>) => serialized(this.#root, async () => {
      if (!liveOperations.has(file) || record.terminal) throw new Error("The character view operation is no longer active");
      return action();
    });
    return {
      stagePng: (key, bytes) => active(async () => {
        if (record.phase !== "preparing" || !record.reservationId || !STAGE_KEY.test(key) ||
            record.staged.length >= MAX_STAGES || record.staged.some(item => item.key === key) ||
            bytes.length > 32 * MiB || !bytes.subarray(0, 8).equals(PNG_HEADER))
          throw new Error("Invalid staged character PNG or preparation state");
        assertNoKnownSecretBytes(bytes);
        const reservation = await findLocalImageRecoverySpace(this.anchor, record.ownerKey);
        if (!reservation || reservation.id !== record.reservationId ||
            record.staged.reduce((total, item) => total + item.size, bytes.length) > reservation.plan.afterBytes)
          throw new Error("Character view PNGs exceed their original reservation");
        const staged = { key, sha256: sha256(bytes), size: bytes.length };
        record.staged.push(staged);
        await this.#save(file, record);
        const directory = await this.#ensureStageDirectory(file);
        const filename = path.join(directory, `${key}.png`);
        await durablePublicationFile(filename, bytes);
        return { path: filename, sha256: staged.sha256, size: staged.size };
      }),
      markEffectsStarted: () => active(async () => {
        record.phase = "effects";
        await this.#save(file, record);
      }),
      prepareCommit: ({ marker, files = [], result }) => active(async () => {
        if (record.evidence || !marker.after.length || marker.after.length > MARKER_LIMIT ||
            (marker.before?.length ?? 0) > MARKER_LIMIT || marker.before?.equals(marker.after) || files.length > 64)
          throw new Error("Invalid or unchanged character view commit marker");
        assertNoKnownSecretBytes(marker.after);
        if (marker.before) assertNoKnownSecretBytes(marker.before);
        const current = await this.#readMarker(marker.path);
        if (marker.before ? !current?.equals(marker.before) : current !== null)
          throw new Error("Character view commit marker changed before publication");
        for (const proof of files) {
          if (!SHA256.test(proof.sha256)) throw new Error("Invalid character view file evidence");
          await localAgentPath(this.anchor.workspace, proof.path, true);
        }
        record.evidence = {
          markerPath: marker.path, before: marker.before?.toString("base64") ?? null, after: marker.after.toString("base64"),
          files: files.map(({ path, sha256 }) => ({ path, sha256 })), result: structuredClone(result),
        };
        if (record.reservationId) {
          const reservation = await findLocalImageRecoverySpace(this.anchor, record.ownerKey);
          if (!reservation || reservation.id !== record.reservationId || marker.after.length > reservation.plan.manifestBytes)
            throw new Error("Character view commit marker exceeds its original reservation");
          // Recognize an interrupted marker write while public files are still untouched.
          await this.#save(file, record);
          const temporary = path.join(await this.#ensureStageDirectory(file), STAGED_MARKER);
          await durablePublicationFile(temporary, marker.after);
          const stat = await lstat(temporary, { bigint: true });
          record.evidence.markerStage = { device: stat.dev.toString(), inode: stat.ino.toString() };
        }
        record.phase = "effects";
        await this.#save(file, record);
      }),
      publishMarker: () => active(async () => {
        const evidence = record.evidence;
        if (!record.reservationId || !evidence?.markerStage)
          throw new Error("Character view marker publication requires its prepared commit and reservation");
        const after = Buffer.from(evidence.after, "base64");
        const reservation = await findLocalImageRecoverySpace(this.anchor, record.ownerKey);
        if (!reservation || reservation.id !== record.reservationId || after.length > reservation.plan.manifestBytes)
          throw new Error("Character view commit marker exceeds its original reservation");
        if (!await this.#markerBeforeMatches(evidence)) throw new Error("Character view commit marker changed before publication");
        if (!await this.#filesProved(evidence.files)) throw new Error("Character view commit references an unverified file");
        const directory = this.#stageDirectory(file);
        const temporary = path.join(directory, STAGED_MARKER);
        const target = await localAgentPath(this.anchor.workspace, evidence.markerPath, true);
        await durablePublicationDirectory(path.dirname(target), 0o755);
        if (!await this.#stagedMarkerIntact(file, evidence)) throw new Error("The original character view commit marker is not safely staged");
        if (!await this.#markerBeforeMatches(evidence)) throw new Error("Character view commit marker changed before publication");
        await rename(temporary, target);
        await syncPublicationDirectory(path.dirname(target));
        await syncPublicationDirectory(directory);
      }),
      commit: () => active(async () => {
        if (!record.evidence || !await this.#commitProved(record))
          throw new Error("Character view commit is missing its verified publication evidence");
        return this.#finish(file, record, { state: "committed", result: record.evidence.result });
      }),
      settleFailure: (reason, effects) => active(async () => {
        if (record.evidence) {
          if (await this.#commitProved(record))
            return this.#finish(file, record, { state: "committed", result: record.evidence.result });
          if (!await this.#markerBeforeMatches(record.evidence))
            return unknown(record.identity, "The character view commit marker changed after preparation");
          if (record.evidence.markerStage && !await this.#stagedMarkerIntact(file, record.evidence))
            return unknown(record.identity, "The original character view commit marker is no longer safely staged");
        }
        if (record.phase === "effects" && effects === undefined)
          return unknown(record.identity, "Character view operation may have retained project or Canvas effects");
        return this.#finish(file, record, { state: "failed", reason, ...(effects === undefined ? {} : { effects }) });
      }),
      detach: () => { liveOperations.delete(file); },
    };
  }
}
