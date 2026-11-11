import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAudio } from "../src/daemon/audio-generation.js";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";
import { KUNPO_AUDIO_MAX_BYTES, KUNPO_AUDIO_TIMEOUT_MS } from "../src/daemon/kunpo-audio.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";

const MODEL = { provider: "volcengine-seed-audio", id: "seed-audio-1.0" } as const;
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]);
const audio = (bytes = MP3, headers: Record<string, string> = {}) => new Response(bytes, { headers: { "content-type": bytes === WAV ? "audio/wav" : "audio/mpeg", ...headers } });
const effect = () => ({ operation: "sound-effect" as const, model: MODEL, prompt: "A heavy stone door closes" });

afterEach(() => vi.useRealTimers());

describe("Kunpo Seed Audio provider", () => {
  it("advertises only documented app formats and marks ambient music as unverified", () => {
    const models = new VolcengineSeedAudioProvider(() => "fake-key").models();
    expect(models.map((entry) => entry.id)).toEqual(["seed-audio-1.0", "seed-audio-1.0-multilingual"]);
    expect(models[0]?.capabilities).toMatchObject({
      formats: ["mp3", "wav"], executionModes: ["synchronous"],
      operationStatus: { "sound-effect": "documented", music: "unverified" },
      maxDurationSeconds: 120, supportsLoop: false, supportsInstrumental: false, supportsAlignment: false,
    });
    expect(models[0]?.capabilities.sampleRates).not.toContain(22_050);
  });

  it("sends Bearer JSON and reads binary audio without inventing task IDs or duration", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio(MP3, { "x-request-id": "kunpo-request-1" }));
    const result = await new VolcengineSeedAudioProvider(() => "fake-key", request).generate({
      ...effect(), durationSeconds: 3, output: { format: "mp3", sampleRate: 48_000 },
    });
    expect(result.bytes).toEqual(MP3);
    expect(result.model).toEqual(MODEL);
    expect(result.metadata).toMatchObject({ codec: "mp3", protocol: "kunpo-seed-audio-binary", operation: "sound-effect", providerRequestId: "kunpo-request-1" });
    expect(result.metadata).not.toHaveProperty("durationMs");
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://llm.ziy.cc/v1/audio/speech");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("seed-audio-1.0");
    expect(body.text_prompt).toContain("approximately 3 seconds");
    expect(body.audio_config).toEqual({ format: "mp3", sample_rate: 48_000, speech_rate: 0, loudness_rate: 0, pitch_rate: 0, enable_subtitle: false });
    expect(body.watermark).toEqual({ aigc_watermark: false, aigc_metadata: { enable: false } });
    expect(result.metadata?.parameters?.text_prompt).toBeUndefined();
    expect(result.metadata?.parameters).not.toHaveProperty("model");
  });

  it("keeps short ambient music explicit and does not claim instrumental guarantees", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio(WAV));
    const adapter = new VolcengineSeedAudioProvider(() => "fake-key", request);
    const provider = new ProviderAudio([adapter]);
    expect(provider.resolveModel("music")).toBeUndefined();
    await expect(provider.generate({ operation: "music", prompt: "harbor", instrumental: true })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("explicit music model"), submissionOutcome: "not-submitted" });
    await expect(new ProviderAudio([]).generate({ operation: "music", prompt: "harbor", instrumental: true })).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("No music model is available"), submissionOutcome: "not-submitted" });
    expect(request).not.toHaveBeenCalled();
    const result = await provider.generate({ operation: "music", model: MODEL, prompt: "Quiet harbor ambience", instrumental: true, durationSeconds: 5, output: { format: "wav" } });
    expect(result.mediaType).toBe("audio/wav");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).text_prompt).toContain("short ambient instrumental audio");
    expect(result.metadata).not.toHaveProperty("durationMs");
  });

  it("passes the exact multilingual ID and supported sample rate", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
    await new VolcengineSeedAudioProvider(() => "fake-key", request).generate({
      ...effect(), model: { ...MODEL, id: "seed-audio-1.0-multilingual" }, output: { sampleRate: 44_100 },
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "seed-audio-1.0-multilingual", audio_config: { sample_rate: 44_100 } });
  });

  it.each([
    { ...effect(), loop: true },
    { ...effect(), negativePrompt: "voices" },
    { ...effect(), durationSeconds: 121 },
    { ...effect(), output: { sampleRate: 22_050 as const } },
    { ...effect(), output: { channels: 1 as const } },
    { ...effect(), prompt: "a".repeat(3_000) },
    { ...effect(), model: { ...MODEL, id: "unknown" } },
    { operation: "music" as const, model: MODEL, prompt: "music", instrumental: false },
    { operation: "music" as const, model: MODEL, prompt: "music", instrumental: true, lyrics: "words" },
    { operation: "music" as const, model: MODEL, prompt: "music", instrumental: true, referenceAssetId: "local-asset" },
  ])("rejects unimplemented parameters before sending a request %#", async (input) => {
    const request = vi.fn<typeof fetch>();
    const failure = await new VolcengineSeedAudioProvider(() => "fake-key", request).generate(input as import("../src/shared/audio.js").AudioGenerationRequest).catch(error => error);
    expect(failure).toMatchObject({ statusCode: 400, submissionOutcome: "not-submitted" });
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "audio_input_invalid", disposition: "correctable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("never brands provider replies, interrupted submissions, disabled configuration or forged properties as correctable input", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("Unsupported loop", { status: 400 }));
    const failure = await new VolcengineSeedAudioProvider(() => "fake-key", request).generate(effect()).catch(error => error);
    expect(request).toHaveBeenCalledOnce(); expect(getToolPreflightFailure(failure)).toBeUndefined();
    const interrupted = await new VolcengineSeedAudioProvider(() => "fake-key", vi.fn().mockRejectedValue(Object.assign(new Error("Seed Audio does not create guaranteed seamless loops"), { preflightFailure: { effect: "none", reason: "audio_input_invalid", disposition: "correctable" } }))).generate(effect()).catch(error => error);
    expect(interrupted.submissionOutcome).toBe("unknown"); expect(getToolPreflightFailure(interrupted)).toBeUndefined();
    for (const provider of [new VolcengineSeedAudioProvider(() => undefined, request), new VolcengineSeedAudioProvider(() => "fake-key", request, undefined, () => false)]) {
      const failure = await new ProviderAudio([provider]).generate({ ...effect(), loop: true }).catch(error => error);
      expect(getToolPreflightFailure(failure)).toBeUndefined();
    }
    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when disabled", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new VolcengineSeedAudioProvider(() => "fake-key", request, undefined, () => false).generate(effect())).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response(JSON.stringify({ audio: MP3.toString("base64") }), { headers: { "content-type": "application/json" } }),
    () => new Response("not mp3", { headers: { "content-type": "audio/mpeg" } }),
    () => audio(MP3, { "content-type": "audio/wav" }),
    () => audio(MP3, { "content-length": String(KUNPO_AUDIO_MAX_BYTES + 1) }),
  ])("rejects JSON, invalid/mismatched formats and overlarge responses %#", async (response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(new VolcengineSeedAudioProvider(() => "fake-key", request).generate(effect())).rejects.toMatchObject({ statusCode: 502 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials out of input, returned bytes and error messages", async () => {
    const key = "sk-audio-canary-do-not-export";
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio(Buffer.concat([MP3, Buffer.from(key)])));
    const provider = new VolcengineSeedAudioProvider(() => key, request);
    await expect(provider.generate({ ...effect(), prompt: key })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
    let failure: unknown;
    try { await provider.generate(effect()); } catch (cause) { failure = cause; }
    expect(String(failure)).not.toContain(key);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a simultaneous identical submission instead of charging it twice", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const provider = new VolcengineSeedAudioProvider(() => "fake-key", request);
    const first = provider.generate(effect());
    await expect(provider.generate(effect())).rejects.toMatchObject({ statusCode: 409 });
    finish(audio());
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects credentials registered by another provider before they enter audio input or metadata", async () => {
    const other = "sk-other-provider-audio-canary";
    registerSensitiveValue(other);
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio(MP3, { "x-request-id": other }));
    const provider = new VolcengineSeedAudioProvider(() => "fake-key", request);
    await expect(provider.generate({ ...effect(), prompt: other })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
    await expect(provider.generate(effect())).rejects.toMatchObject({ statusCode: 502 });
  });

  it("rejects protected bytes split across response chunks", async () => {
    const key = "sk-chunked-audio-canary";
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.concat([MP3, Buffer.from(key.slice(0, 9))]));
      controller.enqueue(Buffer.from(key.slice(9))); controller.close();
    } });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    await expect(new VolcengineSeedAudioProvider(() => key, request).generate(effect())).rejects.toMatchObject({ statusCode: 502 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not submit pre-cancelled requests or retry interrupted submissions", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const provider = new VolcengineSeedAudioProvider(() => "fake-key", request);
    const before = new AbortController(); before.abort();
    await expect(provider.generate(effect(), before.signal)).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
    const during = new AbortController();
    const pending = provider.generate(effect(), during.signal);
    during.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499, submissionOutcome: "unknown" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a non-cooperative mock transport and does not automatically replay on timeout", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = new VolcengineSeedAudioProvider(() => "fake-key", request).generate(effect());
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504, submissionOutcome: "unknown" });
    await vi.advanceTimersByTimeAsync(KUNPO_AUDIO_TIMEOUT_MS);
    await assertion;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled binary body even when cancellation does not settle", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(MP3); },
      pull() { return new Promise(() => {}); },
      cancel() { return new Promise(() => {}); },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    const pending = new VolcengineSeedAudioProvider(() => "fake-key", request).generate(effect());
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504, submissionOutcome: "unknown" });
    await vi.advanceTimersByTimeAsync(KUNPO_AUDIO_TIMEOUT_MS);
    await assertion;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 503], [429, 429], [500, 502]])("returns sanitized failures without retry for HTTP %i", async (status, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("upstream private detail", { status }));
    await expect(new VolcengineSeedAudioProvider(() => "fake-key", request).generate(effect())).rejects.toMatchObject({ statusCode: expected });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
