import { describe, expect, it, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici/index.js";
import { referenceMp3, referenceWav } from "./audio-reference-fixture.js";
import { inspectAudioReference } from "../src/shared/audio-reference.js";
import { VolcengineTtsProvider } from "../src/daemon/volcengine-tts-provider.js";
import { KUNPO_AUDIO_TIMEOUT_MS, KUNPO_AUDIO_RESPONSE_TIMEOUT_MS, KUNPO_AUDIO_RECEIVE_TIMEOUT_MS } from "../src/daemon/kunpo-audio.js";

const MODEL = { provider: "volcengine-tts", id: "seed-audio-1.0" } as const;
const WAV = referenceWav();
const reference = { referenceAssetId: "test-reference", referenceAudio: { bytes: WAV, mediaType: "audio/wav" as const } };
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const audio = () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } });

describe("Kunpo Seed Audio speech candidate", () => {
  it("allows unconditioned speech and separates voice description from the sample script", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => audio());
    const provider = new VolcengineTtsProvider(() => "fake-key", request);
    await provider.generate({ operation: "speech", model: MODEL, text: "Good morning" });
    const first = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(first).not.toHaveProperty("references"); expect(first.text_prompt).not.toContain("@音频1");
    const result = await provider.generate({ operation: "speech", model: MODEL, text: "A short sample", voiceDesign: true, voiceDescription: "A warm adult female voice" });
    const designed = JSON.parse(String(request.mock.calls[1]![1]!.body));
    expect(designed.text_prompt).toContain("Do not read the description aloud");
    expect(designed.text_prompt).toContain("Voice description: A warm adult female voice");
    expect(designed.text_prompt).toContain("Text:\nA short sample");
    expect(designed.text_prompt).not.toContain("@音频1"); expect(designed).not.toHaveProperty("references");
    expect(result.metadata?.parameters).toMatchObject({ referenceCount: 0, voiceDesign: true });
    expect(JSON.stringify(result.metadata)).not.toContain("A warm adult female voice");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { voiceDesign: true },
    { voiceDesign: true, voiceDescription: " " },
    { voiceDesign: true, voiceDescription: "x".repeat(2001) },
    { voiceDescription: "not a script" },
    { voiceDesign: true, voiceDescription: "warm", ...reference },
    { ...reference, referenceSha256: "0".repeat(64) },
    { referenceSha256: "0".repeat(64) },
  ])("rejects invalid design or stale reference binding before submission %#", async (extra) => {
    const request = vi.fn<typeof fetch>();
    await expect(new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "Sample", ...extra })).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("can receive headers after three minutes without replay and keeps a bounded body deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: Response) => void;
      const request = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
      const result = new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "Sample", voiceDesign: true, voiceDescription: "Warm" });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(200_000);
      resolve(audio());
      expect((await result).mediaType).toBe("audio/mpeg");
      expect(request).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("marks strict text fidelity and alignment as unverified/unavailable", () => {
    const models = new VolcengineTtsProvider(() => "fake-key").models();
    expect(models.map((model) => model.id)).toEqual(["seed-audio-1.0", "seed-audio-1.0-multilingual"]);
    expect(models[0]?.capabilities).toMatchObject({
      operations: ["speech"], operationStatus: { speech: "unverified" }, strictTextVerified: false,
      executionModes: ["synchronous"], supportsAlignment: false, supportsSSML: false, maxTextCharacters: 3_000,
    });
  });

  it("sends raw reference audio Base64 and binary output without a Speaker ID", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
    const generated = await new VolcengineTtsProvider(() => "fake-key", request).generate({
      operation: "speech", model: MODEL, text: "你好，旅行者", ...reference,
      language: "zh-cn", style: "Warm storyteller", speed: 10, output: { format: "mp3", sampleRate: 24_000 },
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://llm.ziy.cc/v1/audio/speech");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fake-key");
    expect(headers.has("x-api-resource-id")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "seed-audio-1.0", references: [{ audio_data: WAV.toString("base64") }],
      audio_config: { format: "mp3", sample_rate: 24_000, speech_rate: 10, enable_subtitle: false },
    });
    expect(body).not.toHaveProperty("voice");
    expect(body).not.toHaveProperty("req_params");
    expect(body.text_prompt).toContain("你好，旅行者");
    expect(body.text_prompt).toContain("Warm storyteller");
    expect(generated.bytes).toEqual(MP3);
    expect(generated.model).toEqual(MODEL);
    expect(generated.metadata).toMatchObject({ protocol: "kunpo-seed-audio-binary", operation: "speech", parameters: { referenceCount: 1 } });
    expect(generated.metadata?.parameters).toMatchObject({ referenceAssetId: "test-reference", referenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(generated.metadata).not.toHaveProperty("providerRequestId");
    expect(generated.metadata).not.toHaveProperty("durationMs");
    expect(generated.metadata).not.toHaveProperty("usageCharacters");
  });

  it.each(["code", "type"])("classifies documented HTTP error %s without retaining raw details", async (field) => {
    const privateText = "fake-key https://private.invalid/?signature=private-url private-script audio_data";
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { [field]: "bad_response_status_code", message: privateText, param: privateText }, request_id: privateText }, { status: 400 }));
    const error = await new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "Hello", ...reference }).catch((cause) => cause);
    expect(error).toMatchObject({ statusCode: 400, diagnostic: { phase: "body", category: "http", httpStatus: 400, providerCode: "bad-response-status" } });
    expect(error.message).toBe("Kunpo audio request failed (400; reason unknown)");
    expect(error.diagnostic.requestBytes).toBe(Buffer.byteLength(String(request.mock.calls[0]?.[1]?.body)));
    expect(error.diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    for (const secret of ["fake-key", "private-url", "private-script", "audio_data", "request_id", "https:"]) expect(JSON.stringify(error) + error.message).not.toContain(secret);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["request", "connect", "upload", "headers", "body"] as const)("records the observed %s stage at its bounded phase deadline without replay", async (phase) => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        const identity = { method: "POST" };
        if (phase !== "request" && phase !== "body") channel("undici:request:create").publish({ request: identity });
        if (phase === "upload") channel("undici:request:bodyChunkSent").publish({ request: identity, chunk: Buffer.from("private bytes never retained") });
        if (phase === "headers") channel("undici:request:bodySent").publish({ request: identity });
        if (phase === "body") return new Response(new ReadableStream(), { headers: { "content-type": "audio/mpeg" } });
        return new Promise(() => {});
      });
      const pending = new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "Hello", ...reference }).catch((cause) => cause);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(KUNPO_AUDIO_TIMEOUT_MS);
      const error = await pending;
      expect(error).toMatchObject({ statusCode: 504, submissionOutcome: "unknown", diagnostic: { phase, category: "timeout", timeoutKind: "deadline", elapsedMs: phase === "body" ? KUNPO_AUDIO_RECEIVE_TIMEOUT_MS : KUNPO_AUDIO_RESPONSE_TIMEOUT_MS } });
      expect(Object.keys(error.diagnostic).sort()).toEqual(["category", "elapsedMs", ...(phase === "body" ? ["httpStatus"] : []), "phase", "requestBytes", "timeoutKind"].sort());
      expect(request).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each([["UND_ERR_HEADERS_TIMEOUT", "headers"], ["UND_ERR_BODY_TIMEOUT", "body"], ["UND_ERR_CONNECT_TIMEOUT", "connect"]] as const)("keeps only the safe %s subtype", async (code, timeoutKind) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (timeoutKind === "body") return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error("fake-key private-response"), { code })); } }), { headers: { "content-type": "audio/mpeg" } });
      throw new Error("private-outer", { cause: Object.assign(new Error("fake-key private-response"), { code }) });
    });
    const error = await new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "Hello", ...reference }).catch((cause) => cause);
    expect(error).toMatchObject({ submissionOutcome: "unknown", diagnostic: { phase: timeoutKind === "body" ? "body" : "request", category: "timeout", timeoutKind } });
    for (const secret of ["fake-key", "private-outer", "private-response", code]) expect(JSON.stringify(error) + error.message).not.toContain(secret);
    expect(request).toHaveBeenCalledOnce();
  });

  it("isolates concurrent transport observations and removes subscriptions after cancellation", async () => {
    const subscriptions = ["undici:request:create", "undici:request:bodyChunkSent", "undici:request:bodySent"].map((name) => [channel(name), channel(name).hasSubscribers] as const);
    const requests: object[] = [], signals = [new AbortController(), new AbortController()];
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      const identity = { method: "POST" }; requests.push(identity);
      channel("undici:request:create").publish({ request: identity });
      return new Promise(() => {});
    });
    const provider = new VolcengineTtsProvider(() => "fake-key", request);
    const first = provider.generate({ operation: "speech", model: MODEL, text: "First", ...reference }, signals[0]!.signal).catch((cause) => cause);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = provider.generate({ operation: "speech", model: MODEL, text: "Second", ...reference }, signals[1]!.signal).catch((cause) => cause);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    channel("undici:request:bodySent").publish({ request: requests[1] });
    signals[1]!.abort(); expect((await second).diagnostic).toMatchObject({ phase: "headers", category: "cancelled" });
    channel("undici:request:bodyChunkSent").publish({ request: requests[0] });
    signals[0]!.abort(); expect((await first).diagnostic).toMatchObject({ phase: "upload", category: "cancelled" });
    for (const [event, hadSubscribers] of subscriptions) expect(event.hasSubscribers).toBe(hadSubscribers);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["direct", "proxy"])("preserves different reference sizes and observes real upload/header/body cancellation through %s", async (route) => {
    let mode: "success" | "reject" | "reject500" | "upload" | "headers" | "body" = "success", controller: AbortController | undefined, posts = 0, serialized = "";
    const received: { bytes: number; reference: string }[] = [], failures: unknown[] = [];
    const sockets = new Set<net.Socket>();
    const server = http.createServer(async (request, response) => {
      posts++;
      try {
        if (mode === "upload") { request.once("data", () => controller?.abort()); request.resume(); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString());
        expect(Number(request.headers["content-length"])).toBe(bytes.length);
        expect(request.headers["transfer-encoding"]).toBeUndefined();
        expect(bytes.equals(Buffer.from(serialized))).toBe(true);
        expect(request.url).toBe("/v1/audio/speech"); expect(request.headers.authorization).toBe("Bearer fake-key");
        expect(body.references[0]).not.toHaveProperty("speaker"); expect(body).not.toHaveProperty("voice");
        expect(body.text_prompt).toContain("@音频1");
        received.push({ bytes: bytes.length, reference: body.references[0].audio_data });
        if (mode === "headers") { controller?.abort(); return; }
        if (mode === "body") { response.writeHead(200, { "content-type": "audio/mpeg" }); response.write(MP3); setTimeout(() => controller?.abort(), 25); return; }
        if (mode === "reject" || mode === "reject500") { response.writeHead(mode === "reject500" ? 500 : 400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "bad_response_status_code", message: "fake-key private-script https://private.invalid/?signature=private", param: "private-material" } })); return; }
        response.writeHead(200, { "content-type": "audio/mpeg" }).end(MP3);
      } catch (cause) { failures.push(cause); response.destroy(); }
    });
    const proxy = http.createServer();
    let origin = "";
    proxy.on("connect", (request, socket, head) => {
      sockets.add(socket as net.Socket); socket.once("close", () => sockets.delete(socket as net.Socket));
      if (`http://${request.url}` !== origin) { socket.destroy(); return; }
      const upstream = net.connect(Number(new URL(origin).port), "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const previous = getGlobalDispatcher(), dispatcher = route === "direct" ? new Agent() : new ProxyAgent(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`);
    setGlobalDispatcher(dispatcher);
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).origin).toBe(origin);
      serialized = String(init?.body);
      if (mode !== "upload") return fetch(input, init);
      // Deliberately throttle only the synthetic transport; production JSON is unchanged.
      const bytes = Buffer.from(String(init?.body)); let offset = 0, stopped = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) { await new Promise((resolve) => setTimeout(resolve, 10)); if (stopped) return; if (offset === bytes.length) stream.close(); else { stream.enqueue(bytes.subarray(offset, offset + 16_384)); offset = Math.min(offset + 16_384, bytes.length); } },
        cancel() { stopped = true; },
      });
      return fetch(input, { ...init, body, duplex: "half" } as RequestInit);
    });
    const provider = new VolcengineTtsProvider(() => "fake-key", request, origin + "/v1/audio/speech");
    const generate = (bytes: Buffer) => provider.generate({ operation: "speech", model: MODEL, text: "Hello", referenceAssetId: "synthetic", referenceAudio: { bytes, mediaType: "audio/wav" } }, controller?.signal);
    try {
      const large = referenceWav(27.074467, 44_100, 2);
      // Match the earlier real 192,044-byte PCM reference and the user's large stereo shape without reading either recording.
      for (const bytes of [WAV, referenceWav(2, 48_000), large]) { expect((await generate(bytes)).bytes).toEqual(MP3); expect(received.at(-1)?.reference).toBe(bytes.toString("base64")); }
      // Identical synthetic JSON isolates native-fetch transport wrapping, not
      // the real Workbench runtime, prompt/output settings, or external gateway.
      const native = await fetch(origin + "/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-key" }, body: serialized });
      expect(Buffer.from(await native.arrayBuffer())).toEqual(MP3);
      expect(received.at(-1)?.reference).toBe(large.toString("base64"));
      mode = "reject";
      const rejection = await generate(large).catch((cause) => cause);
      expect(rejection.diagnostic).toMatchObject({ phase: "body", category: "http", httpStatus: 400, providerCode: "bad-response-status", requestBytes: received.at(-1)?.bytes });
      for (const privateText of ["fake-key", "private-script", "signature=private", "private-material", large.toString("base64")]) expect(JSON.stringify(rejection) + rejection.message).not.toContain(privateText);
      mode = "reject500";
      const failed = await generate(referenceWav(2, 48_000)).catch(cause => cause);
      expect(failed).toMatchObject({ submissionOutcome: "unknown", diagnostic: { phase: "body", category: "http", httpStatus: 500, providerCode: "bad-response-status", requestBytes: received.at(-1)?.bytes } });
      for (const privateText of ["fake-key", "private-script", "signature=private", "private-material", referenceWav(2, 48_000).toString("base64")]) expect(JSON.stringify(failed) + failed.message).not.toContain(privateText);
      for (const phase of ["upload", "headers", "body"] as const) {
        mode = phase; controller = new AbortController();
        const guard = setTimeout(() => controller?.abort(), 5000);
        try {
          const error = await generate(large).catch((cause) => cause);
          expect(error).toMatchObject({ statusCode: 499, submissionOutcome: "unknown", diagnostic: { phase, category: "cancelled" } });
        } finally { clearTimeout(guard); }
      }
      expect(posts).toBe(9); expect(request).toHaveBeenCalledTimes(8); expect(failures).toEqual([]);
    } finally {
      setGlobalDispatcher(previous); controller?.abort(); await dispatcher.destroy();
      for (const socket of sockets) socket.destroy(); server.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
    }
  });

  it("validates actual audio format, duration and size locally", async () => {
    expect(await inspectAudioReference(WAV, "audio/wav")).toMatchObject({ mediaType: "audio/wav", duration: 1 });
    expect((await inspectAudioReference(referenceMp3(), "audio/mpeg")).duration).toBeGreaterThan(1);
    expect(await inspectAudioReference(WAV)).toMatchObject({ mediaType: "audio/wav", duration: 1 });
    const taggedMp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), referenceMp3()]);
    expect(await inspectAudioReference(taggedMp3)).toMatchObject({ mediaType: "audio/mpeg" });
    await expect(inspectAudioReference(taggedMp3, "audio/wav")).rejects.toBeDefined();
    await expect(inspectAudioReference(Buffer.from("renamed m4a"))).rejects.toBeDefined();
    await expect(inspectAudioReference(referenceWav(30.1))).rejects.toBeDefined();
    expect(await inspectAudioReference(referenceWav(30), "audio/wav")).toMatchObject({ duration: 30 });
    for (const [bytes, type] of [[referenceWav(30.1), "audio/wav"], [WAV, "audio/mpeg"], [Buffer.from("renamed m4a"), "audio/wav"], [Buffer.alloc(10_000_001), "audio/wav"], [Buffer.alloc(0), "audio/wav"], [WAV, "audio/mp4"]] as const) {
      await expect(inspectAudioReference(bytes, type)).rejects.toBeDefined();
    }
  });

  it("rejects legacy Speaker IDs even with a valid reference", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new VolcengineTtsProvider(() => "fake-key", request).generate({ operation: "speech", model: MODEL, text: "hello", ...reference, voiceId: "old-speaker" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not replay a duplicate or cancelled speech submission after resolving its reference", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const provider = new VolcengineTtsProvider(() => "fake-key", request), controller = new AbortController();
    const first = provider.generate({ operation: "speech", model: MODEL, text: "Hello", ...reference }, controller.signal);
    const stopped = expect(first).rejects.toMatchObject({ statusCode: 499, submissionOutcome: "unknown" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await expect(provider.generate({ operation: "speech", model: MODEL, text: "Hello", ...reference })).rejects.toMatchObject({ statusCode: 409 });
    controller.abort(); await stopped; expect(request).toHaveBeenCalledOnce();
  });

  it("refuses credential bytes hidden in a valid audio container before submission", async () => {
    const key = "sk-speech-reference-private-canary", bytes = referenceWav(); bytes.set(Buffer.from(key), 100);
    const request = vi.fn<typeof fetch>();
    await expect(new VolcengineTtsProvider(() => key, request).generate({ operation: "speech", model: MODEL, text: "Hello", referenceAssetId: "reference", referenceAudio: { bytes, mediaType: "audio/wav" } })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "speech" as const, model: { ...MODEL, id: "seed-tts-2.0" }, text: "hello", ...reference },
    { operation: "speech" as const, model: MODEL, text: " ", ...reference },
    { operation: "speech" as const, model: MODEL, text: "hello", voiceId: "invalid speaker" },
    { operation: "speech" as const, model: MODEL, text: "hello", ...reference, speed: 0.5 },
    { operation: "speech" as const, model: MODEL, text: "hello", ...reference, speed: 101 },
    { operation: "speech" as const, model: MODEL, text: "hello", ...reference, language: "ja" },
    { operation: "speech" as const, model: { ...MODEL, id: "seed-audio-1.0-multilingual" }, text: "hello", ...reference, language: "xx" },
    { operation: "speech" as const, model: MODEL, text: "a".repeat(3_000), ...reference },
    { operation: "speech" as const, model: MODEL, text: "hello", ...reference, output: { channels: 1 as const } },
    { operation: "sound-effect" as const, model: MODEL, prompt: "thunder" },
  ])("rejects old IDs, unsupported parameters and missing input before sending %#", async (input) => {
    const request = vi.fn<typeof fetch>();
    await expect(new VolcengineTtsProvider(() => "fake-key", request).generate(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("passes an explicitly selected multilingual model without silently replacing it", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
    const selected = { ...MODEL, id: "seed-audio-1.0-multilingual" };
    const generated = await new VolcengineTtsProvider(() => "fake-key", request).generate({
      operation: "speech", model: selected, text: "こんにちは", language: "ja", ...reference,
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).model).toBe(selected.id);
    expect(generated.model).toEqual(selected);
  });

  it("accepts regional forms of documented speech languages", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(audio());
    await new VolcengineTtsProvider(() => "fake-key", request).generate({
      operation: "speech", model: MODEL, text: "hello", language: "en-US", ...reference,
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).text_prompt).toContain("Language: en-US.");
  });
});
