import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GPT_IMAGE_FORMATS, isGptImage26 } from "../shared/gpt-image-26.js";
import { validateGeneratedImage } from "./generated-image-format.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { parseProviderUrl } from "../shared/provider-endpoint.js";
import { normalizeGenerationProvenance } from "./asset-library.js";
import { ImageGenerationError, type ImageExecution, type ImageSubmission } from "./openai-image.js";

type SavedImageResult = Pick<ImageSubmission, "generation" | "requestId"> & ({ url: string } | { byteLength: number });

interface ImageJournalEntry {
  version: 1;
  fingerprint: string;
  state: "submitting" | "ready";
  result?: SavedImageResult;
}

const submissions = new Map<string, Promise<unknown>>();

export async function waitForImageRequests(directory: string, ids: ReadonlySet<string>): Promise<void> {
  const files = new Set([...ids].flatMap(id => Array.from({ length: 8 }, (_, index) => path.resolve(directory, `${id}-${index}.json`))));
  for (;;) {
    const pending = [...submissions].filter(([file]) => files.has(file)).map(([, promise]) => promise);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

async function readImageEntry(file: string): Promise<ImageJournalEntry | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    let value: ImageJournalEntry;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) throw new Error();
      const stored = await handle.readFile("utf8");
      if (containsKnownSensitiveValue(stored)) throw new Error();
      value = JSON.parse(stored) as ImageJournalEntry;
    } finally { await handle.close(); }
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !["submitting", "ready"].includes(value.state)) throw new Error();
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ImageGenerationError("The image recovery record could not be read safely", 409);
  }
}

export async function hasSavedImageSlot(directory: string, recoveryId: string, index: number): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(recoveryId) || !Number.isInteger(index) || index < 0 || index >= 8) return false;
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const file = path.join(directory, `${recoveryId}-${index}.json`);
    const entry = await readImageEntry(file);
    if (entry?.state !== "ready") return false;
    const saved = safeSavedResult(entry.result);
    if ("url" in saved) return true;
    const info = await lstat(`${file}.result`);
    return info.isFile() && info.nlink === 1 && info.size === saved.byteLength;
  } catch { return false; }
}

/** Capability only: never creates a record or returns a private artifact URL. */
export async function hasSavedImageResult(directory: string, recoveryId: string, outputs = 1): Promise<boolean> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(recoveryId) || !Number.isInteger(outputs) || outputs < 1 || outputs > 8) return false;
  for (let index = 0; index < outputs; index++) if (!await hasSavedImageSlot(directory, recoveryId, index)) return false;
  return true;
}

/** Sync image APIs have no recoverable task ID. Never turn an uncertain POST into a new paid request. */
export async function imageRequestJournal(directory: string, recoveryId: string, recoveryOnly = false): Promise<ImageExecution> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(recoveryId)) throw new ImageGenerationError("Invalid image recovery ID", 400);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new ImageGenerationError("Linked image recovery directories are unavailable", 409);
  await chmod(directory, 0o700);
  const file = path.resolve(directory, `${recoveryId}.json`);
  const save = async (entry: ImageJournalEntry | Buffer, createOnly = false) => {
    const destination = Buffer.isBuffer(entry) ? `${file}.result` : file;
    const temporary = createOnly ? destination : `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(Buffer.isBuffer(entry) ? entry : JSON.stringify(entry)); await handle.sync(); }
      finally { await handle.close(); }
      if (!createOnly) await rename(temporary, destination);
    } catch (error) {
      if (createOnly && (error as NodeJS.ErrnoException).code === "EEXIST") throw new ImageGenerationError("Another operation already owns this image submission. Review the original request.", 409, true);
      throw error;
    } finally { if (!createOnly) await rm(temporary, { force: true }); }
  };
  return {
    recoveryOnly,
    async submitted(scope, input, create, signal) {
      const pending = (submissions.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        signal?.throwIfAborted();
        const fingerprint = createHash("sha256").update(scope).update(JSON.stringify(input)).digest("hex");
        const previous = await readImageEntry(file);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ImageGenerationError("The image input or provider changed. Restore the original settings to recover, or start a new generation.", 409);
          if (previous.state === "ready") {
            const saved = safeSavedResult(previous.result);
            if ("url" in saved) return saved;
            return readSavedInline(file, saved);
          }
          throw new ImageGenerationError("The previous image submission could not be confirmed. Retry will not submit another paid request; check the provider before starting a new generation.", 409, true);
        }
        if (recoveryOnly) throw new ImageGenerationError("No saved image result is available. Recovery never submits a new generation; check the provider record.", 409, true);
        // An orphan original is still evidence of a paid request (even if its receipt was removed).
        try {
          await lstat(`${file}.result`);
          throw new ImageGenerationError("An original image already exists for this request. Review the retained result before generating again.", 409, true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await save({ version: 1, fingerprint, state: "submitting" }, true);
        if (signal?.aborted) { await rm(file, { force: true }); signal.throwIfAborted(); }
        let result: ImageSubmission;
        try { result = await create(); }
        catch (cause) {
          if (cause instanceof ImageGenerationError && (cause.notSubmitted || [400, 401, 403, 429].includes(cause.statusCode) && !cause.outcomeUnknown)) await rm(file, { force: true });
          throw cause;
        }
        if (result.url) {
          const saved = safeSavedResult(result);
          await save({ version: 1, fingerprint, state: "ready", result: saved });
        } else if (result.inline && isGptImage26(result.generation.model)) {
          const saved = safeSavedResult({ byteLength: result.inline.bytes.length, requestId: result.inline.requestId, generation: result.generation });
          // Recovery requires both files. Publish the original last so a crash cannot hide committed bytes.
          await save({ version: 1, fingerprint, state: "ready", result: saved });
          await save(result.inline.bytes);
        }
        return result;
      });
      submissions.set(file, pending);
      const clear = () => { if (submissions.get(file) === pending) submissions.delete(file); };
      void pending.then(clear, clear);
      if (!signal) return pending;
      signal.throwIfAborted();
      return new Promise<ImageSubmission>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Image request cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        void pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (cause) => { signal.removeEventListener("abort", abort); reject(cause); });
      });
    },
  };
}

function safeSavedResult(value: unknown): NonNullable<ImageJournalEntry["result"]> {
  try {
    const result = value as ImageSubmission & { byteLength?: number };
    if (result.requestId !== undefined && (typeof result.requestId !== "string" || result.requestId.length > 256 || /[\0-\x1f\x7f]/.test(result.requestId) || containsKnownSensitiveValue(result.requestId))) throw new Error();
    const { provider, ...generation } = result.generation;
    if (generation.protocol !== "openai-images" || typeof generation.model !== "string" || provider !== undefined && (typeof provider !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,199}$/i.test(provider) || containsKnownSensitiveValue(provider))) throw new Error();
    const safe = normalizeGenerationProvenance(generation);
    const metadata = { ...(result.requestId === undefined ? {} : { requestId: result.requestId }), generation: { ...safe, model: generation.model, protocol: "openai-images" as const, ...(provider === undefined ? {} : { provider }) } };
    if (result.byteLength !== undefined) {
      if (result.url !== undefined || !isGptImage26(generation.model) || !GPT_IMAGE_FORMATS.some(f => f === safe.parameters.output_format)
        || !Number.isSafeInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > 64 * 1024 * 1024) throw new Error();
      return { byteLength: result.byteLength, ...metadata };
    }
    if (typeof result.url !== "string" || result.url.length > 16_384 || !result.url || containsKnownSensitiveValue(result.url)) throw new Error();
    const url = parseProviderUrl(result.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return { url: result.url, ...metadata };
  } catch { throw new ImageGenerationError("Invalid image recovery result", 409); }
}

async function readSavedInline(file: string, saved: Extract<SavedImageResult, { byteLength: number }>): Promise<ImageSubmission> {
  try {
    const handle = await open(`${file}.result`, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== saved.byteLength) throw new Error();
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const { generation, requestId } = saved;
    const params = generation.parameters;
    const format = GPT_IMAGE_FORMATS.find(f => f === params.output_format);
    if (!format || bytes.length !== saved.byteLength || containsKnownSensitiveValue(bytes.toString("utf8"))) throw new Error();
    await validateGeneratedImage(bytes, format, { frameCount: Number(params.frame_count), frameDurationMs: Number(params.frame_duration_ms) });
    return { generation, requestId, inline: { bytes, mediaType: format === "svg" ? "image/svg+xml" : `image/${format}`, generation, requestId } };
  } catch { throw new ImageGenerationError("The saved original image is missing or invalid; review the existing request before generating again.", 409); }
}
