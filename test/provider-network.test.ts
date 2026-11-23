import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { lookup } from "node:dns/promises";
import {
  fetchProviderArtifact, guardedProviderFetch, isPublicArtifactAddress,
  providerArtifactUrl, providerControlUrl, providerPollingUrl, redactProviderResponse, PROVIDER_SSE_LIMIT_BYTES, PROVIDER_SSE_IDLE_TIMEOUT_MS,
  PROVIDER_REQUEST_LIMIT_BYTES, PROVIDER_REQUEST_INSPECTION_TIMEOUT_MS, providerErrorCode,
} from "../src/daemon/provider-network.js";
import { OpenAIImageGenerator } from "../src/daemon/openai-image.js";
import { SeedreamProvider } from "../src/daemon/seedream-provider.js";
import { seedreamModels } from "../src/daemon/seedream-models.js";
import { SeedanceProvider } from "../src/daemon/seedance-provider.js";
import { seedanceModels } from "../src/daemon/seedance-models.js";
import { MinimaxProvider } from "../src/daemon/minimax-provider.js";
import { minimaxModels } from "../src/daemon/minimax-models.js";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { TripoProvider } from "../src/daemon/tripo-provider.js";
import { Hyper3DProvider } from "../src/daemon/hyper3d-provider.js";
import { VolcengineTtsProvider } from "../src/daemon/volcengine-tts-provider.js";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";
import { withProviderRequestScope } from "../src/daemon/provider-request-monitor.js";

const artifactDns = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: artifactDns,
}));

const canary = "sk-security-canary-0123456789-DO-NOT-EXPOSE";
const endpoint = "https://llm.ziy.cc/v1/responses";
const encode = new TextEncoder();

describe("passive provider request monitoring", () => {
  let log: ReturnType<typeof vi.spyOn>;
  const records = () => log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.msg === "Provider request");
  beforeEach(() => { log = vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([false, true])("counts raw JSON and binary bytes with credentials=%s without claiming model completion", async authenticated => {
    for (const type of ["application/json", "image/png"]) {
      log.mockClear();
      const privateReply = type === "image/png" ? "PRIVATE_IMAGE_BYTES" : '{"reply":"PRIVATE_REPLY"}';
      const body = '{"prompt":"PRIVATE_PROMPT"}';
      const response = await guardedProviderFetch(vi.fn<typeof fetch>(async () => new Response(privateReply, { headers: { "content-type": type, "x-request-id": "req_safe_1", "x-private": "PRIVATE_HEADER" } })))(endpoint, {
        method: "POST", headers: authenticated ? { authorization: `Bearer ${canary}` } : {}, body,
      });
      expect(await response.text()).toBe(privateReply);
      expect(records().map(entry => entry.event)).toEqual(["started", "response", "first_body_byte", "finished"]);
      expect(records().at(-1)).toMatchObject({ outcome: "transport_complete", requestBytes: Buffer.byteLength(body), receivedBytes: Buffer.byteLength(privateReply), statusCode: 200, providerRequestId: "req_safe_1", wireComplete: true, responseValidated: true });
      const encoded = JSON.stringify(records());
      for (const privateValue of ["PRIVATE_", canary, "https:", "authorization", "content-type", "sha256"]) expect(encoded).not.toContain(privateValue);
    }
  });

  it("keeps safe HTTP diagnostics while bounding error-body accounting and never echoing unknown metadata", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ error: { code: "overloaded_error", message: `PRIVATE_PROMPT ${canary}` }, request_id: "req_safe_error" });
    const response = await guardedProviderFetch(vi.fn<typeof fetch>(async () => new Response(body, { status: 500, headers: { "set-cookie": "PRIVATE_COOKIE", "x-request-id": canary } })))(endpoint, { headers: { "x-api-key": canary } });
    expect(response.status).toBe(500);
    expect(records().at(-1)).toMatchObject({ outcome: "http_error", statusCode: 500, providerRequestId: "req_safe_error", errorCode: "overloaded_error", receivedBytes: Buffer.byteLength(body), wireComplete: true, responseValidated: false });
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|sk-security|https:|set-cookie/);
    expect(records().filter(entry => entry.event === "finished")).toHaveLength(1);
  });

  it.each([
    ["ENOTFOUND", "transport_error", "dns", undefined],
    ["ECONNRESET", "transport_error", "connection", undefined],
    ["CERT_HAS_EXPIRED", "transport_error", "connection", undefined],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", "timeout", "headers"],
  ])("classifies %s without retaining the transport cause", async (code, outcome, errorCategory, timeoutKind) => {
    const request = vi.fn<typeof fetch>(async () => { throw Object.assign(new Error(`PRIVATE_CAUSE ${canary}`), { cause: { code } }); });
    await expect(guardedProviderFetch(request)(endpoint)).rejects.toMatchObject({ message: "Could not reach the configured provider", category: errorCategory, code });
    expect(request).toHaveBeenCalledOnce();
    expect(records().at(-1)).toMatchObject({ outcome, errorCategory, errorCode: code, ...(timeoutKind ? { timeoutKind } : {}) });
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|sk-security/);
  });

  it("extracts an allowlisted code from native fetch address failures without exposing unknown properties", async () => {
    const failure = new AggregateError([{ code: canary }, { code: "ECONNREFUSED", address: canary }], canary);
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause: failure }));
    const error = await guardedProviderFetch(request)(endpoint).catch(cause => cause);
    expect(error).toMatchObject({ category: "connection", code: "ECONNREFUSED" });
    expect(error.cause).toBeUndefined();
    expect(records().at(-1)).toMatchObject({ errorCode: "ECONNREFUSED" });
    const unknown = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error(canary), { code: canary }));
    const other = await guardedProviderFetch(unknown)(endpoint).catch(cause => cause);
    expect(other.code).toBeUndefined();
    expect(records().at(-1)).not.toHaveProperty("errorCode");
    expect(JSON.stringify([error, other, records()])).not.toContain(canary);
  });

  it("distinguishes local response validation after HTTP 200 from a failure to connect", async () => {
    const response = new Response("private", { headers: { "content-type": "text/event-stream" } });
    const locked = response.body!.getReader();
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(guardedProviderFetch(request)(endpoint, { headers: { "x-api-key": canary } })).rejects.toMatchObject({
        message: "Provider response could not be safely verified", category: "local-policy", code: "PROVIDER_RESPONSE_VALIDATION_FAILED",
      });
      expect(records().at(-1)).toMatchObject({ statusCode: 200, outcome: "validation_error", errorCode: "PROVIDER_RESPONSE_VALIDATION_FAILED" });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { locked.releaseLock(); }
  });

  it("retains a transport reset while reading an accepted response", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      controller.error(Object.assign(new Error(canary), { code: "ECONNRESET" }));
    } });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const response = await guardedProviderFetch(request)(endpoint);
    await expect(response.text()).rejects.toMatchObject({ code: "ECONNRESET", category: "connection" });
    expect(records().at(-1)).toMatchObject({ statusCode: 200, outcome: "stream_interrupted", errorCode: "ECONNRESET" });
    expect(JSON.stringify(records())).not.toContain(canary);
  });

  it("records local validation and original caller cancellation with no extra submission or leftover timers", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>();
    await expect(guardedProviderFetch(request)(endpoint, { method: "POST", headers: { "x-api-key": canary }, body: canary })).rejects.toThrow("credential data");
    expect(records().at(-1)).toMatchObject({ outcome: "validation_error", receivedBytes: 0, errorCode: "PROVIDER_REQUEST_VALIDATION_FAILED" });
    expect(request).not.toHaveBeenCalled();
    const abort = new AbortController();
    const pendingFetch = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("PRIVATE_ABORT", "AbortError")), { once: true })));
    const pending = guardedProviderFetch(pendingFetch)(endpoint, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1); abort.abort(); await rejected;
    expect(records().at(-1)).toMatchObject({ outcome: "cancelled" });
    expect(records().filter(entry => entry.event === "finished")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records the actual first network body byte before safe release, with at most one progress line a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { upstream, response } = await openSimulatedSse();
    let released = false;
    const text = response.text().then(value => { released = true; return value; });
    await vi.advanceTimersByTimeAsync(35);
    const first = 'data: {"delta":"PRIVATE_STREAM"}\n\n';
    upstream.enqueue(encode.encode(first));
    await vi.advanceTimersByTimeAsync(1);
    expect(records().find(entry => entry.event === "first_body_byte")).toMatchObject({ firstBodyByteMs: 35, receivedBytes: Buffer.byteLength(first) });
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(59_964);
    expect(records().filter(entry => entry.event === "progress")).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({ phase: "receiving_body", responseHeadersMs: 0, firstBodyByteMs: 35, wireComplete: false });
    upstream.close(); await text;
    expect(records().at(-1)).toMatchObject({ outcome: "transport_complete", wireMs: 60_000 });
    expect(JSON.stringify(records())).not.toContain("PRIVATE_STREAM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes a standard caller deadline from cancellation", async () => {
    const abort = new AbortController();
    const response = await guardedProviderFetch(vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } })))(endpoint, { headers: { authorization: `Bearer ${canary}` }, signal: abort.signal });
    const read = expect(response.text()).rejects.toThrow("cancelled");
    abort.abort(new DOMException("PRIVATE_DEADLINE", "TimeoutError"));
    await read;
    expect(records().at(-1)).toMatchObject({ outcome: "timeout", errorCategory: "timeout", timeoutKind: "deadline" });
    expect(records().filter(entry => entry.event === "finished")).toHaveLength(1);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_DEADLINE");
  });

  it.each(["interrupted", "invalid", "idle", "cancelled"])("records an SSE %s exactly once and clears monitoring and transport resources", async failure => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const { upstream, response, cancel, signal } = await openSimulatedSse(abort.signal);
    const read = response.text().catch(() => {});
    if (failure === "idle") await vi.advanceTimersByTimeAsync(PROVIDER_SSE_IDLE_TIMEOUT_MS);
    else if (failure === "cancelled") abort.abort();
    else if (failure === "interrupted") upstream.error(new Error("PRIVATE_TRANSPORT_CAUSE"));
    else { upstream.enqueue(encode.encode(`data: {"delta":"${canary}"}\n\n`)); upstream.close(); }
    await read;
    expect(records().filter(entry => entry.event === "finished")).toHaveLength(1);
    expect(records().at(-1)?.outcome).toBe(failure === "idle" ? "timeout" : failure === "invalid" ? "validation_error" : failure === "cancelled" ? "cancelled" : "stream_interrupted");
    expect(signal.aborted).toBe(true);
    if (["idle", "cancelled"].includes(failure)) expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|sk-security/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps monitoring work and log count constant across many body chunks, including logger failures", async () => {
    let count = 0;
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (count++ < 1024) controller.enqueue(new Uint8Array(1024)); else controller.close(); } }), { headers: { "content-type": "application/octet-stream" } }));
    const response = await guardedProviderFetch(request)(endpoint);
    expect((await response.arrayBuffer()).byteLength).toBe(1024 * 1024);
    expect(records()).toHaveLength(4);
    expect(records().at(-1)?.receivedBytes).toBe(1024 * 1024);
    expect(JSON.stringify(records()).length).toBeLessThan(4096);
    log.mockImplementation(() => { throw Error("Logger unavailable"); });
    const next = await guardedProviderFetch(vi.fn<typeof fetch>(async () => new Response("OK")))(endpoint);
    expect(await next.text()).toBe("OK");
  });

  it("isolates concurrent scopes, resolves later active turns, and drops non-UUID correlation values", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111", conversationId = "22222222-2222-4222-8222-222222222222";
    let turnId = "33333333-3333-4333-8333-333333333333";
    const request = guardedProviderFetch(vi.fn<typeof fetch>(async () => Response.json({ private: "PRIVATE_REPLY" })));
    await Promise.all([
      withProviderRequestScope(() => ({ projectId, conversationId, turnId }), async () => {
        await (await request(endpoint)).text(); turnId = "44444444-4444-4444-8444-444444444444"; await (await request(endpoint)).text();
      }),
      withProviderRequestScope({ projectId: "PRIVATE_PATH", turnId: canary }, async () => { await (await request(endpoint)).text(); }),
    ]);
    const finished = records().filter(entry => entry.event === "finished");
    expect(finished.filter(entry => entry.projectId === projectId).map(entry => entry.turnId)).toEqual(["33333333-3333-4333-8333-333333333333", turnId]);
    expect(finished.filter(entry => entry.projectId === projectId).every(entry => entry.conversationId === conversationId)).toBe(true);
    expect(finished.find(entry => !entry.projectId)).not.toHaveProperty("turnId");
    expect(new Set(finished.map(entry => entry.localRequestId)).size).toBe(3);
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|sk-security/);
  });
});

function textChunks(text: string, split: number): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    controller.enqueue(encode.encode(text.slice(0, split)));
    controller.enqueue(encode.encode(text.slice(split)));
    controller.close();
  } });
}

async function openSimulatedSse(callerSignal?: AbortSignal) {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; }, cancel });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const response = await guardedProviderFetch(transport)(endpoint, { method: "POST", signal: callerSignal, headers: { authorization: `Bearer ${canary}` } });
  return { upstream, response, transport, cancel, signal: transport.mock.calls[0]![1]!.signal! };
}

describe("local secure provider networking", () => {
  beforeEach(() => { artifactDns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); });

  it.each(Array.from({ length: 4 }, (_, generic) => Array.from({ length: 4 }, (_, specific) => [generic, specific])).flat().filter(([generic, specific]) => generic !== specific))("prefers a specific field %s/%s over a generic structured error in either order", async (generic, specific) => {
    const fields: unknown[] = [null, null, null, null]; fields[generic!] = "bad_response_status_code"; fields[specific!] = "invalid_parameter";
    const response = Response.json({ error: { code: fields[0], type: fields[1], message: `${canary} https://private.invalid/?signature=private audio_data private-script` }, code: fields[2], type: fields[3] }, { status: 400 });
    expect(await providerErrorCode(response)).toBe("invalid-request");
  });

  it.each([
    [{ error: { code: "bad_response_status_code", type: "not-a-known-code", message: "invalid_parameter authentication_error timeout private-script" } }, "bad-response-status"],
    [{ error: { code: "not-a-known-code", message: "invalid_parameter authentication_error timeout private-script" }, message: "insufficient_quota" }, "unclassified"],
    [{ error: { code: "invalid_parameter-suffix", type: " invalid_parameter", param: "invalid_parameter" } }, "unclassified"],
    [{ error: { code: { value: "invalid_parameter" }, type: ["invalid_parameter"] }, code: 400 }, "unclassified"],
    [{ error: { code: "bad_response_status_code" }, type: "insufficient_quota" }, "quota"],
    [{ error: { code: "bad_response_status_code", type: "model_not_found" } }, "model-unavailable"],
    [{ error: { code: "server_error", type: "invalid_request_error" } }, "invalid-request"],
    [{ error: { code: "api_error", type: "insufficient_quota" } }, "quota"],
  ])("keeps the fallback closed and ignores free text %#", async (body, expected) => {
    const result = await providerErrorCode(Response.json(body, { status: 400 }));
    expect(result).toBe(expected);
    for (const privateValue of [canary, "https:", "signature=", "private-script", "audio_data"]) expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  it.each([endpoint, "https://llm.ziy.cc/v1/images/edits", "https://llm.ziy.cc/tripo/v3/tasks/task_1", "http://127.0.0.1:11434/v1/chat/completions", "http://[::1]:8000/v1/models"])("accepts a reviewed endpoint: %s", (value) => {
    expect(providerControlUrl(value).href).toBe(value);
  });

  it.each([
    "http://llm.ziy.cc/v1/responses", "https://api.openai.com/v1/responses",
    "https://llm.ziy.cc.evil.example/v1/responses", "https://evil.example/v1/responses",
    "https://user:password@llm.ziy.cc/v1/responses", "https://llm.ziy.cc/v1/responses#secret",
    "https://llm.ziy.cc/v1/responses?key=secret", "https://llm.ziy.cc/v1/community/games",
    "https://llm.ziy.cc/v1/models/%2fprivate", "file:///etc/passwd", "http://192.168.0.2:8000/v1/models",
  ])("rejects an unreviewed control target before sending: %s", async (value) => {
    const transport = vi.fn<typeof fetch>();
    await expect(guardedProviderFetch(transport)(value, { headers: { authorization: `Bearer ${canary}` } })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("forces redirect errors and redacts JSON and response headers using the actual request credential", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answer: `Bearer ${canary}` }, { headers: { "x-request-id": canary } }));
    const response = await guardedProviderFetch(transport)(endpoint, { headers: { authorization: `Bearer ${canary}` }, redirect: "follow" });
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(await response.text()).not.toContain(canary);
    expect(response.headers.get("x-request-id")).toBe("[redacted]");
  });

  it.each(["plain", "json", "unicode-json", "urlencoded", "bytes", "blob", "form-text", "form-file", "stream", "sdk-request"])("rejects a known credential in a %s body before opening the transport", async (kind) => {
    const secret = 'sk-request-body-canary-0123456789/with "escapes"';
    const transport = vi.fn<typeof fetch>();
    const headers = { authorization: `Bearer ${secret}` };
    let body: BodyInit = secret;
    if (kind === "json") body = JSON.stringify({ messages: [{ content: secret }] });
    if (kind === "unicode-json") body = `{"prompt":"${[...secret].map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`;
    if (kind === "urlencoded") body = new URLSearchParams({ prompt: secret });
    if (kind === "bytes") body = Buffer.from(`source: ${secret}`);
    if (kind === "blob") body = new Blob([`source: ${secret}`]);
    if (kind.startsWith("form-")) {
      const form = new FormData();
      form.set("prompt", "A harmless icon");
      form.set("reference", kind === "form-text" ? secret : new Blob([`file source: ${secret}`]));
      body = form;
    }
    if (kind === "stream") body = textChunks(`safe prefix ${secret} suffix`, 25);
    const input = kind === "sdk-request" ? new Request(endpoint, { method: "POST", headers, body: JSON.stringify({ prompt: secret }) }) : endpoint;
    const init = kind === "sdk-request" ? undefined : { method: "POST", headers, body };
    await expect(guardedProviderFetch(transport)(input, init)).rejects.toThrow("Provider request contains credential data");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([`https://llm.ziy.cc/v1/responses?trace=${encodeURIComponent(canary)}`, `https://llm.ziy.cc/v1/responses/${canary}`])("rejects a known credential under a nonstandard URL field: %s", async (url) => {
    const transport = vi.fn<typeof fetch>();
    await expect(guardedProviderFetch(transport)(url, { headers: { authorization: `Bearer ${canary}` } })).rejects.toThrow("Provider request URL contains credential data");
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves clean SDK and multipart request bodies and permits the key only in its authentication header", async () => {
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.headers.get("authorization")).toBe(`Bearer ${canary}`);
      if (outgoing.headers.get("content-type")?.includes("multipart")) expect((await outgoing.formData()).get("prompt")).toBe("clean multipart prompt");
      else expect(await outgoing.text()).toBe('{"prompt":"clean SDK prompt"}');
      return Response.json({ ok: true });
    });
    const guarded = guardedProviderFetch(transport);
    await guarded(new Request(endpoint, { method: "POST", headers: { authorization: `Bearer ${canary}` }, body: '{"prompt":"clean SDK prompt"}' }));
    const form = new FormData(); form.set("prompt", "clean multipart prompt"); form.set("image", new Blob([new Uint8Array([137, 80, 78, 71])]));
    await guarded(endpoint, { method: "POST", headers: { authorization: `Bearer ${canary}` }, body: form });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("sends the checked snapshot even if a caller mutates a byte buffer or an earlier form field during inspection", async () => {
    const bytes = new Uint8Array(canary.length).fill(65);
    const expected = new Uint8Array(bytes);
    const form = new FormData(); form.set("prompt", "checked clean prompt"); form.set("file", new Blob(["clean file"]));
    const file = form.get("file") as File, stream = file.stream.bind(file);
    vi.spyOn(file, "stream").mockImplementation(() => { form.set("prompt", canary); return stream(); });
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const outgoing = new Request(input, init);
      if (outgoing.headers.get("content-type")?.includes("multipart")) expect((await outgoing.formData()).get("prompt")).toBe("checked clean prompt");
      else expect(new Uint8Array(await outgoing.arrayBuffer())).toEqual(expected);
      return Response.json({ ok: true });
    });
    const guarded = guardedProviderFetch(transport);
    const pending = guarded(endpoint, { method: "POST", headers: { authorization: `Bearer ${canary}` }, body: bytes });
    bytes.set(encode.encode(canary));
    await pending;
    await guarded(endpoint, { method: "POST", headers: { authorization: `Bearer ${canary}` }, body: form });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("snapshots URL, authentication headers and URL-encoded fields before async inspection yields", async () => {
    const url = new URL(endpoint), headers = new Headers({ authorization: `Bearer ${canary}` });
    const body = new URLSearchParams({ prompt: "clean form value" });
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${canary}`);
      expect(String(init?.body)).toBe("prompt=clean+form+value");
      return Response.json({ ok: true });
    });
    const pending = guardedProviderFetch(transport)(url, { method: "POST", headers, body });
    url.hostname = "unreviewed.example";
    headers.set("authorization", "Bearer mutated-credential"); body.set("prompt", canary);
    await pending;
    expect(transport).toHaveBeenCalledOnce();
  });

  it("refuses oversized streaming request bodies before sending and cancels their source", async () => {
    const cancel = vi.fn(), transport = vi.fn<typeof fetch>();
    const chunk = new Uint8Array(1024 * 1024);
    let count = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); count++; }, cancel });
    await expect(guardedProviderFetch(transport)(endpoint, { method: "POST", body })).rejects.toThrow("secure size limit");
    expect(count).toBeGreaterThan(PROVIDER_REQUEST_LIMIT_BYTES / chunk.byteLength);
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds request inspection time even when the stream's cancellation does not complete", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {})), transport = vi.fn<typeof fetch>();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const rejected = expect(guardedProviderFetch(transport)(endpoint, { method: "POST", body })).rejects.toThrow("secure inspection time limit");
      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_INSPECTION_TIMEOUT_MS);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(transport).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("cancels pending request inspection without echoing the cancellation reason", async () => {
    const abort = new AbortController(), cancel = vi.fn(), transport = vi.fn<typeof fetch>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const rejected = expect(guardedProviderFetch(transport)(endpoint, { method: "POST", signal: abort.signal, body })).rejects.toThrow("Provider request cancelled");
    abort.abort(new Error(canary));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a credential at every SSE chunk boundary before releasing events", async () => {
    const text = `data: {"delta":"Bearer ${canary}"}\n\ndata: [DONE]\n\n`;
    for (let split = 0; split <= text.length; split++) {
      const response = await redactProviderResponse(new Response(textChunks(text, split), { headers: { "content-type": "text/event-stream" } }), [`Bearer ${canary}`, canary]);
      await expect(response.text()).rejects.toMatchObject({ code: "SSE_VALIDATION_FAILED", message: "Provider SSE response failed local validation" });
    }
  });

  it("redacts escaped and URL-encoded credentials from text", async () => {
    const secret = 'a\\b"canary';
    const text = JSON.stringify({ plain: secret, url: encodeURIComponent(secret) });
    const response = await redactProviderResponse(new Response(text, { headers: { "content-type": "application/json" } }), [secret]);
    expect(await response.text()).toBe('{"plain":"[redacted]","url":"[redacted]"}');
  });

  it("replaces provider error bodies and network exceptions with fixed public messages", async () => {
    const failed = guardedProviderFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response(canary, { status: 400, headers: { "retry-after": canary } })));
    const response = await failed(endpoint, { headers: { "x-api-key": canary } });
    expect(await response.text()).not.toContain(canary);
    expect(response.headers.get("retry-after")).toBeNull();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(`request failed: ${canary}`));
    await expect(guardedProviderFetch(transport)(endpoint, { headers: { "x-api-key": canary } })).rejects.toThrow("Could not reach the configured provider");
  });

  it("preserves only recognized error codes and safe request IDs and logs request scale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const requestBody = JSON.stringify({ input: "private prompt that must not be logged" });
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: "api_error", code: "bad_response_status_code", message: `${canary} private prompt`, debug: "private response" } },
        { status: 500, headers: { "x-request-id": "req_safe_123", "set-cookie": canary, "x-private": "private response" } }));
      const response = await guardedProviderFetch(transport)(endpoint, { method: "POST", headers: { authorization: `Bearer ${canary}` }, body: requestBody });
      expect(response.status).toBe(500);
      expect(response.headers.get("x-request-id")).toBe("req_safe_123");
      expect(await response.json()).toMatchObject({ error: { code: "api_error", message: "Provider request failed" } });
      expect([...response.headers.keys()].sort()).toEqual(["content-type", "x-ohmygame-error-code", "x-request-id"]);
      const logged = JSON.parse(warn.mock.calls[0]![0]);
      expect(logged).toEqual({ msg: "Provider HTTP request failed", statusCode: 500, requestId: "req_safe_123", errorCode: "api_error", requestBytes: Buffer.byteLength(requestBody), responseHeadersMs: expect.any(Number) });
      expect(logged.responseHeadersMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private prompt|private response|sk-security-canary/);
      expect(transport).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it.each(["req_safe_from_body", canary, "https://private.invalid/path", "req_" + "x".repeat(129)])("filters error request IDs and never echoes provider text: %s", async (requestId) => {
    const response = await redactProviderResponse(Response.json({ request_id: requestId, error: { code: canary, type: "unknown_private_code", message: "private prompt" } }, { status: 400, headers: { "x-request-id": canary } }), [canary]);
    expect(response.headers.get("x-request-id")).toBe(requestId === "req_safe_from_body" ? requestId : null);
    expect(await response.text()).toBe('{"error":{"message":"Provider request failed"},"message":"Provider request failed"}');
  });

  it("bounds error inspection and keeps HTTP status and safe headers when an error body stalls", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = redactProviderResponse(new Response(body, { status: 502, headers: { "x-request-id": "req_stalled" } }), [canary]);
      await vi.advanceTimersByTimeAsync(1001);
      const response = await pending;
      expect(response.status).toBe(502);
      expect(response.headers.get("x-request-id")).toBe("req_stalled");
      expect(await response.text()).not.toContain(canary);
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["not JSON", JSON.stringify({ error: { code: "server_error", message: "x".repeat(8192) } })])("discards malformed or oversized error bodies", async (body) => {
    const response = await redactProviderResponse(new Response(body, { status: 500 }), [canary]);
    expect(await response.json()).toEqual({ error: { message: "Provider request failed" }, message: "Provider request failed" });
  });

  it("does not decode or rewrite binary audio", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x81, 0x72]);
    const response = await redactProviderResponse(new Response(bytes, { headers: { "content-type": "audio/mpeg" } }), [canary]);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects clear credential bytes in binary results and inline base64 images before saving", async () => {
    const binary = await redactProviderResponse(new Response(encode.encode(`ID3${canary}`), { headers: { "content-type": "audio/mpeg" } }), [canary]);
    await expect(binary.arrayBuffer()).rejects.toMatchObject({ category: "local-policy", code: "PROVIDER_RESPONSE_VALIDATION_FAILED" });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: Buffer.from(canary).toString("base64") }] }));
    await expect(new OpenAIImageGenerator(canary, "https://llm.ziy.cc/v1", transport).generate({ prompt: "icon", size: "1024x1024" })).rejects.toThrow("credential data");
  });

  it("denies explicit original vendor endpoints before sending any credential", async () => {
    const transport = vi.fn<typeof fetch>(), key = () => canary;
    const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
    const meshKey = vi.fn(() => canary);
    await expect(new MeshyProvider(meshKey, transport).generate({ model: { provider: "meshy", id: "meshy-t2" }, images: [image] })).rejects.toMatchObject({ statusCode: 403, notSubmitted: true });
    expect(meshKey).not.toHaveBeenCalled();
    const operations: Array<() => Promise<unknown>> = [
      () => new OpenAIImageGenerator(canary, "https://api.openai.com/v1", transport).generate({ prompt: "icon", size: "1024x1024" }),
      () => new SeedreamProvider(key, transport, "https://ark.cn-beijing.volces.com/api/v3").generate(seedreamModels()[0]!, { prompt: "icon", resolution: "1K", aspectRatio: "1:1" }),
      () => new SeedanceProvider("volcengine-ark", key, transport, undefined, undefined, { name: "Original Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }).generate(seedanceModels("volcengine-ark")[0]!, { prompt: "video" }),
      () => new MinimaxProvider("minimax-video-cn", key, transport).generate(minimaxModels("minimax-video-cn")[0]!, { prompt: "video" }),
      () => new TripoProvider(key, transport, undefined, undefined, { baseUrl: "https://openapi.tripo3d.ai/v3", apiKey: canary }).generate({ model: { provider: "tripo", id: "P1-20260311" }, images: [image] }),
      () => new Hyper3DProvider(key, transport).generate({ model: { provider: "hyper3d", id: "Gen-2.5-Medium" }, images: [image] }),
      () => new VolcengineTtsProvider(key, transport, "https://openspeech.bytedance.com/api/v3/tts/unidirectional").generate({ operation: "speech", model: { provider: "volcengine-tts", id: "seed-audio-1.0" }, text: "hello", voiceId: "voice" }),
      () => new VolcengineSeedAudioProvider(key, transport, "https://openspeech.bytedance.com/api/v3/tts/create").generate({ operation: "sound-effect", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" }, prompt: "rain" }),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow("local secure mode");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    (value: string) => ({ choices: [{ delta: { content: value } }] }),
    (value: string) => ({ type: "response.output_text.delta", delta: value }),
    (value: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } }),
    (value: string) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: value } }),
    (value: string) => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: value } }),
    (value: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: value } }] } }] }),
  ])("rejects a credential assembled across independent semantic SSE deltas", async (event) => {
    const wire = [...canary].map((part) => `data: ${JSON.stringify(event(part))}\n\n`).join("") + "data: [DONE]\n\n";
    const response = await redactProviderResponse(new Response(wire, { headers: { "content-type": "text/event-stream" } }), [canary]);
    await expect(response.text()).rejects.toMatchObject({ code: "SSE_VALIDATION_FAILED", message: "Provider SSE response failed local validation" });
  });

  it("accepts an active multi-minute SSE response and releases events only after verification", async () => {
    vi.useFakeTimers();
    try {
      const { upstream, response, transport, signal } = await openSimulatedSse();
      const reader = response.body!.getReader(), observed = vi.fn();
      void reader.read().then(observed, observed);
      const frames = ['data: {"delta":"first"}\n\n', ": keepalive\n\n", 'data: {"delta":"last"}\n\n', "data: [DONE]\n\n"];
      for (const frame of frames) {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(observed).not.toHaveBeenCalled();
        upstream.enqueue(encode.encode(frame));
      }
      upstream.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toHaveBeenCalledWith({ done: false, value: encode.encode(frames.join("")) });
      expect((await reader.read()).done).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(transport).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("fails closed on the bounded SSE size limit and propagates cancellation", async () => {
    const response = await redactProviderResponse(new Response(new Uint8Array(PROVIDER_SSE_LIMIT_BYTES + 1), { headers: { "content-type": "text/event-stream" } }), [canary]);
    await expect(response.text()).rejects.toMatchObject({ code: "SSE_VALIDATION_FAILED", message: "Provider SSE response exceeded the secure size limit" });
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ cancel });
    const pending = await redactProviderResponse(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), [canary]);
    await pending.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["before", "after"])("times out after 180 seconds without new bytes %s the first SSE event", async (phase) => {
    vi.useFakeTimers();
    try {
      const { upstream, response, transport, cancel, signal } = await openSimulatedSse();
      const rejected = expect(response.body!.getReader().read()).rejects.toMatchObject({ code: "SSE_IDLE_TIMEOUT" });
      if (phase === "after") {
        await vi.advanceTimersByTimeAsync(120_000);
        upstream.enqueue(encode.encode('data: {"delta":"partial"}\n\n'));
      }
      await vi.advanceTimersByTimeAsync(PROVIDER_SSE_IDLE_TIMEOUT_MS - 1);
      expect(signal.aborted).toBe(false);
      upstream.enqueue(new Uint8Array());
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["interrupted", "SSE_CONNECTION_INTERRUPTED", "Provider SSE connection was interrupted while reading the response"],
    ["invalid", "SSE_VALIDATION_FAILED", "Provider SSE response failed local validation"],
  ])("reports an %s stream without leaking partial output or the private cause, and never resends", async (failure, code, message) => {
    const { upstream, response, transport, signal } = await openSimulatedSse();
    const firstRead = response.body!.getReader().read().catch((cause: unknown) => cause);
    upstream.enqueue(encode.encode('data: {"delta":"partial"}\n\n'));
    if (failure === "interrupted") upstream.error(new Error(canary));
    else { upstream.enqueue(encode.encode(`data: {"private":"${canary}`)); upstream.close(); }
    const result = await firstRead;
    expect(result).toMatchObject({ code, message });
    expect(result).not.toHaveProperty("cause");
    expect(signal.aborted).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("propagates a caller abort to pending SSE verification and upstream reading", async () => {
    const abort = new AbortController(), cancel = vi.fn();
    let signal: AbortSignal | null | undefined;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "text/event-stream" } });
    });
    const response = await guardedProviderFetch(transport)(new Request(endpoint, { signal: abort.signal, headers: { "x-api-key": canary } }));
    const rejected = expect(response.text()).rejects.toThrow("Provider request cancelled");
    abort.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("keeps authenticated polling inside the configured API origin and path", () => {
    expect(providerPollingUrl("https://llm.ziy.cc/v1/videos/task_1", "https://llm.ziy.cc/v1")).toContain("task_1");
    expect(() => providerPollingUrl("https://evil.example/v1/videos/task_1", "https://llm.ziy.cc/v1")).toThrow();
    expect(() => providerPollingUrl("http://127.0.0.1:8000/settings", "http://127.0.0.1:8000/v1")).toThrow();
  });

  it.each(["127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"])("rejects private and reserved artifact addresses: %s", (value) => {
    expect(isPublicArtifactAddress(value)).toBe(false);
  });

  it("checks every DNS answer before accepting a remote artifact", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
    await expect(providerArtifactUrl("https://llm.ziy.cc/artifact.png", "https://llm.ziy.cc/v1", resolve)).rejects.toThrow("Invalid provider artifact address");
  });

  it("explains Fake-IP DNS without accepting reserved addresses or opening HTTP", async () => {
    artifactDns.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
    const transport = vi.fn<typeof fetch>();
    await expect(fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/image.png?signature=private-link", "https://llm.ziy.cc/v1")).rejects.toThrow("Fake-IP DNS");
    expect(transport).not.toHaveBeenCalled();
    expect(isPublicArtifactAddress("198.18.0.106")).toBe(false);
  });

  it("cancels a blocked DNS lookup without downloading or exposing the signed URL", async () => {
    artifactDns.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController(), transport = vi.fn<typeof fetch>();
    const pending = fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/image.png?signature=private-link", "https://llm.ziy.cc/v1", { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow("Could not download the provider artifact");
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a stalled artifact DNS lookup to ten seconds without opening HTTP", async () => {
    vi.useFakeTimers();
    try {
      artifactDns.mockImplementation(() => new Promise(() => {}));
      const transport = vi.fn<typeof fetch>();
      const pending = expect(fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/image.png", "https://llm.ziy.cc/v1")).rejects.toThrow("Could not download the provider artifact");
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(transport).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["meshy.ai", "api.meshy.ai", "assets.meshy.ai.", "ohmygame.ai", "updates.ohmygame.ai", "account.ohmygame.ai", "ohmygame.cc", "us.i.posthog.com", "ingest.sentry.io", "nested.sentry.dev."])("blocks disabled service, author and telemetry artifact targets before DNS: %s", async (host) => {
    const resolve = vi.fn() as unknown as typeof lookup;
    await expect(providerArtifactUrl(`https://${host}/job-signed-image`, "https://llm.ziy.cc/v1", resolve)).rejects.toThrow("blocked in local secure mode");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows local artifacts only on the explicitly selected local model origin", async () => {
    await expect(providerArtifactUrl("http://127.0.0.1:8000/output.png", "http://127.0.0.1:8000/v1")).resolves.toBeInstanceOf(URL);
    await expect(providerArtifactUrl("http://127.0.0.1:8000/output.png", "https://llm.ziy.cc/v1")).rejects.toThrow();
  });

  it("rejects an arbitrary public CDN before DNS until that origin has been reviewed", async () => {
    const resolve = vi.fn() as unknown as typeof lookup;
    await expect(providerArtifactUrl("https://cdn.example/artifact.png", "https://llm.ziy.cc/v1", resolve)).rejects.toThrow("Cross-origin provider artifacts");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("sends no API key or caller headers to artifact servers and rejects keys inside artifact URLs", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("image"));
    await fetchProviderArtifact(transport, "http://127.0.0.1:8000/image.png", "http://127.0.0.1:8000/v1", { headers: { authorization: `Bearer ${canary}` }, protectedSecrets: [canary] });
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
    await expect(fetchProviderArtifact(transport, `http://127.0.0.1:8000/${canary}`, "http://127.0.0.1:8000/v1", { protectedSecrets: [canary] })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://llm.ziy.cc/v1/videos/task_1/content",
    "https://llm.ziy.cc/v1/tasks/task_1/artifacts/model/content",
  ])("authenticates only the reviewed same-origin content route: %s", async (url) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.from([0xff, 0x00, 0x81, 0x72])));
    const response = await fetchProviderArtifact(transport, url, "https://llm.ziy.cc/tripo/v3", {
      apiKey: canary, protectedSecrets: [canary], headers: { cookie: "host-session", "x-unreviewed": "never-forward" },
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0xff, 0x00, 0x81, 0x72]));
    const [target, init] = transport.mock.calls[0]!;
    expect(target).toBe(url);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect([...new Headers(init?.headers)]).toEqual([["authorization", `Bearer ${canary}`]]);
    expect(artifactDns).toHaveBeenCalledWith("llm.ziy.cc", { all: true });
  });

  it.each([
    "https://llm.ziy.cc/artifacts/output.png",
    "https://llm.ziy.cc/v1/videos/task_1",
    "https://llm.ziy.cc/v1/tasks/task_1/artifacts/model",
  ])("does not attach a key to a same-origin path outside the content allowlist: %s", async (url) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("asset"));
    await fetchProviderArtifact(transport, url, "https://llm.ziy.cc/v1", { apiKey: canary, headers: { authorization: `Bearer ${canary}` } });
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("downloads the reviewed exact CDN anonymously even when a control credential is available", async () => {
    const bytes = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0xff, 0x81]);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": "model/gltf-binary", "set-cookie": "should-not-escape" },
    }));
    const response = await fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/output/model.glb", "https://llm.ziy.cc/v1", {
      apiKey: canary, protectedSecrets: [canary], headers: { Authorization: `Bearer ${canary}`, cookie: "host-cookie" },
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "GET", credentials: "omit" });
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(artifactDns).toHaveBeenCalledWith("kunpoapiimg.ziy.cc", { all: true });
  });

  it("downloads the documented native Seedance bucket without forwarding the Kunpo key", async () => {
    const url = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/video.mp4?X-Tos-Signature=private-signature";
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } }));
    await fetchProviderArtifact(transport, url, "https://llm.ziy.cc/v1", { apiKey: canary });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
    artifactDns.mockResolvedValue([{ address: "198.18.0.15", family: 4 }]); transport.mockClear();
    await expect(fetchProviderArtifact(transport, url, "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "https://kunpoapiimg.ziy.cc.evil.example/output.png",
    "https://nested.kunpoapiimg.ziy.cc/output.png",
    "https://kunpoapiimg.ziy.cc:444/output.png",
    "http://kunpoapiimg.ziy.cc/output.png",
    "https://cdn.example/output.png",
    "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com.evil.example/video.mp4",
    "https://other.tos-cn-beijing.volces.com/video.mp4",
    "http://ark-acg-cn-beijing.tos-cn-beijing.volces.com/video.mp4",
  ])("rejects unreviewed CDN origins before DNS or HTTP: %s", async (url) => {
    const transport = vi.fn<typeof fetch>();
    await expect(fetchProviderArtifact(transport, url, "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow("Could not download");
    expect(artifactDns).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not make the Kunpo CDN available to an unrelated loopback provider", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/output.png", "http://127.0.0.1:8000/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(artifactDns).not.toHaveBeenCalled();
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
  ])("rejects private DNS answers on the reviewed CDN before HTTP %#", async (...addresses) => {
    artifactDns.mockResolvedValue(addresses);
    const transport = vi.fn<typeof fetch>();
    await expect(fetchProviderArtifact(transport, "https://kunpoapiimg.ziy.cc/output.png", "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("removes authentication after a reviewed content redirect reaches the exact CDN", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://kunpoapiimg.ziy.cc/archive/video.mp4" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0x00, 0xff, 0x81])));
    const response = await fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0x00, 0xff, 0x81]));
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${canary}`);
    expect(transport.mock.calls[1]?.[0]).toBe("https://kunpoapiimg.ziy.cc/archive/video.mp4");
    expect(transport.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(transport.mock.calls[1]?.[1]?.redirect).toBe("error");
  });

  it.each([
    "https://evil.example/archive.mp4",
    "http://127.0.0.1:8000/private",
    "https://169.254.169.254/latest/meta-data",
    `https://kunpoapiimg.ziy.cc/output/${canary}.mp4`,
  ])("rejects an unsafe redirect without making a second HTTP request: %s", async (location) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow("Could not download");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(artifactDns).toHaveBeenCalledTimes(1);
  });

  it("checks the redirected CDN DNS before forwarding any request", async () => {
    artifactDns.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "192.168.1.3", family: 4 }]);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://kunpoapiimg.ziy.cc/archive.mp4" } }));
    await expect(fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(artifactDns).toHaveBeenCalledTimes(2);
  });

  it("bounds same-origin redirects to two hops and revalidates relative content paths", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/v1/tasks/task_2/artifacts/model/content" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/v1/videos/task_3/content" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "/v1/videos/task_4/content" } }));
    await expect(fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [, init] of transport.mock.calls) {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${canary}`);
    }
  });

  it("rejects a redirect with no Location and never follows anonymous CDN redirects", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchProviderArtifact(missing, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(missing).toHaveBeenCalledTimes(1);
    const cdn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/next" } }));
    const response = await fetchProviderArtifact(cdn, "https://kunpoapiimg.ziy.cc/output.mp4", "https://llm.ziy.cc/v1", { apiKey: canary });
    expect(response.ok).toBe(false);
    expect(cdn).toHaveBeenCalledTimes(1);
    expect(cdn.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects raw and encoded known credentials in CDN URLs before DNS", async () => {
    const secret = "sk-test/+?= encoded-artifact-key";
    const transport = vi.fn<typeof fetch>();
    await expect(fetchProviderArtifact(transport, `https://kunpoapiimg.ziy.cc/output.png?access=${encodeURIComponent(secret)}`, "https://llm.ziy.cc/v1", { apiKey: secret })).rejects.toThrow();
    await expect(fetchProviderArtifact(transport, `https://kunpoapiimg.ziy.cc/${canary}/output.png`, "https://llm.ziy.cc/v1", { apiKey: canary })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(artifactDns).not.toHaveBeenCalled();
  });

  it.each([undefined, "model/gltf-binary"])("keeps GLB bytes intact and guards secret bytes without relying on Content-Type: %s", async (contentType) => {
    const bytes = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 0x00, 0xff, 0x81, 0x00]);
    const headers = contentType ? { "content-type": contentType } : undefined;
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bytes, { headers }))
      .mockResolvedValueOnce(new Response(textChunks(`glTF${canary}`, 12), { headers }));
    const response = await fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/tasks/task_1/artifacts/model/content", "https://llm.ziy.cc/v1", { apiKey: canary });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const unsafe = await fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/tasks/task_2/artifacts/model/content", "https://llm.ziy.cc/v1", { apiKey: canary });
    await expect(unsafe.arrayBuffer()).rejects.toMatchObject({ category: "local-policy", code: "PROVIDER_RESPONSE_VALIDATION_FAILED" });
  });

  it("passes caller cancellation to the artifact transport without replay", async () => {
    const abort = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(`cancelled private ${canary}`)), { once: true });
    }));
    const pending = fetchProviderArtifact(transport, "https://llm.ziy.cc/v1/videos/task_1/content", "https://llm.ziy.cc/v1", { apiKey: canary, signal: abort.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport.mock.calls[0]?.[1]?.signal).toBe(abort.signal);
    const rejected = expect(pending).rejects.toThrow("Could not download the provider artifact");
    abort.abort(); await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });


});
