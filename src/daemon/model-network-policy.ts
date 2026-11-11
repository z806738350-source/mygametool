import type { RuntimeModel } from "./agent.js";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { guardedProviderFetch, providerControlUrl } from "./provider-network.js";
import { kunpoReferenceImageUrls } from "./provider-image-source.js";
import type { AssetLibrary } from "./asset-library.js";
import { isMeshyModelReference, MESHY_DISABLED_MESSAGE } from "../shared/disabled-media-providers.js";

const GUARDED_MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** Never let a text-only adapter silently replace a user image or tool screenshot with text. */
export function assertModelImageInput(model: Pick<RuntimeModel, "input">, context: Pick<TranscriptContext, "messages">): void {
  if (!model.input.includes("image") && context.messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "image"))) {
    throw new Error("The selected connection does not have image input enabled. Choose an image-enabled connection for attachments, screenshots or visual tool results.");
  }
}

/** Other SDK protocols can bypass custom fetch; keep them unavailable until separately isolated. */
type TransportModel = Pick<RuntimeModel, "api" | "baseUrl"> & Partial<Pick<RuntimeModel, "provider" | "id">>;
export function assertLocalModelTransport(model: TransportModel): void {
  if (isMeshyModelReference(model)) throw new Error(MESHY_DISABLED_MESSAGE);
  if (!GUARDED_MODEL_APIS.has(model.api)) throw new Error("This model protocol is unavailable until its network transport is isolated.");
  providerControlUrl(model.baseUrl, true);
}

export function localModelFetch(model: TransportModel, request: typeof fetch = fetch): typeof fetch {
  assertLocalModelTransport(model);
  const origin = providerControlUrl(model.baseUrl, true).origin;
  const guarded = guardedProviderFetch(request);
  return (input, init) => {
    const target = providerControlUrl(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin) throw new Error("The model request left its configured origin.");
    return guarded(input, init);
  };
}

/** Chat URLs and Opus's documented native URL source; Responses and unreviewed models keep their existing contract. */
export async function kunpoImagePayload(model: Pick<RuntimeModel, "api" | "baseUrl" | "id">, context: Pick<TranscriptContext, "messages">, payload: unknown, signal?: AbortSignal, library?: Pick<AssetLibrary, "attachImageSource">): Promise<unknown> {
  const messages = model.api === "anthropic-messages" && model.id === "claude-opus-5-5";
  if (model.api !== "openai-completions" && !messages || providerControlUrl(model.baseUrl, true).origin !== "https://llm.ziy.cc") return payload;
  const images = context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []);
  for (const image of images) {
    const hint = (image as typeof image & { libraryAssetId?: unknown }).libraryAssetId;
    if (library && typeof hint === "string") await library.attachImageSource(hint, image);
  }
  const urls = await kunpoReferenceImageUrls(images, model.baseUrl, [], signal);
  if (!urls.some(Boolean) || !payload || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return payload;
  // Queue every occurrence, including uploads with identical bytes, so a URL cannot spread to another image's origin.
  const occurrences = new Map<string, Array<string | undefined>>();
  images.forEach((image, index) => {
    const data = `data:${image.mimeType};base64,${image.data}`, queue = occurrences.get(data) ?? [];
    queue.push(urls[index]); occurrences.set(data, queue);
  });
  const result = structuredClone(payload) as { messages: Array<{ content?: unknown }> };
  const replace = (content: unknown, depth = 0) => {
    if (!Array.isArray(content) || depth > 1) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (messages && part.type === "tool_result") { replace(part.content, depth + 1); continue; }
      if (messages && part.type === "image" && part.source?.type === "base64" && typeof part.source.media_type === "string" && typeof part.source.data === "string") {
        const url = occurrences.get(`data:${part.source.media_type};base64,${part.source.data}`)?.shift();
        if (url) part.source = { type: "url", url };
      } else if (!messages && part.type === "image_url" && typeof part.image_url?.url === "string") {
        const url = occurrences.get(part.image_url.url)?.shift(); if (url) part.image_url.url = url;
      }
    }
  };
  for (const message of result.messages) replace(message.content);
  return result;
}
