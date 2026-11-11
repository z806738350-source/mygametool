import { readFile, stat } from "node:fs/promises";
import { getGlobalDispatcher } from "undici/index.js";
import type { VideoModel, VideoRequestDiagnostic } from "../shared/contracts.js";
import { providerControlUrl, providerCredentialValues, providerRequest, fetchProviderArtifact, providerArtifactUrl, KUNPO_NATIVE_VIDEO_ORIGIN, ProviderRequestError, providerErrorCode, assertProviderBytes } from "./provider-network.js";
import { VideoGenerationError, type GeneratedVideo, type VideoGenerationInput, type VideoReferenceAsset } from "./video-generation.js";
import { optimizeVideoReferencePng } from "./video-reference-png.js";
import { prepareVideoReferenceJpeg } from "./video-reference-jpeg.js";
import { fitVideoReferenceBudget, type LocalVideoImage } from "./video-reference-budget.js";
import { parseVideoReferencePreparation, VIDEO_REFERENCE_BUDGET_ERROR, type VideoReferencePreparation } from "../shared/video-reference-preparation.js";
import { matchingKunpoImageUrl } from "./provider-image-source.js";
import { videoReferenceTransport } from "./video-generation.js";

const SEEDANCE = "doubao-seedance-2-5-260628";
const VS = "tencent-vod-vs-2.5";
const H3 = "minimax-video-h3";
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_WAIT_MS = 15 * 60_000;
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export function isKunpoVideoModel(id: string): boolean { return [SEEDANCE, VS, H3].includes(id); }

export interface KunpoVideoSource {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authentication?: "api_key" | "none";
}

/** Each protocol has its own states; task IDs are never submitted to another protocol's poller. */
export class KunpoVideoProvider {
  constructor(private readonly source: KunpoVideoSource, private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = 10_000, private readonly maxWaitMs = MAX_VIDEO_WAIT_MS) {}

  async generate(model: VideoModel, input: VideoGenerationInput, callerSignal?: AbortSignal): Promise<GeneratedVideo> {
    const control = providerControlUrl(this.source.baseUrl, true);
    if (!isKunpoVideoModel(model.id)) throw new VideoGenerationError("Unsupported Kunpo video model", 400);
    if (!this.source.apiKey && this.source.authentication !== "none") throw new VideoGenerationError("Kunpo API key is not configured", 503);
    const native = model.id === SEEDANCE;
    const protocol = native ? "seedance" : "kunpo-videos";
    const duration = input.duration ?? 5;
    const resolution = input.resolution ?? (model.id === H3 ? "768p" : "720p");
    const references = input.references ?? [];
    const mode = input.referenceMode ?? "reference";
    const aspectRatio = input.aspectRatio ?? (references.length && mode === "frame" ? "adaptive" : "16:9");
    const allowedResolutions = model.id === H3 ? ["768p", "2K"] : model.id === VS ? ["480p", "720p", "1080p", "2K", "4K"] : ["480p", "720p", "1080p"];
    if (!Number.isInteger(duration) || duration < 4 || duration > (model.id === H3 ? 15 : 30) || !model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
    if (!allowedResolutions.includes(resolution) || !model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
    if (!RATIOS.includes(aspectRatio) || !model.aspectRatios.includes(aspectRatio) || !references.length && aspectRatio === "adaptive") throw new VideoGenerationError("Video aspect ratio is not supported by the selected model and reference mode", 400);
    if (!["frame", "reference"].includes(mode) || model.referenceModes && !model.referenceModes.includes(mode)) throw new VideoGenerationError("Unsupported video reference mode", 400);
    if (references.some((reference) => reference.type === "video" || reference.type === "audio" && !native)) throw new VideoGenerationError("This video reference needs a reviewed public-media upload flow; local video and audio URLs are not exposed automatically", 400);
    if (mode === "frame" && references.some((reference) => reference.type !== "image")) throw new VideoGenerationError("First/last frames cannot be mixed with other reference media", 400);
    if (mode === "frame" && references.length && aspectRatio !== "adaptive") throw new VideoGenerationError("First/last frame mode requires the adaptive aspect ratio", 400);
    const maxImages = mode === "frame" ? 2 : model.id === H3 ? 9 : 30;
    if (references.filter((reference) => reference.type === "image").length > Math.min(maxImages, model.maxImageReferences)) throw new VideoGenerationError("Too many images for the selected video mode", 400);
    if (references.length > 30) throw new VideoGenerationError("Too many video reference assets", 400);
    if (!input.prompt?.trim()) throw new VideoGenerationError("Video prompt must not be empty", 400);
    const sizes = await Promise.all(references.map((reference) => stat(reference.absolutePath)));
    if (sizes.reduce((total, item) => total + item.size, 0) > 64 * 1024 * 1024) throw new VideoGenerationError("Video reference payload exceeds the 64 MiB local limit", 413);
    const content: Record<string, unknown>[] = [];
    const sourceUrls: Array<string | undefined> = [];
    const credentials = providerCredentialValues(this.source.apiKey, this.source.headers);
    for (const [index, reference] of references.entries()) {
      const resolved = await referenceContent(reference, mode === "frame" ? index === 0 ? "first_frame" : "last_frame" : undefined, credentials, control.href);
      content.push(resolved.content); sourceUrls.push(resolved.sourceUrl);
    }
    callerSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.min(this.maxWaitMs, MAX_VIDEO_WAIT_MS));
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const buildBody = (content: Record<string, unknown>[]): Record<string, unknown> => native ? {
      model: model.id, content: [{ type: "text", text: input.prompt }, ...content], duration, resolution,
      ratio: aspectRatio, generate_audio: true, watermark: false, output_format: "mp4",
    } : model.id === VS ? {
      model: model.id, prompt: input.prompt, seconds: duration, resolution: resolution.toUpperCase(), aspect_ratio: aspectRatio, generate_audio: false,
      ...(mode === "frame" && content.length ? { first_frame_url: mediaUrl(content[0]!), ...(content[1] ? { last_frame_url: mediaUrl(content[1]) } : {}) } : content.length ? { images: content.map(mediaUrl) } : {}),
    } : {
      model: model.id, prompt: input.prompt, seconds: duration, resolution: resolution.toUpperCase(), ratio: aspectRatio,
      aigc_watermark: false, ...(content.length ? { content } : {}),
    };
    // Keep this original identity byte-for-byte compatible with legacy journals. Optimization is only inside create.
    const body = buildBody(content);
    const submissionUrl = native ? `${control.origin}/doubao/api/v3/contents/generations/tasks` : `${control.origin}/v1/videos`;
    const create = async () => {
      signal.throwIfAborted();
      if (input.execution?.recoveryOnly) throw new VideoGenerationError("No saved video task is available. Recovery never submits a new generation.", 409);
      if (mode === "frame" && !references.length) throw new VideoGenerationError("Add a first frame before generating in first/last frame mode", 400, true);
      if (control.hostname === "llm.ziy.cc") {
        try { await providerArtifactUrl(`${native ? KUNPO_NATIVE_VIDEO_ORIGIN : control.origin}/`, control.href, undefined, signal); }
        catch { throw new VideoGenerationError("Video download address could not be verified safely. No generation request was submitted; check the provider artifact DNS before generating.", 503, true); }
      }
      const prepared = [...content];
      const localOriginals: Array<LocalVideoImage | undefined> = [], localPrepared: Array<LocalVideoImage | undefined> = [];
      const pngIndexes: number[] = [];
      let urlCount = 0;
      let sourceDnsSafe = false;
      let summary: VideoReferencePreparation | undefined;
      const started = Date.now();
      try {
        if (sourceUrls.some(Boolean)) {
          try { await providerArtifactUrl("https://kunpoapiimg.ziy.cc/", control.href, undefined, signal); sourceDnsSafe = true; }
          catch { signal.throwIfAborted(); } // Fall back to the current local snapshot, never weaken address checks.
        }
        for (const [index, reference] of references.entries()) {
          signal.throwIfAborted();
          if (sourceDnsSafe && sourceUrls[index]) {
            prepared[index] = { ...content[index], image_url: { url: sourceUrls[index] } };
            urlCount++;
            continue;
          }
          if (reference.type !== "image") continue;
          const local = { bytes: Buffer.from(mediaUrl(content[index]!).split(",")[1]!, "base64"), mediaType: reference.mediaType.toLowerCase() };
          localOriginals[index] = local; localPrepared[index] = local;
          if (local.mediaType !== "image/png") continue;
          pngIndexes.push(index);
          summary ??= { version: 2, optimized: 0, unchanged: 0, unsupported: 0, invalid: 0, limited: 0, originalBytes: 0, sentBytes: 0,
            jpegConverted: 0, jpegSkipped: 0, jpegTransparent: 0, jpegLimited: 0, jpegResized: 0, jpegOriented: 0, jpegQuality: 95, jpegMaxEdge: 2048, requestBytes: 0, originalRequestBytes: 0 };
          const original = Buffer.from(mediaUrl(content[index]!).slice("data:image/png;base64,".length), "base64");
          const remaining = 15_000 - (Date.now() - started);
          const result = remaining > 0 ? await optimizeVideoReferencePng(original, signal, remaining) : { bytes: original, status: "limited" as const };
          if (!["optimized", "unchanged"].includes(result.status)) localOriginals[index] = undefined;
          const jpeg = ["optimized", "unchanged"].includes(result.status) ? await prepareVideoReferenceJpeg(result.bytes, signal, 15_000 - (Date.now() - started)) : undefined;
          const sent = jpeg?.status === "converted" ? jpeg.bytes : result.bytes;
          localPrepared[index] = { bytes: sent, mediaType: jpeg?.status === "converted" ? "image/jpeg" : "image/png" };
          assertProviderBytes(sent, credentials);
          if (jpeg?.status === "converted" && summary.version === 2) { summary.jpegConverted++; summary.jpegResized += Number(Boolean(jpeg.resized)); summary.jpegOriented += Number(Boolean(jpeg.oriented)); }
          else {
            summary[result.status]++;
            if (jpeg && summary.version === 2) {
              if (jpeg.status === "transparent") summary.jpegTransparent++;
              else if (jpeg.status === "limited") summary.jpegLimited++;
              else summary.jpegSkipped++;
            }
          }
          summary.originalBytes += original.length; summary.sentBytes += sent.length;
          if (result.status === "optimized" || jpeg?.status === "converted") prepared[index] = { ...content[index], image_url: { url: `data:${jpeg?.status === "converted" ? "image/jpeg" : "image/png"};base64,${sent.toString("base64")}` } };
        }
        const withImages = (images: readonly (LocalVideoImage | undefined)[]) => prepared.map((part, index) => images[index]
          ? { ...part, image_url: { url: `data:${images[index]!.mediaType};base64,${images[index]!.bytes.toString("base64")}` } } : part);
        const fitted = await fitVideoReferenceBudget(localOriginals, localPrepared,
          images => references.some(reference => reference.type === "image") ? Buffer.byteLength(JSON.stringify(buildBody(withImages(images)))) : 0,
          signal, 15_000 - (Date.now() - started));
        prepared.splice(0, prepared.length, ...withImages(fitted.images));
        if (summary) summary.sentBytes = pngIndexes.reduce((sum, index) => sum + fitted.images[index]!.bytes.length, 0);
        const requestBytes = Buffer.byteLength(JSON.stringify(buildBody(prepared))), originalRequestBytes = Buffer.byteLength(JSON.stringify(body));
        if (fitted.budget.passes || !fitted.budget.met || summary && requestBytes > originalRequestBytes) summary = {
          ...(summary ?? { optimized: 0, unchanged: 0, unsupported: 0, invalid: 0, limited: 0, originalBytes: 0, sentBytes: 0,
            jpegConverted: 0, jpegSkipped: 0, jpegTransparent: 0, jpegLimited: 0, jpegResized: 0, jpegOriented: 0, jpegQuality: 95, jpegMaxEdge: 2048, requestBytes: 0, originalRequestBytes: 0 }),
          version: 3, requestBudgetBytes: 786432, requestBudgetMet: fitted.budget.met, requestBudgetPasses: fitted.budget.passes,
          requestBudgetConverted: fitted.budget.converted, requestBudgetQuality: fitted.budget.quality, requestBudgetMaxEdge: fitted.budget.maxEdge,
          requestBudgetResized: fitted.budget.resized,
        } as VideoReferencePreparation;
        if (summary && summary.version !== 1) { summary.requestBytes = requestBytes; summary.originalRequestBytes = originalRequestBytes; }
        if (summary) await input.execution?.referencePrepared?.(summary);
        signal.throwIfAborted();
      } catch {
        throw new VideoGenerationError(signal.aborted ? "Video reference preparation cancelled before submission" : "Video references could not be prepared safely; no generation request was submitted", signal.aborted ? 499 : 503, true,
          { phase: "submission", category: signal.aborted ? "cancelled" : "local-policy" });
      }
      if (summary?.version === 3 && !summary.requestBudgetMet) throw new VideoGenerationError(VIDEO_REFERENCE_BUDGET_ERROR, 413, true, { phase: "submission", category: "local-policy" });
      const submitted = await this.json(submissionUrl, { method: "POST", body: JSON.stringify(buildBody(prepared)), headers: this.headers(true), signal }, true, input.execution?.submissionStarted);
      const taskId = taskIdentifier(submitted.id);
      if (!taskId) throw new VideoGenerationError("Kunpo returned no valid video task ID; submission outcome is unknown. Do not repeat the paid request.", 502, false, { phase: "submission", category: "invalid-response", httpStatus: 200 });
      const saved: { taskId: string; [key: string]: string } = { taskId };
      saved.referenceUrlCount = String(urlCount);
      saved.referenceLocalCount = String(references.length - urlCount);
      if (summary) saved.pngPreparation = JSON.stringify(summary);
      return saved;
    };
    let phase: VideoRequestDiagnostic["phase"] = "submission";
    try {
      const saved = input.execution
        ? await input.execution.submitted("generate", JSON.stringify([control.href, this.source.apiKey, this.source.headers, protocol]), body, create)
        : await create();
      const { taskId } = saved;
      const preparation = parseVideoReferencePreparation(saved.pngPreparation);
      if (preparation) await input.execution?.referencePrepared?.(preparation);
      phase = "status";
      const taskUrl = `${submissionUrl}/${encodeURIComponent(taskId)}`;
      let transientFailures = 0;
      while (true) {
        signal.throwIfAborted();
        let task: Record<string, unknown>;
        try { task = await this.json(taskUrl, { headers: this.headers(), signal }); }
        catch (cause) {
          if (signal.aborted) throw cause;
          if (!(cause instanceof VideoGenerationError) || ![429, 502, 503, 504].includes(cause.statusCode)) throw cause;
          if (++transientFailures >= 5) throw new VideoGenerationError("Video status requests keep failing; resume the saved task later instead of resubmitting", 502);
          await delay(this.pollIntervalMs, signal);
          continue;
        }
        transientFailures = 0;
        const status = typeof task.status === "string" ? task.status.toLowerCase() : "unknown";
        if (status === (native ? "succeeded" : "completed")) {
          const resultUrl = native ? string(record(task.content).video_url) : undefined;
          if (native && !resultUrl) throw new VideoGenerationError("Kunpo completed the task without a video URL; resume this task rather than submitting again", 502);
          phase = "download";
          const response = await fetchProviderArtifact(this.request,
            native ? resultUrl! : `${control.origin}/v1/videos/${encodeURIComponent(taskId)}/content`, control.href,
            { signal, apiKey: this.source.authentication === "none" ? undefined : this.source.apiKey, protectedSecrets: providerCredentialValues(this.source.apiKey, this.source.headers) });
          if (!response.ok) throw new VideoGenerationError("Kunpo video download failed; resume the saved task", response.status >= 500 ? 502 : response.status);
          const bytes = await limitedVideo(response, signal);
          return { bytes, mediaType: "video/mp4", requestId: taskId, metadata: {
            model: { provider: model.provider, id: model.id }, protocol, taskId,
            parameters: { duration, resolution, aspectRatio, referenceMode: mode, outputFormat: "mp4", referenceCount: references.length,
              ...videoReferenceTransport(saved),
              ...(preparation ? { referencePngOptimized: preparation.optimized, referencePngUnchanged: preparation.unchanged,
                referencePngUnsupported: preparation.unsupported, referencePngInvalid: preparation.invalid, referencePngLimited: preparation.limited,
                referencePngBytesOriginal: preparation.originalBytes, referencePngBytesSent: preparation.sentBytes } : {}),
              ...(preparation && preparation.version !== 1 ? { referencePreparationVersion: preparation.version, referenceJpegConverted: preparation.jpegConverted, referenceJpegSkipped: preparation.jpegSkipped,
                referenceRequestBytes: preparation.requestBytes, referenceOriginalRequestBytes: preparation.originalRequestBytes,
                referenceJpegTransparent: preparation.jpegTransparent, referenceJpegLimited: preparation.jpegLimited, referenceJpegResized: preparation.jpegResized, referenceJpegOriented: preparation.jpegOriented,
                ...(preparation.jpegConverted || preparation.version === 3 && preparation.requestBudgetConverted ? {
                  referenceJpegQuality: preparation.version === 3 && preparation.requestBudgetConverted ? preparation.requestBudgetQuality : preparation.jpegQuality,
                  referenceJpegMaxEdge: preparation.version === 3 && preparation.requestBudgetConverted ? preparation.requestBudgetMaxEdge : preparation.jpegMaxEdge } : {}) } : {}),
              ...(preparation?.version === 3 ? { referenceBudgetBytes: preparation.requestBudgetBytes, referenceBudgetPasses: preparation.requestBudgetPasses,
                referenceBudgetConverted: preparation.requestBudgetConverted, referenceBudgetResized: preparation.requestBudgetResized, referenceBudgetQuality: preparation.requestBudgetQuality, referenceBudgetMaxEdge: preparation.requestBudgetMaxEdge } : {}),
              ...(native ? { generateAudio: true, watermark: false } : model.id === VS ? { generateAudio: false } : { watermark: false }) },
          } };
        }
        if (["failed", "expired", "cancelled", "canceled"].includes(status)) throw new VideoGenerationError(`Kunpo video task ${status}; no new task was submitted`, 400);
        // A new/transitional state is not a terminal failure. Keep the saved ID and
        // wait within the same bounded timeout; never submit a replacement.
        await delay(this.pollIntervalMs, signal);
      }
    } catch (cause) {
      if (cause instanceof VideoGenerationError && cause.notSubmitted) throw cause;
      if (callerSignal?.aborted) throw new VideoGenerationError("Local video waiting cancelled. The upstream task may continue; retry resumes a saved task and does not promise cancellation or a refund.", 499, false, { phase, category: "cancelled" });
      if (timeout.aborted) throw new VideoGenerationError("Video waiting timed out. Resume the saved task; do not repeat the paid submission.", 504, false, { phase, category: "timeout", timeoutKind: "deadline" });
      throw cause;
    }
  }

  private headers(json = false): Record<string, string> {
    return { ...this.source.headers, ...(this.source.authentication === "none" ? {} : { authorization: `Bearer ${this.source.apiKey}` }), ...(json ? { "content-type": "application/json" } : {}) };
  }

  private async json(url: string, init: RequestInit, submission = false, beforeSubmission?: () => Promise<void>): Promise<Record<string, unknown>> {
    const phase = submission ? "submission" : "status";
    let providerCode: NonNullable<VideoRequestDiagnostic["providerCode"]> = "unclassified";
    let response: Response;
    let attempted = false;
    const observedRequest: typeof fetch = async (input, options) => {
      // Reuse the active route/pool; never mutate or close the global dispatcher.
      const waitMs = Math.max(1, Math.min(this.maxWaitMs, MAX_VIDEO_WAIT_MS));
      const requestOptions = { ...options, ...(submission ? { dispatcher: getGlobalDispatcher().compose((dispatch) => (request, handler) => dispatch({ ...request, headersTimeout: waitMs, bodyTimeout: waitMs }, handler)) } : {}) };
      if (submission) {
        await beforeSubmission?.();
        init.signal?.throwIfAborted();
        attempted = true;
      }
      const result = await this.request(input, requestOptions);
      if (!result.ok) providerCode = await providerErrorCode(result, init.signal ?? undefined);
      return result;
    };
    try { response = await providerRequest(observedRequest, url, init); }
    catch (cause) { throw new VideoGenerationError(submission ? attempted ? "Video submission could not be confirmed. Do not repeat the paid request." : "Video request was not submitted." : "Video status request interrupted; resume the saved task", 502, submission && !attempted,
      { phase, category: cause instanceof ProviderRequestError ? cause.category : "unknown", ...(cause instanceof ProviderRequestError && cause.timeoutKind ? { timeoutKind: cause.timeoutKind } : {}) }); }
    if (!response.ok) {
      const reason = ["bad-response-status", "unclassified"].includes(providerCode) ? "reason unknown" : providerCode;
      throw new VideoGenerationError(`${submission ? "Kunpo rejected the video request" : "Kunpo video status request failed"} (HTTP ${response.status}; ${reason})`, response.status, false,
        { phase, category: "http", httpStatus: response.status, providerCode });
    }
    let value: unknown;
    try { value = await response.json(); }
    catch (cause) {
      throw new VideoGenerationError(submission ? "Video submission response was interrupted. Do not repeat the paid request." : "Video status response interrupted; resume the saved task", 502, false,
        { phase, category: cause instanceof ProviderRequestError ? cause.category : "invalid-response", ...(cause instanceof ProviderRequestError && cause.timeoutKind ? { timeoutKind: cause.timeoutKind } : {}), httpStatus: response.status });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoGenerationError("Kunpo returned an invalid video response; do not repeat a paid submission", 502, false, { phase, category: "invalid-response", httpStatus: response.status });
    return value as Record<string, unknown>;
  }
}

async function referenceContent(reference: VideoReferenceAsset, frame: "first_frame" | "last_frame" | undefined, credentials: readonly string[], controlBase: string): Promise<{ content: Record<string, unknown>; sourceUrl?: string }> {
  const mediaType = reference.mediaType.toLowerCase();
  if (reference.type === "image" && !["image/png", "image/jpeg", "image/webp"].includes(mediaType) || reference.type === "audio" && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(mediaType)) throw new VideoGenerationError("Unsupported video reference format", 400);
  const info = await stat(reference.absolutePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_REFERENCE_BYTES) throw new VideoGenerationError("Video references must be nonempty media files up to 30 MiB", 400);
  const bytes = await readFile(reference.absolutePath);
  try { assertProviderBytes(bytes, credentials); }
  catch { throw new VideoGenerationError("Video reference contains protected credential data; no generation request was submitted", 400, true); }
  if (bytes.length !== info.size || bytes.length > MAX_REFERENCE_BYTES) throw new VideoGenerationError("Video reference changed while it was being read", 409);
  const type = reference.type === "image" ? "image_url" : "audio_url";
  return { content: { type, [type]: { url: `data:${mediaType};base64,${bytes.toString("base64")}` }, role: frame ?? (reference.type === "image" ? "reference_image" : "reference_audio") },
    ...(reference.type === "image" ? { sourceUrl: matchingKunpoImageUrl(reference, bytes, controlBase, credentials) } : {}) };
}

function mediaUrl(content: Record<string, unknown>): string { return String(record(content[String(content.type)]).url); }
function taskIdentifier(value: unknown): string | undefined { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

async function limitedVideo(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_VIDEO_BYTES) { void response.body?.cancel(); throw new VideoGenerationError("Video artifact exceeds the 256 MiB local limit", 413); }
  if (!response.body) throw new VideoGenerationError("Video artifact is empty", 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_VIDEO_BYTES) throw new VideoGenerationError("Video artifact exceeds the 256 MiB local limit", 413);
      chunks.push(value);
    }
    if (!length) throw new VideoGenerationError("Video artifact is empty", 502);
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 8 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new VideoGenerationError("Provider returned an invalid MP4 artifact", 502);
    return bytes;
  } finally { signal.removeEventListener("abort", onAbort); void reader.cancel().catch(() => undefined); }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
