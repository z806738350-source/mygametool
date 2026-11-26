import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ImageContent, TextContent, Model, Api, TranscriptContext, Message, ToolCall } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, type SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDeepSeekFileModel } from "./deepseek-image-files.js";
import { PNG_SIGNATURE } from "./image-format.js";
import type { PromptImage } from "../shared/contracts.js";
import { LOCAL_IMAGE_BUDGET_MESSAGE } from "../shared/agent-errors.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { KUNPO_ASTRA_MODEL_ID, KUNPO_BASE_URL, KUNPO_PROVIDER_ID } from "../shared/kunpo-models.js";
import { prepareSessionImageDisplay } from "./retained-image-display.js";
export { prepareSessionImageDisplay };

export const IMAGE_OFFLOAD_ENTRY = "ohmygame-image-offload-v1";
export const IMAGE_ORIGINS_ENTRY = "ohmygame-image-origins-v1";
export const INLINE_IMAGE_HIGH_BYTES = 20 * 1024 * 1024;
export const INLINE_IMAGE_LOW_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_HIGH_COUNT = 64;
export const INLINE_IMAGE_LOW_COUNT = 32;
export const MODEL_REQUEST_HIGH_BYTES = 32 * 1024 * 1024;
const ASTRA_INLINE_SCOPE = "inline:kunpo-astra-responses";
// Local watermarks for long visual workflows. Current references can exceed them, up to the shared hard budget.
const astraHistory = { highCount: 32, lowCount: 16, highBytes: 8 * 1024 * 1024, lowBytes: 4 * 1024 * 1024, retainedBytes: 12 * 1024 * 1024 };
const inlineHistory = { highCount: INLINE_IMAGE_HIGH_COUNT, lowCount: INLINE_IMAGE_LOW_COUNT, highBytes: INLINE_IMAGE_HIGH_BYTES, lowBytes: INLINE_IMAGE_LOW_BYTES };
export function inlineImageScope(model: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">): string {
  return model.provider === KUNPO_PROVIDER_ID && model.id === KUNPO_ASTRA_MODEL_ID && model.api === "openai-responses"
    && model.baseUrl.replace(/\/+$/, "") === KUNPO_BASE_URL ? ASTRA_INLINE_SCOPE : "inline";
}
// Allow room for the original images before the smaller outbound model budget is applied.
export const MAX_ORIGINAL_TURN_BYTES = 4 * MODEL_REQUEST_HIGH_BYTES;
export type Json = Record<string, unknown>;
export const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

interface ImageOccurrence {
  image: ImageContent;
  toolCallId?: string;
  game: boolean;
  resizableRead?: boolean;
  display?: { image: ImageContent; marker: string };
  protected: boolean;
  previousObservation?: boolean;
}
interface OffloadData { scope: string; images: string[] }
interface SentToolPictures { output: Json[]; omittedText: string; ids: string[]; markers: string[]; bytes: number }
interface ImageOrigins { version: 1; messageHash: string; assetIds: Array<string | null> }
const originId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) && !containsKnownSensitiveValue(value);

function originMessageHash(message: { role: string; timestamp: number; content: unknown }): string | undefined {
  if (message.role !== "user" || !Number.isFinite(message.timestamp) || !Array.isArray(message.content)) return undefined;
  const normalized = [];
  let bytes = 0;
  for (const block of message.content) {
    if (!object(block)) return undefined;
    if (block.type === "text" && typeof block.text === "string") normalized.push({ type: "text", text: block.text });
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      bytes += block.data.length;
      if (bytes > MAX_ORIGINAL_TURN_BYTES) return undefined;
      normalized.push({ type: "image", mimeType: block.mimeType, dataHash: createHash("sha256").update(block.data).digest("hex") });
    } else return undefined;
  }
  return createHash("sha256").update(JSON.stringify([message.role, message.timestamp, normalized])).digest("hex");
}

function imageOrigins(value: unknown): ImageOrigins | undefined {
  if (!object(value) || Object.keys(value).sort().join(",") !== "assetIds,messageHash,version" || value.version !== 1 || typeof value.messageHash !== "string" || !/^[a-f0-9]{64}$/.test(value.messageHash)
    || !Array.isArray(value.assetIds) || !value.assetIds.length || value.assetIds.length > INLINE_IMAGE_HIGH_COUNT || !value.assetIds.every(id => id === null || originId(id))) return undefined;
  return value as unknown as ImageOrigins;
}

/** Called for the application's actual started turn, before Pi persists its user message. No URL or image data is stored here. */
export function recordSessionImageOrigins(manager: Pick<SessionManager, "appendCustomEntry"> | undefined, message: { role: string; timestamp: number; content: unknown }, originals: readonly PromptImage[]): boolean {
  if (!manager || !originals.length || originals.length > INLINE_IMAGE_HIGH_COUNT) return false;
  const actual = imageBlocks(message.content);
  if (actual.length !== originals.length || !actual.every((image, index) => image.mimeType === originals[index]!.mediaType && image.data === originals[index]!.data)) return false;
  const assetIds = originals.map(image => originId(image.libraryAssetId) ? image.libraryAssetId : null);
  if (!assetIds.some(Boolean)) return false;
  const messageHash = originMessageHash(message); if (!messageHash) return false;
  try { manager.appendCustomEntry(IMAGE_ORIGINS_ENTRY, { version: 1, messageHash, assetIds } satisfies ImageOrigins); return true; }
  catch { return false; } // Do not discard user work for optional provenance; a missing receipt after restart stays inline.
}

/** Bind only to the next canonical message on this branch, never to a global pixel/hash lookup. */
export function sessionImageOrigins(entries: readonly SessionEntry[]): Map<string, Array<string | null>> {
  const result = new Map<string, Array<string | null>>();
  let pending: ImageOrigins | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === IMAGE_ORIGINS_ENTRY) { pending = imageOrigins(entry.data); continue; }
    if (entry.type !== "message") continue;
    if (pending && entry.message.role === "user" && pending.messageHash === originMessageHash(entry.message)
      && imageBlocks(entry.message.content).length === pending.assetIds.length) result.set(entry.id, pending.assetIds);
    pending = undefined;
  }
  return result;
}

export class ImageBudgetError extends Error {
  readonly status = 413;
  readonly code = "request_size_exceeded";
  constructor() {
    super(LOCAL_IMAGE_BUDGET_MESSAGE);
  }
}

export function localImageError(error: ImageBudgetError): Response {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: error.code, message: error.message } }),
  { status: error.status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
}

/** Only known image blocks are traversed; unrelated text, URLs and file references are untouched. */
export interface WireImage {
  data: string;
  mime: string;
  id?: string;
  replace(image: ImageContent, marker?: string): void;
  omit(): void;
  file?: (id: string) => void;
}
const omittedIds = (text: string) => [...text.matchAll(/\[Image omitted from model context\. Session image: ([a-zA-Z0-9_-]+:\d+)/g)].map((match) => match[1]);
const markerIds = (text: string) => {
  const omitted = new Set(omittedIds(text));
  return [...text.matchAll(/^Session image: ([a-zA-Z0-9_-]+:\d+)/gm)].map((match) => match[1]).filter((id) => !omitted.has(id));
};
const googleOutput = (response: Json) => object(response.response)
  ? String(response.response.output ?? response.response.error ?? "") : "";
export function wireImages(payload: unknown): WireImage[] {
  const images: WireImage[] = [];
  const labels = new Map<string, { owner: Json; key: string }>();
  const marked = (owner: Json, key: string) => {
    const value = owner[key];
    const ids = typeof value === "string" ? markerIds(value) : [];
    for (const id of ids) labels.set(id, { owner, key });
    return ids;
  };
  const googleMarkers = (part: Json) => object(part.response)
    ? marked(part.response, typeof part.response.error === "string" ? "error" : "output") : [];
  const visit = (value: unknown, inheritedIds: string[] = [], googleResponse?: Json) => {
    if (Array.isArray(value)) {
      let ids = [...inheritedIds];
      let deferred: string[] = [];
      for (const item of value) {
        if (object(item)) {
          // Completions and Gemini < 3 put tool text before a separate user image turn.
          const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
          const head = parts[0];
          if (item.role === "user" && object(head) && ["Attached image(s) from tool result:", "Tool result image:"].includes(String(head.text))) {
            visit(parts, deferred); deferred = []; continue;
          }
          if (item.role === "tool" && typeof item.content === "string") deferred.push(...marked(item, "content"));
          else {
            const toolParts = parts.filter((part) => object(part) && object(part.functionResponse) && !Array.isArray(part.functionResponse.parts));
            if (toolParts.length) for (const part of toolParts) deferred.push(...googleMarkers((part as Json).functionResponse as Json));
            else if (item.role && !(item.role === "assistant" && item.content === "I have processed the tool results.")) deferred = [];
          }
          if (typeof item.text === "string") {
            const markers = marked(item, "text");
            if (markers.length) ids = markers;
            for (const omitted of omittedIds(item.text)) {
              const index = ids.indexOf(omitted); if (index >= 0) ids.splice(0, index + 1);
            }
          }
        }
        visit(item, ids, googleResponse);
      }
      return;
    }
    if (!object(value) || ArrayBuffer.isView(value)) return;
    if (object(value.functionResponse)) {
      const response = value.functionResponse;
      if (Array.isArray(response.parts)) visit(response.parts, googleMarkers(response), response);
      return;
    }
    let data: string | undefined;
    let mime: string | undefined;
    let kind: "responses" | "completions" | "anthropic" | "google" | "bedrock" | undefined;
    const url = value.type === "input_image" ? value.image_url
      : value.type === "image_url" && object(value.image_url) ? value.image_url.url : undefined;
    if (typeof url === "string") {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
      if (match) { mime = match[1]; data = match[2]; kind = value.type === "input_image" ? "responses" : "completions"; }
    } else if (value.type === "image" && object(value.source) && value.source.type === "base64"
      && typeof value.source.data === "string" && typeof value.source.media_type === "string") {
      data = value.source.data; mime = value.source.media_type; kind = "anthropic";
    } else {
      const inline = value.inlineData ?? value.inline_data;
      if (object(inline) && typeof inline.data === "string" && typeof (inline.mimeType ?? inline.mime_type) === "string") {
        data = inline.data; mime = String(inline.mimeType ?? inline.mime_type); kind = "google";
      } else if (object(value.image) && object(value.image.source) && value.image.source.bytes instanceof Uint8Array
        && typeof value.image.format === "string" && /^(jpeg|png|gif|webp)$/.test(value.image.format)) {
        data = Buffer.from(value.image.source.bytes).toString("base64"); mime = `image/${value.image.format}`; kind = "bedrock";
      }
    }
    if (data !== undefined && mime?.startsWith("image/") && kind) {
      const format = kind;
      const id = inheritedIds.shift();
      const label = id && labels.get(id);
      const replaceBlock = (block: Json) => {
        for (const key of Object.keys(value)) delete value[key];
        Object.assign(value, block);
      };
      images.push({ data, mime, id,
        replace: ({ mimeType, data }, marker) => {
          if (id && label && marker) {
            const text = String(label.owner[label.key]);
            label.owner[label.key] = text.split("\n").map(line => line === imageText(id) ? marker : line).join("\n");
          }
          const url = `data:${mimeType};base64,${data}`;
          if (format === "responses") value.image_url = url;
          else if (format === "completions") (value.image_url as Json).url = url;
          else if (format === "anthropic") Object.assign(value.source as Json, { media_type: mimeType, data });
          else if (format === "google") {
            const inline = (value.inlineData ?? value.inline_data) as Json;
            inline[Object.hasOwn(inline, "mimeType") ? "mimeType" : "mime_type"] = mimeType; inline.data = data;
          } else {
            const image = value.image as Json;
            image.format = mimeType.slice("image/".length);
            (image.source as Json).bytes = new Uint8Array(Buffer.from(data, "base64"));
          }
        },
        omit: () => {
          if (format === "google" && googleResponse && Array.isArray(googleResponse.parts) && object(googleResponse.response)) {
            // FunctionResponse.parts accepts image/file data only; placeholders belong in its output.
            const parts = googleResponse.parts; const index = parts.indexOf(value);
            if (index >= 0) parts.splice(index, 1);
            if (!parts.length) delete googleResponse.parts;
            const key = typeof googleResponse.response.error === "string" ? "error" : "output";
            googleResponse.response[key] = `${googleOutput(googleResponse)}\n${omittedText(id)}`;
          } else replaceBlock(format === "google" || format === "bedrock" ? { text: omittedText(id) }
            : { type: format === "responses" ? "input_text" : "text", text: omittedText(id) });
        },
        file: format === "responses" ? (fileId) => { delete value.image_url; value.file_id = fileId; } : undefined,
      });
      return;
    }
    if (value.type === "input_image" && (typeof value.file_id === "string" || typeof value.image_url === "string")
      || value.type === "image_url" && object(value.image_url) && typeof value.image_url.url === "string") inheritedIds.shift();
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return images;
}

const imageText = (id: string) => `Session image: ${id}. Use recall_image with this imageId to inspect the original again.`;
const omittedText = (id?: string) => id ? `[Image omitted from model context. ${imageText(id)}]` : "[Image omitted from model context.]";

/** Match Pi's one merged text block and its ordered pictures to genuine source occurrences. */
function sentToolPictures(callId: string, output: unknown, observed: Map<string, ImageOccurrence>): SentToolPictures | undefined {
  if (!Array.isArray(output)) return;
  const [label, ...pictures] = output;
  if (label?.type !== "input_text" || typeof label.text !== "string" || !pictures.length) return;
  const ids = markerIds(label.text);
  if (ids.length !== pictures.length) return;
  let bytes = 0;
  const markers: string[] = [];
  for (const [i, picture] of pictures.entries()) {
    const id = ids[i]!;
    const source = observed.get(id);
    if (!source || source.toolCallId !== callId || picture?.type !== "input_image") return;
    const shown = source.display ?? { image: source.image, marker: imageText(id) };
    if (picture.image_url !== `data:${shown.image.mimeType};base64,${shown.image.data}`) return;
    markers.push(shown.marker);
    bytes += shown.image.data.length;
  }
  const omitted = new Map(ids.map((id, i) => [markers[i]!, omittedText(id)]));
  return { ids, markers, bytes, output, omittedText: label.text.split("\n").map((line: string) => omitted.get(line) ?? line).join("\n") };
}

/** A retained output must differ from the current one only by images that aged out of the working set. */
function onlyRetiredPictures(previous: SentToolPictures, output: unknown, retired: ReadonlySet<string>) {
  const [label, ...pictures] = previous.output;
  const remaining = pictures.filter((_, index) => !retired.has(previous.ids[index]!));
  if (remaining.length === pictures.length) return false;
  if (!remaining.length) return previous.omittedText === output;
  const markers = new Map(previous.ids.flatMap((id, i) => retired.has(id) ? [[previous.markers[i]!, omittedText(id)] as const] : []));
  const text = (label!.text as string).split("\n").map(line => markers.get(line) ?? line).join("\n");
  return isDeepStrictEqual(output, [{ ...label, text }, ...remaining]);
}
const imageBlocks = (content: unknown): ImageContent[] => Array.isArray(content)
  ? content.filter((block): block is ImageContent => object(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") : [];
const entryImages = (entry: SessionEntry | undefined): ImageContent[] => imageBlocks(
  entry?.type === "message" && "content" in entry.message ? entry.message.content
    : entry?.type === "custom_message" ? entry.content : undefined,
);

/** A branch-local inventory of recallable originals; image pixels and provenance stay in the session. */
export function sessionImageReferences(entries: readonly SessionEntry[]): Array<{ imageId: string; mimeType: string }> {
  return entries.flatMap(entry => entryImages(entry).map((image, index) => ({ imageId: `${entry.id}:${index}`, mimeType: image.mimeType })));
}

export function hasSessionImages(entries: readonly SessionEntry[]): boolean {
  return entries.some(entry => entryImages(entry).length > 0);
}

export function sessionImageReferenceContext(entries: readonly SessionEntry[], offset = 0): string | undefined {
  const references = sessionImageReferences(entries);
  const end = references.length - offset;
  if (end <= 0) return undefined;
  const omitted = Math.max(0, end - 64);
  return [
    "Retained image references on the current conversation branch:",
    ...references.slice(omitted, end).map(reference => JSON.stringify(reference)),
    ...(omitted ? [`${omitted} older image references are omitted from this list. Call recall_image with offset ${offset + 64} to list the previous page.`] : []),
    "This list contains no image pixels. This applies only to the reference list, not to the separate image content blocks returned by recall_image. Use recall_image with the exact imageId to read the original before making visual claims. Text descriptions are not visual evidence.",
  ].join("\n");
}
const messageKey = (message: { role: string; timestamp: number; toolCallId?: string }) =>
  JSON.stringify([message.role === "custom" ? "user" : message.role, message.timestamp, message.toolCallId]);

function releasesReviewedImages(call: ToolCall) {
  return call.arguments.releaseReviewedImages === true && (["edit", "write", "recall_image"].includes(call.name)
    || call.name === "run_blender" && Object.hasOwn(call.arguments, "save"));
}

/** Pi serializes summaries and automatic continuations as user messages. They do not start a new visual task. */
export function visualWorkingSet(messages: readonly Message[], entries: readonly SessionEntry[], stableFeedback: boolean) {
  const synthetic = new Set<number>();
  const users = new Map<number, Array<Extract<Message, { role: "user" }>["content"]>>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const sameTime = users.get(entry.message.timestamp);
      if (sameTime) sameTime.push(entry.message.content);
      else users.set(entry.message.timestamp, [entry.message.content]);
    }
    if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction")
      synthetic.add(Date.parse(entry.timestamp));
    if (entry.type === "message" && entry.message.role === "bashExecution") synthetic.add(entry.message.timestamp);
  }
  const currentUser = messages.findLastIndex(message => message.role === "user" && (!synthetic.has(message.timestamp)
    || users.get(message.timestamp)?.some(content => content === message.content || isDeepStrictEqual(content, message.content))));
  const batches = new Map<number, number[]>();
  const canRecall = getCurrentTools(messages).some(tool => tool.name === "recall_image");
  let caller: number | undefined;
  let handoff: Map<string, string> | undefined;
  let reviewing = true;
  let released = false;
  let feedbackAt: number | undefined;
  for (let i = currentUser + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      caller = i;
      const calls = message.content.filter(block => block.type === "toolCall");
      handoff = canRecall && message.stopReason === "toolUse" && calls.some(releasesReviewedImages)
        ? new Map(calls.map(call => [call.id, call.name])) : undefined;
      continue;
    }
    if (message.role !== "toolResult" && message.role !== "user") continue;
    const hasImages = imageBlocks(message.content).length > 0;
    if (handoff) {
      const details = message.role === "toolResult" && message.toolName === "run_blender" && object(message.details) ? message.details : undefined;
      const status = object(details?.blender) ? details.blender.status : undefined;
      // Saving a Blender recipe can succeed even if the subsequent run fails.
      const version = details?.projectFileVersion;
      const saved = object(version) && typeof version.path === "string" && typeof version.sha256 === "string" && /^[a-f0-9]{64}$/.test(version.sha256);
      if (message.role !== "toolResult" || hasImages || handoff.get(message.toolCallId) !== message.toolName ||
          (!saved && (message.isError || status === "saved-not-run" || status === "failed"))) handoff = undefined;
      else {
        handoff.delete(message.toolCallId);
        if (!handoff.size) {
          batches.clear(); reviewing = false; handoff = undefined;
          released = true; feedbackAt = undefined;
        }
      }
    }
    if (!hasImages) continue;
    reviewing = true;
    if (stableFeedback && released && message.role === "toolResult") feedbackAt ??= i;
    const batch = message.role === "toolResult" ? caller ?? i : i;
    const siblings = batches.get(batch);
    if (siblings) siblings.push(i);
    else batches.set(batch, [i]);
  }
  const groups = new Map<number, number>();
  const required = new Set<number>();
  if (currentUser >= 0 && reviewing && !(stableFeedback && released)) { groups.set(currentUser, currentUser); required.add(currentUser); }
  const observations = [...batches].slice(-2);
  for (const [batch, indices] of observations) for (const index of indices) {
    groups.set(index, batch);
    if (batch === observations.at(-1)?.[0]) required.add(index);
  }
  return { groups, required, currentUser, feedbackAt };
}

/** Session originals and branch-local decisions are authoritative; the preview cache is disposable. */
export class SessionImages {
  private occurrences = new Map<string, ImageOccurrence>();
  private workingSetOmissions = new Set<string>();
  private previousPictures?: { leaf: string; boundary: string; tools: Map<string, SentToolPictures> };
  private lastResizeSetting?: boolean;
  constructor(private readonly manager: SessionManager, private readonly cacheDir: string) {}

  private originRecords(): Map<string, Array<string | null>> {
    return sessionImageOrigins(this.manager.getBranch());
  }

  readonly recallTool = defineTool({
    name: "recall_image", label: "Recall Image",
    promptGuidelines: [
      "Inspect required images together and record visual findings first. When moving to nonvisual work, mark the next edit or write with releaseReviewedImages=true; recall originals for further comparison or revised views.",
    ],
    description: "Read a retained original by imageId, or list image IDs with optional paging offset. After inspecting all needed images, set releaseReviewedImages alone to keep only recallable references during nonvisual work.",
    parameters: Type.Object({ imageId: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]+:[0-9]+$" })), offset: Type.Optional(Type.Integer({ minimum: 0 })), releaseReviewedImages: Type.Optional(Type.Boolean()) }),
    execute: async (_callId, { imageId, offset, releaseReviewedImages }) => {
      if (releaseReviewedImages) {
        if (imageId !== undefined || offset !== undefined) throw new Error("Release reviewed images separately from listing or recalling them.");
        return { content: [{ type: "text" as const, text: "Visual review complete. The original images remain available by imageId." }], details: undefined };
      }
      if (imageId === undefined) {
        const text = sessionImageReferenceContext(this.manager.getBranch(), offset) ?? "No retained image references on this page.";
        return { content: [{ type: "text" as const, text }], details: undefined };
      }
      const [entryId, index] = imageId.split(":");
      const entry = this.manager.getBranch().find((item) => item.id === entryId);
      const image = entryImages(entry)[Number(index)];
      if (!image) throw new Error("The image is not available on this conversation branch.");
      const assetId = this.originRecords().get(entryId)?.[Number(index)];
      return { content: [{ type: "text" as const, text: `Original ${imageText(imageId)} The original is included as a separate image content block. OhMyGame did not generate a text caption; provider-side processing is not visible to this tool.` }, { ...image, ...(assetId ? { libraryAssetId: assetId } : {}) }], details: undefined };
    },
  });

  async prepare(context: TranscriptContext, model: Model<Api>, resizeReadImages = true): Promise<TranscriptContext> {
    const astra = inlineImageScope(model) === ASTRA_INLINE_SCOPE;
    if (!astra || this.lastResizeSetting !== resizeReadImages) this.previousPictures = undefined;
    this.lastResizeSetting = resizeReadImages;
    if (isDeepSeekFileModel(model)) return context;
    return this.annotate(context, resizeReadImages, visualWorkingSet(context.messages, this.manager.getBranch(), astra));
  }

  /** Match SDK blocks to canonical occurrences before applying wire-format budgets. */
  async annotate(context: TranscriptContext, resizeReadImages = true, working?: ReturnType<typeof visualWorkingSet>): Promise<TranscriptContext> {
    const sources = new Map<string, Array<{ id: string; images: ImageContent[] }>>();
    for (const entry of this.manager.getBranch()) {
      const message = entry.type === "message" && "content" in entry.message ? entry.message
        : entry.type === "custom_message" ? { role: "user", timestamp: Date.parse(entry.timestamp), content: entry.content } : undefined;
      if (!message) continue;
      const images = imageBlocks(message.content);
      if (!images.length) continue;
      const key = messageKey(message);
      const bucket = sources.get(key) ?? [];
      bucket.push({ id: entry.id, images }); sources.set(key, bucket);
    }
    const used = new Set<string>();
    const origins = this.originRecords();
    const messages: Message[] = [];
    const occurrences = new Map<string, ImageOccurrence>();
    const workingSetOmissions = new Set<string>();
    const feedback: Array<{ id: string; image: ImageContent }> = [];
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const recentImages = context.messages.map((message, index) => message.role === "toolResult" && imageBlocks(message.content).length ? index : -1)
      .filter((index) => index >= 0).slice(-2);
    const projected: Array<{ content: Array<TextContent | ImageContent>; index: number; id: string; group: number; image: ImageContent }> = [];
    for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
      const message = context.messages[messageIndex];
      if (message.role === "system" || message.role === "assistant" || !Array.isArray(message.content)) { messages.push(message); continue; }
      const images = imageBlocks(message.content);
      if (!images.length) { messages.push(message); continue; }
      const source = sources.get(messageKey(message))?.find(({ id, images: original }) => !used.has(id)
        && original.length === images.length
        && original.every((image, index) => image.data === images[index].data && image.mimeType === images[index].mimeType));
      if (source) used.add(source.id);
      let index = 0;
      let convertedRead = false;
      const content: Array<TextContent | ImageContent> = [];
      for (const block of message.content) {
        if (block.type !== "image") { content.push(block); continue; }
        const id = source ? `${source.id}:${index}` : undefined;
        const assetId = source ? origins.get(source.id)?.[index] : undefined;
        index++;
        if (working && id && !working.groups.has(messageIndex)) {
          if (message.role === "toolResult") workingSetOmissions.add(id);
          if (messageIndex === working.currentUser && working.feedbackAt !== undefined)
            feedback.push({ id, image: block });
          content.push({ type: "text", text: omittedText(id) });
          continue;
        }
        const game = message.role === "toolResult" && message.toolName === "game_use";
        const read = message.role === "toolResult" && message.toolName === "read" && resizeReadImages;
        const preview = game || read ? await this.preview(block, game) : block;
        const image = assetId && preview.data === block.data && preview.mimeType === block.mimeType ? { ...preview, libraryAssetId: assetId } : preview;
        if (read && image.mimeType !== block.mimeType) convertedRead = true;
        if (id) {
          occurrences.set(id, { image, game, resizableRead: resizeReadImages && message.role === "toolResult" && ["read", "read_project_file"].includes(message.toolName), toolCallId: message.role === "toolResult" ? message.toolCallId.split("|")[0] : undefined,
            protected: working ? working.required.has(messageIndex) : messageIndex === lastUser || recentImages.includes(messageIndex),
            previousObservation: working !== undefined && !working.required.has(messageIndex) });
          content.push({ type: "text" as const, text: imageText(id) });
          if (working) projected.push({ content, index: content.length, id, group: working.groups.get(messageIndex)!, image });
        }
        content.push(image);
      }
      if (messageIndex === working?.feedbackAt && message.role === "toolResult") {
        // Reopen the comparison at the new evidence instead of rewriting the user message.
        for (const { id, image } of feedback) {
          if (imageBlocks(content).some(block => block.mimeType === image.mimeType && block.data === image.data)) continue;
          occurrences.set(id, { image, game: false, protected: true, toolCallId: message.toolCallId.split("|")[0] });
          content.push({ type: "text", text: `Earlier user reference for this comparison.\n${imageText(id)}` }, image);
        }
      }
      if (convertedRead) for (const [index, block] of content.entries()) {
        if (block.type === "text") content[index] = { ...block, text: block.text.replace("Read image file [image/png]", "Read image file [image/jpeg]") };
      }
      messages.push({ ...message, content } as Message);
    }
    // A later observation already supplies these same bytes. Keep the ordering and all views inside a comparison batch.
    const latest = new Map<string, { id: string; group: number; mime: string }>();
    for (const slot of projected.reverse()) {
      const duplicate = latest.get(slot.image.data);
      if (duplicate && duplicate.group !== slot.group && duplicate.mime === slot.image.mimeType) {
        slot.content[slot.index] = { type: "text", text: `${omittedText(slot.id)} Identical pixels are included under session image ${duplicate.id} in this request.` };
        if (occurrences.get(slot.id)?.protected) occurrences.get(duplicate.id)!.protected = true;
      } else latest.set(slot.image.data, { id: slot.id, group: slot.group, mime: slot.image.mimeType });
    }
    this.occurrences = occurrences;
    this.workingSetOmissions = workingSetOmissions;
    return { ...context, messages };
  }

  /** Keep previously accepted comparison pictures in their original tool results while they fit. */
  withPreviousToolImages<T>(base: T, scope: string, preserveRetiringRenders = true) {
    const unchanged = { payload: base, commit() {}, discard() {} };
    if (scope !== ASTRA_INLINE_SCOPE || !object(base) || !Array.isArray(base.input)) return unchanged;
    const branch = this.manager.getBranch();
    const leaf = branch.findLast(entry => entry.id)?.id;
    const boundary = branch.findLast(entry => entry.type === "compaction" || entry.type === "branch_summary" ||
      entry.type === "message" && (entry.message.role === "user" ||
        entry.message.role === "toolResult" && entry.message.toolName === "inspect_3d_views" ||
        entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall" && releasesReviewedImages(block))))?.id;
    const current = wireImages(base);
    let bytes = current.reduce((n, image) => n + image.data.length, 0), count = current.length;
    const maxBytes = preserveRetiringRenders ? astraHistory.retainedBytes : astraHistory.lowBytes;
    const maxCount = astraHistory.highCount;
    if (!leaf || !boundary || !count || bytes > maxBytes || count > maxCount) {
      this.previousPictures = undefined;
      return unchanged;
    }
    const previous = this.previousPictures;
    const prior = previous?.boundary === boundary && branch.some(entry => entry.id === previous.leaf) ? previous.tools : undefined;
    const omitted = this.omitted(scope, branch);
    const observed = this.occurrences;
    const freshTools = new Map<string, SentToolPictures>();
    const restored = new Map<string, SentToolPictures>();
    const calls = new Set<string>(), results = new Set<string>(), ambiguous = new Set<string>();
    for (const item of base.input) {
      if (!object(item) || typeof item.call_id !== "string") continue;
      const seen = item.type === "function_call" ? calls : item.type === "function_call_output" ? results : undefined;
      if (seen?.has(item.call_id)) ambiguous.add(item.call_id);
      seen?.add(item.call_id);
    }
    const input = base.input.map(item => {
      if (!object(item) || item.type !== "function_call_output" || typeof item.call_id !== "string" ||
          !calls.has(item.call_id) || ambiguous.has(item.call_id)) return item;
      const old = prior?.get(item.call_id);
      const sent = sentToolPictures(item.call_id, item.output, observed);
      if (old && !old.ids.some(id => omitted.has(id))) {
        const retired = new Set(old.ids.filter(id => this.workingSetOmissions.has(id)));
        const extraBytes = old.bytes - (sent?.bytes ?? 0);
        const matches = preserveRetiringRenders
          ? (typeof item.output === "string" || !!sent) && onlyRetiredPictures(old, item.output, retired)
          : retired.size === old.ids.length && old.omittedText === item.output;
        if (matches && (!preserveRetiringRenders || (bytes + extraBytes <= maxBytes && count + retired.size <= maxCount))) {
          restored.set(item.call_id, old);
          bytes += extraBytes;
          count += retired.size;
          return { ...item, output: old.output };
        }
      }
      if (sent) freshTools.set(item.call_id, sent);
      return item;
    });
    let payload = base;
    if (restored.size && bytes <= maxBytes && count <= maxCount) {
      const expanded = { ...base, input };
      if (Buffer.byteLength(JSON.stringify(expanded)) <= MODEL_REQUEST_HIGH_BYTES) {
        payload = expanded;
        for (const [id, old] of restored) freshTools.set(id, old);
      }
    }
    return { payload, commit: () => {
      if (observed === this.occurrences) this.previousPictures = { leaf, boundary, tools:freshTools };
    }, discard: () => {
      if (observed === this.occurrences) this.previousPictures = undefined;
    } };
  }

  applyOmissions(payload: unknown, scope: string): WireImage[] {
    const omitted = this.omitted(scope);
    return wireImages(payload).filter((image) => {
      if (image.id && omitted.has(image.id)) { image.omit(); return false; }
      return true;
    });
  }

  /** The caller has already applied Files conversion or extracted the actual WS delta. */
  async budget(payload: unknown, scope: string, force = false, signal?: AbortSignal): Promise<boolean> {
    const images = this.applyOmissions(payload, scope);
    const target = scope === ASTRA_INLINE_SCOPE ? astraHistory : inlineHistory;
    // SDKs such as Bedrock serialize binary blobs as Base64, not numeric object keys.
    const requestBytes = () => Buffer.byteLength(JSON.stringify(payload,
      (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value));
    let bytes = images.reduce((total, image) => total + Buffer.byteLength(image.data), 0);
    let count = images.length;
    if (!force && bytes <= target.highBytes && count <= target.highCount
      && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) return false;
    // Keep both sides of an active comparison at the soft watermarks; a real size failure can still shrink the older side.
    const keepComparison = !force && bytes <= INLINE_IMAGE_HIGH_BYTES && count <= INLINE_IMAGE_HIGH_COUNT && requestBytes() <= MODEL_REQUEST_HIGH_BYTES;
    const selected: string[] = [];
    const candidates = images.flatMap((image) => {
      const occurrence = image.id ? this.occurrences.get(image.id) : undefined;
      return occurrence && occurrence.image.data === image.data && occurrence.image.mimeType === image.mime && !occurrence.protected && !(keepComparison && occurrence.previousObservation)
        ? [{ image, game: occurrence.game }] : [];
    }).sort((a, b) => Number(!a.game) - Number(!b.game));
    for (const { image } of candidates) {
      if ((!force || selected.length > 0) && bytes <= target.lowBytes && count <= target.lowCount
        && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) break;
      image.omit(); selected.push(image.id!); bytes -= Buffer.byteLength(image.data); count--;
    }
    // The latest comparison cannot lose a view. Only scale its verified read results
    // if optional history alone could not make the actual inline request fit.
    let bodyBytes = requestBytes();
    const excess = Math.max(bytes - INLINE_IMAGE_HIGH_BYTES, bodyBytes - MODEL_REQUEST_HIGH_BYTES);
    if (excess > 0 && !force && count <= INLINE_IMAGE_HIGH_COUNT) {
      const reads = images.flatMap(slot => {
        const occurrence = slot.id && this.occurrences.get(slot.id);
        if (!occurrence || !occurrence.protected || !occurrence.resizableRead ||
            occurrence.image.data !== slot.data || occurrence.image.mimeType !== slot.mime ||
            !(slot.mime === "image/jpeg" || slot.mime === "image/png" || slot.mime === "image/webp")) return [];
        return [{ slot, occurrence, mime: slot.mime } as const];
      }).sort((a, b) => a.slot.data.length - b.slot.data.length);
      // Reserve envelope space for the source/display dimensions before dividing Base64 bytes.
      const readBytes = reads.reduce((sum, { slot }) => sum + slot.data.length, 0);
      let available = readBytes - Math.max(bytes - INLINE_IMAGE_HIGH_BYTES, bodyBytes + 128 * reads.length - MODEL_REQUEST_HIGH_BYTES);
      const replacements = [];
      for (const [index, { slot, occurrence, mime }] of reads.entries()) {
        const share = Math.floor(available / (reads.length - index) / 4) * 4;
        if (share <= 0) throw new ImageBudgetError();
        available -= Math.min(slot.data.length, share);
        if (slot.data.length <= share) continue;
        try {
          const display = await prepareSessionImageDisplay(Buffer.from(slot.data, "base64"), mime, signal, share / 4 * 3);
          const image = { type: "image" as const, mimeType: display.mimeType, data: display.bytes.toString("base64") };
          const marker = imageText(slot.id!) + ` Displayed at ${display.displayWidth}x${display.displayHeight} from the ${display.sourceWidth}x${display.sourceHeight} source. Use source coordinates for pixel landmarks.`;
          replacements.push({ slot, occurrence, image, marker });
        } catch {
          signal?.throwIfAborted();
          throw new ImageBudgetError();
        }
      }
      for (const { slot, occurrence, image, marker } of replacements) {
        slot.replace(image, marker);
        occurrence.display = { image, marker };
        bytes += image.data.length - slot.data.length;
      }
      if (replacements.length) bodyBytes = requestBytes();
    }
    if (bytes > INLINE_IMAGE_HIGH_BYTES || count > INLINE_IMAGE_HIGH_COUNT
      || bodyBytes > MODEL_REQUEST_HIGH_BYTES || force && !selected.length) throw new ImageBudgetError();
    if (selected.length) this.manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope, images: selected } satisfies OffloadData);
    return selected.length > 0;
  }

  private omitted(scope: string, branch = this.manager.getBranch()): Set<string> {
    return new Set(branch.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== IMAGE_OFFLOAD_ENTRY || !object(entry.data) || !Array.isArray(entry.data.images)) return [];
      if (entry.data.scope !== scope && !(scope === ASTRA_INLINE_SCOPE && entry.data.scope === "inline")) return [];
      return entry.data.images.filter((id): id is string => typeof id === "string");
    }));
  }

  private async preview(image: ImageContent, game: boolean): Promise<ImageContent> {
    if (image.mimeType !== "image/png" || image.data.length <= 256 * 1024) return image;
    const original = Buffer.from(image.data, "base64");
    // Read sprites may rely on transparency. Captures are opaque page observations.
    if (!game && !isOpaquePng(original)) return image;
    const hash = createHash("sha256").update("photon-jpeg-q80-v1:").update(image.data).digest("hex");
    const file = path.join(this.cacheDir, `${hash}.jpg`);
    let bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (!bytes) {
      const { PhotonImage } = await import("@silvia-odwyer/photon-node");
      let decoded: InstanceType<typeof PhotonImage> | undefined;
      try {
        decoded = PhotonImage.new_from_byteslice(original);
        bytes = Buffer.from(decoded.get_bytes_jpeg(80));
      } catch { return image; }
      finally { decoded?.free(); }
      if (bytes.length >= original.length) return image;
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    }
    return { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") };
  }
}

/** PNG alpha channels and palette transparency must survive read previews. */
function isOpaquePng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  if (![0, 2, 3].includes(bytes[25])) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + bytes.readUInt32BE(offset) + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") return false;
    if (type === "IDAT") return true;
    offset = end;
  }
  return false;
}
