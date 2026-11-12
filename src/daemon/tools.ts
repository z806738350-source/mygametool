import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MAX_REFERENCE_IMAGES,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  TOOL_IDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ModelRef,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type PromptImage,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
  type VideoRequestDiagnostic,
  type AudioRequestDiagnostic,
  type ImageSize,
  type RunImageToolRequest,
  type Run3DToolRequest,
  type RunAnimate3DToolRequest,
  type RunVideoToolRequest,
  type RunToolRequest,
  type ToolId,
  type ToolJob,
  type ToolJobContext,
  type ToolRun,
  type ToolRunFile,
  type GenerationProvenance,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";
import { isMeshyModelReference, MESHY_DISABLED_MESSAGE } from "../shared/disabled-media-providers.js";
import { sniffImageType } from "./image-format.js";
import { decodedReferenceIdentity } from "./image-working-assets.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DAnimationAction, type Model3DGenerator } from "./model3d.js";
import { hasAttempted3DTask, hasSaved3DTask, model3DJournal, waitFor3DTasks } from "./model3d-journal.js";
import { hasAttemptedVideoTask, hasSavedVideoTask, videoTaskJournal, waitForVideoTasks } from "./video-task-journal.js";
import { hasSavedImageResult, hasSavedImageSlot, imageRequestJournal, waitForImageRequests } from "./image-request-journal.js";
import { inspectModel3D } from "./model3d-inspect.js";
import { FBX_MEDIA_TYPE, createFbxPreview } from "./fbx-preview.js";
import type { Model3DExecution } from "./model3d.js";
import { MAX_ANIMATION_ACTIONS, mediaGenerationNeedsConfirmation, resolveModel3D } from "../shared/generation-config.js";
import { model3DOptionFields, remeshPolycount, requiresModelTurnaround } from "../shared/model3d-operations.js";
import { VideoGenerationError, type VideoGenerator, type VideoReferenceAsset, type VideoExecution } from "./video-generation.js";
import { normalizeGenerationProvenance, publicGenerationParameters, type AssetLibrary } from "./asset-library.js";
import { AudioGenerationError, type AudioGenerator } from "./audio-generation.js";
import { AgentMediaRecovery, type AgentMediaCall, type ConfirmPaidMedia } from "./agent-media-recovery.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { validVideoReferencePreparation, type VideoReferencePreparation } from "../shared/video-reference-preparation.js";
import { AUDIO_REFERENCE_MAX_BYTES, inspectAudioReference } from "../shared/audio-reference.js";
import { inheritToolPreflightFailure, toolPreflightError } from "./agent-tool-errors.js";
import type {
  AudioGenerationRequest,
  RunMusicToolRequest,
  RunSoundEffectToolRequest,
  RunSpeechToolRequest,
} from "../shared/audio.js";

const VIDEO_DEFAULT_DURATION = 6;
const HISTORY_LIMIT = 20;

/** Inspect strings in place, without duplicating inline images into one large JSON string. */
export function assertSafeGenerationInput(input: unknown, allowSensitiveValue?: (path: readonly string[]) => boolean): void {
  let bytes = 0, entries = 0;
  const seen = new WeakSet<object>();
  const path: string[] = [];
  const string = (value: string, allowSensitive = false): void => {
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > 256 * 1024 * 1024) throw new ToolRunError("Generation input exceeds the secure inspection limit", 400);
    if (!allowSensitive && containsKnownSensitiveValue(value)) throw new ToolRunError("Generation input contains protected credential data", 400);
  };
  const visit = (value: unknown, depth: number): void => {
    if (++entries > 20_000 || depth > 16) throw new ToolRunError("Generation input exceeds the secure inspection limit", 400);
    if (typeof value === "string") return string(value, allowSensitiveValue?.(path));
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value !== "object" || seen.has(value)) throw new ToolRunError("Generation input must contain ordinary JSON data", 400);
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      string(key);
      path.push(key);
      visit(item, depth + 1);
      path.pop();
    }
  };
  visit(input, 0);
}

function assertAvailableMediaReference(input: RunToolRequest): void {
  if (isMeshyModelReference("model" in input ? input.model : undefined) || isMeshyModelReference("imageModel" in input ? input.imageModel : undefined)) throw new ToolRunError(MESHY_DISABLED_MESSAGE, 410, undefined, undefined, undefined, true);
}

interface ToolJobRecord extends ToolJob {
  recoveryId: string;
  input?: RunToolRequest;
  metadata: ToolJobMetadata;
  controller: AbortController;
  prepared: boolean;
}

interface StoredToolRun extends ToolRun {
  recoveryId?: string;
  batchRecoveryId?: string;
  version: 1;
  canvasContext?: ToolJobContext;
  preview?: { fileName: string; mediaType: "image/png" | "image/jpeg" };
}

interface ToolJobMetadata {
  title?: string;
  context?: ToolJobContext;
  confirmedJobId?: string;
}

export class ToolRunError extends Error {
  constructor(message: string, readonly statusCode: number, readonly submissionOutcome?: "unknown", readonly videoDiagnostic?: VideoRequestDiagnostic, readonly audioDiagnostic?: AudioRequestDiagnostic, readonly notSubmitted?: boolean) {
    super(message);
  }
}

function requiresNewJobConfirmation(job: ToolJob): boolean {
  return Boolean(job.run && (job.status === "failed" || job.status === "cancelled")) || mediaGenerationNeedsConfirmation(job);
}

class PartialImageRunError extends ToolRunError {
  constructor(readonly run: ToolRun, outputs: number) {
    super(`Retained ${run.files.length} of ${outputs} requested images in run ${run.id}. Recover to retrieve any other saved provider results. Missing images will not be generated again.`, 502, "unknown");
  }
}

export class ToolRunner {
  readonly agentMedia: AgentMediaRecovery;
  readonly #runsDirectory: string;
  readonly #jobs = new Map<string, ToolJobRecord>();
  #jobWrites = Promise.resolve();
  #closed = false;
  #log?: GenerationLogger;
  #projectAdmission?: (projectId: string) => void;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #directRuns = new Map<string, number>();

  constructor(
    private readonly dataDirectory: string,
    private readonly imageGenerator: ImageGenerator,
    private readonly model3DGenerator?: Model3DGenerator,
    private readonly videoGenerator?: VideoGenerator,
    private readonly assetLibrary?: AssetLibrary,
    private readonly resolveInput?: (toolId: string, input: RunToolRequest, projectId?: string) => Promise<RunToolRequest>,
    private readonly audioGenerator?: AudioGenerator,
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
    this.agentMedia = new AgentMediaRecovery(path.join(dataDirectory, "tools", "agent-media"));
  }

  /** Where finished generations are logged; the daemon passes its logger. */
  setLogger(log: GenerationLogger): void {
    this.#log = log;
  }

  setProjectAdmission(check: (projectId: string) => void): void { this.#projectAdmission = check; }
  isProjectBusy(projectId: string): boolean {
    return !!this.#directRuns.get(projectId) || [...this.#pending.keys()].some((id) => this.#jobs.get(id)?.context?.projectId === projectId);
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
    try {
      const jobs: ToolJobRecord[] = JSON.parse(await readFile(path.join(this.#runsDirectory, "../jobs.json"), "utf8"));
      for (const job of jobs) this.#jobs.set(job.id, { ...job, videoSubmission: ["not-submitted", "attempted"].includes(job.videoSubmission ?? "") ? job.videoSubmission : undefined, videoReferencePreparation: validVideoReferencePreparation(job.videoReferencePreparation) ? job.videoReferencePreparation : undefined, controller: new AbortController(),
        ...(job.status === "running" ? { status: "cancelled", error: "Generation interrupted. Resume a saved task; never automatically submit an unknown request again.",
          ...(!["image-to-3d", "animate-3d", "generate-video"].includes(job.toolId) ? { submissionOutcome: "unknown" as const } : {}) } : {}) });
      for (const job of this.#jobs.values()) {
        if ((job.status === "failed" || job.status === "cancelled") && await this.mediaWasAttempted(job.toolId, job.recoveryId ?? job.id, (job.input as RunImageToolRequest | undefined)?.outputs)) job.submissionOutcome = "unknown";
      }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  #saveJobs(): Promise<void> {
    this.#jobWrites = this.#jobWrites.catch(() => {}).then(async () => {
      const file = path.join(this.#runsDirectory, "../jobs.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify([...this.#jobs.values()].map(({ controller: _, ...job }) => job)), { mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return this.#jobWrites;
  }
  async #saveJobsSafely(): Promise<void> {
    await this.#saveJobs().catch((cause) => console.error("Could not save generation history", cause));
  }

  start(toolId: string, input: RunToolRequest, metadata: ToolJobMetadata = {}, prepared = false, recoveryId: string = randomUUID(), imageRecoveryOnly = false, videoRecoveryOnly = false, model3DRecoveryOnly = false, previousImageRun?: ToolRun): ToolJob {
    if (this.#closed) throw new ToolRunError("Generation is shutting down", 503);
    if (metadata.context?.projectId) this.#projectAdmission?.(metadata.context.projectId);
    if (!isToolId(toolId)) throw new ToolRunError("Tool not found", 404);
    assertSafeGenerationInput(input);
    assertAvailableMediaReference(input);
    assertSafeGenerationInput(metadata);
    assertSafeGenerationInput(recoveryId);
    const context = metadata.context;
    const sameNode = (job: ToolJob) => Boolean(context && job.context?.projectId === context.projectId && job.context?.nodeId === context.nodeId && job.context?.boardId === context.boardId);
    const nodeJobs = context ? [...this.#jobs.values()].filter(sameNode) : [];
    if (nodeJobs.some((job) => job.status === "cancelled" && this.#pending.has(job.id))) throw new ToolRunError("Wait for the cancelled generation to finish recording its result.", 409);
    const running = nodeJobs.find((job) => job.status === "running");
    if (running) {
      if (running.toolId === toolId && JSON.stringify(running.input) === JSON.stringify(input)) return publicJob(running);
      throw new ToolRunError("This node already has a generation in progress", 409);
    }
    if (metadata.context && !imageRecoveryOnly && !videoRecoveryOnly && !model3DRecoveryOnly) {
      const previous = nodeJobs.findLast((job) => job.toolId === toolId);
      if (metadata.confirmedJobId && metadata.confirmedJobId !== previous?.id) throw new ToolRunError("The confirmation is out of date. Refresh the previous job.", 409);
      if (previous && requiresNewJobConfirmation(previous) && metadata.confirmedJobId !== previous.id) throw new ToolRunError("The previous request may have been billed. Recover the previous job or explicitly confirm a new generation.", 409);
    }
    const id = randomUUID();
    const controller = new AbortController();
    const job: ToolJobRecord = {
      ...(toolId === "generate-video" ? { videoSubmission: videoRecoveryOnly ? "attempted" as const : "not-submitted" as const } : {}),
      id,
      recoveryId,
      imageRecoveryOnly,
      videoRecoveryOnly,
      model3DRecoveryOnly,
      toolId,
      createdAt: new Date().toISOString(),
      status: "running",
      title: promptTitle("prompt" in input ? input.prompt : "text" in input ? input.text : undefined) ?? metadata.title ?? toolName(toolId),
      ...(metadata.context ? { context: metadata.context } : {}),
      input: structuredClone(input),
      ...(previousImageRun ? { run: previousImageRun } : {}),
      prepared,
      metadata: { title: metadata.title, context: metadata.context },
      controller,
    };
    this.#jobs.set(id, job);
    const pending = this.#execute(job);
    this.#pending.set(id, pending);
    void pending.finally(() => this.#pending.delete(id)).catch(() => {});
    return publicJob(job);
  }

  jobs(): ToolJob[] {
    return [...this.#jobs.values()]
      .reverse()
      .map(publicJob);
  }

  hasSavedImageResult(recoveryId: string, outputs = 1): Promise<boolean> {
    return hasSavedImageResult(path.join(this.#runsDirectory, "../image-requests"), recoveryId, outputs);
  }

  hasSavedVideoTask(recoveryId: string): Promise<boolean> {
    return hasSavedVideoTask(path.join(this.#runsDirectory, "../video-tasks"), recoveryId);
  }

  hasSavedModel3DTask(recoveryId: string): Promise<boolean> {
    return hasSaved3DTask(path.join(this.#runsDirectory, "../model3d-tasks"), recoveryId);
  }

  async mediaWasAttempted(toolId: string, recoveryId: string, outputs = 1): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(recoveryId)) return true;
    const folder = path.dirname(this.#runsDirectory);
    if (toolId === "image-to-3d" || toolId === "animate-3d") return hasAttempted3DTask(path.join(folder, "model3d-tasks"), recoveryId);
    if (toolId === "generate-video") return hasAttemptedVideoTask(path.join(folder, "video-tasks"), recoveryId);
    if (toolId !== "generate-image") {
      let marker: FileHandle | undefined;
      try {
        marker = await open(path.join(folder, "audio-attempts", recoveryId + ".json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const info = await marker.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 256) return true;
        return await marker.readFile("utf8") !== JSON.stringify({ toolId, attempted: true, rejected: true });
      } catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ENOENT"; }
      finally { await marker?.close(); }
    }
    const files = Array.from({ length: isImageOutputCount(outputs) ? outputs : 1 }, (_, i) => path.join(folder, "image-requests", `${recoveryId}-${i}.json`));
    for (const file of files) {
      try { await stat(file); return true; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    }
    return false;
  }

  cancelJob(jobId: string): ToolJob {
    const job = this.#jobs.get(jobId);
    if (!job) throw new ToolRunError("Generation job not found", 404);
    if (job.status === "running") {
      job.status = "cancelled";
      job.error = "Generation cancelled";
      if (["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId)) job.submissionOutcome = "unknown";
      job.controller.abort();
      void this.#saveJobsSafely();
    }
    return publicJob(job);
  }

  async retryJob(jobId: string): Promise<ToolJob> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new ToolRunError("Generation job not found", 404);
    if (job.status !== "failed" && job.status !== "cancelled") throw new ToolRunError("Only failed or cancelled jobs can be retried", 409);
    if (!job.input) throw new ToolRunError("Generation job can no longer be retried", 409);
    if (job.status === "cancelled" && job.toolId === "generate-image" && "outputs" in job.input && (job.input.outputs ?? 1) > 1 && this.#pending.has(jobId)) {
      throw new ToolRunError("Wait for the cancelled image batch to finish recording its files.", 409);
    }
    if (job.submissionOutcome === "unknown" && !["image-to-3d", "animate-3d", "generate-video", "generate-image"].includes(job.toolId)) throw new ToolRunError("The previous request may have been billed. Its result is unknown; automatic resubmission is unavailable. Start a new generation only if you intend another request.", 409);
    await this.assertMediaAvailable(job.toolId, job.input, ["image-to-3d", "animate-3d"].includes(job.toolId));
    if (this.#jobs.get(jobId) !== job || !["failed", "cancelled"].includes(job.status)) throw new ToolRunError("This recovery was superseded. Refresh the job before continuing.", 409);
    // A definite audio rejection may be explicitly retried as a new request; unknown outcomes were rejected above.
    const recoveryId = ["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId) ? randomUUID() : job.recoveryId;
    const retried = this.start(job.toolId, job.input, job.metadata, job.prepared, recoveryId, job.toolId === "generate-image", job.toolId === "generate-video", ["image-to-3d", "animate-3d"].includes(job.toolId), job.toolId === "generate-image" ? job.run : undefined);
    this.#jobs.delete(jobId);
    return retried;
  }

  async close(): Promise<void> {
    this.#closed = true;
    let changed = false;
    for (const job of this.#jobs.values()) {
      if (job.status === "running") {
        changed = true;
        job.status = "cancelled";
        job.error = "Generation interrupted";
        if (["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId)) job.submissionOutcome = "unknown";
        job.controller.abort();
      }
    }
    await Promise.allSettled([...this.#pending.values()]);
    if (changed) await this.#saveJobsSafely();
    else await this.#jobWrites.catch((cause) => console.error("Could not save generation history", cause));
  }

  async #execute(job: ToolJobRecord): Promise<void> {
    try {
      job.run = await this.#withGenerationLog(job.toolId, () => job.input!, job.controller.signal, job.context?.projectId, async () => {
        await this.#saveJobs();
        if (!job.prepared) {
          job.input = await this.#prepare(job.toolId, job.input!, job.context?.projectId);
          job.prepared = true;
        }
        await this.#saveJobs();
        job.model = selectedModel(job.toolId, job.input!);
        return this.#projectGeneration(job.context?.projectId, job.recoveryId, () => this.#runPrepared(job.toolId, job.input!, job.controller.signal, job.recoveryId, job.imageRecoveryOnly, job.videoRecoveryOnly, job.model3DRecoveryOnly, async (summary) => {
          if (!validVideoReferencePreparation(summary)) throw new ToolRunError("Invalid video reference preparation summary", 400);
          job.videoReferencePreparation = summary;
          await this.#saveJobsSafely();
        }, async () => {
          job.controller.signal.throwIfAborted();
          job.videoSubmission = "attempted";
          await this.#saveJobs();
        }, job.context, job.run?.id));
      });
      if (job.run.files.length && job.run.files.every((file) => file.assetId)) {
        await this.removeRun(job.run.id).catch(() => {});
      }
      job.status = "succeeded";
      job.input = undefined;
    } catch (cause) {
      if (cause instanceof PartialImageRunError) job.run = cause.run;
      if (job.toolId === "generate-video" && cause instanceof ToolRunError && cause.notSubmitted) job.videoSubmission = "not-submitted";
      if (cause instanceof ToolRunError && cause.videoDiagnostic) job.videoDiagnostic = cause.videoDiagnostic;
      if (cause instanceof ToolRunError && cause.audioDiagnostic) job.audioDiagnostic = cause.audioDiagnostic;
      if (cause && typeof cause === "object" && "submissionOutcome" in cause && cause.submissionOutcome === "unknown") job.submissionOutcome = "unknown";
      if (await this.mediaWasAttempted(job.toolId, job.recoveryId, (job.input as RunImageToolRequest | undefined)?.outputs)) job.submissionOutcome = "unknown";
      if (job.controller.signal.aborted || cause instanceof Error && cause.name === "AbortError") {
        job.status = "cancelled";
        job.error = "Generation cancelled";
      } else {
        job.status = "failed";
        job.error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      this.#pruneJobs();
      if (!this.#closed) await this.#saveJobsSafely();
    }
  }

  #pruneJobs(): void {
    const seen = new Set<string>();
    let terminal = 0;
    for (const job of [...this.#jobs.values()].reverse()) {
      const key = job.context && JSON.stringify([job.context.projectId, job.context.boardId, job.context.nodeId, job.toolId]);
      const latest = key !== undefined && !seen.has(key);
      if (key !== undefined) seen.add(key);
      if (job.status === "running" || terminal++ < HISTORY_LIMIT) continue;
      if (latest && requiresNewJobConfirmation(job)) continue;
      this.#jobs.delete(job.id);
    }
  }

  async animationActions(model?: ModelRef, options?: RunAnimate3DToolRequest["options"]): Promise<Model3DAnimationAction[]> {
    const generator = this.model3DGenerator;
    if (!generator?.animations) throw new ToolRunError("3D animation is not configured", 503);
    try { return await generator.animations(undefined, model, options); }
    catch (cause) { throw cause instanceof Model3DGenerationError ? inheritToolPreflightFailure(new ToolRunError(cause.message, cause.statusCode, undefined, undefined, undefined, cause.notSubmitted), cause) : cause; }
  }

  async run(toolId: string, input: RunToolRequest | (() => Promise<RunToolRequest>), signal?: AbortSignal, projectId?: string, options: {
    recoveryId?: string; agentCall?: AgentMediaCall; confirmNew?: ConfirmPaidMedia;
    imageRecoveryOnly?: boolean; videoRecoveryOnly?: boolean; model3DRecoveryOnly?: boolean; audioRecoveryOnly?: boolean;
    agentCanInspectImages?: boolean;
  } = {}): Promise<ToolRun> {
    if (this.#closed) throw new ToolRunError("Generation is shutting down", 503);
    if (projectId) this.#projectAdmission?.(projectId);
    if (typeof input !== "function") assertSafeGenerationInput(input);
    const { confirmNew, ...identity } = options;
    assertSafeGenerationInput(identity);
    let prepared = typeof input === "function" ? undefined : input;
    if (projectId) this.#directRuns.set(projectId, (this.#directRuns.get(projectId) ?? 0) + 1);
    try {
      return await this.#withGenerationLog(toolId, () => prepared, signal, projectId, async () => {
        const recoveryId = options.recoveryId ?? randomUUID();
        let executing = false;
        const execute = async () => {
          // A saved run can be delivered even if its original references or model disappeared.
          const request = typeof input === "function" ? await input() : input;
          if (typeof input === "function") assertSafeGenerationInput(request);
          prepared = await this.#prepare(toolId, request, projectId, options.model3DRecoveryOnly ? undefined : options.agentCanInspectImages);
          if (options.imageRecoveryOnly && !await this.hasSavedImageResult(recoveryId)) throw new ToolRunError("No saved image result is available for this call. Recovery never submits a new generation.", 409);
          if (options.videoRecoveryOnly && !await this.hasSavedVideoTask(recoveryId)) throw new ToolRunError("No saved video task is available. Recovery never submits a new generation.", 409);
          if (options.model3DRecoveryOnly && !await this.hasSavedModel3DTask(recoveryId)) throw new ToolRunError("No saved 3D task is available. Recovery never submits a new generation.", 409);
          if (options.audioRecoveryOnly) throw new ToolRunError("No completed local audio is available. Check the provider before authorizing a new paid request.", 409, "unknown");
          executing = true;
          return this.#projectGeneration(projectId, recoveryId, () => this.#runPrepared(toolId, prepared!, signal, recoveryId, options.imageRecoveryOnly, options.videoRecoveryOnly, options.model3DRecoveryOnly));
        };
        if (!options.agentCall) return execute();
        const recovering = Boolean(options.imageRecoveryOnly || options.videoRecoveryOnly || options.model3DRecoveryOnly || options.audioRecoveryOnly);
        return this.agentMedia.use({ ...options.agentCall, ...(projectId ? { projectId } : {}) }, recoveryId, recovering, confirmNew, async (receipt, save) => {
          if (receipt.runId) {
            const stored = await this.#readRun(receipt.runId);
            if (!stored || stored.toolId !== toolId) throw new ToolRunError("The retained media is unavailable. Check the original result before authorizing another generation.", 409, "unknown");
            return publicRun(stored);
          }
          const run = await execute();
          await save({ runId: run.id });
          return run;
        }, async (cause) => !executing || (cause instanceof ToolRunError && !cause.submissionOutcome
          && !await this.mediaWasAttempted(toolId, recoveryId) && (cause.notSubmitted || [400, 401, 403, 404, 429].includes(cause.statusCode))));
      });
    } finally {
      if (projectId) {
        const remaining = (this.#directRuns.get(projectId) ?? 1) - 1;
        if (remaining) this.#directRuns.set(projectId, remaining); else this.#directRuns.delete(projectId);
      }
    }
  }

  async prepare(toolId: string, input: RunToolRequest, projectId?: string, agentCanInspectImages?: boolean): Promise<RunToolRequest> {
    if (projectId) this.#projectAdmission?.(projectId);
    assertSafeGenerationInput(input);
    const started = Date.now();
    try {
      return await this.#prepare(toolId, input, projectId, agentCanInspectImages);
    } catch (cause) {
      this.#recordGeneration(toolId, () => input, projectId, started, "failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  async #prepare(toolId: string, input: RunToolRequest, projectId?: string, agentCanInspectImages?: boolean): Promise<RunToolRequest> {
    if (!isToolId(toolId)) throw new ToolRunError("Tool not found", 404);
    assertSafeGenerationInput(input);
    await this.assertMediaAvailable(toolId, input);
    const prepared = this.resolveInput ? await this.resolveInput(toolId, input, projectId) : input;
    assertSafeGenerationInput(prepared);
    await this.assertMediaAvailable(toolId, prepared);
    if (agentCanInspectImages === false && toolId === "image-to-3d") {
      const { operation = "image", options, model } = prepared as Run3DToolRequest;
      if (operation === "image") {
        const protocol = options?.pose && options.referenceMode !== "turnaround" ? (await this.#resolve3DModel(model, operation))?.protocol : undefined;
        if (requiresModelTurnaround(options, protocol, operation)) throw new ToolRunError("Switch to a vision-capable main Agent and inspect the front, left, and back images before submitting production image-to-3D. No generation was submitted.", 400);
      }
    }
    return prepared;
  }

  /** Check disabled connections before changing job history or creating a task journal. */
  async assertMediaAvailable(toolId: string, input: RunToolRequest, recoveryOnly = false): Promise<void> {
    assertAvailableMediaReference(input);
    if (recoveryOnly && ["image-to-3d", "animate-3d"].includes(toolId) && !(input as Run3DToolRequest).model) throw new ToolRunError("The saved 3D task has no explicit connection binding. Its original records are retained; recovery cannot select a replacement provider.", 409);
    try {
      if (toolId === "generate-image") await this.imageGenerator.assertGenerationAllowed?.((input as RunImageToolRequest).imageModel);
      if (toolId === "generate-video") await this.videoGenerator?.assertGenerationAllowed?.((input as RunVideoToolRequest).model);
      if (toolId === "image-to-3d") await this.model3DGenerator?.assertGenerationAllowed?.((input as Run3DToolRequest).model);
      if (toolId === "animate-3d") await this.model3DGenerator?.assertOperationAllowed?.((input as RunAnimate3DToolRequest).model);
      if (!recoveryOnly && ["generate-speech", "generate-sound-effect", "generate-music"].includes(toolId)) {
        const operation = toolId === "generate-speech" ? "speech" : toolId === "generate-music" ? "music" : "sound-effect";
        this.audioGenerator?.validate?.({ ...input, operation } as AudioGenerationRequest);
      }
    } catch (cause) {
      if (cause instanceof ImageGenerationError || cause instanceof VideoGenerationError) throw new ToolRunError(cause.message, cause.statusCode, undefined, undefined, undefined, true);
      model3DToolError(cause);
    }
  }

  /** Resolved options only: check before Canvas/source writes or a new task journal. */
  async assertMediaInputOptions(toolId: string, input: RunToolRequest): Promise<void> {
    if (toolId !== "image-to-3d" && toolId !== "animate-3d") return;
    assertSafeGenerationInput(input);
    await this.assertMediaAvailable(toolId, input);
    const request = input as Run3DToolRequest;
    const operation = toolId === "animate-3d" ? "animate" : request.operation ?? "image";
    // Model selection/policy failures are outside the pure-validator scope.
    const model = operation === "animate"
      ? this.model3DGenerator?.resolveOperationModel ? await this.model3DGenerator.resolveOperationModel(request.model, "animate") : resolveModel3D(request.model)
      : await this.#resolve3DModel(request.model, operation);
    if (!model) return;
    try {
      validate3DOptions(request.options);
      const options = request.options && { ...request.options };
      if (options?.referenceMode !== undefined && operation !== "image") throw new ToolRunError("Reference mode applies only to image-to-3D", 400);
      if (options) {
        delete options.referenceMode;
        if (operation === "image" && model.protocol === "tripo") delete options.pose;
      }
      validateOperationOptions(options, operation, operation === "animate" ? model.protocol ?? "tripo" : model.protocol);
    } catch (cause) {
      if (!(cause instanceof ToolRunError) || cause.statusCode !== 400) throw cause;
      const text = `${cause.message}. Check the selected model and operation options in list_media_capabilities; correct the arguments using a new call ID. No generation was submitted.`;
      throw inheritToolPreflightFailure(new ToolRunError(text, 400, undefined, undefined, undefined, true), toolPreflightError(text, "invalid_media_options"));
    }
  }

  /** Executes an input whose model and generation options have already been resolved. */
  async runPrepared(toolId: string, input: RunToolRequest, signal?: AbortSignal, options: { recoveryId?: string; projectId?: string; canvasContext?: ToolJobContext; imageRecoveryOnly?: boolean; videoRecoveryOnly?: boolean; model3DRecoveryOnly?: boolean } = {}, referencePrepared?: (summary: VideoReferencePreparation) => Promise<void>, submissionStarted?: () => Promise<void>): Promise<ToolRun> {
    if (this.#closed) throw new ToolRunError("Generation is shutting down", 503);
    if (options.projectId) this.#projectAdmission?.(options.projectId);
    assertSafeGenerationInput(input);
    assertSafeGenerationInput(options);
    const { recoveryId = randomUUID(), projectId } = options;
    if (projectId) this.#directRuns.set(projectId, (this.#directRuns.get(projectId) ?? 0) + 1);
    try {
      return await this.#withGenerationLog(toolId, () => input, signal, projectId, () => this.#projectGeneration(projectId, recoveryId, () => this.#runPrepared(toolId, input, signal, recoveryId, options.imageRecoveryOnly, options.videoRecoveryOnly, options.model3DRecoveryOnly, referencePrepared, submissionStarted, options.canvasContext)));
    } finally {
      if (projectId) {
        const remaining = (this.#directRuns.get(projectId) ?? 1) - 1;
        if (remaining) this.#directRuns.set(projectId, remaining); else this.#directRuns.delete(projectId);
      }
    }
  }

  async #projectGeneration(projectId: string | undefined, recoveryId: string, execute: () => Promise<ToolRun>): Promise<ToolRun> {
    if (!projectId) return execute();
    await this.agentMedia.trackProject(projectId, recoveryId);
    try {
      const run = await execute();
      await this.agentMedia.trackProject(projectId, recoveryId, { runId: run.id });
      return run;
    } catch (cause) {
      if (cause instanceof PartialImageRunError) await this.agentMedia.trackProject(projectId, recoveryId, { runId: cause.run.id });
      throw cause;
    }
  }

  async #withGenerationLog(toolId: string, input: () => RunToolRequest | undefined, signal: AbortSignal | undefined, projectId: string | undefined, execute: () => Promise<ToolRun>): Promise<ToolRun> {
    const started = Date.now();
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let error: string | undefined;
    let videoDiagnostic: VideoRequestDiagnostic | undefined;
    let audioDiagnostic: AudioRequestDiagnostic | undefined;
    let run: ToolRun | undefined;
    try {
      run = await execute();
      return run;
    } catch (cause) {
      status = signal?.aborted || cause instanceof Error && cause.name === "AbortError" ? "cancelled" : "failed";
      error = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof ToolRunError) videoDiagnostic = cause.videoDiagnostic;
      if (cause instanceof ToolRunError) audioDiagnostic = cause.audioDiagnostic;
      throw cause;
    } finally {
      this.#recordGeneration(toolId, input, projectId, started, status, error, run?.model, videoDiagnostic, audioDiagnostic);
    }
  }

  #recordGeneration(toolId: string, input: () => RunToolRequest | undefined, projectId: string | undefined, started: number, status: "succeeded" | "failed" | "cancelled", error?: string, runModel?: ModelRef, videoDiagnostic?: VideoRequestDiagnostic, audioDiagnostic?: AudioRequestDiagnostic): void {
    try {
      const model = runModel ?? selectedModel(toolId, input());
      const outcome = {
        toolId,
        ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        ...(projectId ? { projectId } : {}),
        durationMs: Date.now() - started,
        ...(videoDiagnostic ? { videoDiagnostic } : {}),
        ...(audioDiagnostic ? { audioDiagnostic } : {}),
      };
      if (status === "failed") this.#log?.warn({ ...outcome, error }, "Generation failed");
      else this.#log?.info(outcome, status === "cancelled" ? "Generation cancelled" : "Generation succeeded");
    } catch { /* Logging must not change the result or prevent job persistence. */ }
  }

  async #runPrepared(toolId: string, input: RunToolRequest, signal: AbortSignal | undefined, recoveryId: string, imageRecoveryOnly = false, videoRecoveryOnly = false, model3DRecoveryOnly = false, referencePrepared?: (summary: VideoReferencePreparation) => Promise<void>, submissionStarted?: () => Promise<void>, canvasContext?: ToolJobContext, previousImageRunId?: string): Promise<ToolRun> {
    assertSafeGenerationInput(input);
    assertSafeGenerationInput(recoveryId);
    await this.assertMediaAvailable(toolId, input, model3DRecoveryOnly);
    if (!model3DRecoveryOnly) await this.assertMediaInputOptions(toolId, input);
    if (toolId === "image-to-3d") {
      assertOnlyKeys(input, ["images", "model", "targetPolycount", "texture", "pbr", "operation", "prompt", "sourceAssetId", "options"]);
      return this.#run3D(input as Run3DToolRequest, signal, recoveryId, await model3DJournal(path.join(this.#runsDirectory, "../model3d-tasks"), recoveryId, model3DRecoveryOnly), canvasContext).catch(model3DToolError);
    }
    if (toolId === "animate-3d") {
      assertOnlyKeys(input, ["assetId", "actionIds", "heightMeters", "model", "options"]);
      return this.#runAnimate3D(input as RunAnimate3DToolRequest, signal, recoveryId, await model3DJournal(path.join(this.#runsDirectory, "../model3d-tasks"), recoveryId, model3DRecoveryOnly), canvasContext).catch(model3DToolError);
    }
    if (toolId === "generate-video") {
      assertOnlyKeys(input, ["prompt", "model", "references", "duration", "aspectRatio", "resolution", "referenceMode"]);
      return this.#runVideo(input as RunVideoToolRequest, signal, recoveryId, await videoTaskJournal(path.join(this.#runsDirectory, "../video-tasks"), recoveryId, videoRecoveryOnly, referencePrepared, submissionStarted), canvasContext);
    }
    if (toolId === "generate-speech") {
      assertOnlyKeys(input, ["text", "model", "referenceAssetId", "referenceSha256", "voiceDesign", "voiceDescription", "language", "style", "speed", "output"]);
      const speech = input as RunSpeechToolRequest;
      if (speech.referenceSha256 !== undefined && (typeof speech.referenceSha256 !== "string" || !speech.referenceAssetId || !/^[a-f0-9]{64}$/.test(speech.referenceSha256))) throw new ToolRunError("Invalid audio reference binding", 400);
      if (speech.voiceDesign !== undefined && typeof speech.voiceDesign !== "boolean") throw new ToolRunError("Invalid voice design intent", 400);
      if (speech.voiceDescription !== undefined && typeof speech.voiceDescription !== "string" || speech.voiceDesign && (!speech.voiceDescription?.trim() || speech.voiceDescription.length > 2000 || speech.referenceAssetId) || speech.voiceDescription !== undefined && !speech.voiceDesign) throw new ToolRunError("Voice design requires a description and no reference audio", 400);
      return this.#runAudio(toolId, { operation: "speech", ...(input as RunSpeechToolRequest) }, signal, recoveryId, canvasContext);
    }
    if (toolId === "generate-sound-effect") {
      assertOnlyKeys(input, ["prompt", "model", "durationSeconds", "loop", "negativePrompt", "output"]);
      return this.#runAudio(toolId, { operation: "sound-effect", ...(input as RunSoundEffectToolRequest) }, signal, recoveryId, canvasContext);
    }
    if (toolId === "generate-music") {
      assertOnlyKeys(input, ["prompt", "model", "instrumental", "lyrics", "durationSeconds", "loop", "referenceAssetId", "output"]);
      return this.#runAudio(toolId, { operation: "music", ...(input as RunMusicToolRequest) }, signal, recoveryId, canvasContext);
    }
    if (toolId !== "generate-image") throw new ToolRunError("Tool not found", 404);
    assertOnlyKeys(input, ["prompt", "imageModel", "size", "resolution", "aspectRatio", "outputs", "images", "quality", "outputFormat", "outputCompression", "background", "mask"]);
    return this.#runImage(input as RunImageToolRequest, signal, recoveryId, imageRecoveryOnly, canvasContext, previousImageRunId);
  }

  async #runImage(input: RunImageToolRequest, signal: AbortSignal | undefined, recoveryId: string, recoveryOnly = false, canvasContext?: ToolJobContext, previousImageRunId?: string): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const imageInput = "images" in input ? input.images : undefined;
    const usesConfiguredOptions = input.resolution !== undefined || input.aspectRatio !== undefined || input.outputs !== undefined || imageInput !== undefined;
    if (input.size !== undefined && usesConfiguredOptions) throw new ToolRunError("Image size cannot be combined with resolution, aspect ratio, output count, or reference images", 400);
    if (usesConfiguredOptions && (input.resolution === undefined || input.aspectRatio === undefined)) {
      throw new ToolRunError("Resolution and aspect ratio are required for configured image generation", 400);
    }
    const size = input.size ?? "1024x1024";
    if (!isImageSize(size)) throw new ToolRunError("Unsupported image size", 400);
    const resolution = input.resolution;
    const aspectRatio = input.aspectRatio;
    const outputs = input.outputs ?? 1;
    if (resolution !== undefined && !isImageResolution(resolution)) throw new ToolRunError("Unsupported image resolution", 400);
    if (aspectRatio !== undefined && !isImageAspectRatio(aspectRatio)) throw new ToolRunError("Unsupported image aspect ratio", 400);
    if (!isImageOutputCount(outputs)) throw new ToolRunError("Unsupported image output count", 400);
    if (imageInput && (imageInput.length > IMAGE_MAX_REFERENCE_IMAGES || imageInput.some((image) => !isPromptImage(image, true)))) throw new ToolRunError(`Up to ${IMAGE_MAX_REFERENCE_IMAGES} PNG, JPEG, or WebP images are supported`, 400);
    await this.#attachImageSources(imageInput ?? []);

    const previous = recoveryOnly && outputs > 1 && previousImageRunId && isRunId(previousImageRunId) ? await this.#readRun(previousImageRunId) : undefined;
    if (previousImageRunId && (previous?.toolId !== "generate-image" || previous.batchRecoveryId !== recoveryId)) throw new ToolRunError("The retained image batch is unavailable. Recovery stopped without submitting.", 409);
    const id = previous?.id ?? randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    const registeredAssetIds: string[] = [];
    try {
      signal?.throwIfAborted();
      const journals = path.join(this.#runsDirectory, "../image-requests");
      const slots = await Promise.allSettled(Array.from({ length: outputs }, async (_, index) => {
        const original = previous?.files.find(file => file.name === imageFileName(file.mediaType, index + 1));
        if (original) {
          const retained = await lstat(path.join(destination, original.name)).catch(cause => {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          });
          if (retained?.isFile() && retained.size > 0) return { file: original };
        }
        if (recoveryOnly && outputs > 1 && !await hasSavedImageSlot(journals, recoveryId, index)) {
          throw new ToolRunError("The provider result for this image was not recorded.", 409, "unknown");
        }
        const image = await this.imageGenerator.generate({
          prompt,
          execution: await imageRequestJournal(journals, `${recoveryId}-${index}`, recoveryOnly),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.outputFormat !== undefined ? { outputFormat: input.outputFormat } : {}),
          ...(input.outputCompression !== undefined ? { outputCompression: input.outputCompression } : {}),
          ...(input.background !== undefined ? { background: input.background } : {}),
          ...(input.mask ? { mask: input.mask } : {}),
          ...(input.imageModel ? { imageModel: input.imageModel } : {}),
          ...(usesConfiguredOptions ? { resolution: resolution!, aspectRatio: aspectRatio!, ...(imageInput?.length ? { images: imageInput } : {}) } : { size }),
        }, signal);
        const mediaType = sniffImageType(image.bytes) ?? image.mediaType;
        return { image, file: { name: imageFileName(mediaType, outputs > 1 ? index + 1 : undefined), mediaType } as ToolRunFile };
      }));
      const retained = slots.flatMap(slot => slot.status === "fulfilled" ? [slot.value] : []);
      const failure = slots.find(slot => slot.status === "rejected");
      if (!retained.length && failure) throw failure.reason;
      if (outputs === 1) signal?.throwIfAborted();
      await mkdir(temporary, { recursive: true });
      for (const { file, image } of retained) {
        if (!image) continue;
        if (this.assetLibrary) {
          file.assetId = (await this.assetLibrary.add(file.name, image.bytes, {
            origin: "generated", prompt, sourceKey: `tool:${id}:${file.name}`,
            ...(image.generation ? { generation: generationProvenance(image.generation) } : {}),
          })).id;
          registeredAssetIds.push(file.assetId);
          await this.assetLibrary.bindGeneratedImageSource(file.assetId, image);
        }
        await writeFile(path.join(temporary, file.name), image.bytes);
      }
      const generation = retained.find(slot => slot.image?.generation)?.image?.generation;
      const run: StoredToolRun = {
        version: 1,
        recoveryId,
        canvasContext,
        ...(outputs > 1 ? { batchRecoveryId: recoveryId } : {}),
        id,
        toolId: "generate-image",
        ...(previous?.generation ? { generation: previous.generation, model: previous.model } : {}),
        ...(input.imageModel ? { model: input.imageModel } : {}),
        ...(generation ? { generation: generationProvenance(generation),
          model: { provider: generation.provider ?? input.imageModel?.provider ?? "openai", id: generation.model } } : {}),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        files: retained.map(slot => slot.file),
      };
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      if (previous) {
        for (const { file, image } of retained) if (image) await rename(path.join(temporary, file.name), path.join(destination, file.name));
        await rename(path.join(temporary, "run.json"), path.join(destination, "run.json"));
        await rm(temporary, { recursive: true, force: true });
      } else {
        await rename(temporary, destination);
      }
      if (failure || (outputs > 1 && signal?.aborted)) throw new PartialImageRunError(publicRun(run), outputs);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof PartialImageRunError) throw cause;
      if (registeredAssetIds.length) throw retainedLibraryMedia(registeredAssetIds);
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof ImageGenerationError) throw new ToolRunError(cause.message, cause.statusCode, cause.outcomeUnknown || (!cause.notSubmitted && cause.statusCode === 502) ? "unknown" : undefined, undefined, undefined, cause.notSubmitted);
      throw cause;
    }
  }

  #resolve3DModel(model: Run3DToolRequest["model"], operation: NonNullable<Run3DToolRequest["operation"]>) {
    const generator = this.model3DGenerator;
    return generator?.resolveOperationModel ? generator.resolveOperationModel(model, operation)
      : generator?.resolveModel ? generator.resolveModel(model) : resolveModel3D(model);
  }

  async #run3D(input: Run3DToolRequest, signal: AbortSignal | undefined, recoveryId: string, execution: Model3DExecution, canvasContext?: ToolJobContext): Promise<ToolRun> {
    const operation = input.operation ?? "image", images = input.images;
    if (!["image", "text", "retexture", "remesh"].includes(operation)) throw new ToolRunError("Unknown 3D operation", 400);
    if (input.prompt !== undefined && typeof input.prompt !== "string") throw new ToolRunError("3D prompt must be a string", 400);
    validate3DOptions(input.options);
    const generator = this.model3DGenerator;
    const model = await this.#resolve3DModel(input.model, operation);
    if (!model) throw new ToolRunError("The selected model does not support this 3D operation", 400);
    if (!Array.isArray(images) || images.some((image) => !isPromptImage(image))) throw new ToolRunError("Invalid 3D reference images", 400);
    if (operation === "image" && input.prompt?.trim()) throw new ToolRunError("Omit prompt for image-to-3D and supply reference images. For text-only generation, use operation=text with a prompt and no images. No generation was submitted.", 400);
    const options = input.options && { ...input.options };
    if (options?.referenceMode !== undefined && operation !== "image") throw new ToolRunError("Reference mode applies only to image-to-3D", 400);
    if (!execution.recoveryOnly && requiresModelTurnaround(options, model.protocol, operation)) await validateTurnaroundImages(images, model.maxReferenceImages);
    // Local view preparation never changes the provider payload or fingerprints of retained tasks.
    if (options) {
      delete options.referenceMode;
      if (operation === "image" && model.protocol === "tripo") delete options.pose;
    }
    if (images.length > (operation === "retexture" ? 1 : model.maxReferenceImages)) throw new ToolRunError("Invalid 3D reference images", 400);
    await this.#attachImageSources(images);
    if (operation === "image" && !images.length) throw new ToolRunError("Provide at least one reference image", 400);
    if (operation === "text" && (!input.prompt?.trim() || images.length)) throw new ToolRunError("Text-to-3D needs a prompt without images", 400);
    if (operation === "retexture" && !input.prompt?.trim() && !images.length) throw new ToolRunError("Add a texture prompt or reference image", 400);
    if (operation === "remesh" && (images.length || input.prompt?.trim())) throw new ToolRunError("Remesh takes a model and face count only", 400);
    const range = operation === "remesh" ? remeshPolycount(model.protocol) : model.polycount;
    if (operation !== "retexture" && input.targetPolycount !== undefined && (!Number.isInteger(input.targetPolycount) || input.targetPolycount < range.min || input.targetPolycount > range.max)) throw new ToolRunError(`3D poly count must be between ${range.min} and ${range.max}`, 400);
    if (input.texture !== undefined && typeof input.texture !== "boolean" || input.pbr !== undefined && typeof input.pbr !== "boolean") throw new ToolRunError("Texture and PBR must be booleans", 400);
    if (!generator) throw new ToolRunError("3D generation is not configured", 503);
    validateOperationOptions(options, operation, model.protocol);
    let source: Buffer | undefined, sourceMetadata: Generated3DModel["metadata"];
    if (operation === "retexture" || operation === "remesh") {
      const content = await this.#modelSource(input.sourceAssetId, signal);
      source = content.bytes; sourceMetadata = content.metadata;
    } else if (input.sourceAssetId !== undefined) throw new ToolRunError("Generation does not accept a source model", 400);
    const primaryImage = images[0];
    return this.#storeModelRun("image-to-3d", signal, recoveryId, async () => {
      const { sourceAssetId: _, ...generationInput } = input;
      const result = await generator.generate({ ...generationInput, options, model: { provider: model.provider, id: model.id }, source, execution }, signal);
      return { ...result, metadata: { ...(sourceMetadata?.forwardAxis ? { forwardAxis: sourceMetadata.forwardAxis } : {}), ...result.metadata, provider: model.provider, operation } };
    }, primaryImage ? {
      fileName: `preview.${primaryImage.mediaType === "image/png" ? "png" : "jpg"}`,
      mediaType: primaryImage.mediaType as "image/png" | "image/jpeg", bytes: Buffer.from(primaryImage.data, "base64"),
    } : undefined, { provider: model.provider, id: model.id }, canvasContext);
  }

  async #modelSource(assetId?: string, signal?: AbortSignal) {
    if (!assetId) throw new ToolRunError("Choose a source GLB model", 400);
    if (!this.assetLibrary) throw new ToolRunError("The asset library is unavailable", 503);
    const asset = this.assetLibrary.get(assetId);
    if (!asset) throw new ToolRunError("The 3D model is no longer in the Library", 404);
    signal?.throwIfAborted();
    const source = await this.assetLibrary.openContent(assetId, 64 * 1024 * 1024, asset.contentType === FBX_MEDIA_TYPE, signal);
    signal?.throwIfAborted();
    if (source.asset.contentType !== "model/gltf-binary") throw new ToolRunError("Only GLB models are supported", 400);
    const chunks: Buffer[] = []; for await (const chunk of source.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    const metadata = { ...source.asset.model3d, ...await inspectModel3D(bytes, signal) };
    return { bytes, metadata };
  }

  async #runAnimate3D(input: RunAnimate3DToolRequest, signal: AbortSignal | undefined, recoveryId: string, execution: Model3DExecution, canvasContext?: ToolJobContext): Promise<ToolRun> {
    const { actionIds, heightMeters } = input;
    if (typeof input.assetId !== "string" || !input.assetId) throw new ToolRunError("Choose a 3D model to animate", 400);
    if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > MAX_ANIMATION_ACTIONS
      || actionIds.some((id) => typeof id === "number" ? !Number.isInteger(id) || id < 0 : typeof id !== "string" || !id || id.length > 120) || new Set(actionIds).size !== actionIds.length) {
      throw new ToolRunError(`Choose 1 to ${MAX_ANIMATION_ACTIONS} different animations`, 400);
    }
    if (heightMeters !== undefined && (typeof heightMeters !== "number" || !Number.isFinite(heightMeters) || heightMeters <= 0 || heightMeters > 100)) {
      throw new ToolRunError("Character height must be a positive number of meters", 400);
    }
    const generator = this.model3DGenerator;
    if (!generator?.animate) throw new ToolRunError("3D animation is not configured", 503);
    validate3DOptions(input.options);
    const source = await this.#modelSource(input.assetId, signal);
    const connection = generator.resolveOperationModel ? await generator.resolveOperationModel(input.model, "animate") : resolveModel3D(input.model);
    if (!connection) throw new ToolRunError("Choose an available animation provider", 400);
    if (isMeshyModelReference(connection)) throw new ToolRunError(MESHY_DISABLED_MESSAGE, 410, undefined, undefined, undefined, true);
    validateOperationOptions(input.options, "animate", connection.protocol ?? "tripo");
    return this.#storeModelRun("animate-3d", signal, recoveryId, async () => {
      const result = await generator.animate!({ model: source.bytes, actionIds, providerModel: input.model, options: input.options, forwardAxis: source.metadata.forwardAxis, execution, ...(heightMeters !== undefined ? { heightMeters } : {}) }, signal);
      return { ...result, metadata: { ...(source.metadata.forwardAxis ? { forwardAxis: source.metadata.forwardAxis } : {}), ...result.metadata, provider: connection.provider, operation: "animate" } };
    }, undefined, input.model, canvasContext);

  }

  /** FBX originals and their optional GLB previews are committed together as one Library asset. */
  async #storeModelRun(
    toolId: "image-to-3d" | "animate-3d",
    signal: AbortSignal | undefined,
    recoveryId: string,
    produce: () => Promise<Generated3DModel>,
    preview?: { fileName: string; mediaType: "image/png" | "image/jpeg"; bytes: Buffer },
    model?: ModelRef,
    canvasContext?: ToolJobContext,
  ): Promise<ToolRun> {
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const generated = await produce();
      const fbx = generated.mediaType === FBX_MEDIA_TYPE;
      let modelPreview: Buffer | undefined;
      if (fbx) {
        try { modelPreview = await createFbxPreview(generated.bytes, signal); }
        catch { signal?.throwIfAborted(); /* The original stays usable when local preview conversion is unsupported. */ }
      }
      const model3d = { ...generated.metadata, ...(fbx && !modelPreview ? { triangles: 0, textured: false, rigged: false, animations: [] } : await inspectModel3D(modelPreview ?? generated.bytes, signal)),
        ...(fbx ? { preview: { status: modelPreview ? "ready" as const : "unavailable" as const, materialApproximation: true as const } } : {}) };
      const fileName = fbx ? "model-original.fbx" : "model.glb";
      if (model3d.generation) model3d.generation = generationProvenance(model3d.generation);
      signal?.throwIfAborted();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add(fileName, generated.bytes, {
          origin: "generated", signal,
          sourceKey: `tool:${id}:${fileName}`,
          ...(modelPreview ? { modelPreview } : {}),
          model3d,
          ...(model3d.generation ? { generation: model3d.generation } : {}),
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        recoveryId,
        canvasContext,
        id,
        toolId,
        ...(model ? { model } : {}),
        ...(model3d.generation ? { generation: model3d.generation } : {}),
        createdAt: new Date().toISOString(),
        files: [{
          name: fileName,
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }, ...(modelPreview ? [{ name: "model-preview.glb", mediaType: "model/gltf-binary" }] : [])],
        ...(preview ? { preview: { fileName: preview.fileName, mediaType: preview.mediaType } } : {}),
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, fileName), generated.bytes);
      if (modelPreview) await writeFile(path.join(temporary, "model-preview.glb"), modelPreview);
      if (preview) await writeFile(path.join(temporary, preview.fileName), preview.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (registeredAssetId) throw retainedLibraryMedia([registeredAssetId]);
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode, !cause.notSubmitted && cause.statusCode === 502 ? "unknown" : undefined, undefined, undefined, cause.notSubmitted);
      throw cause;
    }
  }

  async #runVideo(input: RunVideoToolRequest, signal: AbortSignal | undefined, recoveryId: string, execution?: VideoExecution, canvasContext?: ToolJobContext): Promise<ToolRun> {
    if (!this.videoGenerator) throw new ToolRunError("Video generation is not configured", 503);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const references = input.references ?? [];
    validateVideoReferences(references);
    if (input.referenceMode !== undefined && input.referenceMode !== "frame" && input.referenceMode !== "reference") throw new ToolRunError("Unsupported video reference mode", 400);
    const duration = input.duration ?? VIDEO_DEFAULT_DURATION;
    if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new ToolRunError("Unsupported video duration", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const model = input.model;
      const aspectRatio = input.aspectRatio ?? "adaptive";
      const resolution = input.resolution ?? "720p";
      if (!model || !model.provider.trim() || !model.id.trim() || model.provider.length > 100 || model.id.length > 200) throw new ToolRunError("A valid video model is required", 400);
      if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) throw new ToolRunError("Unsupported video aspect ratio", 400);
      if (!VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) throw new ToolRunError("Unsupported video resolution", 400);
      const resolvedReferences = await this.#videoReferences(references);
      const generated = await this.videoGenerator.generate({ prompt, model, references: resolvedReferences, duration, aspectRatio, resolution, execution, ...(input.referenceMode ? { referenceMode: input.referenceMode } : {}) }, signal);
      signal?.throwIfAborted();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add("output.mp4", generated.bytes, {
          origin: "generated",
          prompt,
          sourceKey: `tool:${id}:output.mp4`,
          duration,
          ...(generated.metadata ? { generation: generationProvenance(generated.metadata) } : {}),
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        recoveryId,
        canvasContext,
        id,
        toolId: "generate-video",
        model,
        ...(generated.metadata ? { generation: generationProvenance(generated.metadata) } : {}),
        createdAt: new Date().toISOString(),
        files: [{
          name: "output.mp4",
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "output.mp4"), generated.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (registeredAssetId) throw retainedLibraryMedia([registeredAssetId]);
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof VideoGenerationError) throw new ToolRunError(cause.message, cause.statusCode, !cause.notSubmitted && cause.statusCode === 502 ? "unknown" : undefined, cause.diagnostic, undefined, cause.notSubmitted);
      throw cause;
    }
  }

  async #runAudio(toolId: "generate-speech" | "generate-sound-effect" | "generate-music", input: AudioGenerationRequest, signal: AbortSignal | undefined, recoveryId: string, canvasContext?: ToolJobContext): Promise<ToolRun> {
    if (!this.audioGenerator) throw new ToolRunError("Audio generation is not configured", 503);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    let received = false;
    let marker: FileHandle | undefined;
    try {
      signal?.throwIfAborted();
      let referenceAudio: import("../shared/audio.js").AudioGenerationInput["referenceAudio"];
      if (input.operation === "speech" && input.referenceAssetId) {
        if (!this.assetLibrary) throw new AudioGenerationError("The selected reference audio is unavailable", 400, "not-submitted");
        const opened = await this.assetLibrary.openContent(input.referenceAssetId, AUDIO_REFERENCE_MAX_BYTES);
        if (opened.asset.mediaType !== "audio") { opened.stream.destroy(); throw new AudioGenerationError("Select an MP3 or WAV audio reference", 400, "not-submitted"); }
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
        const bytes = Buffer.concat(chunks);
        let inspected;
        try { inspected = await inspectAudioReference(bytes, opened.asset.contentType); }
        catch { throw new AudioGenerationError("Reference audio must be a valid MP3 or WAV of 30 seconds or less and at most 10 MB", 400, "not-submitted"); }
        if (input.referenceSha256 && createHash("sha256").update(bytes).digest("hex") !== input.referenceSha256) throw new AudioGenerationError("The selected audio changed; explicitly select it again", 409, "not-submitted");
        referenceAudio = { bytes, mediaType: inspected.mediaType };
      }
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(recoveryId)) throw new ToolRunError("Invalid audio recovery identity", 400);
      const attempts = path.join(this.#runsDirectory, "../audio-attempts");
      await mkdir(attempts, { recursive: true, mode: 0o700 });
      // A stable Agent call ID can be replayed after a crash; a synchronous provider cannot recover that result.
      try {
        marker = await open(path.join(attempts, `${recoveryId}.json`), "wx", 0o600);
        await marker.writeFile(JSON.stringify({ toolId, attempted: true }));
      }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ToolRunError("This audio call was already attempted. Repeating it cannot recover the result; a new paid request requires explicit intent.", 409, "unknown");
        throw new ToolRunError("Could not safely record the audio attempt; no request was sent", 503);
      }
      signal?.throwIfAborted();
      const generated = await this.audioGenerator.generate({ ...input, ...(referenceAudio ? { referenceAudio } : {}) }, signal);
      received = true;
      const extension = generated.mediaType === "audio/wav" ? "wav" : "mp3";
      const fileName = `output.${extension}`;
      const prompt = input.operation === "speech" ? input.voiceDesign ? input.voiceDescription!.trim() : input.text.trim()
        : input.operation === "dialogue" ? input.turns.map((turn) => turn.text.trim()).filter(Boolean).join("\n")
          : input.prompt.trim();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add(fileName, generated.bytes, {
          origin: "generated",
          prompt,
          sourceKey: `tool:${id}:${fileName}`,
          ...(generated.metadata?.protocol ? { generation: generationProvenance({ model: generated.model.id, protocol: generated.metadata.protocol, parameters: generated.metadata.parameters }) } : {}),
          ...(generated.metadata?.durationMs !== undefined ? { duration: generated.metadata.durationMs / 1_000 } : {}),
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        recoveryId,
        canvasContext,
        id,
        toolId,
        model: generated.model,
        ...(generated.metadata?.protocol ? { generation: generationProvenance({ model: generated.model.id, protocol: generated.metadata.protocol, parameters: generated.metadata.parameters }) } : {}),
        createdAt: new Date().toISOString(),
        files: [{
          name: fileName,
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, fileName), generated.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (registeredAssetId) throw new ToolRunError(`Audio was received and retained in the Library (asset ${registeredAssetId}), but its local run could not be saved. Use the retained asset; do not generate again.`, 502, "unknown");
      if (received) throw new ToolRunError("Audio was received but could not be saved. Do not submit another paid request automatically.", 502, "unknown");
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof AudioGenerationError) {
        const unknown = cause.submissionOutcome === "unknown";
        if (!unknown && marker) {
          // Keep the original ID single-use while allowing a fresh request after a definite rejection.
          await marker.write(JSON.stringify({ toolId, attempted: true, rejected: true }), 0, "utf8").catch(() => {});
        }
        throw new ToolRunError(cause.message, cause.statusCode, unknown ? "unknown" : undefined, undefined, cause.diagnostic, !unknown);
      }
      throw cause;
    } finally { await marker?.close(); }
  }

  async #videoReferences(references: VideoGenerationReference[]): Promise<VideoReferenceAsset[]> {
    if (!references.length) return [];
    if (!this.assetLibrary) throw new ToolRunError("Asset Library is not configured", 503);
    try {
      return await Promise.all(references.map(async (reference) => {
        const { asset, absolutePath } = await this.assetLibrary!.content(reference.assetId);
        if (asset.mediaType !== reference.type) throw new ToolRunError(`Reference ${asset.name} is not a ${reference.type} asset`, 400);
        if (!supportedVideoReferenceType(reference.type, asset.contentType)) {
          throw new ToolRunError(`Unsupported ${reference.type} reference format: ${asset.contentType}`, 400);
        }
        const maximum = reference.type === "image" ? 30 * 1024 * 1024
          : reference.type === "video" ? 200 * 1024 * 1024
            : 15 * 1024 * 1024;
        if (asset.size > maximum) throw new ToolRunError(`${reference.type} reference is too large`, 400);
        const resolved = { type: reference.type, name: asset.name, mediaType: asset.contentType, absolutePath, ...(asset.duration !== undefined ? { duration: asset.duration } : {}) };
        if (reference.type === "image") await this.assetLibrary!.attachImageSource(asset.id, resolved);
        return resolved;
      }));
    } catch (cause) {
      if (cause instanceof ToolRunError) throw cause;
      throw new ToolRunError(cause instanceof Error ? cause.message : String(cause), 400);
    }
  }

  async #attachImageSources(images: readonly PromptImage[]): Promise<void> {
    if (!this.assetLibrary) return;
    for (const image of images) if (typeof image.libraryAssetId === "string") await this.assetLibrary.attachImageSource(image.libraryAssetId, image);
  }

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; assetId?: string; preview?: { bytes: Buffer; mediaType: "image/png" | "image/jpeg" } } | undefined> {
    if (!isRunId(runId) || !isToolRunFileName(fileName)) return undefined;
    try {
      const directory = path.join(this.#runsDirectory, runId);
      const run = await this.#readRun(runId);
      if (!run) return undefined;
      const file = run.files.find((candidate) => candidate.name === fileName);
      const filePath = path.join(directory, fileName);
      if (!file || !(await stat(filePath)).isFile()) return undefined;
      const preview = run.preview
        ? { bytes: await readFile(path.join(directory, run.preview.fileName)), mediaType: run.preview.mediaType }
        : undefined;
      return {
        bytes: await readFile(filePath),
        mediaType: file.mediaType,
        ...(file.assetId ? { assetId: file.assetId } : {}),
        ...(preview ? { preview } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async recoverCanvasRun(runId: string, toolId: ToolId, context: ToolJobContext): Promise<ToolRun> {
    const stored = isRunId(runId) ? await this.#readRun(runId) : undefined;
    const owner = stored?.canvasContext;
    if (!stored || stored.toolId !== toolId || !owner || owner.projectId !== context.projectId || owner.boardId !== context.boardId || owner.nodeId !== context.nodeId) {
      throw new ToolRunError("The retained output is unavailable for this canvas node. No new request was submitted.", 409);
    }
    return publicRun(stored);
  }

  async removeRun(runId: string): Promise<void> {
    if (!isRunId(runId)) return;
    await this.agentMedia.delivered(runId);
    await rm(path.join(this.#runsDirectory, runId), { recursive: true, force: true });
  }

  /** Called after project admission is closed and Agent/Canvas work has settled. */
  async removeProject(projectId: string, options: { workspacePath?: string; generationScopes?: readonly string[] } = {}): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) throw new ToolRunError("Invalid project media owner", 400);
    for (const job of this.#jobs.values()) if (job.context?.projectId === projectId && job.status === "running") this.cancelJob(job.id);
    await Promise.allSettled([...this.#pending].filter(([id]) => this.#jobs.get(id)?.context?.projectId === projectId).map(([, pending]) => pending));
    if (this.isProjectBusy(projectId)) throw new ToolRunError("Wait for project media work to finish before deleting its records", 409);
    const recoveryIds = new Set<string>(), runIds = new Set<string>();
    const collect = (job: { recoveryId?: string; id?: string; run?: { id?: string } }) => {
      const recoveryId = job.recoveryId ?? job.id;
      if (recoveryId && /^[a-zA-Z0-9_-]{1,120}$/.test(recoveryId)) recoveryIds.add(recoveryId);
      if (job.run?.id && isRunId(job.run.id)) runIds.add(job.run.id);
    };
    for (const job of this.#jobs.values()) if (job.context?.projectId === projectId) collect(job);
    if (options.workspacePath) for (const job of await projectCanvasJobs(options.workspacePath)) collect(job);
    const records = await this.agentMedia.projectRecords(projectId);
    const scopes = new Set(records.flatMap(record => record.scopes));
    for (const generationScope of [projectId, ...options.generationScopes ?? []]) for (const toolId of TOOL_IDS)
      scopes.add(createHash("sha256").update(JSON.stringify([projectId, generationScope, toolId])).digest("hex"));
    for (const scope of scopes) records.push(...await this.agentMedia.scopeRecords(scope));
    this.agentMedia.assertScopesIdle([...scopes]);
    for (const record of records) { recoveryIds.add(record.recoveryId); for (const runId of record.runIds) runIds.add(runId); }
    const runRecoveries = new Map<string, string>();
    for (const name of await ordinaryDirectoryNames(this.#runsDirectory)) {
      if (!isRunId(name)) continue;
      const run = await this.#readRun(name);
      const recoveryId = run?.recoveryId ?? run?.batchRecoveryId;
      if (recoveryId) runRecoveries.set(name, recoveryId);
      // The output and its original request identity commit together, even if the later owner update was interrupted.
      if (run?.canvasContext?.projectId === projectId || recoveryId && recoveryIds.has(recoveryId)) {
        runIds.add(name); if (recoveryId) recoveryIds.add(recoveryId);
      }
    }
    // Persist legacy ownership before removing anything so a failed cleanup can be retried.
    for (const recoveryId of recoveryIds) await this.agentMedia.trackProject(projectId, recoveryId);
    for (const runId of runIds) await this.agentMedia.trackProject(projectId, runId, { runId });
    const sharedRecovery = new Set<string>(), sharedRuns = new Set<string>();
    for (const record of await this.agentMedia.otherProjectRecords(projectId)) {
      sharedRecovery.add(record.recoveryId); for (const runId of record.runIds) sharedRuns.add(runId);
      for (const scope of record.scopes) scopes.delete(scope);
    }
    const shared = (job: { recoveryId?: string; id?: string; run?: { id?: string } }) => {
      if (job.recoveryId ?? job.id) sharedRecovery.add((job.recoveryId ?? job.id)!);
      if (job.run?.id) sharedRuns.add(job.run.id);
    };
    for (const job of this.#jobs.values()) if (job.context?.projectId !== projectId) shared(job);
    const projects = path.join(this.dataDirectory, "projects");
    for (const id of await ordinaryDirectoryNames(projects)) if (id !== projectId && /^[a-zA-Z0-9_-]{1,120}$/.test(id))
      for (const job of await projectCanvasJobs(path.join(projects, id, "workspace"))) shared(job);
    for (const [runId, recoveryId] of runRecoveries) if (sharedRecovery.has(recoveryId)) sharedRuns.add(runId);
    for (const id of sharedRecovery) recoveryIds.delete(id);
    for (const id of sharedRuns) runIds.delete(id);
    const root = path.dirname(this.#runsDirectory);
    await Promise.all([waitForImageRequests(path.join(root, "image-requests"), recoveryIds), waitForVideoTasks(path.join(root, "video-tasks"), recoveryIds), waitFor3DTasks(path.join(root, "model3d-tasks"), recoveryIds)]);
    for (const runId of runIds) await this.removeRun(runId);
    for (const kind of ["image-requests", "video-tasks", "model3d-tasks", "audio-attempts"]) {
      const directory = path.join(root, kind);
      for (const name of await ordinaryDirectoryNames(directory)) {
        const match = (kind === "image-requests" ? /^([a-zA-Z0-9_-]{1,120})-[0-7]\.json(?:\.|$)/ : /^([a-zA-Z0-9_-]{1,120})\.json(?:\.|$)/).exec(name);
        if (match && recoveryIds.has(match[1]!)) await rm(path.join(directory, name), { recursive: true, force: true });
      }
    }
    for (const [id, job] of this.#jobs) if (job.context?.projectId === projectId) this.#jobs.delete(id);
    await this.#saveJobs();
    await this.agentMedia.removeProject(projectId, [...scopes]);
  }

  async #readRun(runId: string): Promise<StoredToolRun | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.#runsDirectory, runId, "run.json"), "utf8")) as Partial<StoredToolRun>;
      if (value.version !== 1 || value.id !== runId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !isToolId(value.toolId) || !Array.isArray(value.files)) return undefined;
      if (value.files.some((file) => !file || typeof file.name !== "string" || typeof file.mediaType !== "string" ||
        file.assetId !== undefined && typeof file.assetId !== "string")) return undefined;
      return value as StoredToolRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

async function ordinaryDirectoryNames(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Project media storage must be an ordinary directory");
    return await readdir(directory);
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
}

async function projectCanvasJobs(workspace: string): Promise<Array<{ id?: string; recoveryId?: string; run?: { id?: string } }>> {
  try { if (!(await lstat(workspace)).isDirectory()) throw new Error("Canvas media ownership requires an ordinary workspace"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
  const directory = path.join(workspace, "canvas");
  if (!(await ordinaryDirectoryNames(directory)).includes("jobs.json")) return [];
  const handle = await open(path.join(directory, "jobs.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("Canvas media ownership could not be read safely");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!Array.isArray(value)) throw new Error("Invalid Canvas media ownership");
    return value;
  } finally { await handle.close(); }
}

function isPromptImage(value: unknown, allowWebP = false): value is PromptImage {
  if (!value || typeof value !== "object") return false;
  const image = value as { mediaType?: unknown; data?: unknown };
  return (image.mediaType === "image/png" || image.mediaType === "image/jpeg" || (allowWebP && image.mediaType === "image/webp")) && typeof image.data === "string" && image.data.length > 0;
}

function validateVideoReferences(references: VideoGenerationReference[]): void {
  if (!Array.isArray(references) || references.some((reference) => !reference || typeof reference.assetId !== "string" || !reference.assetId || !["image", "audio", "video"].includes(reference.type))) {
    throw new ToolRunError("Invalid video references", 400);
  }
}

function supportedVideoReferenceType(type: VideoGenerationReference["type"], contentType: string): boolean {
  if (type === "image") return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
  if (type === "video") return contentType === "video/mp4" || contentType === "video/quicktime";
  return contentType === "audio/mpeg" || contentType === "audio/wav";
}

function publicRun({ version: _, preview: __, canvasContext: ___, batchRecoveryId: ____, recoveryId: _____, ...run }: StoredToolRun): ToolRun {
  return { ...run, files: run.files.map((file) => ({ ...file })) };
}

function generationProvenance(value: { model?: string | ModelRef; protocol: string; parameters?: Record<string, string | number | boolean>; taskId?: string; taskIds?: string[] }): GenerationProvenance {
  return normalizeGenerationProvenance({
    ...(value.model ? { model: typeof value.model === "string" ? value.model : value.model.id } : {}),
    protocol: value.protocol, parameters: publicGenerationParameters(value.parameters ?? {}),
    ...(value.taskId ? { taskId: value.taskId } : {}), ...(value.taskIds ? { taskIds: value.taskIds } : {}),
  });
}

function publicJob({ input: _, metadata: __, controller: ___, prepared: ____, recoveryId: _____, ...job }: ToolJobRecord): ToolJob {
  return { ...job, ...(job.run ? { run: { ...job.run, files: job.run.files.map((file) => ({ ...file })) } } : {}) };
}

function toolName(toolId: ToolId): string {
  if (toolId === "generate-video") return "Generated Video";
  if (toolId === "image-to-3d") return "Generated 3D Model";
  if (toolId === "animate-3d") return "Animated 3D Model";
  if (toolId === "generate-speech") return "Generated Speech";
  if (toolId === "generate-sound-effect") return "Generated Sound Effect";
  if (toolId === "generate-music") return "Generated Music";
  return "Generated Image";
}

function promptTitle(value?: string): string | undefined {
  const prompt = value?.replace(/\s+/g, " ").trim();
  if (!prompt) return undefined;
  return prompt.length > 60 ? `${prompt.slice(0, 57).trimEnd()}...` : prompt;
}

function assertOnlyKeys(input: RunToolRequest, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new ToolRunError(`Unexpected ${unexpected} option`, 400);
}

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTIONS.includes(value as ImageResolution);
}

function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);
}

function isImageOutputCount(value: unknown): value is ImageOutputCount {
  return typeof value === "number" && IMAGE_OUTPUT_COUNTS.includes(value as ImageOutputCount);
}

function retainedLibraryMedia(ids: string[]): ToolRunError {
  return new ToolRunError(`Generated output is retained in the Library (assets ${ids.join(", ")}). Local saving failed. Use the existing assets; do not regenerate.`, 502, "unknown");
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isToolRunFileName(value: string): boolean {
  return /^(?:output(?:-[1-4])?\.(?:png|jpg|webp)|model(?:-preview)?\.glb|model-original\.fbx|output\.(?:mp4|mp3|wav))$/.test(value);
}

function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && TOOL_IDS.includes(value as ToolId);
}

function imageFileName(mediaType: string, index?: number): string {
  const suffix = index ? `-${index}` : "";
  return mediaType === "image/png" ? `output${suffix}.png` : mediaType === "image/jpeg" ? `output${suffix}.jpg` : `output${suffix}.webp`;
}

function selectedModel(toolId: string, input: RunToolRequest | undefined): ModelRef | undefined {
  if (!input) return undefined;
  if (toolId === "generate-image") return (input as RunImageToolRequest).imageModel;
  if (toolId === "generate-video" || toolId === "image-to-3d" || toolId === "animate-3d") return (input as RunVideoToolRequest | Run3DToolRequest).model;
  if (toolId === "generate-speech" || toolId === "generate-sound-effect" || toolId === "generate-music") return (input as RunSpeechToolRequest | RunSoundEffectToolRequest | RunMusicToolRequest).model;
  return undefined;
}

async function validateTurnaroundImages(images: PromptImage[], maxReferenceImages: number): Promise<void> {
  const guidance = "Inspect and provide separate full-object front, left, and back references in that order; right is optional. No generation was submitted.";
  if (maxReferenceImages < 3) throw new ToolRunError(`This model cannot accept a turnaround. Choose a multi-view model with at least three reference slots. ${guidance}`, 400);
  if (images.length < 3 || images.length > Math.min(4, maxReferenceImages)) throw new ToolRunError(guidance, 400);
  const views = new Set<string>();
  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    if (sniffImageType(bytes) !== image.mediaType) throw new ToolRunError(`Invalid reference image format. ${guidance}`, 400);
    let identity: string;
    try { identity = await decodedReferenceIdentity(bytes); }
    catch { throw new ToolRunError(`Could not decode a reference as a PNG or JPEG within the image limits (32 MiB, 32 megapixels). ${guidance}`, 400); }
    if (views.has(identity)) throw new ToolRunError(`Two view slots contain the same image. ${guidance}`, 400);
    views.add(identity);
  }
}

function validate3DOptions(options: Run3DToolRequest["options"]): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["referenceMode", "pose", "textureModel", "textureQuality", "rigModel", "rigType", "animateInPlace", "quad", "smartUv", "geometryQuality"].includes(key))) throw new ToolRunError("Invalid 3D options", 400);
  if (options.referenceMode !== undefined && !["turnaround", "provided-views"].includes(options.referenceMode)
    || options.pose !== undefined && !["a-pose", "t-pose"].includes(options.pose)
    || options.textureQuality !== undefined && !["fast", "standard", "detailed", "extreme"].includes(options.textureQuality)
    || options.rigModel !== undefined && !["v1.0-20240301", "v2.5-20260210", "v3.0-20260909"].includes(options.rigModel)
    || options.rigType !== undefined && !["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"].includes(options.rigType)
    || options.quad !== undefined && typeof options.quad !== "boolean"
    || options.smartUv !== undefined && typeof options.smartUv !== "boolean"
    || options.geometryQuality !== undefined && !["standard", "detailed"].includes(options.geometryQuality)
    || options.animateInPlace !== undefined && typeof options.animateInPlace !== "boolean"
    || options.textureModel !== undefined && (typeof options.textureModel !== "string" || !options.textureModel || options.textureModel.length > 120)) throw new ToolRunError("Unsupported 3D option", 400);
}

function validateOperationOptions(options: Run3DToolRequest["options"], operation: string, protocol?: string): void {
  const allowed = model3DOptionFields(protocol, operation);
  const unsupported = Object.entries(options ?? {}).filter(([key, value]) => value !== undefined && !allowed.includes(key)).map(([key]) => key);
  if (unsupported.length) throw new ToolRunError(`These options are not supported by the selected 3D operation. Unsupported keys: ${unsupported.join(", ")}. Allowed for ${protocol ?? "this provider"} ${operation}: ${allowed.join(", ") || "none"}`, 400);
}

function model3DToolError(cause: unknown): never {
  if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode, !cause.notSubmitted && cause.statusCode === 502 ? "unknown" : undefined, undefined, undefined, cause.notSubmitted);
  throw cause;
}

interface GenerationLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}
