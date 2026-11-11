import type { VideoAspectRatio, VideoGenerationReference, VideoModelRef, VideoResolution, VideoReferenceMode, VideoRequestDiagnostic } from "../shared/contracts.js";
import type { VideoReferencePreparation } from "../shared/video-reference-preparation.js";

export interface VideoGenerationInput {
  prompt: string;
  referenceMode?: VideoReferenceMode;
  model?: VideoModelRef;
  references?: VideoReferenceAsset[];
  duration?: number;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  /** Stable across retries/restarts of the same paid generation. */
  execution?: VideoExecution;
}

export interface VideoExecution {
  readonly recoveryOnly?: boolean;
  submissionStarted?(): Promise<void>;
  referencePrepared?(summary: VideoReferencePreparation): Promise<void>;
  submitted<T extends Record<string, string>>(stage: string, scope: string, input: unknown, create: () => Promise<T>): Promise<T>;
}

export interface GeneratedVideo {
  bytes: Buffer;
  mediaType: "video/mp4";
  requestId?: string;
  metadata?: {
    model: VideoModelRef;
    protocol: "seedance" | "kunpo-videos";
    parameters: Record<string, string | number | boolean>;
    taskId: string;
  };
}

export interface VideoGenerator {
  assertGenerationAllowed?(model?: VideoModelRef): Promise<void>;
  generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo>;
}

export interface VideoReferenceAsset {
  type: VideoGenerationReference["type"];
  name: string;
  mediaType: string;
  absolutePath: string;
  duration?: number;
}

/** These protocols poll by a stable task ID and never need the original POST again. */
export async function existingOrNewVideoTask(
  execution: VideoExecution | undefined, scope: string, body: string, submit: () => Promise<string | undefined>,
): Promise<string> {
  const create = async () => {
    if (execution?.recoveryOnly) throw new VideoGenerationError("Video recovery cannot submit a new task.", 409);
    await execution?.submissionStarted?.();
    const taskId = await submit();
    if (!taskId || !/^[a-zA-Z0-9_-]{1,200}$/.test(taskId)) throw new VideoGenerationError("The provider returned no valid video task ID. Check the provider before starting another generation.");
    return { taskId };
  };
  const result = execution ? await execution.submitted("generate", scope, body, create) : await create();
  return result.taskId;
}

/** Closed numeric receipt only; source URLs remain daemon-private and are not needed for task polling. */
export function videoReferenceTransport(task: Record<string, string>): { referenceUrlCount: number; referenceLocalCount: number } | undefined {
  const url = task.referenceUrlCount, local = task.referenceLocalCount;
  if (!/^(0|[1-9][0-9]?)$/.test(url ?? "") || !/^(0|[1-9][0-9]?)$/.test(local ?? "") || Number(url) + Number(local) > 30) return undefined;
  return { referenceUrlCount: Number(url), referenceLocalCount: Number(local) };
}

export class VideoGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly notSubmitted = false, readonly diagnostic?: VideoRequestDiagnostic) {
    super(message);
  }
}
