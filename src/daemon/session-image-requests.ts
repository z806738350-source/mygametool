import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ResponsesTransportMode } from "../shared/contracts.js";
import type { OpenAISessionTransport } from "./openai-session-transport.js";
import { assertModelImageInput, localModelFetch } from "./model-network-policy.js";
import { SessionImages, localImageError, ImageBudgetError, MODEL_REQUEST_HIGH_BYTES } from "./session-images.js";
import { monitorModelRequest } from "./provider-request-monitor.js";

/** Reapply persisted decisions on HTTP retries and shrink a 413 at most once. */
function wrapInlineImageFetch(delegate: typeof fetch, images: SessionImages): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, init);
    if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) return delegate(request);
    if (request.headers.has("content-encoding")) {
      const body = await request.clone().arrayBuffer();
      return body.byteLength > MODEL_REQUEST_HIGH_BYTES ? localImageError(new ImageBudgetError()) : delegate(request);
    }
    const body = await request.clone().text();
    const payload: unknown = JSON.parse(body);
    try { images.budget(payload, "inline"); }
    catch (error) { if (error instanceof ImageBudgetError) return localImageError(error); throw error; }
    const headers = new Headers(request.headers); headers.delete("content-length");
    request = new Request(request, { headers, body: JSON.stringify(payload) });
    const response = await delegate(request);
    if (response.status !== 413) return response;
    request.signal.throwIfAborted();
    try {
      images.budget(payload, "inline", true);
      await response.body?.cancel();
      const reduced = await delegate(new Request(request, { body: JSON.stringify(payload), redirect: "error" }));
      if (reduced.status !== 413) return reduced;
      const finalHeaders = new Headers(reduced.headers); finalHeaders.set("x-should-retry", "false");
      return new Response(reduced.body, { status: reduced.status, statusText: reduced.statusText, headers: finalHeaders });
    } catch (error) {
      request.signal.throwIfAborted();
      if (!(error instanceof ImageBudgetError)) throw error;
      await response.body?.cancel(); return localImageError(error);
    }
  };
}

/** All supported session requests use the reviewed HTTP fetch boundary, including retries. */
export function installSessionImageRequests(session: AgentSession, images: SessionImages, _agentDir: string,
  options: { transport?: OpenAISessionTransport; transportMode?: (provider: string) => ResponsesTransportMode } = {}): void {
  const lifetime = new AbortController();
  const stream = session.agent.streamFunction;
  const dispose = session.dispose.bind(session);
  session.dispose = () => { lifetime.abort(new Error("Session disposed")); options.transport?.dispose(); dispose(); };
  // Cache warming and WebSocket adapters can create requests outside the guarded HTTP path.
  session.settingsManager.getCacheWarmingMode = () => "off";
  session.agent.streamFunction = (model, context, requestOptions) => monitorModelRequest(model.api, async () => {
    assertModelImageInput(model, context);
    const delegate = localModelFetch(model, requestOptions?.fetch ?? globalThis.fetch);
    const prepared = await images.prepare(context, model, session.settingsManager.getImageAutoResize());
    return stream(model, prepared, {
      ...requestOptions,
      transport: "sse",
      signal: requestOptions?.signal ? AbortSignal.any([requestOptions.signal, lifetime.signal]) : lifetime.signal,
      fetch: wrapInlineImageFetch(delegate, images),
    });
  }, requestOptions?.signal ? AbortSignal.any([requestOptions.signal, lifetime.signal]) : lifetime.signal);
}
