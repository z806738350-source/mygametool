import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Model3DMetadata } from "../shared/contracts.js";
import { knownSensitiveValueRevision } from "../shared/sensitive-values.js";
import { assertNoKnownSecretBytes } from "./safe-project-file.js";
import { Model3DGenerationError } from "./model3d.js";
import { GLB_LIMITS, type GlbPreflightSummary } from "./glb-preflight.js";
import type { GlbMergeProof } from "./glb-merge.js";

export interface InspectedModelResources {
  metadata: Model3DMetadata;
  preflight: GlbPreflightSummary;
  resources?: Map<string, Buffer>;
  resourceFailure?: { code: "budget" | "unsupported"; message: string };
}
const cache = new Map<
  string,
  Pick<InspectedModelResources, "metadata" | "preflight">
>();
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let pendingBytes = 0;
let uncertain = false;
const uncertainErrors = new WeakSet<object>();
export function isModel3DParserUncertain(value: unknown): boolean {
  return !!value && typeof value === "object" && uncertainErrors.has(value);
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function failure(code: string): Error {
  const text: Record<string, string> = {
    GLB_INVALID: "Invalid GLB model; the original result is retained.",
    GLB_LIMIT:
      "GLB inspection exceeds the bounded resource budget; the original result is retained. Do not regenerate to repair this result.",
    GLB_UNSUPPORTED:
      "This GLB uses an unsupported codec, extension or layout; the original result is retained without conversion.",
    GLB_POLICY:
      "GLB data or protected-data policy changed during inspection; no parsed result was published.",
    GLB_TIMEOUT:
      "Local GLB inspection timed out; the original result is retained.",
    GLB_BUSY:
      "Local GLB inspection queue is full; close pending inspections before trying again.",
    GLB_UNCERTAIN:
      "Local GLB parser shutdown could not be confirmed; further parsing is blocked until the application restarts.",
  };
  const error = new Model3DGenerationError(
    text[code] ??
      "Invalid GLB model: bounded local parsing failed; the original result is retained.",
    code === "GLB_UNCERTAIN" ? 503 : 400,
  );
  if (code === "GLB_UNCERTAIN") uncertainErrors.add(error);
  return error;
}
function source(
  bytes: Buffer,
  signal?: AbortSignal,
): { sha256: string; revision: number } {
  signal?.throwIfAborted();
  if (uncertain) throw failure("GLB_UNCERTAIN");
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.buffer instanceof SharedArrayBuffer ||
    bytes.length < 20 ||
    bytes.length > GLB_LIMITS.encodedBytes
  )
    throw failure("GLB_INVALID");
  assertNoKnownSecretBytes(bytes);
  return { sha256: digest(bytes), revision: knownSensitiveValueRevision() };
}
function remember(
  sha256: string,
  value: Pick<InspectedModelResources, "metadata" | "preflight">,
): void {
  cache.delete(sha256);
  cache.set(
    sha256,
    structuredClone({ metadata: value.metadata, preflight: value.preflight }),
  );
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
}
function exactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, any> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}
function transferred(
  value: unknown,
  maximum: number,
): value is Uint8Array<ArrayBuffer> {
  return (
    value instanceof Uint8Array &&
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength &&
    value.byteLength > 0 &&
    value.byteLength <= maximum
  );
}
function decodeResult(
  value: unknown,
  mode: string,
  sha256: string,
): InspectedModelResources & { bytes?: Buffer; mergeProof?: GlbMergeProof } {
  if (!value || typeof value !== "object") throw failure("GLB_INVALID");
  const result = value as Record<string, any>;
  const keys = [
    "metadata",
    "preflight",
    "measurement",
    ...(mode === "merge"
      ? ["bytes", "mergeProof"]
      : mode === "face"
        ? ["bytes"]
        : mode === "split"
          ? [result.resources ? "resources" : "resourceFailure"]
          : []),
  ];
  if (!exactKeys(result, keys)) throw failure("GLB_INVALID");
  const metadata = result.metadata,
    preflight = result.preflight;
  if (
    !exactKeys(metadata, [
      "triangles",
      "textured",
      "rigged",
      "animations",
      ...(metadata?.animationClips ? ["animationClips"] : []),
    ]) ||
    !Number.isSafeInteger(metadata.triangles) ||
    metadata.triangles < 1 ||
    typeof metadata.textured !== "boolean" ||
    typeof metadata.rigged !== "boolean" ||
    !Array.isArray(metadata.animations) ||
    metadata.animations.length > GLB_LIMITS.animations ||
    metadata.animations.some(
      (name: unknown) => typeof name !== "string" || name.length > 256,
    )
  )
    throw failure("GLB_INVALID");
  if (
    metadata.animationClips !== undefined &&
    (!Array.isArray(metadata.animationClips) ||
      metadata.animationClips.length !== metadata.animations.length ||
      metadata.animationClips.some(
        (clip: any, index: number) =>
          !exactKeys(clip, ["name", "channels", "durationSeconds"]) ||
          clip.name !== metadata.animations[index] ||
          !Number.isSafeInteger(clip.channels) ||
          clip.channels < 0 ||
          !Number.isFinite(clip.durationSeconds) ||
          clip.durationSeconds < 0,
      ))
  )
    throw failure("GLB_INVALID");
  if (
    !exactKeys(preflight, [
      "version",
      "sha256",
      "encodedBytes",
      "jsonBytes",
      "binBytes",
      "accessorAllocationBytes",
      "sparseAllocationBytes",
      "imageAllocationBytes",
      "readerAllocationBytes",
      "accessorCount",
      "imageCount",
      "textureDecoding",
    ]) ||
    preflight.version !== 1 ||
    preflight.sha256 !== sha256 ||
    preflight.textureDecoding !== "not-performed" ||
    Object.entries(preflight).some(
      ([key, entry]) =>
        !["sha256", "textureDecoding"].includes(key) &&
        (!Number.isSafeInteger(entry) || Number(entry) < 0),
    ) ||
    preflight.readerAllocationBytes > GLB_LIMITS.readerAllocationBytes ||
    preflight.encodedBytes > GLB_LIMITS.encodedBytes ||
    preflight.jsonBytes > GLB_LIMITS.jsonBytes
  )
    throw failure("GLB_INVALID");
  assertNoKnownSecretBytes(Buffer.from(JSON.stringify(metadata)));
  const output: InspectedModelResources & {
    bytes?: Buffer;
    mergeProof?: GlbMergeProof;
  } = {
    metadata: metadata as unknown as Model3DMetadata,
    preflight: preflight as unknown as GlbPreflightSummary,
  };
  if (mode === "face" || mode === "merge") {
    if (!transferred(result.bytes, GLB_LIMITS.encodedBytes))
      throw failure("GLB_INVALID");
    output.bytes = Buffer.from(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    );
    assertNoKnownSecretBytes(output.bytes);
  }
  if (mode === "merge") {
    const proof = result.mergeProof;
    if (
      !exactKeys(proof, [
        "version",
        "compatibility",
        "inputSha256",
        "inputBytes",
        "outputSha256",
        "outputBytes",
        "copiedAccessors",
        "copiedViews",
        "renamedClips",
      ]) ||
      proof.version !== 1 ||
      proof.compatibility !== "exact-model-semantic-v1" ||
      !Array.isArray(proof.inputSha256) ||
      proof.inputSha256.length !== 2 ||
      proof.inputSha256.some(
        (sha: unknown) =>
          typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha),
      ) ||
      proof.outputSha256 !== sha256 ||
      proof.outputBytes !== output.bytes!.length ||
      !Number.isSafeInteger(proof.inputBytes) ||
      proof.inputBytes < 40 ||
      proof.inputBytes > 2 * GLB_LIMITS.encodedBytes ||
      !Number.isSafeInteger(proof.copiedAccessors) ||
      proof.copiedAccessors < 0 ||
      proof.copiedAccessors > GLB_LIMITS.objects ||
      !Number.isSafeInteger(proof.copiedViews) ||
      proof.copiedViews < 0 ||
      proof.copiedViews > GLB_LIMITS.objects ||
      !Array.isArray(proof.renamedClips) ||
      proof.renamedClips.length > GLB_LIMITS.animations ||
      proof.renamedClips.some(
        (clip: any) =>
          !exactKeys(clip, ["input", "index", "from", "to"]) ||
          ![0, 1].includes(clip.input) ||
          !Number.isSafeInteger(clip.index) ||
          clip.index < 0 ||
          typeof clip.from !== "string" ||
          !clip.from ||
          clip.from.length > 256 ||
          typeof clip.to !== "string" ||
          !clip.to ||
          clip.to.length > 256,
      ) ||
      Buffer.byteLength(JSON.stringify(proof)) > 128 * 1024
    )
      throw failure("GLB_INVALID");
    assertNoKnownSecretBytes(Buffer.from(JSON.stringify(proof)));
    output.mergeProof = proof as unknown as GlbMergeProof;
  }
  if (mode === "split") {
    if (result.resources) {
      if (
        !Array.isArray(result.resources) ||
        !result.resources.length ||
        result.resources.length > 1901
      )
        throw failure("GLB_INVALID");
      const files = new Map<string, Buffer>();
      let total = 0;
      for (const file of result.resources) {
        if (
          !exactKeys(file, ["name", "bytes"]) ||
          typeof file.name !== "string" ||
          !/^(?:model\.gltf|buffer-\d+\.bin|texture-\d+\.(?:png|jpg|webp))$/.test(
            file.name,
          ) ||
          files.has(file.name) ||
          !transferred(file.bytes, GLB_LIMITS.sourceFileBytes)
        )
          throw failure("GLB_INVALID");
        total += file.bytes.byteLength;
        if (total > GLB_LIMITS.sourceBytes) throw failure("GLB_LIMIT");
        const bytes = Buffer.from(
          file.bytes.buffer,
          file.bytes.byteOffset,
          file.bytes.byteLength,
        );
        assertNoKnownSecretBytes(bytes);
        files.set(file.name, bytes);
      }
      if (!files.has("model.gltf")) throw failure("GLB_INVALID");
      output.resources = files;
    } else {
      if (
        !exactKeys(result.resourceFailure, ["code", "message"]) ||
        !["budget", "unsupported"].includes(result.resourceFailure.code)
      )
        throw failure("GLB_INVALID");
      output.resourceFailure = {
        code: result.resourceFailure.code,
        message:
          result.resourceFailure.code === "budget"
            ? "Model resources exceed the unchanged 2 MiB per-file or 8 MiB aggregate source budget"
            : "This GLB cannot be split under the inspected allocation contract; the original is retained",
      };
    }
  }
  return output;
}
async function run(
  sourceInputs: readonly Buffer[],
  mode: "inspect" | "face" | "split" | "merge" | "animation-batch",
  signal?: AbortSignal,
) {
  const inputs = [...sourceInputs];
  if (inputs.length !== (mode === "merge" ? 2 : 1))
    throw failure("GLB_INVALID");
  const initial = inputs.map((bytes) => source(bytes, signal)),
    inputBytes = inputs.reduce((sum, bytes) => sum + bytes.length, 0);
  if (pending >= 2 || pendingBytes + inputBytes > 200 * 1024 * 1024)
    throw failure("GLB_BUSY");
  pending++;
  pendingBytes += inputBytes;
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  try {
    if (signal)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
    else await previous;
    entered = true;
    signal?.throwIfAborted();
    if (uncertain) throw failure("GLB_UNCERTAIN");
    if (
      initial.some(
        (snapshot, index) =>
          knownSensitiveValueRevision() !== snapshot.revision ||
          digest(inputs[index]!) !== snapshot.sha256,
      )
    )
      throw failure("GLB_POLICY");
    for (const bytes of inputs) assertNoKnownSecretBytes(bytes);
    // Each pair member has exactly one owned transfer, never an all-batch structured clone.
    const owned = inputs.map((bytes) => {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return copy;
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      const ts = import.meta.url.endsWith(".ts");
      let worker: Worker;
      try {
        worker = new Worker(
          new URL(
            ts ? "./glb-parser-bootstrap.mjs" : "./glb-parser-worker.js",
            import.meta.url,
          ),
          {
            workerData:
              mode === "merge"
                ? {
                    mode,
                    inputs: owned.map((bytes, index) => ({
                      bytes,
                      sha256: initial[index]!.sha256,
                    })),
                  }
                : { bytes: owned[0], mode, sha256: initial[0]!.sha256 },
            transferList: owned.map((bytes) => bytes.buffer),
            env: {},
            stdout: true,
            stderr: true,
            execArgv: [],
            // V8 heap stop-loss only. External ArrayBuffer bounds come from preflight, not resourceLimits.
            resourceLimits: {
              maxOldGenerationSizeMb: 256,
              maxYoungGenerationSizeMb: 32,
              stackSizeMb: 4,
            },
          },
        );
      } catch {
        reject(failure("GLB_PARSE_FAILED"));
        return;
      }
      worker.stdout?.resume();
      worker.stderr?.resume();
      let finished = false;
      const finish = (error?: unknown, output?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void (async () => {
          try {
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                worker.terminate(),
                new Promise<never>((_resolve, reject) => {
                  cleanupTimer = setTimeout(
                    () => reject(new Error("GLB termination unconfirmed")),
                    5_000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(cleanupTimer);
            }
          } catch {
            uncertain = true;
            reject(failure("GLB_UNCERTAIN"));
            return;
          }
          if (error) reject(error);
          else resolve(output);
        })();
      };
      const abort = () =>
        finish(signal?.reason ?? new Error("Local GLB inspection cancelled"));
      const timer = setTimeout(() => finish(failure("GLB_TIMEOUT")), 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: unknown) => {
        if (exactKeys(message, ["ok", "result"]) && message.ok === true)
          finish(undefined, message.result);
        else if (
          exactKeys(message, ["ok", "code"]) &&
          message.ok === false &&
          typeof message.code === "string" &&
          [
            "GLB_INVALID",
            "GLB_LIMIT",
            "GLB_UNSUPPORTED",
            "GLB_PARSE_FAILED",
          ].includes(message.code)
        )
          finish(failure(message.code));
        else finish(failure("GLB_INVALID"));
      });
      worker.once("error", () => finish(failure("GLB_PARSE_FAILED")));
      worker.once("exit", () => finish(failure("GLB_PARSE_FAILED")));
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    if (
      initial.some(
        (snapshot, index) =>
          knownSensitiveValueRevision() !== snapshot.revision ||
          digest(inputs[index]!) !== snapshot.sha256,
      )
    )
      throw failure("GLB_POLICY");
    let outputSha = initial[0]!.sha256;
    if (mode === "merge") {
      const data = result as { bytes?: unknown };
      if (!transferred(data?.bytes, GLB_LIMITS.encodedBytes))
        throw failure("GLB_INVALID");
      outputSha = digest(data.bytes);
    }
    const value = decodeResult(result, mode, outputSha);
    if (mode === "merge") {
      if (
        value.mergeProof!.inputBytes !== inputBytes ||
        value.mergeProof!.inputSha256.some(
          (sha, index) => sha !== initial[index]!.sha256,
        )
      )
        throw failure("GLB_INVALID");
    } else remember(initial[0]!.sha256, value);
    if (value.bytes)
      remember(digest(value.bytes), {
        metadata: value.metadata,
        preflight: {
          ...value.preflight,
          sha256: digest(value.bytes),
          encodedBytes: value.bytes.length,
        },
      });
    return value;
  } finally {
    pending--;
    pendingBytes -= inputBytes;
    if (entered) release();
    else void previous.then(release, release);
  }
}

/** One bounded worker, no texture decoding, and metadata-only SHA cache (32 entries). */
export async function inspectModel3D(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Model3DMetadata> {
  const { sha256 } = source(bytes, signal),
    found = cache.get(sha256);
  if (found) {
    assertNoKnownSecretBytes(Buffer.from(JSON.stringify(found.metadata)));
    return structuredClone(found.metadata);
  }
  return (await run([bytes], "inspect", signal)).metadata;
}
export function inspectAndSplitModel3D(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<InspectedModelResources> {
  return run([bytes], "split", signal);
}
/** Pure JSON scene wrappers preserve original BIN bytes and bone/animation indices. No NodeIO writer is used. */
export async function modelFacingPositiveZ(
  bytes: Buffer,
  axis?: Model3DMetadata["forwardAxis"],
  signal?: AbortSignal,
): Promise<Buffer> {
  if (axis !== "+X") {
    await inspectModel3D(bytes, signal);
    return bytes;
  }
  return (await run([bytes], "face", signal)).bytes!;
}

/** Incremental pair merge: callers retain each original batch before invoking this pure conversion. */
export async function mergeModel3DBatches(
  base: Buffer,
  next: Buffer,
  signal?: AbortSignal,
): Promise<{
  bytes: Buffer;
  metadata: Model3DMetadata;
  preflight: GlbPreflightSummary;
  proof: GlbMergeProof;
}> {
  const result = await run([base, next], "merge", signal);
  return {
    bytes: result.bytes!,
    metadata: result.metadata,
    preflight: result.preflight,
    proof: result.mergeProof!,
  };
}

/** Always validates merge eligibility in the worker; a generic metadata cache hit is insufficient. */
export async function inspectModel3DAnimationBatch(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Model3DMetadata> {
  return (await run([bytes], "animation-batch", signal)).metadata;
}
