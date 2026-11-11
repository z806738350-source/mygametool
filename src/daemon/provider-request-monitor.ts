import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { assistantMessageError } from "./agent-errors.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";

export type ProviderRequestOutcome = "completed" | "incomplete" | "http_error" | "transport_error" | "stream_interrupted" | "validation_error" | "cancelled" | "timeout" | "protocol_error" | "transport_complete" | "unobserved_transport";
type Protocol = "openai-completions" | "openai-responses" | "anthropic-messages";
type Phase = "preparing" | "awaiting_headers" | "receiving_body" | "checking_response" | "awaiting_protocol";
type Event = "started" | "response" | "first_body_byte" | "progress" | "finished";
type Scope = { projectId?: string; conversationId?: string; turnId?: string };
const scopeStorage = new AsyncLocalStorage<() => Scope>();
const modelStorage = new AsyncLocalStorage<ModelRequestMonitor>();
const PROGRESS_INTERVAL_MS = 60_000;

/** The getter resolves the active turn at request start, including queued/steered turns. */
export function withProviderRequestScope<T>(scope: Scope | (() => Scope), work: () => T): T {
  return scopeStorage.run(typeof scope === "function" ? scope : () => scope, work);
}

function safeId(value: unknown, uuid = false): string | undefined {
  return typeof value === "string" && (uuid ? /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i : /^[a-zA-Z0-9_-]{1,128}$/).test(value)
    && !/^(?:sk|pk)-/i.test(value) && !containsKnownSensitiveValue(value) ? value : undefined;
}

/** Counters only: no body, header collection, URL, content hash or extra stream buffering. */
export class ProviderRequestTrace {
  readonly localRequestId = randomUUID();
  readonly #started = performance.now();
  readonly #scope: Scope;
  readonly #protocol?: Protocol;
  readonly #modelRequestId?: string;
  readonly #onFinish?: () => void;
  #phase: Phase = "preparing";
  #timer?: ReturnType<typeof setTimeout>;
  #signal?: AbortSignal;
  #abort?: () => void;
  #finished = false;
  #fetchAt?: number;
  #headersMs?: number;
  #firstBodyByteMs?: number;
  #wireMs?: number;
  #lastByteAt?: number;
  #maxIdleMs = 0;
  #receivedBytes = 0;
  #requestBytes?: number;
  #status?: number;
  #providerRequestId?: string;
  #errorCode?: string;
  #wireComplete = false;
  #validated = false;
  #inspectedSse = false;
  #messageStop = false;

  constructor(protocol?: Protocol, modelRequestId?: string, onFinish?: () => void) {
    let scope: Scope = {};
    try { scope = scopeStorage.getStore()?.() ?? {}; } catch { /* Optional correlation cannot fail a request. */ }
    this.#scope = { projectId: safeId(scope.projectId, true), conversationId: safeId(scope.conversationId, true), turnId: safeId(scope.turnId, true) };
    this.#protocol = protocol; this.#modelRequestId = modelRequestId; this.#onFinish = onFinish;
    this.#log("started"); this.#schedule();
  }

  get finished(): boolean { return this.#finished; }
  get submitted(): boolean { return this.#fetchAt !== undefined; }
  get modelOwned(): boolean { return this.#protocol !== undefined; }
  get responseValidated(): boolean { return this.#validated; }
  hasProtocolEnd(message: AssistantMessage): boolean {
    if (this.#protocol === "anthropic-messages" && this.#inspectedSse) return this.#messageStop;
    // Chat adapters can synthesize stop on EOF when supportsFinishReason is false.
    return typeof message.rawStopReason === "string" && message.rawStopReason.length > 0;
  }
  /** Reuse the security parser; retain only whether the native terminal event occurred. */
  sseEvent(value: unknown): void {
    this.#inspectedSse = true;
    if (value && typeof value === "object" && "type" in value && value.type === "message_stop") this.#messageStop = true;
  }
  listen(signal?: AbortSignal): void {
    if (this.#finished || !signal || this.#signal) return;
    this.#signal = signal; this.#abort = () => signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? this.finish("timeout", "timeout", "deadline") : this.finish("cancelled");
    if (signal.aborted) this.#abort(); else signal.addEventListener("abort", this.#abort, { once: true });
  }
  sending(bytes?: number): void {
    if (this.#finished) return;
    this.#requestBytes = bytes; this.#fetchAt = performance.now(); this.#phase = "awaiting_headers";
  }
  headers(status: number, requestId?: string, errorCode?: string): void {
    if (this.#finished) return;
    const first = this.#headersMs === undefined;
    this.#headersMs ??= this.#sinceFetch(); this.#status = status;
    this.#providerRequestId = safeId(requestId) ?? this.#providerRequestId;
    // Callers supply only the transport's closed error-code allowlist.
    this.#errorCode = safeId(errorCode) ?? this.#errorCode;
    if (!this.#wireComplete) this.#phase = "receiving_body";
    if (first) this.#log("response");
  }
  received(bytes: number): void {
    if (this.#finished || !bytes) return;
    const first = this.#firstBodyByteMs === undefined;
    const now = performance.now(); this.#firstBodyByteMs ??= this.#sinceFetch(now);
    this.#maxIdleMs = Math.max(this.#maxIdleMs, now - (this.#lastByteAt ?? this.#fetchAt ?? this.#started));
    this.#lastByteAt = now; this.#receivedBytes += bytes;
    if (first) this.#log("first_body_byte");
  }
  wireEnded(): void {
    if (this.#finished) return;
    this.#maxIdleMs = Math.max(this.#maxIdleMs, performance.now() - (this.#lastByteAt ?? this.#fetchAt ?? this.#started));
    this.#wireComplete = true; this.#wireMs = this.#sinceFetch(); this.#phase = "checking_response";
  }
  validated(): void {
    if (this.#finished) return;
    this.#validated = true; this.#phase = "awaiting_protocol";
    if (!this.#protocol) this.finish("transport_complete");
  }
  bodyCancelled(): void {
    // SDK iterators cancel their reader on a valid terminal event too. The model
    // result (or original caller signal) owns classification in that case.
    if (!this.modelOwned) this.finish("cancelled");
  }
  finish(outcome: ProviderRequestOutcome, category?: "timeout" | "dns" | "connection" | "cancelled" | "local-policy" | "unknown", timeoutKind?: "connect" | "headers" | "body" | "deadline" | "unknown"): void {
    if (this.#finished) return;
    this.#finished = true; clearTimeout(this.#timer);
    if (this.#abort) this.#signal?.removeEventListener("abort", this.#abort);
    this.#log("finished", { outcome, ...(category ? { errorCategory: category } : {}), ...(timeoutKind ? { timeoutKind } : {}) });
    this.#onFinish?.();
  }
  #sinceFetch(now = performance.now()): number { return Math.max(0, Math.round(now - (this.#fetchAt ?? this.#started))); }
  #schedule(): void {
    this.#timer = setTimeout(() => { if (!this.#finished) { this.#log("progress"); this.#schedule(); } }, PROGRESS_INTERVAL_MS);
    this.#timer.unref?.();
  }
  #log(event: Event, terminal: object = {}): void {
    const now = performance.now();
    const idle = this.#fetchAt === undefined ? undefined : Math.max(0, Math.round(now - (this.#lastByteAt ?? this.#fetchAt)));
    try { console.info(JSON.stringify({ msg: "Provider request", event, time: Date.now(), localRequestId: this.localRequestId,
      modelRequestId: this.#modelRequestId, projectId: safeId(this.#scope.projectId, true), conversationId: safeId(this.#scope.conversationId, true), turnId: safeId(this.#scope.turnId, true),
      protocol: this.#protocol ?? "provider-http", phase: this.#phase, totalMs: Math.max(0, Math.round(now - this.#started)),
      prepareMs: this.#fetchAt === undefined ? undefined : Math.max(0, Math.round(this.#fetchAt - this.#started)),
      responseHeadersMs: this.#headersMs, firstBodyByteMs: this.#firstBodyByteMs, wireMs: this.#wireMs,
      requestBytes: this.#requestBytes, receivedBytes: this.#receivedBytes, maxIdleMs: Math.round(Math.max(this.#maxIdleMs, this.#wireComplete ? 0 : idle ?? 0)),
      ...(event === "progress" ? { lastDataAgeMs: idle } : {}), statusCode: this.#status, providerRequestId: safeId(this.#providerRequestId), errorCode: safeId(this.#errorCode),
      wireComplete: this.#wireComplete, responseValidated: this.#validated, ...terminal })); } catch { /* Monitoring must not affect transport or release. */ }
  }
}

class ModelRequestMonitor {
  readonly primary: ProviderRequestTrace;
  readonly #pending = new Set<ProviderRequestTrace>();
  #claimed = false;
  constructor(readonly protocol: Protocol, readonly signal?: AbortSignal) {
    this.primary = this.#trace();
  }
  #trace(parent?: string): ProviderRequestTrace {
    const trace = new ProviderRequestTrace(this.protocol, parent, () => this.#pending.delete(trace));
    this.#pending.add(trace); trace.listen(this.signal); return trace;
  }
  http(): ProviderRequestTrace {
    if (!this.#claimed) { this.#claimed = true; return this.primary; }
    return this.#trace(this.primary.localRequestId);
  }
  failed(signal?: AbortSignal): void {
    for (const trace of this.#pending) trace.finish(signal?.aborted ? "cancelled" : trace.submitted ? "protocol_error" : "validation_error");
  }
  result(message: AssistantMessage): void {
    const code = message.stopReason === "error" ? assistantMessageError(message).code : undefined;
    const outcome: ProviderRequestOutcome = message.stopReason === "aborted" ? "cancelled" : message.stopReason === "length" ? "incomplete"
      : ["stop", "toolUse"].includes(message.stopReason) ? "completed"
      : code === "sse_validation_failed" ? "validation_error" : code === "sse_idle_timeout" ? "timeout"
      : code === "sse_connection_interrupted" || code === "stream_error" ? "stream_interrupted" : "protocol_error";
    for (const trace of this.#pending) {
      let terminal: ProviderRequestOutcome = outcome;
      if (!this.#claimed) terminal = ["completed", "incomplete"].includes(outcome) ? "unobserved_transport" : outcome === "cancelled" ? outcome : "validation_error";
      else if (["completed", "incomplete"].includes(outcome) && (!trace.responseValidated || !trace.hasProtocolEnd(message))) terminal = "stream_interrupted";
      trace.finish(terminal);
    }
  }
}

/** The existing SDK result is observed, never replaced, replayed or consumed a second time. */
export function monitorModelRequest<T extends AssistantMessageEventStream>(protocol: string, create: () => T, signal?: AbortSignal): T;
export function monitorModelRequest<T extends AssistantMessageEventStream>(protocol: string, create: () => Promise<T>, signal?: AbortSignal): Promise<T>;
export function monitorModelRequest<T extends AssistantMessageEventStream>(protocol: string, create: () => T | Promise<T>, signal?: AbortSignal): T | Promise<T> {
  if (modelStorage.getStore() || !["openai-completions", "openai-responses", "anthropic-messages"].includes(protocol)) return create();
  const monitor = new ModelRequestMonitor(protocol as Protocol, signal);
  const observe = (stream: T): T => { void stream.result().then(message => monitor.result(message)).catch(() => monitor.failed(signal)); return stream; };
  try {
    const stream = modelStorage.run(monitor, create);
    return stream instanceof Promise ? stream.then(observe, cause => { monitor.failed(signal); throw cause; }) : observe(stream);
  } catch (cause) { monitor.failed(signal); throw cause; }
}

export function providerHttpTrace(): ProviderRequestTrace { return modelStorage.getStore()?.http() ?? new ProviderRequestTrace(); }
