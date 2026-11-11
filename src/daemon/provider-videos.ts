import { MESHY_DISABLED_MESSAGE, isMeshyEndpoint, isMeshyModelReference, isMeshyProviderConfiguration } from "../shared/disabled-media-providers.js";
import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerCredentialValues, fetchProviderArtifact, providerPollingUrl, providerRequest, providerControlUrl } from "./provider-network.js";
import type { CustomProviderDetails, MediaModelCatalog, VideoModel, VideoModelRef } from "../shared/contracts.js";
import { customVideoModel } from "../shared/custom-models.js";
import { customMediaSource } from "./custom-media-source.js";
import {
  VideoGenerationError,
  type GeneratedVideo,
  type VideoGenerationInput,
  type VideoGenerator,
  type VideoReferenceAsset,
} from "./video-generation.js";
import {
  listOpenRouterVideoModels,
  openRouterHeaders,
  resolveOpenRouterMediaSource,
  type OpenRouterMediaSource,
} from "./openrouter-media.js";
import { SeedanceProvider } from "./seedance-provider.js";
import { isSeedanceProviderId, SEEDANCE_PROVIDER_IDS, SEEDANCE_PROVIDERS, seedanceModel, seedanceModels, kunpoVideoModels, type SeedanceProviderId } from "./seedance-models.js";
import { isKunpoVideoModel, KunpoVideoProvider } from "./kunpo-video-provider.js";
import { MinimaxProvider } from "./minimax-provider.js";
import { isMinimaxProviderId, MINIMAX_PROVIDER_IDS, MINIMAX_PROVIDERS, minimaxModel, minimaxModels, type MinimaxProviderId } from "./minimax-models.js";

const MAX_WAIT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 5_000;

export class ProviderVideos implements VideoGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly request: typeof fetch = fetch,
    private readonly seedanceApiKey: (providerId: SeedanceProviderId) => string | undefined = () => undefined,
    private readonly isEnabled: (provider: string) => boolean = () => true,
    private readonly options: { customProviders?: () => Promise<CustomProviderDetails[]>; defaultModel?: () => VideoModelRef | undefined; minimaxApiKey?: (providerId: MinimaxProviderId) => string | undefined; kunpoApiKey?: () => string | undefined | Promise<string | undefined> } = {},
  ) {}

  #blockedCustom(provider: CustomProviderDetails, id?: string): boolean {
    const definition = id === undefined ? undefined : provider.models.find(model => model.id === id);
    return isMeshyProviderConfiguration(provider) || isMeshyModelReference({ provider: provider.id, id }) || isMeshyEndpoint(definition?.usages?.video?.baseUrl);
  }
  async #blockedSelection(ref?: VideoModelRef): Promise<boolean> {
    if (!ref) return false;
    if (isMeshyModelReference(ref)) return true;
    const provider = (await this.options.customProviders?.() ?? []).find(provider => provider.id === ref.provider);
    return !!provider && this.#blockedCustom(provider, ref.id);
  }
  /** Configuration-only admission; cached catalog/default values do not authorize Meshy. */
  async assertGenerationAllowed(ref?: VideoModelRef): Promise<void> {
    if (await this.#blockedSelection(ref ?? this.options.defaultModel?.())) throw new VideoGenerationError(MESHY_DISABLED_MESSAGE, 410, true);
  }

  async models(signal?: AbortSignal): Promise<VideoModel[]> {
    return (await this.catalog(signal)).models;
  }

  /** Every connected video provider with its models, or the reason it has none. */
  async catalog(signal?: AbortSignal, localOnly?: Set<string>): Promise<MediaModelCatalog<VideoModel>> {
    const custom = await this.options.customProviders?.() ?? [];
    const kunpoKey = await this.options.kunpoApiKey?.();
    if (localOnly && this.isEnabled("openrouter") && (await this.runtime()).hasConfiguredAuth("openrouter")) localOnly.add("openrouter");
    const entries = await Promise.all([
      localOnly ? undefined : this.#openRouterCatalog(signal),
      ...(this.isEnabled("kunpo") && kunpoKey ? [Promise.resolve({ models: kunpoVideoModels(), provider: { provider: "kunpo", providerName: "KunpoAPI", state: "ready" as const } })] : []),
      ...SEEDANCE_PROVIDER_IDS.map(async (providerId) => {
        if (!this.isEnabled(providerId) || !this.seedanceApiKey(providerId)) return undefined;
        const definition = SEEDANCE_PROVIDERS[providerId];
        const models = seedanceModels(providerId).filter((model) => new URL(definition.baseUrl).hostname !== "llm.ziy.cc" || model.id === "doubao-seedance-2-5-260628");
        return {
          models,
          provider: { provider: definition.id, providerName: definition.name, state: "ready" as const },
        };
      }),
      ...MINIMAX_PROVIDER_IDS.map(async (providerId) => {
        if (!this.isEnabled(providerId) || !this.options.minimaxApiKey?.(providerId)) return undefined;
        const definition = MINIMAX_PROVIDERS[providerId];
        const models = minimaxModels(providerId);
        return {
          models,
          provider: { provider: definition.id, providerName: definition.name, state: "ready" as const },
        };
      }),
      ...custom.filter((provider) => !this.#blockedCustom(provider) && this.isEnabled(provider.id) && provider.models.some((model) => model.usages?.video && !this.#blockedCustom(provider, model.id))).map(async (provider) => {
        if (!(await this.runtime()).hasConfiguredAuth(provider.id)) return undefined;
        const models = provider.models.filter((model) => !this.#blockedCustom(provider, model.id) && !provider.hiddenModelIds.includes(model.id)).flatMap((model) => {
          const video = customVideoModel(provider, model);
          return video ? [video] : [];
        });
        return { models, provider: { provider: provider.id, providerName: provider.name, state: models.length ? "ready" as const : "empty" as const,
          ...(!models.length ? { message: "Enable video models in Models." } : {}) } };
      }),
    ]);
    const connected = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const savedDefault = this.options.defaultModel?.();
    const defaultModel = await this.#blockedSelection(savedDefault) ? undefined : savedDefault;
    const models = [...new Map(connected.flatMap((entry) => entry.models).filter(model => !isMeshyModelReference(model)).map((model) => [`${model.provider}/${model.id}`, model])).values()];
    const index = models.findIndex((model) => sameModel(model, defaultModel));
    if (index > 0) models.unshift(...models.splice(index, 1));
    return { models, providers: connected.map((entry) => entry.provider), ...(defaultModel ? { defaultModel } : {}) };
  }

  async #openRouterCatalog(signal?: AbortSignal): Promise<{ models: VideoModel[]; provider: MediaModelCatalog<VideoModel>["providers"][number] } | undefined> {
    if (!this.isEnabled("openrouter")) return undefined;
    const source = await this.runtime().then((runtime) => isMeshyProviderConfiguration(runtime.getProvider?.("openrouter")) ? undefined : resolveOpenRouterMediaSource(runtime, signal)).catch(() => undefined);
    if (!source) return undefined;
    try {
      const models = await listOpenRouterVideoModels(source, this.request, signal);
      return {
        models,
        provider: models.length
          ? { provider: "openrouter", providerName: "OpenRouter", state: "ready" }
          : { provider: "openrouter", providerName: "OpenRouter", state: "empty", message: "OpenRouter lists no video models for this account." },
      };
    } catch (cause) {
      return { models: [], provider: { provider: "openrouter", providerName: "OpenRouter", state: "error", message: cause instanceof Error ? cause.message : String(cause) } };
    }
  }

  async generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    input = { ...input, model: input.model ?? this.options.defaultModel?.() };
    await this.assertGenerationAllowed(input.model);
    if (!this.isEnabled(input.model?.provider ?? "openrouter")) throw new VideoGenerationError("The selected provider is disabled", 409);
    const custom = (await this.options.customProviders?.() ?? []).find((provider) => provider.id === input.model?.provider);
    if (custom) {
      if (this.#blockedCustom(custom, input.model?.id)) throw new VideoGenerationError(MESHY_DISABLED_MESSAGE, 410, true);
      const selected = custom.models.find((model) => model.id === input.model?.id && !custom.hiddenModelIds.includes(model.id));
      const model = selected && customVideoModel(custom, selected);
      const config = selected?.usages?.video;
      if (!model || !config) throw new VideoGenerationError("The selected video model is not available", 503);
      const expectedProtocol = model.id === "doubao-seedance-2-5-260628" ? "seedance" : isKunpoVideoModel(model.id) ? "kunpo-videos" : undefined;
      if (providerControlUrl(config.baseUrl ?? custom.baseUrl, true).hostname === "llm.ziy.cc" && !expectedProtocol) throw new VideoGenerationError("This Kunpo video model has no reviewed submission and recovery contract", 400);
      if (config.protocol === "kunpo-videos" && expectedProtocol !== "kunpo-videos" || expectedProtocol && config.protocol !== expectedProtocol) throw new VideoGenerationError("The selected model and video protocol do not match", 400);
      const runtime = await this.runtime();
      if (!runtime.hasConfiguredAuth(custom.id)) throw new VideoGenerationError("Video generation is not configured", 503);
      const signature = JSON.stringify([custom.id, custom.preset, custom.baseUrl, config]);
      const source = await customMediaSource(runtime, custom, config.baseUrl, signal);
      const fresh = (await this.options.customProviders?.() ?? []).find(item => item.id === custom.id), current = fresh?.models.find(item => item.id === model.id)?.usages?.video;
      if (fresh && this.#blockedCustom(fresh, model.id) || isMeshyEndpoint(source.baseUrl)) throw new VideoGenerationError(MESHY_DISABLED_MESSAGE, 410, true);
      if (!fresh || signature !== JSON.stringify([fresh.id, fresh.preset, fresh.baseUrl, current])) throw new VideoGenerationError("The selected video connection changed before dispatch", 409);
      if (config.protocol === "seedance") return new SeedanceProvider("volcengine-ark", () => source.apiKey, this.request, undefined, undefined,
        { name: custom.name, baseUrl: source.baseUrl, headers: source.headers, authentication: source.authentication }).generate(model, input, signal);
      if (config.protocol === "kunpo-videos") return new KunpoVideoProvider({ name: custom.name, ...source }, this.request).generate(model, input, signal);
      return this.#generateOpenRouter({ ...source, headers: source.headers ?? {} }, model, input, signal);
    }
    if (input.model?.provider === "kunpo") {
      const model = kunpoVideoModels().find((entry) => entry.id === input.model?.id);
      if (!model) throw new VideoGenerationError("The selected Kunpo video model is not available", 503);
      return new KunpoVideoProvider({ name: "KunpoAPI", baseUrl: "https://llm.ziy.cc/v1", apiKey: await this.options.kunpoApiKey?.() }, this.request).generate(model, input, signal);
    }
    if (input.model && isMinimaxProviderId(input.model.provider)) {
      const providerId = input.model.provider;
      const model = minimaxModel(providerId, input.model.id);
      if (!model) throw new VideoGenerationError("The selected video model is not available", 503);
      return new MinimaxProvider(providerId, () => this.options.minimaxApiKey?.(providerId), this.request)
        .generate(model, input, signal);
    }
    if (input.model && isSeedanceProviderId(input.model.provider)) {
      const providerId = input.model.provider;
      const model = seedanceModel(providerId, input.model.id);
      if (!model) throw new VideoGenerationError("The selected video model is not available", 503);
      return new SeedanceProvider(providerId, () => this.seedanceApiKey(providerId), this.request)
        .generate(model, input, signal);
    }
    if (input.execution?.recoveryOnly) throw new VideoGenerationError("Saved-task recovery is unavailable for OpenRouter video; no new task was submitted.", 409);
    const runtime = await this.runtime();
    if (isMeshyProviderConfiguration(runtime.getProvider?.("openrouter"))) throw new VideoGenerationError(MESHY_DISABLED_MESSAGE, 410, true);
    const source = await resolveOpenRouterMediaSource(runtime, signal);
    if (source) {
      const models = await listOpenRouterVideoModels(source, this.request, signal);
      const model = models.find((candidate) => sameModel(candidate, input.model));
      if (model) return this.#generateOpenRouter(source, model, input, signal);
    }
    throw new VideoGenerationError("The selected video model is not available", 503);
  }

  async #generateOpenRouter(source: OpenRouterMediaSource, model: VideoModel, input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    if (isMeshyModelReference(model) || isMeshyEndpoint(source.baseUrl)) throw new VideoGenerationError(MESHY_DISABLED_MESSAGE, 410, true);
    if (input.execution?.recoveryOnly) throw new VideoGenerationError("Saved-task recovery is unavailable for OpenRouter video; no new task was submitted.", 409);
    const duration = input.duration ?? model.durations[0]!;
    const resolution = input.resolution ?? model.resolutions[0]!;
    const aspectRatio = input.aspectRatio ?? model.aspectRatios[0]!;
    if (!model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
    if (!model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
    if (!model.aspectRatios.includes(aspectRatio)) throw new VideoGenerationError("Video aspect ratio is not supported by the selected model", 400);
    const references = input.references ?? [];
    const mode = input.referenceMode ?? model.imageReferenceMode ?? "reference";
    if (!(model.referenceModes ?? [model.imageReferenceMode ?? "reference"]).includes(mode)) throw new VideoGenerationError("The selected video model does not support this reference mode", 400);
    if (references.some((reference) => reference.type !== "image")) {
      throw new VideoGenerationError("OpenRouter video generation currently supports image references only", 400);
    }
    const maxReferences = mode === "frame" ? Math.min(2, model.maxImageReferences) : model.maxImageReferences;
    if (references.length > maxReferences) {
      throw new VideoGenerationError(`The selected video model supports up to ${maxReferences} reference images`, 400);
    }
    const referenceItems = await Promise.all(references.map(referenceItem));
    const referencePayload = mode === "frame" && referenceItems.length
      ? { frame_images: referenceItems.slice(0, 2).map((reference, index) => ({ ...reference, frame_type: index === 0 ? "first_frame" : "last_frame" })) }
      : referenceItems.length ? { input_references: referenceItems } : {};
    await input.execution?.submissionStarted?.();
    const created = await json(await providerRequest(this.request, `${source.baseUrl}/videos`, {
      method: "POST",
      headers: openRouterHeaders(source, true),
      body: JSON.stringify({
        model: model.id,
        prompt: input.prompt,
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        ...referencePayload,
      }),
      signal,
    }), "OpenRouter video generation request failed");
    const requestId = string(created.id);
    const pollingUrl = httpUrl(created.polling_url) ?? (requestId ? `${source.baseUrl}/videos/${encodeURIComponent(requestId)}` : undefined);
    if (!requestId || !pollingUrl) throw new VideoGenerationError("OpenRouter returned no video job ID");

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const status = await json(await providerRequest(this.request, providerPollingUrl(pollingUrl, source.baseUrl), { headers: openRouterHeaders(source), signal }), "OpenRouter video status request failed");
      const state = string(status.status)?.toLowerCase();
      if (state === "completed" || state === "succeeded" || state === "success") {
        const contentUrl = firstHttpUrl(status.unsigned_urls) ?? httpUrl(status.content_url) ?? `${source.baseUrl}/videos/${encodeURIComponent(requestId)}/content`;
        const content = await fetchProviderArtifact(this.request, contentUrl, source.baseUrl, { signal, protectedSecrets: providerCredentialValues(source.apiKey, source.headers) });
        if (!content.ok) throw new VideoGenerationError(`OpenRouter video download failed (${content.status})`, content.status);
        return { bytes: Buffer.from(await content.arrayBuffer()), mediaType: "video/mp4", requestId };
      }
      if (state === "failed" || state === "failure" || state === "error" || state === "expired" || state === "cancelled") {
        throw new VideoGenerationError(`OpenRouter video generation ${state}`);
      }
      await delay(POLL_INTERVAL_MS, signal);
    }
    throw new VideoGenerationError("OpenRouter video generation timed out", 504);
  }
}

function sameModel(left: VideoModelRef | undefined, right: VideoModelRef | undefined): boolean {
  return Boolean(left && right && left.provider === right.provider && left.id === right.id);
}

async function referenceItem(reference: VideoReferenceAsset) {
  const data = await readFile(reference.absolutePath);
  return {
    type: "image_url" as const,
    image_url: { url: `data:${reference.mediaType};base64,${data.toString("base64")}` },
  };
}

async function json(response: Response, message: string): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return body;
  if (response.status === 401 || response.status === 403) throw new VideoGenerationError("OpenRouter credentials were rejected", 503);
  if (response.status === 429) throw new VideoGenerationError("OpenRouter video generation is temporarily rate limited", 429);
  throw new VideoGenerationError(message, response.status >= 500 ? 502 : 400);
}


function firstHttpUrl(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(httpUrl).find(Boolean) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && /^https?:\/\//.test(candidate) ? candidate : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Video generation cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
