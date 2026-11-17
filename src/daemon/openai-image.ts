import type { ImageAspectRatio, ImageGenerationSettings, ImageModelRef, ImageResolution, ImageSize, PromptImage } from "../shared/contracts.js";
import { GPT_IMAGE_26_DEFAULTS, gptImage26FrameSize, isGptImage26, validateGptImage26Settings } from "../shared/gpt-image-26.js";
import sharp from "sharp";
import { serializeRasterDecoding } from "./raster-policy.js";
import { validateGeneratedImage } from "./generated-image-format.js";
import { assertProviderBytes, providerCredentialValues, fetchProviderArtifact, providerArtifactTarget, providerArtifactUrl, ProviderArtifactAddressError, providerControlUrl, providerRequest } from "./provider-network.js";
import { sniffImageType } from "./image-format.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { kunpoReferenceImageUrls, rememberKunpoImageSource } from "./provider-image-source.js";

export const IMAGE_REQUEST_TIMEOUT_MS = 16 * 60_000;
const IMAGE_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const IMAGE_INPUT_LIMIT_BYTES = 32 * 1024 * 1024;

export type GeneratedImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "image/gif";

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: GeneratedImageMediaType;
  requestId?: string;
  generation?: { provider?: string; model: string; protocol: "openai-images"; parameters: Record<string, string | number | boolean> };
}

export interface ImageGenerationInput extends ImageGenerationSettings {
  prompt: string;
  imageModel?: ImageModelRef;
  size?: ImageSize;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  images?: PromptImage[];
  /** Daemon-only paid-request recovery; never accepted from renderer JSON. */
  execution?: ImageExecution;
}

export interface ImageSubmission {
  url?: string;
  inline?: GeneratedImage;
  requestId?: string;
  generation: NonNullable<GeneratedImage["generation"]>;
}

export interface ImageExecution {
  readonly recoveryOnly?: boolean;
  submitted(scope: string, input: unknown, create: () => Promise<ImageSubmission>, signal?: AbortSignal): Promise<ImageSubmission>;
}

export interface ImageGenerator {
  assertGenerationAllowed?(model?: ImageModelRef): Promise<void>;
  generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ImageGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly outcomeUnknown = false, readonly notSubmitted = false) {
    super(message);
  }
}

export class OpenAIImageGenerator implements ImageGenerator {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl = "https://llm.ziy.cc/v1",
    private readonly request: Fetch = fetch,
    private readonly headers: Record<string, string> = {},
    private readonly authentication: "api_key" | "none" = "api_key",
  ) {}

  async generate(input: ImageGenerationInput & { model?: string }, signal?: AbortSignal): Promise<GeneratedImage> {
    providerControlUrl(this.baseUrl, true);
    if (!this.apiKey && this.authentication !== "none") throw new ImageGenerationError("Image generation is not configured", 503);
    signal?.throwIfAborted();
    const model = input.model ?? "gpt-image-2.5-sunburst";
    const images = input.images ?? [];
    const nano = model === "Image-GI2.1";
    const gpt26 = isGptImage26(model);
    const problem = validateGptImage26Settings(model, gpt26 && input.size && !input.pixelSize ? { ...input, pixelSize: input.size } : input, images.length);
    if (problem) throw new ImageGenerationError(problem, 400, false, true);
    validateImageInput(input, nano, gpt26);
    const firstReferenceSize = gpt26 && images.length ? await serializeRasterDecoding(() => validate26References(input)) : undefined;
    const endpoint = imageEndpoint(this.baseUrl, !nano && images.length > 0);
    const timeout = AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const size = nano ? input.aspectRatio ?? legacyRatio(input.size) : gpt26 ? gpt26Size(input, firstReferenceSize) : openAIImageSize(input);
    const format = input.outputFormat ?? "png";
    const svg = gpt26 && format === "svg" ? { model: input.svgModel?.trim() || GPT_IMAGE_26_DEFAULTS.svgModel, reasoning: { effort: input.svgReasoningEffort ?? GPT_IMAGE_26_DEFAULTS.svgReasoningEffort } } : undefined;
    const parameters: Record<string, string | number | boolean> = nano
      ? { size, imageSize: input.resolution ?? "1K", n: 1, stream: false }
      : { size, quality: input.quality ?? "auto", output_format: format, background: input.background ?? "auto", n: 1,
        ...(!gpt26 || input.imageModel?.provider === "kunpo" || providerControlUrl(this.baseUrl, true).origin === "https://llm.ziy.cc" ? { response_format: "url" } : {}),
        ...(gpt26 ? { complexity: input.complexity ?? GPT_IMAGE_26_DEFAULTS.complexity } : {}),
        ...(gpt26 && format === "gif" ? { frame_count: input.frameCount ?? GPT_IMAGE_26_DEFAULTS.frameCount, frame_duration_ms: input.frameDurationMs ?? GPT_IMAGE_26_DEFAULTS.frameDurationMs } : {}),
        ...(input.outputCompression !== undefined ? { output_compression: input.outputCompression } : {}) };
    const generation: NonNullable<GeneratedImage["generation"]> = { ...(input.imageModel ? { provider: input.imageModel.provider } : {}), model, protocol: "openai-images", parameters: { ...parameters, referenceCount: images.length, masked: Boolean(input.mask),
      ...(gpt26 ? { markedUp: Boolean(input.markup) } : {}), ...(svg ? { svgModel: svg.model, svgReasoningEffort: svg.reasoning.effort } : {}) } };

    const submit = async (): Promise<ImageSubmission> => {
      requestSignal.throwIfAborted();
      if (input.execution?.recoveryOnly) throw new ImageGenerationError("No saved image result is available. Recovery never submits a new generation; check the provider record.", 409, true);
      // The documented CDN is needed for every Kunpo URL response. Catch local DNS failures before billing.
      if (providerControlUrl(this.baseUrl, true).origin === "https://llm.ziy.cc") {
        try { await providerArtifactUrl("https://kunpoapiimg.ziy.cc/", this.baseUrl, undefined, requestSignal); requestSignal.throwIfAborted(); }
        catch (cause) { throw new ImageGenerationError(cause instanceof ProviderArtifactAddressError ? `${cause.message} No generation request was submitted.` : "Image CDN could not be reached safely. No generation request was submitted.", 503, false, true); }
      }
      let response: Response;
      let referenceUrls: Array<string | undefined> = [];
      try { if (!input.mask && images.length) referenceUrls = await kunpoReferenceImageUrls(images, this.baseUrl, providerCredentialValues(this.apiKey, this.headers), requestSignal); }
      catch { throw new ImageGenerationError("Image reference preparation cancelled before submission", 499, false, true); }
      try {
        const multipart = !nano && images.length > 0 && (Boolean(input.mask) || !gpt26 && !referenceUrls.some(Boolean));
        generation.parameters.referenceUrlCount = multipart ? 0 : referenceUrls.filter(Boolean).length;
        generation.parameters.referenceLocalCount = images.length - Number(generation.parameters.referenceUrlCount);
        const body = multipart
          ? editForm({ ...input, model, images }, parameters)
          : JSON.stringify({
              model,
              prompt: input.prompt,
              ...parameters,
              ...(svg ? { svg } : {}),
              ...(input.markup ? { markup: { image_url: `data:image/png;base64,${input.markup.data}` } } : {}),
              ...(images.length ? { ...(nano ? { imageMimeType: images[0]!.mediaType } : {}), images: images.map((image, index) => {
                const url = referenceUrls[index] ?? `data:${image.mediaType};base64,${image.data}`;
                return gpt26 ? { image_url: url } : url;
              }) } : {}),
            });
        response = await awaitImageResponse(providerRequest(this.request, endpoint, {
          method: "POST",
          headers: {
            ...this.headers,
            ...(this.authentication === "none" ? {} : { authorization: `Bearer ${this.apiKey}` }),
            ...(!multipart ? { "content-type": "application/json" } : {}),
          },
          body,
          signal: requestSignal,
        }), requestSignal);
      } catch (cause) {
        if (signal?.aborted) throw signal.reason ?? cause;
        const message = timeout.aborted || cause instanceof Error && cause.name === "TimeoutError"
          ? "Image generation timed out; the upstream result is unknown. Do not automatically submit again."
          : "Image generation was interrupted; the upstream result is unknown. Do not automatically submit again.";
        throw new ImageGenerationError(message, 502, true);
      }

      const errorContext = gpt26 ? { model, svgAuthor: svg?.model, format } : undefined;
      const body = await imageJson(response, requestSignal).catch((cause) => {
        if (signal?.aborted) throw signal.reason ?? cause;
        if (gpt26 && !response.ok) throw openAIError(response.status, undefined, errorContext);
        throw new ImageGenerationError("Image response could not be read; the upstream result is unknown. Do not automatically submit again.", 502, true);
      }) as {
        data?: Array<{ b64_json?: unknown; url?: unknown }>;
        error?: { code?: unknown; message?: unknown };
      };
      if (!response.ok) throw openAIError(response.status, body?.error, errorContext);
      if (gpt26 && Array.isArray(body?.data) && body.data.length > 1)
        throw new ImageGenerationError("The provider returned unexpected additional results for one image request. Review the original operation before submitting again.", 502, true);
      const result = body?.data?.[0];
      const encoded = result?.b64_json;
      if (typeof encoded === "string" && encoded) {
        const bytes = assertProviderBytes(Buffer.from(encoded, "base64"), providerCredentialValues(this.apiKey, this.headers));
        if (gpt26 && bytes.toString("base64") !== encoded) throw new ImageGenerationError("Invalid Base64 in the provider's image result", 502, true);
        const mediaType = await verifiedImageType(bytes, gpt26 ? input : undefined);
        return { inline: {
          bytes,
          mediaType,
          requestId: response.headers.get("x-request-id") ?? undefined,
          generation,
        }, generation };
      }
      if (typeof result?.url === "string" && result.url) {
        const resultUrl = result.url;
        const secrets = providerCredentialValues(this.apiKey, this.headers);
        if (containsKnownSensitiveValue(resultUrl) || secrets.some((secret) => resultUrl.includes(secret) || resultUrl.includes(encodeURIComponent(secret)))) throw new ImageGenerationError("The image result URL contains protected data");
        if (/\[redacted\]|%5bredacted%5d/i.test(resultUrl)) throw new ImageGenerationError("The image result URL contains protected data");
        // Save only a reviewed, bounded URL; DNS and download checks happen after the journal is durable.
        const url = providerArtifactTarget(resultUrl, this.baseUrl);
        return { url: url.href, requestId: response.headers.get("x-request-id") ?? undefined, generation };
      }
      throw new ImageGenerationError("OpenAI returned no generated image; the upstream result is unknown. Do not automatically submit again.", 502, true);
    };
    const result = input.execution ? await input.execution.submitted(
      JSON.stringify([this.baseUrl, this.authentication, this.apiKey, this.headers]),
      { provider: input.imageModel?.provider, model, prompt: input.prompt, parameters, images, mask: input.mask, ...(svg ? { svg } : {}), ...(input.markup ? { markup: input.markup } : {}) }, submit, requestSignal,
    ) : await submit();
    requestSignal.throwIfAborted();
    if (result.inline) return result.inline;
    if (!result.url) throw new ImageGenerationError("The saved image result is unavailable", 409);
    const generated = { ...await this.downloadImage(result.url, requestSignal, result.requestId ?? null, gpt26 ? input : undefined), generation: result.generation };
    rememberKunpoImageSource(generated, result.url, this.baseUrl);
    return generated;
  }

  private async downloadImage(url: string, signal: AbortSignal | undefined, requestId: string | null, expected?: ImageGenerationInput): Promise<GeneratedImage> {
    let imageResponse: Response;
    const timeout = AbortSignal.timeout(30_000);
    const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      imageResponse = await awaitImageResponse(fetchProviderArtifact(this.request, url, this.baseUrl, { signal: downloadSignal, protectedSecrets: providerCredentialValues(this.apiKey, this.headers) }), downloadSignal);
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      throw new ImageGenerationError(cause instanceof ProviderArtifactAddressError ? `${cause.message} The image result was received; recover it after fixing the network.` : "The image result was received, but its download failed. Recover the existing result; do not generate again.");
    }
    if (!imageResponse.ok) throw new ImageGenerationError("The image result was received, but its download failed. Recover the existing result; do not generate again.");
    const bytes = await imageBytes(imageResponse, downloadSignal);
    return {
      bytes,
      mediaType: await verifiedImageType(bytes, expected),
      requestId: requestId ?? undefined,
    };
  }
}

function imageEndpoint(baseUrl: string, edit: boolean): string {
  try {
    const url = providerControlUrl(baseUrl, true);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/images/${edit ? "edits" : "generations"}`;
    return url.toString();
  } catch {
    throw new ImageGenerationError("OpenAI base URL is not valid", 503);
  }
}

const OPENAI_IMAGE_SIZES: Record<Exclude<ImageResolution, "512">, Record<ImageAspectRatio, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
    "3:4": "960x1280",
    "4:3": "1280x960",
    "4:5": "1024x1280",
    "5:4": "1280x1024",
    "9:16": "864x1536",
    "16:9": "1536x864",
    "21:9": "1456x624",
  },
  "2K": {
    "1:1": "2048x2048",
    "2:3": "1344x2016",
    "3:2": "2016x1344",
    "3:4": "1536x2048",
    "4:3": "2048x1536",
    "4:5": "1600x2000",
    "5:4": "2000x1600",
    "9:16": "1152x2048",
    "16:9": "2048x1152",
    "21:9": "2016x864",
  },
  "4K": {
    "1:1": "2880x2880",
    "2:3": "2304x3456",
    "3:2": "3456x2304",
    "3:4": "2448x3264",
    "4:3": "3264x2448",
    "4:5": "2560x3200",
    "5:4": "3200x2560",
    "9:16": "2160x3840",
    "16:9": "3840x2160",
    "21:9": "3808x1632",
  },
};

export function openAIImageSize(input: ImageGenerationInput): string {
  if (input.size) {
    const match = /^(\d+)x(\d+)$/.exec(input.size);
    const width = Number(match?.[1]), height = Number(match?.[2]), pixels = width * height;
    if (!match || !width || !height || width % 16 || height % 16 || width > 3840 || height > 3840
      || width / height > 3 || height / width > 3 || pixels < 655_360 || pixels > 8_294_400) throw new ImageGenerationError("Image size is outside the selected model's supported bounds", 400);
    return input.size;
  }
  if (!input.resolution || input.resolution === "512" || !input.aspectRatio) {
    throw new ImageGenerationError("Image resolution and aspect ratio are not supported by the selected model", 400);
  }
  return OPENAI_IMAGE_SIZES[input.resolution][input.aspectRatio];
}

function editForm(input: ImageGenerationInput & { model?: string }, parameters: Record<string, string | number | boolean>): FormData {
  const images = input.images;
  if (!images?.length) throw new ImageGenerationError("A reference image is required", 400);
  const form = new FormData();
  form.set("model", input.model ?? "gpt-image-2.5-sunburst");
  form.set("prompt", input.prompt);
  for (const [key, value] of Object.entries(parameters)) form.set(key, String(value));
  images.forEach((image, index) => {
    const extension = image.mediaType === "image/png" ? "png" : image.mediaType === "image/jpeg" ? "jpg" : "webp";
    form.append(images.length === 1 ? "image" : "image[]", new Blob([Buffer.from(image.data, "base64")], { type: image.mediaType }), `reference-${index + 1}.${extension}`);
  });
  if (input.mask) form.set("mask", new Blob([Buffer.from(input.mask.data, "base64")], { type: "image/png" }), "mask.png");
  return form;
}

function gpt26Size(input: ImageGenerationInput, first?: { width: number; height: number }): string {
  if (input.pixelSize) return input.pixelSize;
  if (input.size) return input.size;
  if (input.outputFormat === "gif") {
    const ratio = input.aspectRatio ?? (first ? `${first.width}:${first.height}` : undefined);
    return gptImage26FrameSize(ratio);
  }
  if (input.aspectRatio && input.resolution && input.resolution !== "512") return openAIImageSize(input);
  if (first) {
    const ratio = Math.min(3, Math.max(1 / 3, first.width / first.height));
    return `${Math.round(64 * Math.sqrt(ratio)) * 16}x${Math.round(64 / Math.sqrt(ratio)) * 16}`;
  }
  return "1024x1024";
}

/** Validate references locally before a paid POST, including oriented dimensions for markup. */
async function validate26References(input: ImageGenerationInput): Promise<{ width: number; height: number }> {
  const limitInputPixels = 16_777_216;
  let first!: { width: number; height: number };
  try {
    for (const [index, image] of input.images!.entries()) {
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.toString("base64") !== image.data || sniffImageType(bytes) !== image.mediaType) throw new Error();
      const metadata = await sharp(bytes, !index && input.markup ? { limitInputPixels } : {}).metadata();
      if ((metadata.pages ?? 1) !== 1) throw new Error();
      if (!index) first = metadata.autoOrient;
    }
    if (input.markup) {
      const bytes = Buffer.from(input.markup.data, "base64");
      if (input.markup.mediaType !== "image/png" || bytes.toString("base64") !== input.markup.data || sniffImageType(bytes) !== "image/png") throw new Error();
      const layer = sharp(bytes, { limitInputPixels }).timeout({ seconds: 10 });
      const meta = await layer.metadata();
      if (meta.autoOrient.width !== first.width || meta.autoOrient.height !== first.height ||
        !meta.hasAlpha || (meta.pages ?? 1) !== 1 || (await layer.stats()).isOpaque) throw new Error();
    }
  } catch {
    throw new ImageGenerationError(input.markup
      ? "Markup requires a static PNG with transparent pixels and the same oriented dimensions as the first reference, both within 16 megapixels."
      : "Provide valid static PNG, JPEG, or WebP references.", 400, false, true);
  }
  return first;
}

function validateImageInput(input: ImageGenerationInput, nano: boolean, gpt26: boolean): void {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new ImageGenerationError("An image prompt is required", 400);
  if (input.quality !== undefined && !["auto", "low", "medium", "high", "xhigh", "max"].includes(input.quality)) throw new ImageGenerationError("Unsupported image quality", 400);
  if (input.outputFormat !== undefined && !gpt26 && !["png", "jpeg"].includes(input.outputFormat)) throw new ImageGenerationError("Unsupported image output format", 400);
  if (input.background !== undefined && !["auto", "opaque", "transparent"].includes(input.background)) throw new ImageGenerationError("Unsupported image background", 400);
  if (input.background === "transparent" && input.outputFormat === "jpeg") throw new ImageGenerationError("Transparent backgrounds require PNG output", 400);
  if (input.outputCompression !== undefined && (!Number.isInteger(input.outputCompression) || input.outputCompression < 0 || input.outputCompression > 100 || input.outputFormat !== "jpeg" && !(gpt26 && input.outputFormat === "webp"))) throw new ImageGenerationError("Image output compression must be an integer from 0 to 100 for a supported format", 400);
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > (nano ? 14 : 16)) throw new ImageGenerationError(`The selected image model supports up to ${nano ? 14 : 16} references`, 400);
  if (input.mask && (!images.length || input.mask.mediaType !== "image/png")) throw new ImageGenerationError("A PNG mask requires a reference image", 400);
  const resources = [...images, ...(input.mask ? [input.mask] : []), ...(input.markup ? [input.markup] : [])];
  if (resources.some((image) => !image || !["image/png", "image/jpeg", ...(nano || gpt26 ? ["image/webp"] : [])].includes(image.mediaType)
    || typeof image.data !== "string" || !image.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) {
    throw new ImageGenerationError(nano || gpt26 ? "Provide PNG, JPEG, or WebP reference images" : "Provide PNG or JPEG reference images", 400);
  }
  if (resources.reduce((bytes, image) => bytes + Buffer.byteLength(image.data, "base64"), 0) > IMAGE_INPUT_LIMIT_BYTES) throw new ImageGenerationError("Image references and mask exceed the local 32 MiB limit", 400);
  if (resources.some((image) => containsKnownSensitiveValue(Buffer.from(image.data, "base64").toString("utf8")))) throw new ImageGenerationError("Protected data cannot be included in image references or masks", 400);
  if (input.mask) {
    const mask = Buffer.from(input.mask.data, "base64"), first = Buffer.from(images[0]!.data, "base64");
    if (gpt26 && (sniffImageType(first) !== "image/png" || mask.length >= 4 * 1024 * 1024)) throw new ImageGenerationError("Use a PNG first reference and a PNG mask smaller than 4 MiB", 400, false, true);
    const maskSize = imagePixelSize(mask), sourceSize = imagePixelSize(first);
    if (!maskSize || !sourceSize || sniffImageType(mask) !== "image/png" || ![4, 6].includes(mask[25]!)
      || maskSize.width !== sourceSize.width || maskSize.height !== sourceSize.height) throw new ImageGenerationError("The mask must be a PNG with an alpha channel and the same dimensions as the first reference", 400);
  }
  if (nano) {
    if (input.mask || input.background && input.background !== "auto" || input.outputFormat || input.outputCompression !== undefined || input.quality && input.quality !== "auto") throw new ImageGenerationError("Image-GI2.1 does not support mask, background, quality or output format options", 400);
    if (input.resolution === "512") throw new ImageGenerationError("Image-GI2.1 supports 1K, 2K, or 4K", 400);
    if (images.some((image) => image.mediaType !== images[0]!.mediaType)) throw new ImageGenerationError("Image-GI2.1 references must use one image MIME type", 400);
  }
}

function imagePixelSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 26 && sniffImageType(bytes) === "image/png" && bytes.toString("ascii", 12, 16) === "IHDR") {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width && height ? { width, height } : undefined;
  }
  if (sniffImageType(bytes) !== "image/jpeg") return undefined;
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const width = bytes.readUInt16BE(offset + 7), height = bytes.readUInt16BE(offset + 5);
      return width && height ? { width, height } : undefined;
    }
    offset += length + 2;
  }
  return undefined;
}

function legacyRatio(size?: ImageSize): string {
  return size === "1536x1024" ? "3:2" : size === "1024x1536" ? "2:3" : "1:1";
}

async function verifiedImageType(bytes: Buffer, expected?: ImageGenerationInput): Promise<GeneratedImageMediaType> {
  if (containsKnownSensitiveValue(bytes.toString("utf8"))) throw new ImageGenerationError("The image result contains protected data");
  if (expected) {
    const format = expected.outputFormat ?? "png";
    try {
      await validateGeneratedImage(bytes, format, format === "gif" ? {
        frameCount: expected.frameCount ?? GPT_IMAGE_26_DEFAULTS.frameCount,
        frameDurationMs: expected.frameDurationMs ?? GPT_IMAGE_26_DEFAULTS.frameDurationMs,
      } : undefined);
    } catch (error) {
      throw new ImageGenerationError(error instanceof Error ? error.message : "Invalid generated image", 502, true);
    }
    return format === "svg" ? "image/svg+xml" : `image/${format}`;
  }
  const type = sniffImageType(bytes);
  if (!type) throw new ImageGenerationError("The provider returned an unsupported image file");
  return type;
}

async function imageJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return JSON.parse((await imageBytes(response, signal)).toString("utf8"));
}

function awaitImageResponse(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then((response) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); reject(signal.reason); }
      else resolve(response);
    }, (cause) => { signal.removeEventListener("abort", abort); reject(cause); });
  });
}

async function imageBytes(response: Response, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
  const length = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(length) && length > IMAGE_RESPONSE_LIMIT_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new ImageGenerationError("The image response exceeds the local 64 MiB limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > IMAGE_RESPONSE_LIMIT_BYTES) throw new ImageGenerationError("The image response exceeds the local 64 MiB limit");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } catch (cause) {
    void reader.cancel().catch(() => {});
    throw cause;
  } finally { signal?.removeEventListener("abort", abort); }
}

function openAIError(status: number, error?: { code?: unknown; message?: unknown }, request?: { model: string; svgAuthor?: string; format: string }): ImageGenerationError {
  if (status === 403 && request) {
    const selection = request.svgAuthor ? `${request.model} with SVG author ${request.svgAuthor}` : request.model;
    return new ImageGenerationError(`Access denied for ${selection} (403). Check the configured model permissions.`, 403);
  }
  if (request && status === 401) return new ImageGenerationError("The image provider rejected the configured API key.", 401);
  if (request && (status >= 500 || status === 408 || status === 499)) return new ImageGenerationError(`Image provider returned ${status}; the generation outcome is unknown. Review the original request before submitting again.`, 502, true);
  if (request?.format === "gif" && status === 400 && typeof error?.message === "string" && /pixel|budget|sheet/i.test(error.message))
    return new ImageGenerationError("The provider rejected this GIF's pixel budget. Choose a smaller frame size or fewer frames.", 400);
  if (status === 401 || status === 403) {
    return new ImageGenerationError("OpenAI API key was rejected", 503);
  }
  if (status === 429) {
    return new ImageGenerationError("OpenAI image generation is temporarily rate limited", 429);
  }
  if (error?.code === "moderation_blocked") {
    return new ImageGenerationError("The image request did not meet safety requirements", 400);
  }
  if (status >= 400 && status < 500) {
    return new ImageGenerationError("OpenAI rejected the image request", 400);
  }
  return new ImageGenerationError("OpenAI image generation failed");
}
