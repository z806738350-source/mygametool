import { registerSensitiveValue } from "../shared/sensitive-values.js";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential, type Credential, type CredentialStore, type Provider, type ProviderStreams, type AuthOperationOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { assertLocalModelTransport, assertModelImageInput, kunpoImagePayload } from "./model-network-policy.js";
import type { AssetLibrary } from "./asset-library.js";
import type { RuntimeModel } from "./agent.js";
import { KUNPO_PROVIDER_ID } from "../shared/kunpo-models.js";
import { monitorModelRequest } from "./provider-request-monitor.js";
import { isMeshyEndpoint, isMeshyModelReference, isMeshyProviderConfiguration, MESHY_DISABLED_MESSAGE } from "../shared/disabled-media-providers.js";

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
export interface LocalRuntimeProvider { id: string; config: ProviderConfig }

function literalCredential(value: unknown): ApiKeyCredential {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "api_key" || !("key" in value) ||
    typeof value.key !== "string" || !value.key || value.key.length > 16_384 || /[^\x20-\x7e]/.test(value.key)) {
    throw new Error("Only a literal API key is supported in the local secure edition");
  }
  // Deliberately discard OAuth, env, command resolvers and every additional field.
  registerSensitiveValue(value.key);
  return { type: "api_key", key: value.key };
}

/** New, daemon-owned storage. Never reads or migrates SDK auth.json or ambient credentials. */
export class LocalApiKeyStore implements CredentialStore {
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async #load(): Promise<Record<string, ApiKeyCredential>> {
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null); throw new Error("Local API key storage is unavailable"); }
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > 1024 * 1024 || process.platform !== "win32" &&
        ((entry.mode & 0o077) !== 0 || typeof process.getuid === "function" && entry.uid !== process.getuid())) throw new Error();
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const values: Record<string, ApiKeyCredential> = Object.create(null);
      for (const [id, value] of Object.entries(parsed)) values[id] = literalCredential(value);
      return values;
    } catch { throw new Error("Local API key storage is invalid or not private"); }
    finally { await handle.close(); }
  }

  async #save(values: Record<string, ApiKeyCredential>): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Local API key storage must not be a symbolic link");
    await chmod(directory, 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(values)}\n`, "utf8"); } finally { await handle.close(); }
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const value = (await this.#load())[id];
    return value ? { ...value } : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.keys(await this.#load()).map((providerId) => ({ providerId, type: "api_key" as const }));
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#pending.catch(() => {}).then(work);
    this.#pending = next.catch(() => {});
    return next;
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      const values = await this.#load(), current = values[id];
      const value = await fn(current ? { ...current } : undefined);
      if (value === undefined) return current ? { ...current } : undefined;
      values[id] = literalCredential(value);
      options?.signal?.throwIfAborted();
      await this.#save(values);
      return { ...values[id] };
    });
  }
  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      const values = await this.#load();
      delete values[id];
      await this.#save(values);
    });
  }

  /** A deliberately separate launch profile can replace its own credentials without reading an old profile. */
  replace(values: Readonly<Record<string, ApiKeyCredential>>): Promise<void> {
    return this.#serialize(async () => {
      const next: Record<string, ApiKeyCredential> = Object.create(null);
      for (const [id, value] of Object.entries(values)) next[id] = literalCredential(value);
      await this.#save(next);
    });
  }
}

const literalAuth: Provider["auth"] = { apiKey: {
  name: "Local API key",
  login: async (interaction) => literalCredential({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) }),
  check: async ({ credential }) => credential?.key ? { type: "api_key", source: "local API key" } : undefined,
  resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "local API key" } : undefined,
} };
function withoutAutomaticRetries(api: ProviderStreams, library?: Pick<AssetLibrary, "attachImageSource">): ProviderStreams {
  const requestOptions = (model: Parameters<ProviderStreams["stream"]>[0], context: Parameters<ProviderStreams["stream"]>[1], options: Parameters<ProviderStreams["stream"]>[2]) => ({ ...options, maxRetries: 0,
    onPayload: async (payload: unknown, current: typeof model) => kunpoImagePayload(model, context, await options?.onPayload?.(payload, current) ?? payload, options?.signal, library) });
  return { ...api,
    // A failed response does not establish that a billed POST was never submitted.
    stream: (model, context, options) => monitorModelRequest(model.api, () => { assertModelImageInput(model, context); return api.stream(model, context, requestOptions(model, context, options)); }, options?.signal),
    streamSimple: (model, context, options) => monitorModelRequest(model.api, () => { assertModelImageInput(model, context); return api.streamSimple(model, context, requestOptions(model, context, options)); }, options?.signal),
  };
}
const createApis = (library?: Pick<AssetLibrary, "attachImageSource">) => ({
  "openai-completions": withoutAutomaticRetries(openAICompletionsApi(), library),
  "openai-responses": withoutAutomaticRetries(openAIResponsesApi(), library),
  "anthropic-messages": withoutAutomaticRetries(anthropicMessagesApi(), library),
});
const apis = createApis();

function localProvider(id: string, config: ProviderConfig, previous?: Provider, registry = apis): Provider {
  if (["apiKey", "headers", "oauth", "streamSimple", "images", "classifiers", "refreshModels"].some((key) => Object.hasOwn(config, key))) {
    throw new Error("Dynamic provider authentication and executable configuration are unavailable");
  }
  const models = config.models ?? previous?.getModels() ?? [];
  const safeModels: RuntimeModel[] = models.filter((model) => !model.type || model.type === "chat").flatMap((model) => {
    const api = model.api ?? config.api;
    const baseUrl = config.models ? model.baseUrl ?? config.baseUrl ?? "" : config.baseUrl ?? model.baseUrl ?? previous?.baseUrl ?? "";
    if (isMeshyModelReference({ provider: id, id: model.id }) || isMeshyProviderConfiguration({ baseUrl })) return [];
    // Built-in official catalogs remain visible as metadata, but their transports are unavailable.
    if (!api || !(api in apis)) return [];
    return [{
      id: model.id, name: model.name, provider: id, api, baseUrl,
      input: model.input, reasoning: "reasoning" in model && model.reasoning,
      contextWindow: "contextWindow" in model ? model.contextWindow : 128_000,
      maxTokens: "maxTokens" in model ? model.maxTokens : 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...("thinkingLevelMap" in model && model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      // Only this reviewed adapter policy is copied; user-provided compat never enters the runtime.
      ...(id === KUNPO_PROVIDER_ID && model.id === "claude-opus-5-5" && api === "anthropic-messages"
        ? { compat: { forceAdaptiveThinking: true, supportsTemperature: false } } : {}),
    } as RuntimeModel];
  });
  return createProvider({ id, name: config.name ?? previous?.name ?? id, baseUrl: config.baseUrl ?? previous?.baseUrl,
    models: safeModels, auth: literalAuth, api: registry });
}

/** No SDK file resolvers, OAuth, ambient auth, dynamic catalogs or unreviewed protocol implementations. */
export async function createLocalModelRuntime(file: string, providers: () => Promise<LocalRuntimeProvider[]>, library?: Pick<AssetLibrary, "attachImageSource">): Promise<ModelRuntime> {
  const registry = library ? createApis(library) : apis;
  const runtime = await ModelRuntime.create({ credentials: new LocalApiKeyStore(file), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const refresh = runtime.refresh.bind(runtime);
  const register = runtime.registerNativeProvider.bind(runtime);
  const unregister = runtime.unregisterProvider.bind(runtime);
  for (const provider of runtime.getProviders()) if (isMeshyProviderConfiguration({ id: provider.id, baseUrl: provider.baseUrl })) unregister(provider.id);
  const defaults = new Map(runtime.getProviders().filter((provider) => !isMeshyProviderConfiguration({ id: provider.id, baseUrl: provider.baseUrl })).map((provider) => [provider.id, localProvider(provider.id, {}, provider, registry)]));
  const overrides = new Map<string, ProviderConfig>();
  let applying = false;
  let applied = new Set<string>();
  let pending: Promise<unknown> = Promise.resolve();
  const install = (id: string, config: ProviderConfig) => register(localProvider(id, config, runtime.getProvider(id), registry));
  // registerNativeProvider schedules refresh: suppress reentry while replaying inert metadata.
  runtime.refresh = (options = {}) => {
    if (applying) return Promise.resolve({ aborted: false, errors: new Map() });
    const next = pending.catch(() => {}).then(async () => {
      const configured = await providers();
      applying = true;
      try {
        for (const id of applied) if (!defaults.has(id)) unregister(id);
        for (const provider of defaults.values()) register(provider);
        for (const { id, config } of configured) if (!isMeshyProviderConfiguration({ id, baseUrl: config.baseUrl })) install(id, config);
        for (const [id, config] of overrides) install(id, config);
        applied = new Set(configured.map(({ id }) => id));
      } finally { applying = false; }
      return refresh({ ...options, allowNetwork: false });
    });
    pending = next.catch(() => {});
    return next;
  };
  runtime.registerProvider = (id, config) => {
    const normalized = { ...overrides.get(id), ...config };
    if (isMeshyProviderConfiguration({ id, baseUrl: normalized.baseUrl })) throw new Error(MESHY_DISABLED_MESSAGE);
    const provider = localProvider(id, normalized, runtime.getProvider(id), registry);
    overrides.set(id, normalized);
    applying = true;
    try { register(provider); } finally { applying = false; }
  };
  runtime.unregisterProvider = (id) => {
    overrides.delete(id);
    applying = true;
    try { if (defaults.has(id)) register(defaults.get(id)!); else unregister(id); }
    finally { applying = false; }
  };
  const login = runtime.login.bind(runtime);
  runtime.login = (id, type, interaction, options) => {
    if (isMeshyProviderConfiguration({ id, baseUrl: runtime.getProvider(id)?.baseUrl })) return Promise.reject(new Error(MESHY_DISABLED_MESSAGE));
    if (type !== "api_key") return Promise.reject(new Error("OAuth is unavailable in the local secure edition"));
    return login(id, type, interaction, options);
  };
  await runtime.refresh({ allowNetwork: false });
  // Verify at the actual request boundary as well as the selectors; old saved models cannot revive an origin.
  const getAvailable = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = async (...args) => (await getAvailable(...args)).filter((model) => {
    try { assertLocalModelTransport(model); return true; } catch { return false; }
  });
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => { assertLocalModelTransport(model); return streamSimple(model, context,
    model.provider === KUNPO_PROVIDER_ID && model.id === "claude-opus-5-5" && model.api === "anthropic-messages"
      ? { ...options, reasoning: options?.reasoning ?? "medium" } : options); };
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) => { assertLocalModelTransport(model); return stream(model, context, options); };
  const assertIdentity = (model: { provider: string; id: string; baseUrl?: string }) => {
    if (isMeshyModelReference(model) || isMeshyEndpoint(model.baseUrl)) throw new Error(MESHY_DISABLED_MESSAGE);
  };
  const deferred = runtime.streamDeferred.bind(runtime);
  runtime.streamDeferred = (model, handle, options) => { assertIdentity(model); return deferred(model, handle, options); };
  const cancelDeferred = runtime.cancelDeferred.bind(runtime);
  runtime.cancelDeferred = async (model, handle, options) => { assertIdentity(model); return cancelDeferred(model, handle, options); };
  const generateImages = runtime.generateImages.bind(runtime);
  runtime.generateImages = async (model, context, options) => { assertIdentity(model); return generateImages(model, context, options); };
  const classify = runtime.classify.bind(runtime);
  runtime.classify = async (model, context, options) => { assertIdentity(model); return classify(model, context, options); };
  return runtime;
}
