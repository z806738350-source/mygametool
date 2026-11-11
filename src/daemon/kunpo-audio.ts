import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import {
  type AudioGenerationRequest,
  type AudioGenerationInput,
  type AudioModel,
  type GeneratedAudio,
} from "../shared/audio.js";
import { AudioGenerationError, audioInputError } from "./audio-generation.js";
import type { AudioRequestDiagnostic, ProviderErrorCode } from "../shared/contracts.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { assertProviderBytes, providerControlUrl, providerCredentialValues, providerRequest, providerErrorCode, ProviderRequestError } from "./provider-network.js";
import { inspectAudioReference } from "../shared/audio-reference.js";

export const KUNPO_AUDIO_ENDPOINT = "https://llm.ziy.cc/v1/audio/speech";
export const KUNPO_AUDIO_PROTOCOL = "kunpo-seed-audio-binary";
export const KUNPO_AUDIO_MODELS = ["seed-audio-1.0", "seed-audio-1.0-multilingual"] as const;
export const KUNPO_AUDIO_RESPONSE_TIMEOUT_MS = 300_000;
export const KUNPO_AUDIO_RECEIVE_TIMEOUT_MS = 180_000;
export const KUNPO_AUDIO_TIMEOUT_MS = KUNPO_AUDIO_RESPONSE_TIMEOUT_MS + KUNPO_AUDIO_RECEIVE_TIMEOUT_MS;
export const KUNPO_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
const SAMPLE_RATES = [8_000, 16_000, 24_000, 32_000, 44_100, 48_000] as const;
const MAX_PROMPT_CHARACTERS = 3_000;
const MULTILINGUAL_LANGUAGES = ["zh-cn", "en", "ja", "ko", "es", "de", "fr", "pt", "th", "vi", "ms", "fil", "it", "ru", "nl", "pl", "tr"] as const;
const inFlight = new Set<string>();
const audioTransport = new AsyncLocalStorage<{ phase: AudioRequestDiagnostic["phase"] }>();

/** Observe only this fetch's request identity; never inspect or retain headers, URLs or chunks. */
function observeAudioTransport(progress: { phase: AudioRequestDiagnostic["phase"] }): () => void {
  const requests = new WeakSet<object>();
  const created = (message: unknown) => {
    const request = (message as { request?: { method?: string } })?.request;
    if (audioTransport.getStore() === progress && request?.method === "POST") { requests.add(request); progress.phase = "connect"; }
  };
  const stage = (phase: AudioRequestDiagnostic["phase"]) => (message: unknown) => {
    const request = (message as { request?: object })?.request;
    if (request && requests.has(request) && progress.phase !== "body") progress.phase = phase;
  };
  const subscriptions: [string, (message: unknown) => void][] = [
    ["undici:request:create", created], ["undici:request:bodyChunkSent", stage("upload")], ["undici:request:bodySent", stage("headers")],
  ];
  for (const [name, observer] of subscriptions) channel(name).subscribe(observer);
  return () => { for (const [name, observer] of subscriptions) channel(name).unsubscribe(observer); };
}

export function kunpoAudioModels(provider: string, providerName: string, speech = false): AudioModel[] {
  return KUNPO_AUDIO_MODELS.map((id) => ({
    provider,
    providerName,
    id,
    name: id === "seed-audio-1.0" ? "Seed Audio 1.0" : "Seed Audio 1.0 Multilingual",
    protocol: KUNPO_AUDIO_PROTOCOL,
    capabilities: {
      operations: speech ? ["speech"] : ["sound-effect", "music"],
      operationStatus: speech ? { speech: "unverified" } : { "sound-effect": "documented", music: "unverified" },
      capabilityNotes: speech
        ? ["Strict reading and voice consistency have not been verified. An optional MP3/WAV reference may be at most 30 seconds and 10 MB. Voice design generates a candidate audio sample, not a permanent speaker ID.", "Non-streaming audio only; no subtitle or alignment JSON is returned."]
        : ["Music is an experimental short ambient-audio candidate, not a verified full background-music service.", "Duration and instrumental instructions are prompts, not exact output guarantees."],
      executionModes: ["synchronous"],
      languages: id === "seed-audio-1.0" ? ["zh-cn", "en"] : [...MULTILINGUAL_LANGUAGES],
      // The application currently imports and plays MP3/WAV; raw PCM/OGG are not advertised here.
      formats: ["mp3", "wav"],
      sampleRates: [...SAMPLE_RATES],
      maxTextCharacters: MAX_PROMPT_CHARACTERS,
      maxDurationSeconds: 120,
      supportsSSML: false,
      supportsVoiceClone: false,
      supportsVoiceDesign: speech,
      supportsAlignment: false,
      supportsLoop: false,
      supportsLyrics: false,
      supportsInstrumental: false,
      supportsReferenceAudio: speech,
      supportsNegativePrompt: false,
      ...(speech ? { strictTextVerified: false } : {}),
    },
  }));
}

/** Pure validation shared by the Canvas preflight and the final provider boundary. */
export function validateKunpoAudioInput(input: AudioGenerationRequest, provider: string): { model: NonNullable<AudioGenerationRequest["model"]>; format: "mp3" | "wav"; sampleRate: number; textPrompt: string } {
  if (input.model?.provider !== provider || !KUNPO_AUDIO_MODELS.includes(input.model.id as typeof KUNPO_AUDIO_MODELS[number]))
    throw audioInputError("The selected Kunpo audio model is unavailable");
  const format = input.output?.format ?? "mp3";
  const sampleRate = input.output?.sampleRate ?? 48_000;
  if (format !== "mp3" && format !== "wav") throw audioInputError("Kunpo audio output must be MP3 or WAV");
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRate)) throw audioInputError("Unsupported Kunpo audio sample rate");
  if (input.output?.channels !== undefined) throw audioInputError("Kunpo Seed Audio does not expose channel selection");
  if (input.operation === "speech") {
    if (input.voiceId) throw audioInputError("Speaker IDs are retired; explicitly select reference audio or no reference");
    if (input.voiceDesign !== undefined && typeof input.voiceDesign !== "boolean") throw audioInputError("Invalid voice design intent");
    if (input.voiceDesign && input.referenceAssetId) throw audioInputError("Voice design cannot use reference audio");
    if (input.language) {
      const languages = input.model.id === "seed-audio-1.0" ? ["zh-cn", "en"] : MULTILINGUAL_LANGUAGES;
      const primary = input.language.toLowerCase().split("-")[0];
      if (!languages.some(language => language.split("-")[0] === primary))
        throw audioInputError(input.model.id === "seed-audio-1.0"
          ? "Seed Audio 1.0 supports Chinese and English; select the multilingual model for other documented languages"
          : "The selected speech language is not documented for Seed Audio Multilingual");
    }
  }
  const textPrompt = audioPrompt(input);
  if (textPrompt.length > MAX_PROMPT_CHARACTERS) throw audioInputError("Seed Audio prompt must be 3,000 characters or fewer after instructions are added");
  return { model: input.model, format, sampleRate, textPrompt };
}

export async function generateKunpoAudio(options: {
  input: AudioGenerationInput;
  provider: string;
  key: string;
  request: typeof fetch;
  endpoint: string;
  signal?: AbortSignal;
}): Promise<GeneratedAudio> {
  const { input, provider, key, request, endpoint, signal } = options;
  signal?.throwIfAborted();
  providerControlUrl(endpoint);
  const { model, format, sampleRate, textPrompt } = validateKunpoAudioInput(input, provider);
  if (input.operation === "speech") {
    if (input.voiceDesign && (input.referenceAssetId || input.referenceAudio)) throw new AudioGenerationError("Voice design cannot use reference audio", 400);
    if (Boolean(input.referenceAssetId) !== Boolean(input.referenceAudio)) throw new AudioGenerationError("The selected reference audio is unavailable", 400);
    if (input.referenceSha256 && (!input.referenceAudio || !/^[a-f0-9]{64}$/.test(input.referenceSha256) || createHash("sha256").update(input.referenceAudio.bytes).digest("hex") !== input.referenceSha256)) throw new AudioGenerationError("The selected audio changed; explicitly select it again", 409);
    try { if (input.referenceAudio) { await inspectAudioReference(input.referenceAudio.bytes, input.referenceAudio.mediaType); assertProviderBytes(input.referenceAudio.bytes, providerCredentialValues(key)); } }
    catch { throw new AudioGenerationError("Reference audio is invalid, protected, or exceeds 30 seconds / 10 MB; select a valid MP3 or WAV", 400); }
  }
  const speechRate = input.operation === "speech" ? input.speed ?? 0 : 0;
  const body = {
    model: model.id,
    text_prompt: textPrompt,
    ...(input.operation === "speech" && input.referenceAudio ? { references: [{ audio_data: Buffer.from(input.referenceAudio.bytes).toString("base64") }] } : {}),
    audio_config: { format, sample_rate: sampleRate, speech_rate: speechRate, loudness_rate: 0, pitch_rate: 0, enable_subtitle: false },
    watermark: { aigc_watermark: false, aigc_metadata: { enable: false } },
  };
  const serialized = JSON.stringify(body);
  if (containsKnownSensitiveValue(serialized)) throw new AudioGenerationError("Audio input contains protected credential data", 400);
  try { assertProviderBytes(Buffer.from(serialized), providerCredentialValues(key)); }
  catch { throw new AudioGenerationError("Audio input contains protected credential data", 400); }
  const requestKey = createHash("sha256").update(endpoint).update(key).update(serialized).digest("hex");
  if (inFlight.has(requestKey)) throw new AudioGenerationError("An identical audio request is already running", 409);
  inFlight.add(requestKey);
  const controller = new AbortController();
  const progress: { phase: AudioRequestDiagnostic["phase"] } = { phase: "request" };
  const stopObserving = observeAudioTransport(progress);
  const started = Date.now(), requestBytes = Buffer.byteLength(serialized);
  let httpStatus: number | undefined, providerCode: ProviderErrorCode | undefined;
  const diagnostic = (category: AudioRequestDiagnostic["category"], timeoutKind?: AudioRequestDiagnostic["timeoutKind"]): AudioRequestDiagnostic => ({
    phase: progress.phase, category, requestBytes, elapsedMs: Math.max(0, Math.min(KUNPO_AUDIO_TIMEOUT_MS, Date.now() - started)),
    ...(timeoutKind ? { timeoutKind } : {}), ...(httpStatus === undefined ? {} : { httpStatus }), ...(providerCode ? { providerCode } : {}),
  });
  const onAbort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), KUNPO_AUDIO_TIMEOUT_MS);
  let phaseTimeout = setTimeout(() => controller.abort(), KUNPO_AUDIO_RESPONSE_TIMEOUT_MS);
  signal?.addEventListener("abort", onAbort, { once: true });
  let submitted = false;
  let rejectedBeforeGeneration = false;
  try {
    controller.signal.throwIfAborted();
    submitted = true;
    const observedRequest: typeof fetch = async (input, init) => {
      const response = await audioTransport.run(progress, () => request(input, init));
      clearTimeout(phaseTimeout);
      phaseTimeout = setTimeout(() => controller.abort(), KUNPO_AUDIO_RECEIVE_TIMEOUT_MS);
      progress.phase = "body";
      httpStatus = response.status;
      if (!response.ok) providerCode = await providerErrorCode(response, controller.signal);
      return response;
    };
    const response = await abortable(providerRequest(observedRequest, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: serialized,
      signal: controller.signal,
    }), controller.signal);
    if (!response.ok) {
      rejectedBeforeGeneration = [400, 401, 403, 404, 422, 429].includes(response.status);
      throw new AudioGenerationError(response.status === 401 || response.status === 403
        ? "Kunpo audio credentials were rejected or the model is unavailable"
        : response.status === 429 ? "Kunpo audio rate or quota limit was reached" : `Kunpo audio request failed (${response.status}${providerCode === "bad-response-status" || providerCode === "unclassified" ? "; reason unknown" : ""})`,
      response.status === 401 || response.status === 403 ? 503 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const allowedTypes = format === "mp3" ? ["audio/mpeg", "audio/mp3"] : ["audio/wav", "audio/x-wav", "audio/wave"];
    if (contentType && contentType !== "application/octet-stream" && !allowedTypes.includes(contentType)) {
      void response.body?.cancel().catch(() => {});
      throw new AudioGenerationError("Kunpo audio returned an unexpected content type instead of binary audio", 502);
    }
    const bytes = assertProviderBytes(await readAudio(response, controller.signal), providerCredentialValues(key));
    if (containsKnownSensitiveValue(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"))) throw new AudioGenerationError("Kunpo returned protected credential data", 502);
    validateAudio(bytes, format);
    const providerRequestId = response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid");
    if (providerRequestId && containsKnownSensitiveValue(providerRequestId)) throw new AudioGenerationError("Kunpo returned protected credential data", 502);
    return {
      bytes,
      mediaType: format === "wav" ? "audio/wav" : "audio/mpeg",
      model: { provider, id: model.id },
      metadata: {
        codec: format,
        ...(providerRequestId ? { providerRequestId } : {}),
        protocol: KUNPO_AUDIO_PROTOCOL,
        operation: input.operation,
        parameters: { format, sample_rate: sampleRate, speech_rate: speechRate,
          ...(input.operation === "speech" ? { referenceCount: input.referenceAudio ? 1 : 0, voiceDesign: Boolean(input.voiceDesign), ...(input.referenceAudio && input.referenceAssetId ? { referenceAssetId: input.referenceAssetId, referenceSha256: createHash("sha256").update(input.referenceAudio.bytes).digest("hex") } : {}) } : {}),
          ...(input.operation !== "speech" && input.operation !== "dialogue" && input.durationSeconds !== undefined ? { requested_duration_seconds: input.durationSeconds } : {}) },
      },
    };
  } catch (cause) {
    if (cause instanceof AudioGenerationError) {
      const unknown = submitted && !rejectedBeforeGeneration;
      throw new AudioGenerationError(unknown ? `${cause.message}; completion is unknown and will not be retried automatically` : cause.message,
        cause.statusCode, unknown ? "unknown" : cause.submissionOutcome, diagnostic(httpStatus !== undefined && httpStatus >= 400 ? "http" : "invalid-response"));
    }
    throw new AudioGenerationError(signal?.aborted
      ? "Audio request cancelled; completion is unknown and will not be retried automatically"
      : controller.signal.aborted ? "Audio request timed out; completion is unknown and will not be retried automatically"
        : "Audio request interrupted; completion is unknown and will not be retried automatically", signal?.aborted ? 499 : controller.signal.aborted ? 504 : 502,
    submitted ? "unknown" : "not-submitted", diagnostic(signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : cause instanceof ProviderRequestError ? cause.category : "unknown",
      !signal?.aborted && controller.signal.aborted ? "deadline" : cause instanceof ProviderRequestError ? cause.timeoutKind : undefined));
  } finally {
    stopObserving();
    clearTimeout(timeout);
    clearTimeout(phaseTimeout);
    signal?.removeEventListener("abort", onAbort);
    inFlight.delete(requestKey);
  }
}

function audioPrompt(input: AudioGenerationRequest): string {
  if (input.operation === "dialogue") throw audioInputError("Multi-speaker dialogue is not integrated for Kunpo Seed Audio");
  if (input.operation === "speech") {
    if (!input.text?.trim()) throw audioInputError("Speech text must not be empty");
    if (input.speed !== undefined && (!Number.isInteger(input.speed) || input.speed < -50 || input.speed > 100)) throw audioInputError("Speech rate must be an integer between -50 and 100");
    if (input.language && !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(input.language)) throw audioInputError("Unsupported speech language");
    if (input.voiceDescription !== undefined && (typeof input.voiceDescription !== "string" || input.voiceDescription.length > 2000 || !input.voiceDesign)) throw audioInputError("Voice descriptions require voice design and at most 2,000 characters");
    if (input.voiceDesign && !input.voiceDescription?.trim()) throw audioInputError("Describe the voice before generating a sample");
    return `${input.voiceDesign ? `Generate one voice candidate matching this description. Do not read the description aloud. Voice description: ${input.voiceDescription!.trim()}. ` : ""}${input.referenceAssetId ? "Use @音频1 only as a voice/timbre reference; do not repeat its words. " : ""}Generate one clear, dry speaking voice without music, extra words, laughter or sound effects. Read the following text once, verbatim.${input.language ? ` Language: ${input.language}.` : ""}${input.style?.trim() ? ` Delivery: ${input.style.trim()}.` : ""}\nText:\n${input.text}`;
  }
  if (!input.prompt?.trim()) throw audioInputError("Audio prompt must not be empty");
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 120)) throw audioInputError("Seed Audio requested duration must be between 1 and 120 seconds");
  if (input.loop) throw audioInputError("Seed Audio does not create guaranteed seamless loops");
  const duration = input.durationSeconds === undefined ? "" : ` approximately ${input.durationSeconds} seconds long`;
  if (input.operation === "sound-effect") {
    if (input.negativePrompt?.trim()) throw audioInputError("Kunpo Seed Audio does not support negative prompts");
    return `Create a standalone game sound effect${duration}. Do not include speech, narration, singing, or background music. Description: ${input.prompt.trim()}`;
  }
  if (!input.instrumental || input.lyrics?.trim()) throw audioInputError("Only experimental instrumental ambient music is integrated; lyrics and vocal music are unavailable");
  if (input.referenceAssetId) throw audioInputError("Reference audio is not integrated for the music tool");
  return `Create short ambient instrumental audio${duration}. Do not include vocals, speech, narration, or lyrics. Description: ${input.prompt.trim()}`;
}

async function readAudio(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > KUNPO_AUDIO_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new AudioGenerationError("Kunpo audio response exceeded the size limit", 502);
  }
  if (!response.body) throw new AudioGenerationError("Kunpo returned no audio", 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > KUNPO_AUDIO_MAX_BYTES) throw new AudioGenerationError("Kunpo audio response exceeded the size limit", 502);
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A cancelled reader may still have a pending native read. */ }
  }
}

function validateAudio(bytes: Uint8Array, format: "mp3" | "wav"): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid = format === "wav" ? bytes.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE"
    : bytes.length >= 3 && (buffer.subarray(0, 3).toString("ascii") === "ID3" || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (!valid) throw new AudioGenerationError(`Kunpo returned data that is not valid ${format.toUpperCase()} audio`, 502);
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new Error("cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (cause) => { signal.removeEventListener("abort", onAbort); reject(cause); });
  });
}
