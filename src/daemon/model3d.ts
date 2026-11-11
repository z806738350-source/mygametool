import type { Model3DAnimationAction, Model3DActionId, Model3DBalance, Model3DMetadata, Model3DOperation, Model3DOptions, Model3DModel, Model3DModelRef, PromptImage } from "../shared/contracts.js";

export type { Model3DAnimationAction };

export interface Model3DGenerationInput {
  operation?: Exclude<Model3DOperation, "animate">;
  prompt?: string;
  source?: Buffer;
  options?: Model3DOptions;
  execution?: Model3DExecution;
  model: Model3DModelRef;
  images: PromptImage[];
  targetPolycount?: number;
  texture?: boolean;
  pbr?: boolean;
}

export interface Model3DAnimationInput {
  /** A GLB suitable for the selected provider and rig type. */
  model: Buffer;
  actionIds: Model3DActionId[];
  providerModel?: Model3DModelRef;
  options?: Model3DOptions;
  forwardAxis?: Model3DMetadata["forwardAxis"];
  execution?: Model3DExecution;
  heightMeters?: number;
}

export interface Generated3DModel {
  bytes: Buffer;
  mediaType: "model/gltf-binary" | "application/vnd.autodesk.fbx";
  requestId?: string;
  metadata?: Partial<Model3DMetadata>;
}

export interface Model3DGenerator {
  /** Policy-only admission; no credentials, task submission or remote recovery. */
  assertGenerationAllowed?(model?: Model3DModelRef): Promise<void>;
  assertOperationAllowed?(model?: Model3DModelRef): Promise<void>;
  generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel>;
  /** Rigging and animation; providers without it cannot animate models. */
  animate?(input: Model3DAnimationInput, signal?: AbortSignal): Promise<Generated3DModel>;
  animations?(signal?: AbortSignal, model?: Model3DModelRef, options?: Model3DOptions): Promise<Model3DAnimationAction[]>;
  operationModels?(): Promise<Model3DModel[]>;
  balance?(model: Model3DModelRef, signal?: AbortSignal): Promise<Model3DBalance>;
  resolveOperationModel?(model: Model3DModelRef | undefined, operation: Model3DOperation): Promise<Model3DModel | undefined>;
  resolveModel?(model?: Model3DModelRef): Promise<Model3DModel | undefined>;
}

/** Private durable task credentials; never sent to the renderer. */
export interface Model3DExecution {
  /** Recovery may only query/download recorded stages, never create an upload or task. */
  readonly recoveryOnly?: boolean;
  /** Private saved stage results (downloads or bounded local merge proofs); an omitted callback performs a cache-only read. */
  result?(stage: string, taskId: string, download?: () => Promise<Buffer>): Promise<Buffer | undefined>;
  submitted<T extends Record<string, string>>(stage: string, scope: string, input: unknown, create: () => Promise<T>): Promise<T>;
}
export class Model3DGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly notSubmitted = false) {
    super(message);
  }
}

/** Bound downloaded artifacts while streaming, before allocating a complete GLB. */
export async function readModel3DResult(response: Response, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const maximum = 100 * 1024 * 1024;
  if (!response.body) throw new Model3DGenerationError("Generated model download is empty");
  if (Number(response.headers.get("content-length")) > maximum) {
    void response.body.cancel().catch(() => {});
    throw new Model3DGenerationError("Generated model is too large", 413);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 120_000);
  const bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  bounded.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      bounded.throwIfAborted();
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) { bounded.removeEventListener("abort", abort); reject(bounded.reason); return; }
        void reader.read().then((value) => { bounded.removeEventListener("abort", abort); resolve(value); }, (cause) => { bounded.removeEventListener("abort", abort); reject(cause); });
      });
      bounded.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Model3DGenerationError("Generated model is too large", 413);
      chunks.push(value);
    }
  } catch (cause) {
    if (timeout.signal.aborted && !signal?.aborted) throw new Model3DGenerationError("Generated model download timed out; resume the existing task", 504);
    throw cause;
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A cancelled native reader may still be settling. */ }
  }
  if (!size) throw new Model3DGenerationError("Generated model download is empty");
  return Buffer.concat(chunks);
}
