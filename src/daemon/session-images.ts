import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, Model, Api, TranscriptContext, Message } from "@earendil-works/pi-ai";
import { defineTool, type SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDeepSeekFileModel } from "./deepseek-image-files.js";
import { PNG_SIGNATURE } from "./image-format.js";
import type { PromptImage } from "../shared/contracts.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
export { prepareSessionImageDisplay } from "./retained-image-display.js";

export const IMAGE_OFFLOAD_ENTRY = "ohmygame-image-offload-v1";
export const IMAGE_ORIGINS_ENTRY = "ohmygame-image-origins-v1";
export const INLINE_IMAGE_HIGH_BYTES = 20 * 1024 * 1024;
export const INLINE_IMAGE_LOW_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_HIGH_COUNT = 64;
export const INLINE_IMAGE_LOW_COUNT = 32;
export const MODEL_REQUEST_HIGH_BYTES = 32 * 1024 * 1024;
// Allow room for the original images before the smaller outbound model budget is applied.
export const MAX_ORIGINAL_TURN_BYTES = 4 * MODEL_REQUEST_HIGH_BYTES;
export type Json = Record<string, unknown>;
export const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

interface ImageOccurrence {
  image: ImageContent;
  game: boolean;
  protected: boolean;
}
interface OffloadData { scope: string; images: string[] }
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
    super("The model request exceeds the local image/history budget. Original images remain in the session. Reduce the current images or compact the text history before retrying.");
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
          if (item.role === "tool" && typeof item.content === "string") deferred.push(...markerIds(item.content));
          else {
            const toolParts = parts.filter((part) => object(part) && object(part.functionResponse) && !Array.isArray(part.functionResponse.parts));
            if (toolParts.length) for (const part of toolParts) deferred.push(...markerIds(googleOutput((part as Json).functionResponse as Json)));
            else if (item.role && !(item.role === "assistant" && item.content === "I have processed the tool results.")) deferred = [];
          }
          if (typeof item.text === "string") {
            const markers = markerIds(item.text);
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
      if (Array.isArray(response.parts)) visit(response.parts, markerIds(googleOutput(response)), response);
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
      const replaceBlock = (block: Json) => {
        for (const key of Object.keys(value)) delete value[key];
        Object.assign(value, block);
      };
      images.push({ data, mime, id,
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

export function sessionImageReferenceContext(entries: readonly SessionEntry[]): string | undefined {
  const references = sessionImageReferences(entries);
  if (!references.length) return undefined;
  const latest = references.slice(-64), omitted = references.length - latest.length;
  return [
    "Retained image references on the current conversation branch:",
    ...latest.map(reference => JSON.stringify(reference)),
    ...(omitted ? [`${omitted} older image references are omitted from this list.`] : []),
    "This list contains no image pixels. This applies only to the reference list, not to the separate image content blocks returned by recall_image. Use recall_image with the exact imageId to read the original before making visual claims. Text descriptions are not visual evidence.",
  ].join("\n");
}
const messageKey = (message: { role: string; timestamp: number; toolCallId?: string }) =>
  JSON.stringify([message.role === "custom" ? "user" : message.role, message.timestamp, message.toolCallId]);

/** Session originals and branch-local decisions are authoritative; the preview cache is disposable. */
export class SessionImages {
  private occurrences = new Map<string, ImageOccurrence>();
  constructor(private readonly manager: SessionManager, private readonly cacheDir: string) {}

  private originRecords(): Map<string, Array<string | null>> {
    return sessionImageOrigins(this.manager.getBranch());
  }

  readonly recallTool = defineTool({
    name: "recall_image", label: "Recall Image",
    description: "Read an original image retained in this conversation, including screenshots omitted from model context. Use the imageId shown in its placeholder.",
    parameters: Type.Object({ imageId: Type.String({ pattern: "^[a-zA-Z0-9_-]+:[0-9]+$" }) }),
    execute: async (_callId, { imageId }) => {
      const [entryId, index] = imageId.split(":");
      const entry = this.manager.getBranch().find((item) => item.id === entryId);
      const image = entryImages(entry)[Number(index)];
      if (!image) throw new Error("The image is not available on this conversation branch.");
      const assetId = this.originRecords().get(entryId)?.[Number(index)];
      return { content: [{ type: "text" as const, text: `Original ${imageText(imageId)} The original is included as a separate image content block. OhMyGame did not generate a text caption; provider-side processing is not visible to this tool.` }, { ...image, ...(assetId ? { libraryAssetId: assetId } : {}) }], details: undefined };
    },
  });

  async prepare(context: TranscriptContext, model: Model<Api>, resizeReadImages = true): Promise<TranscriptContext> {
    if (isDeepSeekFileModel(model)) return context;
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
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const recentImages = context.messages.map((message, index) => message.role === "toolResult" && imageBlocks(message.content).length ? index : -1)
      .filter((index) => index >= 0).slice(-2);
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
      const content = [];
      for (const block of message.content) {
        if (block.type !== "image") { content.push(block); continue; }
        const id = source ? `${source.id}:${index}` : undefined;
        const assetId = source ? origins.get(source.id)?.[index] : undefined;
        index++;
        const game = message.role === "toolResult" && message.toolName === "game_use";
        const read = message.role === "toolResult" && message.toolName === "read" && resizeReadImages;
        const preview = game || read ? await this.preview(block, game) : block;
        const image = assetId && preview.data === block.data && preview.mimeType === block.mimeType ? { ...preview, libraryAssetId: assetId } : preview;
        if (read && image.mimeType !== block.mimeType) convertedRead = true;
        if (id) {
          occurrences.set(id, { image, game, protected: messageIndex === lastUser || recentImages.includes(messageIndex) });
          content.push({ type: "text" as const, text: imageText(id) });
        }
        content.push(image);
      }
      messages.push({ ...message, content: convertedRead ? content.map((block) => block.type === "text"
        ? { ...block, text: block.text.replace("Read image file [image/png]", "Read image file [image/jpeg]") } : block) : content } as Message);
    }
    this.occurrences = occurrences;
    return { ...context, messages };
  }

  applyOmissions(payload: unknown, scope: string): WireImage[] {
    const omitted = this.omitted(scope);
    return wireImages(payload).filter((image) => {
      if (image.id && omitted.has(image.id)) { image.omit(); return false; }
      return true;
    });
  }

  /** The caller has already applied Files conversion or extracted the actual WS delta. */
  budget(payload: unknown, scope: string, force = false): boolean {
    const images = this.applyOmissions(payload, scope);
    // SDKs such as Bedrock serialize binary blobs as Base64, not numeric object keys.
    const requestBytes = () => Buffer.byteLength(JSON.stringify(payload,
      (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value));
    let bytes = images.reduce((total, image) => total + Buffer.byteLength(image.data), 0);
    let count = images.length;
    if (!force && bytes <= INLINE_IMAGE_HIGH_BYTES && count <= INLINE_IMAGE_HIGH_COUNT
      && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) return false;
    const selected: string[] = [];
    const candidates = images.flatMap((image) => {
      const occurrence = image.id ? this.occurrences.get(image.id) : undefined;
      return occurrence && occurrence.image.data === image.data && occurrence.image.mimeType === image.mime && !occurrence.protected
        ? [{ image, game: occurrence.game }] : [];
    }).sort((a, b) => Number(!a.game) - Number(!b.game));
    for (const { image } of candidates) {
      if ((!force || selected.length > 0) && bytes <= INLINE_IMAGE_LOW_BYTES && count <= INLINE_IMAGE_LOW_COUNT
        && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) break;
      image.omit(); selected.push(image.id!); bytes -= Buffer.byteLength(image.data); count--;
    }
    if (bytes > INLINE_IMAGE_HIGH_BYTES || count > INLINE_IMAGE_HIGH_COUNT
      || requestBytes() > MODEL_REQUEST_HIGH_BYTES || force && !selected.length) throw new ImageBudgetError();
    if (selected.length) this.manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope, images: selected } satisfies OffloadData);
    return selected.length > 0;
  }

  private omitted(scope: string): Set<string> {
    return new Set(this.manager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== IMAGE_OFFLOAD_ENTRY || !object(entry.data) || entry.data.scope !== scope || !Array.isArray(entry.data.images)) return [];
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
