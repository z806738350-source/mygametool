import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CHARACTER_VIEW_DIRECTIONS, type CharacterViewDirection } from "../shared/character-views.js";
import type { RunToolRequest, ToolJob } from "../shared/contracts.js";
import { CanvasError } from "./canvas-files.js";
import { durablePublicationDirectory, durablePublicationFile, syncPublicationDirectory } from "./isolated-publication-journal.js";
import type { LocalImageRecoveryAnchor } from "./recovery-space.js";
import { assertNoKnownSecretBytes, MAX_SAFE_PROJECT_FILE_BYTES, readSafeProjectFile } from "./safe-project-file.js";

const INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ALIASES = 64;
const identity = /^[a-zA-Z0-9_-]{1,120}$/;
const sha256 = /^[a-f0-9]{64}$/;
const phases = ["prepared", "admitted", "not-submitted", "uncertain", "succeeded"] as const;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Raised before sealCharacterViewNodes can save its binding changes. */
export class CharacterViewSealRejected extends CanvasError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface CharacterViewNodeReservation {
  boardId?: string;
  nodeId: string;
  setId: string;
  designRevision: string;
  direction: CharacterViewDirection;
  viewRevision: string;
  displayHeadToGround?: number;
  planFingerprint: string;
}

export interface CharacterViewNodeSeal {
  boardId: string;
  nodeId: string;
  planFingerprint: string;
}

export interface CharacterViewAttempt {
  recoveryId: string;
  phase: (typeof phases)[number];
  job: ToolJob;
  previousJobs: string[];
  resultSha256?: string;
}

export interface CharacterViewBinding extends CharacterViewNodeReservation {
  boardId: string;
  inputFingerprint?: string;
  nodeFingerprint?: string;
  attempt?: CharacterViewAttempt;
}

function valid(binding: CharacterViewBinding, projectId: string) {
  if (!binding || ![binding.boardId, binding.nodeId, binding.setId, binding.designRevision, binding.viewRevision]
    .every(value => typeof value === "string" && identity.test(value)) ||
    !CHARACTER_VIEW_DIRECTIONS.includes(binding.direction) || !sha256.test(binding.planFingerprint) ||
    (binding.inputFingerprint !== undefined && !sha256.test(binding.inputFingerprint)) ||
    (binding.nodeFingerprint !== undefined && !sha256.test(binding.nodeFingerprint))) return false;
  const attempt = binding.attempt;
  if (!attempt) return true;
  const job = attempt.job;
  return Boolean(
    binding.inputFingerprint && identity.test(attempt.recoveryId) && phases.includes(attempt.phase) &&
    Array.isArray(attempt.previousJobs) && attempt.previousJobs.length <= MAX_ALIASES &&
    attempt.previousJobs.every(id => typeof id === "string" && identity.test(id)) &&
    job && identity.test(job.id) && job.toolId === "generate-image" &&
    ["running", "cancelled", "failed", "succeeded"].includes(job.status) &&
    job.context?.projectId === projectId && job.context.boardId === binding.boardId && job.context.nodeId === binding.nodeId &&
    (attempt.phase !== "succeeded" || job.status === "succeeded" &&
      !!job.run?.files[0]?.assetId && typeof attempt.resultSha256 === "string" && sha256.test(attempt.resultSha256)),
  );
}

export const sameCharacterViewRevision = (left: CharacterViewBinding, right: CharacterViewBinding) =>
  left.setId === right.setId && left.designRevision === right.designRevision &&
  left.direction === right.direction && left.viewRevision === right.viewRevision;

export function characterViewSettingsJson(value: unknown) {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, (entry as Record<string, unknown>)[key]]))
    : entry);
}

export function characterViewFingerprint(settings: unknown) {
  return hash(characterViewSettingsJson(settings));
}

export function matchesCharacterViewFingerprint(settings: unknown, fingerprint: string | undefined) {
  return Boolean(fingerprint && (characterViewFingerprint(settings) === fingerprint || hash(JSON.stringify(settings)) === fingerprint));
}

export function recordCharacterViewJobAlias(attempt: CharacterViewAttempt) {
  if (attempt.previousJobs.length >= MAX_ALIASES)
    throw new CanvasError("The managed direction's recovery history is full. Preserve the original records.", 409);
  attempt.previousJobs.push(attempt.job.id);
}

/** All writes are serialized by the project's existing Canvas lock. */
export class CharacterViewBindings {
  readonly #directory: string;
  readonly #index: string;

  constructor(private readonly anchor: LocalImageRecoveryAnchor) {
    this.#directory = path.join(anchor.storage, "character-view-bindings");
    this.#index = path.join(this.#directory, "bindings.json");
  }

  async #checkRoot(create = false) {
    if (create) await durablePublicationDirectory(this.#directory);
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
        (info.mode & 0o077) || await realpath(this.#directory) !== this.#directory)
      throw new CanvasError("Unsafe managed character view directory", 409);
  }

  async #read(file: string, maximum: number) {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o177))
      throw new CanvasError("Unsafe managed character view record", 409);
    return readSafeProjectFile(this.#directory, file, maximum);
  }

  async #replace(file: string, bytes: Buffer, maximum: number) {
    const temporary = file + ".tmp";
    try {
      await this.#read(temporary, maximum);
      await rm(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await durablePublicationFile(temporary, bytes);
    await rename(temporary, file);
    await syncPublicationDirectory(this.#directory);
  }

  async load(): Promise<CharacterViewBinding[]> {
    let bytes: Buffer;
    try {
      await this.#checkRoot();
      bytes = await this.#read(this.#index, INDEX_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Missing index after data has been written cannot make an old job unmanaged.
        const entries = await readdir(this.#directory).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return [];
        });
        if (!entries.length) return [];
        throw new CanvasError("Incomplete managed character view index; no replacement was submitted", 409);
      }
      throw error;
    }
    const index = JSON.parse(bytes.toString("utf8"));
    if (index?.version !== 1 || index.projectId !== this.anchor.projectId ||
        index.workspace !== this.anchor.workspace || !Array.isArray(index.bindings) ||
        !index.bindings.every((binding: CharacterViewBinding) => valid(binding, this.anchor.projectId)))
      throw new CanvasError("Invalid managed character view index; no replacement was submitted", 409);
    return index.bindings;
  }

  async save(bindings: CharacterViewBinding[]) {
    if (!bindings.every(binding => valid(binding, this.anchor.projectId)))
      throw new CanvasError("Invalid managed character view record", 409);
    const bytes = Buffer.from(JSON.stringify({
      version: 1, workspace: this.anchor.workspace, projectId: this.anchor.projectId, bindings,
    }));
    if (bytes.length > INDEX_BYTES) throw new CanvasError("Managed character view history is full", 409);
    assertNoKnownSecretBytes(bytes);
    await this.#checkRoot(true);
    await this.#replace(this.#index, bytes, INDEX_BYTES);
  }

  async retainInput(binding: CharacterViewBinding, input: RunToolRequest) {
    // Existing bindings keep their original byte-based recovery identity.
    const canonical = characterViewSettingsJson(input);
    const frozen = hash(canonical) === binding.inputFingerprint ? canonical : JSON.stringify(input);
    const bytes = Buffer.from(frozen);
    if (bytes.length > MAX_SAFE_PROJECT_FILE_BYTES || !binding.inputFingerprint || hash(bytes) !== binding.inputFingerprint)
      throw new CanvasError("The original image input cannot be retained within the managed request bound", 409);
    assertNoKnownSecretBytes(bytes);
    await this.#checkRoot();
    const file = path.join(this.#directory, `input-${binding.inputFingerprint}.json`);
    try {
      if (!(await this.#read(file, MAX_SAFE_PROJECT_FILE_BYTES)).equals(bytes))
        throw new CanvasError("The saved character direction input no longer matches its binding", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#replace(file, bytes, MAX_SAFE_PROJECT_FILE_BYTES);
    }
  }

  async originalInput(binding: CharacterViewBinding): Promise<RunToolRequest> {
    await this.#checkRoot();
    const bytes = await this.#read(path.join(this.#directory, `input-${binding.inputFingerprint}.json`), MAX_SAFE_PROJECT_FILE_BYTES);
    if (!binding.inputFingerprint || hash(bytes) !== binding.inputFingerprint)
      throw new CanvasError("The saved character direction input no longer matches its binding", 409);
    return JSON.parse(bytes.toString("utf8"));
  }
}
