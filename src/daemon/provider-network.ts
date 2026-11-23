import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isLoopbackModelHost, parseProviderUrl, providerControlUrl } from "../shared/provider-endpoint.js";
import { containsKnownSensitiveValue, registerSensitiveValue } from "../shared/sensitive-values.js";
import type { ImageDownloadNetworkStatus, ProviderErrorCode, VideoRequestDiagnostic } from "../shared/contracts.js";
import { providerHttpTrace, type ProviderRequestTrace } from "./provider-request-monitor.js";
export { providerControlUrl } from "../shared/provider-endpoint.js";
export const PROVIDER_SSE_LIMIT_BYTES = 32 * 1024 * 1024;
export const PROVIDER_SSE_IDLE_TIMEOUT_MS = 180_000;
export const PROVIDER_REQUEST_LIMIT_BYTES = 128 * 1024 * 1024;
export const PROVIDER_REQUEST_INSPECTION_TIMEOUT_MS = 30_000;

const transportCategories = {
  ENOTFOUND: "dns", EAI_AGAIN: "dns",
  ECONNREFUSED: "connection", ECONNRESET: "connection", EPIPE: "connection", UND_ERR_SOCKET: "connection",
  ENETUNREACH: "connection", EHOSTUNREACH: "connection",
  CERT_HAS_EXPIRED: "connection", CERT_NOT_YET_VALID: "connection", DEPTH_ZERO_SELF_SIGNED_CERT: "connection",
  SELF_SIGNED_CERT_IN_CHAIN: "connection", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "connection",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "connection", ERR_TLS_CERT_ALTNAME_INVALID: "connection",
  ETIMEDOUT: "timeout", UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout", UND_ERR_BODY_TIMEOUT: "timeout",
  ABORT_ERR: "cancelled",
} as const;
type TransportCode = keyof typeof transportCategories;
type DiagnosticCode = TransportCode | "PROVIDER_REQUEST_VALIDATION_FAILED" | "PROVIDER_RESPONSE_VALIDATION_FAILED";
const timeoutKinds: Partial<Record<TransportCode, NonNullable<VideoRequestDiagnostic["timeoutKind"]>>> = {
  ETIMEDOUT: "unknown", UND_ERR_CONNECT_TIMEOUT: "connect", UND_ERR_HEADERS_TIMEOUT: "headers", UND_ERR_BODY_TIMEOUT: "body",
};

/** SDKs read code and cause, but a raw transport cause may include credential-bearing URLs. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly category: "timeout" | "dns" | "connection" | "cancelled" | "local-policy" | "unknown",
    readonly timeoutKind?: VideoRequestDiagnostic["timeoutKind"],
    readonly code?: DiagnosticCode,
  ) { super(message); }
}

function transportDiagnostic(cause: unknown): Pick<ProviderRequestError, "category" | "timeoutKind" | "code"> {
  const pending = [cause];
  const seen = new Set<object>();
  // Native fetch can nest an AggregateError when several addresses fail to connect.
  for (let i = 0; i < pending.length && i < 16; i++) {
    const current = pending[i];
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProviderRequestError) return current;
    const error = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof error.code === "string" && Object.hasOwn(transportCategories, error.code)) {
      const code = error.code as TransportCode;
      return { code, category: transportCategories[code], timeoutKind: timeoutKinds[code] };
    }
    if (error.name === "AbortError") return { category: "cancelled", code: "ABORT_ERR" };
    if (error.cause) pending.push(error.cause);
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8));
  }
  return { category: "unknown" };
}
const BLOCKED_ARTIFACT_DOMAINS = ["meshy.ai", "ohmygame.ai", "ohmygame.cc", "posthog.com", "posthog.io", "posthogusercontent.com", "sentry.io", "sentry.dev", "sentry.com"];
// Exact output buckets only; never a wildcard, control endpoint, or caller-provided allowlist.
// Native Seedance returns this temporary TOS origin (Volcengine's video-task documentation).
export const KUNPO_NATIVE_VIDEO_ORIGIN = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com";
const KUNPO_ARTIFACT_ORIGINS = new Set(["https://kunpoapiimg.ziy.cc", KUNPO_NATIVE_VIDEO_ORIGIN]);
const AUTHENTICATED_ARTIFACT_PATH = /^\/v1\/(?:videos\/[^/]+\/content|tasks\/[^/]+\/artifacts\/[^/]+\/content)\/?$/;

export function providerCredentialValues(apiKey = "", values?: HeadersInit): string[] {
  return [...new Set([apiKey, ...[...new Headers(values)].filter(([name]) => /authorization|api[-_]?key|token|secret|cookie/i.test(name))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, ""), ...value.split(/,\s*/).map((part) => part.replace(/^Bearer\s+/i, ""))])])].filter(Boolean);
}

export function assertProviderBytes<T extends Uint8Array>(bytes: T, credentials: readonly string[]): T {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (credentials.filter(Boolean).some((secret) => buffer.includes(Buffer.from(secret)))) throw new ProviderRequestError("Provider returned credential data", "local-policy", undefined, "PROVIDER_RESPONSE_VALIDATION_FAILED");
  return bytes;
}

/** Wrap SDK/adapter control requests; errors deliberately contain no URL, body or credential. */
export function guardedProviderFetch(request: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const trace = providerHttpTrace();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!trace.modelOwned) trace.listen(callerSignal);
    try {
      const target = providerControlUrl(input instanceof Request ? input.url : String(input));
      const headerInput = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      const headers = new Headers(headerInput);
      const outboundHeaders: HeadersInit = headerInput instanceof Headers ? headers : Array.isArray(headerInput)
        ? headerInput.map(([name, value]): [string, string] => [name, value]) : { ...headerInput };
      const secrets = providerCredentialValues("", headers);
      for (const secret of secrets) registerSensitiveValue(secret);
      if (containsKnownSensitiveValue(target.href)) throw new ProviderRequestError("Provider request URL contains credential data", "local-policy", undefined, "PROVIDER_REQUEST_VALIDATION_FAILED");
      const upstream = new AbortController();
      const signal = callerSignal ? AbortSignal.any([callerSignal, upstream.signal]) : upstream.signal;
      // Inspect before opening the transport. A streaming scan while forwarding
      // would already leak the prefix if a credential appeared near the end.
      let body: BodyInit | undefined;
      try { body = await checkedProviderBody(input, init, signal); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        throw new ProviderRequestError(callerSignal?.aborted ? "Provider request cancelled" : /^Provider request (?:contains credential data|exceeded the secure (?:size|inspection time) limit|body cannot be safely inspected)$/.test(message)
          ? message : "Provider request body could not be safely verified", callerSignal?.aborted ? "cancelled" : "local-policy", undefined,
          callerSignal?.aborted ? "ABORT_ERR" : "PROVIDER_REQUEST_VALIDATION_FAILED");
      }
      const started = performance.now();
      const requestBytes = typeof body === "string" || body instanceof URLSearchParams ? Buffer.byteLength(String(body)) : ArrayBuffer.isView(body) ? body.byteLength : body instanceof Blob ? body.size : undefined;
      trace.sending(requestBytes);
      let response: Response;
      try {
        response = await request(input instanceof Request ? input : target.href, { ...init, headers: outboundHeaders, ...(body === undefined ? {} : { body }), signal, redirect: "error" });
      } catch (cause) {
        if (callerSignal?.aborted) throw new ProviderRequestError("Provider request cancelled", "cancelled", undefined, "ABORT_ERR");
        const diagnostic = transportDiagnostic(cause);
        throw new ProviderRequestError("Could not reach the configured provider", diagnostic.category, diagnostic.timeoutKind, diagnostic.code);
      }
      try {
        const responseHeadersMs = Math.round(performance.now() - started);
        trace.headers(response.status, safeProviderRequestId(response.headers.get("x-request-id"), secrets) ?? safeProviderRequestId(response.headers.get("request-id"), secrets));
        const checked = await redactProviderResponse(response, secrets, { signal, abort: () => upstream.abort() }, trace);
        if (!checked.ok) {
          trace.headers(checked.status, checked.headers.get("x-request-id") ?? undefined, checked.headers.get("x-ohmygame-error-code") ?? undefined);
          trace.finish("http_error");
          // Only closed numeric fields and already filtered identifiers reach the log.
          try { console.warn(JSON.stringify({ msg: "Provider HTTP request failed", statusCode: checked.status,
            requestId: checked.headers.get("x-request-id") ?? undefined, errorCode: checked.headers.get("x-ohmygame-error-code") ?? undefined,
            requestBytes, responseHeadersMs })); } catch { /* Logging must not change a request's outcome. */ }
        }
        return checked;
      } catch (cause) {
        upstream.abort();
        if (callerSignal?.aborted) throw new ProviderRequestError("Provider request cancelled", "cancelled", undefined, "ABORT_ERR");
        const diagnostic = transportDiagnostic(cause);
        if (diagnostic.code) throw new ProviderRequestError("Provider response interrupted", diagnostic.category, diagnostic.timeoutKind, diagnostic.code);
        throw new ProviderRequestError("Provider response could not be safely verified", "local-policy", undefined, "PROVIDER_RESPONSE_VALIDATION_FAILED");
      }
    } catch (cause) {
      const diagnostic = transportDiagnostic(cause);
      trace.finish(callerSignal?.aborted || diagnostic.category === "cancelled" ? "cancelled" : !trace.submitted || diagnostic.category === "local-policy" ? "validation_error" : diagnostic.category === "timeout" ? "timeout" : "transport_error", diagnostic.category, diagnostic.timeoutKind, diagnostic.code);
      throw cause;
    }
  };
}

async function checkedProviderBody(input: string | URL | Request, init: RequestInit | undefined, signal: AbortSignal): Promise<BodyInit | undefined> {
  signal.throwIfAborted();
  const deadline = Date.now() + PROVIDER_REQUEST_INSPECTION_TIMEOUT_MS;
  let bytes = 0;
  const charge = (size: number) => {
    bytes += size;
    signal.throwIfAborted();
    if (bytes > PROVIDER_REQUEST_LIMIT_BYTES) throw new Error("Provider request exceeded the secure size limit");
    if (Date.now() >= deadline) throw new Error("Provider request exceeded the secure inspection time limit");
  };
  const text = (value: string) => {
    if (containsKnownSensitiveValue(value)) throw new Error("Provider request contains credential data");
    // SDK JSON may spell characters as Unicode escapes. Compare its decoded
    // strings too, without returning any input or credential in the error.
    let decoded: string | undefined;
    try { decoded = JSON.stringify(JSON.parse(value)); } catch { /* Not every provider body is JSON. */ }
    if (decoded && containsKnownSensitiveValue(decoded)) throw new Error("Provider request contains credential data");
  };
  const read = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> => {
    const reader = body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Provider request cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("Provider request exceeded the secure inspection time limit")), Math.max(0, deadline - Date.now()));
    });
    try {
      while (true) {
        const next = await Promise.race([reader.read(), interrupted]);
        if (next.done) break;
        charge(next.value.byteLength);
        length += next.value.byteLength;
        chunks.push(new Uint8Array(next.value));
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      text(Buffer.from(result.buffer).toString("utf8"));
      return result;
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", abort!);
      // Do not await cancellation of a Request clone: the unconsumed tee
      // branch can otherwise make a rejected SDK request hang indefinitely.
      void reader.cancel().catch(() => {});
    }
  };
  const body = init?.body;
  if (body == null) {
    if (input instanceof Request && input.body) {
      try { return await read(input.clone().body!); }
      finally { void input.body.cancel().catch(() => {}); }
    }
    return undefined;
  }
  if (typeof body === "string" || body instanceof URLSearchParams) {
    const value = String(body); charge(Buffer.byteLength(value)); text(value); return typeof body === "string" ? body : new URLSearchParams(value);
  }
  if (body instanceof FormData) {
    const checked = new FormData();
    for (const [name, value] of body) {
      charge(Buffer.byteLength(name) + 256); text(name);
      if (typeof value === "string") { charge(Buffer.byteLength(value)); text(value); checked.append(name, value); }
      else {
        const fileName = value.name, mediaType = value.type;
        charge(Buffer.byteLength(fileName) + Buffer.byteLength(mediaType)); text(fileName); text(mediaType);
        checked.append(name, new Blob([new Uint8Array(await read(value.stream()))], { type: mediaType }), fileName);
      }
    }
    return checked;
  }
  if (body instanceof Blob) {
    const mediaType = body.type;
    charge(Buffer.byteLength(mediaType)); text(mediaType);
    return new Blob([new Uint8Array(await read(body.stream()))], { type: mediaType });
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const data = new Uint8Array(body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    charge(data.byteLength); text(Buffer.from(data).toString("utf8")); return data;
  }
  if (body instanceof ReadableStream) return read(body);
  throw new Error("Provider request body cannot be safely inspected");
}

/** Keep a raw tail until a possible credential crossing a network chunk is complete. */
export async function redactProviderResponse(response: Response, credentials: readonly string[], cancellation: { signal?: AbortSignal; abort?: () => void } = {}, trace?: ProviderRequestTrace): Promise<Response> {
  if (!response.ok) {
    const fields = await readProviderErrorFields(response, cancellation.signal, trace);
    const codes = fields.codes?.filter((value) => !containsKnownSensitiveValue(value) && !credentials.filter(Boolean).some((secret) => value.includes(secret)));
    const code = preferredProviderErrorCode(codes);
    const requestId = safeProviderRequestId(response.headers.get("x-request-id"), credentials)
      ?? safeProviderRequestId(response.headers.get("request-id"), credentials) ?? safeProviderRequestId(fields.requestId, credentials);
    // Anthropic exposes the whole body as APIError.error; OpenAI exposes the nested error.
    const structuredCode = code ? { code, type: code } : {};
    return new Response(JSON.stringify({ error: { message: "Provider request failed", ...structuredCode }, message: "Provider request failed", ...structuredCode }), {
      status: response.status, headers: { "content-type": "application/json", ...(response.status === 429 ? { "retry-after": "5" } : {}),
        ...(requestId ? { "x-request-id": requestId } : {}), ...(code ? { "x-ohmygame-error-code": code } : {}) },
    });
  }
  const secrets = [...new Set(credentials.flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  if (!secrets.length) {
    if (!trace) return response;
    if (!response.body) { trace.wireEnded(); trace.validated(); return response; }
    return new Response(publicProviderBody(response.body, trace, true), { status: response.status, headers: response.headers });
  }
  const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  const headers = new Headers(response.headers);
  for (const [name, value] of headers) headers.set(name, redact(value));
  headers.delete("set-cookie");
  const textual = !/^(?:image|audio|video)\/|application\/(?:octet-stream|gltf|zip|pdf)/i.test(headers.get("content-type") ?? "");
  if (!response.body) { trace?.wireEnded(); trace?.validated(); return new Response(null, { status: response.status, headers }); }
  if (!textual) return new Response(guardBinaryCredentials(response.body, credentials, trace), { status: response.status, headers });
  headers.delete("content-length");
  if (/text\/event-stream/i.test(headers.get("content-type") ?? "")) {
    return new Response(bufferProviderSse(response.body, secrets, redact, cancellation, trace), { status: response.status, headers });
  }
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const keep = Math.max(...secrets.map((value) => value.length)) - 1;
  let pending = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      trace?.received(chunk.byteLength);
      pending += decoder.decode(chunk, { stream: true });
      let cut = Math.max(0, pending.length - keep);
      let previous: number;
      do {
        previous = cut;
        for (const secret of secrets) {
          const start = pending.lastIndexOf(secret, cut - 1);
          if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
        }
      } while (cut !== previous);
      if (cut) { controller.enqueue(encoder.encode(redact(pending.slice(0, cut)))); pending = pending.slice(cut); }
    },
    flush(controller) { controller.enqueue(encoder.encode(redact(pending + decoder.decode()))); trace?.wireEnded(); trace?.validated(); },
  }));
  return new Response(publicProviderBody(body, trace), { status: response.status, headers });
}

/** No SSE event is released until logical delta strings have been checked together. */
function bufferProviderSse(body: ReadableStream<Uint8Array>, secrets: readonly string[], redact: (text: string) => string, cancellation: { signal?: AbortSignal; abort?: () => void }, trace?: ProviderRequestTrace): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let stopped = false, started = false;
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const cleanup = () => { clearTimeout(timer); cancellation.signal?.removeEventListener("abort", onAbort); };
  const stopUpstream = () => { cancellation.abort?.(); void reader.cancel().catch(() => {}); };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, message: string,
    code?: "SSE_IDLE_TIMEOUT" | "SSE_CONNECTION_INTERRUPTED" | "SSE_VALIDATION_FAILED") => {
    if (stopped) return;
    trace?.finish(code === "SSE_IDLE_TIMEOUT" ? "timeout" : code === "SSE_VALIDATION_FAILED" ? "validation_error" : code === "SSE_CONNECTION_INTERRUPTED" ? "stream_interrupted" : "cancelled", code === "SSE_IDLE_TIMEOUT" ? "timeout" : undefined, code === "SSE_IDLE_TIMEOUT" ? "body" : undefined);
    stopped = true; cleanup(); stopUpstream();
    controller.error(Object.assign(new Error(message), { code, transport: "sse" }));
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => fail(controller, "Provider request cancelled");
      timer = setTimeout(() => fail(controller,
        `Provider SSE stream timed out locally after ${PROVIDER_SSE_IDLE_TIMEOUT_MS / 1000} seconds without data`,
        "SSE_IDLE_TIMEOUT"), PROVIDER_SSE_IDLE_TIMEOUT_MS);
      if (cancellation.signal?.aborted) onAbort();
      else cancellation.signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (started || stopped) return;
      started = true;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (!stopped) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); }
        catch { return fail(controller, "Provider SSE connection was interrupted while reading the response", "SSE_CONNECTION_INTERRUPTED"); }
        if (next.done || stopped) break;
        if (!next.value.byteLength) continue;
        trace?.received(next.value.byteLength);
        bytes += next.value.byteLength;
        if (bytes > PROVIDER_SSE_LIMIT_BYTES) return fail(controller, "Provider SSE response exceeded the secure size limit", "SSE_VALIDATION_FAILED");
        timer.refresh();
        chunks.push(next.value);
      }
      if (stopped) return;
      trace?.wireEnded();
      try {
        const wire = Buffer.concat(chunks).toString("utf8");
        assertSafeSseDeltas(wire, secrets, trace);
        trace?.validated();
        controller.enqueue(new TextEncoder().encode(redact(wire)));
        stopped = true; cleanup();
        controller.close();
      } catch {
        fail(controller, "Provider SSE response failed local validation", "SSE_VALIDATION_FAILED");
      }
    },
    cancel() { if (!stopped) { stopped = true; cleanup(); trace?.bodyCancelled(); stopUpstream(); } },
  });
}

function assertSafeSseDeltas(wire: string, secrets: readonly string[], trace?: ProviderRequestTrace): void {
  const fields = new Map<string, string[]>(), deltas: string[] = [];
  const strings = (value: unknown, path: string[], deltaEvent: boolean): void => {
    if (typeof value === "string") {
      const key = path.join(".");
      const fragments = fields.get(key) ?? []; fragments.push(value); fields.set(key, fragments);
      const leaf = path.at(-1) ?? "";
      if ((deltaEvent || path.includes("delta") || path.includes("tool_calls")) && ["delta", "text", "content", "thinking", "reasoning_content", "arguments", "partial_json", "refusal"].includes(leaf)) deltas.push(value);
    } else if (Array.isArray(value)) value.forEach((item, index) => strings(item, [...path, String(index)], deltaEvent));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) strings(item, [...path, key], deltaEvent);
  };
  for (const frame of wire.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data.trim() === "[DONE]") continue;
    const value: unknown = JSON.parse(data);
    trace?.sseEvent(value);
    const type = value && typeof value === "object" && "type" in value ? String(value.type) : "";
    strings(value, [], /delta/i.test(type));
  }
  for (const fragments of [...fields.values(), deltas]) {
    const value = fragments.join("");
    if (secrets.some((secret) => value.includes(secret))) throw new Error("Provider returned credential data");
  }
}

function publicProviderBody(body: ReadableStream<Uint8Array>, trace?: ProviderRequestTrace, observeRaw = false): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await reader.read(); if (next.done) { if (observeRaw) { trace?.wireEnded(); trace?.validated(); } controller.close(); } else { if (observeRaw) trace?.received(next.value.byteLength); controller.enqueue(next.value); } }
      catch (cause) {
        if (cause instanceof ProviderRequestError && cause.code === "PROVIDER_RESPONSE_VALIDATION_FAILED") {
          trace?.finish("validation_error", "local-policy", undefined, "PROVIDER_RESPONSE_VALIDATION_FAILED");
          controller.error(new ProviderRequestError("Provider response could not be safely verified", "local-policy", undefined, "PROVIDER_RESPONSE_VALIDATION_FAILED"));
          return;
        }
        const diagnostic = transportDiagnostic(cause);
        trace?.finish(diagnostic.category === "timeout" ? "timeout" : diagnostic.category === "cancelled" ? "cancelled" : "stream_interrupted", diagnostic.category, diagnostic.timeoutKind, diagnostic.code);
        controller.error(new ProviderRequestError("Provider response interrupted", diagnostic.category, diagnostic.timeoutKind, diagnostic.code));
      }
    },
    cancel() { trace?.bodyCancelled(); return reader.cancel(); },
  });
}

function guardBinaryCredentials(body: ReadableStream<Uint8Array>, credentials: readonly string[], trace?: ProviderRequestTrace): ReadableStream<Uint8Array> {
  const secrets = credentials.filter(Boolean), keep = Math.max(1, ...secrets.map((value) => Buffer.byteLength(value))) - 1;
  let pending = Buffer.alloc(0);
  return publicProviderBody(body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      trace?.received(chunk.byteLength);
      pending = Buffer.concat([pending, chunk]);
      assertProviderBytes(pending, secrets);
      const cut = Math.max(0, pending.length - keep);
      if (cut) { controller.enqueue(pending.subarray(0, cut)); pending = pending.subarray(cut); }
    },
    flush(controller) { assertProviderBytes(pending, secrets); if (pending.length) controller.enqueue(pending); trace?.wireEnded(); trace?.validated(); },
  })), trace);
}

export function providerRequest(request: typeof fetch, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return guardedProviderFetch(request)(input, init);
}

const PROVIDER_ERROR_CODES: Record<string, ProviderErrorCode> = {
  invalid_request_error: "invalid-request", invalid_parameter: "invalid-request", invalid_parameters: "invalid-request", context_length_exceeded: "invalid-request",
  authentication_error: "authentication", invalid_api_key: "authentication", unauthorized: "authentication",
  rate_limit_error: "rate-limit", rate_limit_exceeded: "rate-limit", insufficient_quota: "quota", quota_exceeded: "quota",
  content_policy_violation: "content-policy", model_not_found: "model-unavailable", bad_response_status_code: "bad-response-status",
  api_error: "unclassified", server_error: "unclassified", internal_server_error: "unclassified", overloaded_error: "unclassified", timeout: "unclassified",
};

function preferredProviderErrorCode(codes: readonly string[] = []): string | undefined {
  return codes.find((value) => !["unclassified", "bad-response-status"].includes(PROVIDER_ERROR_CODES[value]!))
    ?? codes.find((value) => value !== "bad_response_status_code") ?? codes[0];
}

function safeProviderRequestId(value: unknown, credentials: readonly string[]): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !/^(?:sk|pk)-/i.test(value)
    && !containsKnownSensitiveValue(value) && !credentials.filter(Boolean).some((secret) => value.includes(secret)) ? value : undefined;
}

/** Inspect at most 8 KiB for one second; never retain free text, URLs or unknown codes. */
async function readProviderErrorFields(response: Response, signal?: AbortSignal, trace?: ProviderRequestTrace): Promise<{ codes?: string[]; requestId?: unknown }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try { reader = response.body?.getReader(); } catch { return {}; }
  if (!reader) return {};
  const bounded = AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      bounded.throwIfAborted();
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) { bounded.removeEventListener("abort", abort); reject(bounded.reason); return; }
        void reader!.read().then((value) => { bounded.removeEventListener("abort", abort); resolve(value); }, (cause) => { bounded.removeEventListener("abort", abort); reject(cause); });
      });
      if (next.done) { trace?.wireEnded(); break; }
      trace?.received(next.value.byteLength);
      bytes += next.value.byteLength;
      if (bytes > 8192) return {};
      chunks.push(next.value);
    }
    const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))), error = record(body.error);
    return { codes: [error.code, error.type, body.code, body.type].filter((value): value is string => typeof value === "string" && Object.hasOwn(PROVIDER_ERROR_CODES, value)),
      requestId: body.request_id ?? error.request_id };
  } catch { /* Untrusted text, invalid/large JSON and stalled bodies are never echoed. */ }
  finally { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
  return {};
}

/** Media callers receive only a closed category, never identifiers or provider text. */
export async function providerErrorCode(response: Response, signal?: AbortSignal): Promise<ProviderErrorCode> {
  const fields = await readProviderErrorFields(response, signal);
  const code = preferredProviderErrorCode(fields.codes);
  return code ? PROVIDER_ERROR_CODES[code]! : "unclassified";
}

export function providerPollingUrl(value: string, base: string): string {
  const target = providerControlUrl(value), origin = providerControlUrl(base, true);
  const prefix = origin.pathname.replace(/\/+$/, "");
  if (target.origin !== origin.origin || (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) throw new Error("Invalid provider polling URL");
  return target.href;
}

/** Only global unicast addresses may serve a remote artifact. Loopback is opt-in through its control origin. */
export function isPublicArtifactAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:0?db8:/i.test(address);
}

/** Syntax/origin checks do not perform DNS: a received result can be saved before downloading. */
export function providerArtifactTarget(value: string, base: string): URL {
  const target = parseProviderUrl(value), control = providerControlUrl(base, true);
  const host = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (BLOCKED_ARTIFACT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error("Provider artifact destination is blocked in local secure mode");
  if (target.origin !== control.origin && !(control.origin === "https://llm.ziy.cc" && KUNPO_ARTIFACT_ORIGINS.has(target.origin))) throw new Error("Cross-origin provider artifacts are unavailable in local secure mode");
  if (target.origin === control.origin && isLoopbackModelHost(control.hostname)) return target;
  if (target.protocol !== "https:") throw new Error("Invalid provider artifact URL");
  if (isIP(host)) {
    if (!isPublicArtifactAddress(host)) throw new Error("Invalid provider artifact address");
  } else if (!host.includes(".") || /\.(?:localhost|local|internal|home|lan)\.?$/i.test(host)) throw new Error("Invalid provider artifact host");
  return target;
}

export class ProviderArtifactAddressError extends Error {
  constructor(readonly fakeIp = false) {
    super(fakeIp ? "Invalid provider artifact address: Fake-IP DNS is not supported. Exclude kunpoapiimg.ziy.cc from Fake-IP DNS; private addresses remain blocked." : "Invalid provider artifact address");
  }
}

/** Fixed, fee-free DNS diagnostic. No provider auth, HTTP or system configuration changes. */
export async function imageDownloadNetworkStatus(): Promise<ImageDownloadNetworkStatus> {
  try {
    await providerArtifactUrl("https://kunpoapiimg.ziy.cc/", "https://llm.ziy.cc/v1", undefined, AbortSignal.timeout(5_000));
    return { state: "ready" };
  } catch (cause) {
    return { state: cause instanceof ProviderArtifactAddressError ? cause.fakeIp ? "fake-ip" : "blocked" : "unavailable" };
  }
}

export async function providerArtifactUrl(value: string, base: string, resolve = lookup, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  const target = providerArtifactTarget(value, base);
  const host = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (target.origin === providerControlUrl(base, true).origin && isLoopbackModelHost(target.hostname)) return target;
  if (!isIP(host)) {
    let addresses: Array<{ address: string }>;
    try {
      const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
      addresses = await new Promise<Array<{ address: string }>>((accept, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) { abort(); return; }
        void resolve(host, { all: true }).then(accept, reject).finally(() => bounded.removeEventListener("abort", abort));
      });
    }
    catch { throw new Error("Could not resolve the provider artifact host"); }
    if (!addresses.length || addresses.some((entry) => !isPublicArtifactAddress(entry.address))) throw new ProviderArtifactAddressError(host === "kunpoapiimg.ziy.cc" && addresses.some((entry) => /^198\.(?:18|19)\./.test(entry.address)));
  }
  return target;
}

export async function fetchProviderArtifact(request: typeof fetch, value: string, base: string, init: RequestInit & { protectedSecrets?: readonly string[]; apiKey?: string } = {}): Promise<Response> {
  const secrets = [...new Set([...(init.protectedSecrets ?? []), ...(init.apiKey ? [init.apiKey] : [])])].filter(Boolean);
  for (const secret of secrets) registerSensitiveValue(secret);
  const control = providerControlUrl(base, true);
  let next = value;
  try {
    for (let hop = 0; hop <= 2; hop++) {
      if (secrets.some((secret) => next.includes(secret) || next.includes(encodeURIComponent(secret)))) throw new Error();
      const target = await providerArtifactUrl(next, base, lookup, init.signal ?? undefined);
      const authenticated = !!init.apiKey && target.origin === control.origin && AUTHENTICATED_ARTIFACT_PATH.test(target.pathname);
      if (authenticated) providerControlUrl(target);
      // Only the reviewed same-origin content routes may receive a key. Every redirect is revalidated.
      const response = await request(target.href, { signal: init.signal, method: "GET", credentials: "omit",
        redirect: authenticated ? "manual" : "error", ...(authenticated ? { headers: { authorization: `Bearer ${init.apiKey}` } } : {}) });
      if (authenticated && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => {});
        if (!location || hop === 2) throw new Error();
        next = new URL(location, target).href;
        continue;
      }
      if (!response.ok) return redactProviderResponse(response, secrets);
      const headers = new Headers(response.headers);
      headers.delete("set-cookie");
      for (const [name, value] of headers) headers.set(name, secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value));
      return new Response(response.body ? guardBinaryCredentials(response.body, secrets) : null, { status: response.status, headers });
    }
    throw new Error();
  }
  catch (cause) { if (cause instanceof ProviderArtifactAddressError) throw cause; throw new Error("Could not download the provider artifact"); }
}
