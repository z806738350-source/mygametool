import { isDeepStrictEqual } from "node:util";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomModel3DSettings, CustomProviderDetails, MediaModelCatalog, Model3DDefinition, Model3DModel, Model3DModelRef, Model3DOperation, Model3DOptions } from "../shared/contracts.js";
import { customModel3D, model3DModel } from "../shared/custom-models.js";
import { resolveModel3D, resolveModel3DConnection } from "../shared/generation-config.js";
import { isNative3DProvider, MODEL_3D_PRESETS, NATIVE_3D_PROVIDER_NAMES, type Native3DProviderId } from "../shared/model3d-presets.js";
import { MODEL3D_CONNECTION_ID } from "../shared/model3d-operations.js";
import { customMediaSource } from "./custom-media-source.js";
import { TripoProvider } from "./tripo-provider.js";
import type { MeshyProvider } from "./meshy-provider.js";
import { Hyper3DProvider } from "./hyper3d-provider.js";
import { Model3DGenerationError, type Model3DGenerator, type Model3DGenerationInput, type Model3DAnimationInput } from "./model3d.js";
import type { CloudModelsClient } from "./cloud-models.js";

import { MESHY_DISABLED_MESSAGE, isMeshyEndpoint, isMeshyModelReference, isMeshyProviderConfiguration } from "../shared/disabled-media-providers.js";

const PROVIDERS = { tripo: TripoProvider, hyper3d: Hyper3DProvider };
type Connection = MeshyProvider | TripoProvider | Hyper3DProvider;

interface ProviderModels3DOptions {
  runtime: () => Promise<ModelRuntime>;
  meshy?: { generator: MeshyProvider; configured: () => boolean };
  tripo?: { generator: TripoProvider; configured: () => boolean };
  hyper3d?: { generator: Hyper3DProvider; configured: () => boolean };
  customProviders: () => Promise<CustomProviderDetails[]>;
  nativeModels: (provider: Native3DProviderId) => Model3DDefinition[];
  isEnabled: (provider: string) => boolean;
  isVisible: (model: Model3DModelRef) => boolean;
  request?: typeof fetch;
  defaultModel: () => Model3DModelRef | undefined;
  cloud?: CloudModelsClient;
}

export class ProviderModels3D implements Model3DGenerator {
  readonly #customConnections = new Map<string, { fingerprint: string; generator: Connection }>();
  readonly #blockedReferences = new Set<string>();
  readonly #blockedProviders = new Set<string>();
  constructor(private readonly options: ProviderModels3DOptions) {}

  private disabled(): never { throw new Model3DGenerationError(MESHY_DISABLED_MESSAGE, 410, true); }
  private blockedDefinition(provider: CustomProviderDetails, definition: CustomProviderDetails["models"][number]): boolean {
    const settings = definition.usages?.["3d"];
    return isMeshyProviderConfiguration(provider) || isMeshyModelReference({ provider: provider.id, id: definition.id, protocol: settings?.protocol }) || isMeshyEndpoint(settings?.baseUrl);
  }
  private async customProviders(): Promise<CustomProviderDetails[]> {
    const providers = await this.options.customProviders();
    this.#blockedProviders.clear(); this.#blockedReferences.clear();
    for (const provider of providers) {
      if (isMeshyProviderConfiguration(provider)) this.#blockedProviders.add(provider.id);
      for (const definition of provider.models) if (this.blockedDefinition(provider, definition)) this.#blockedReferences.add(JSON.stringify([provider.id, definition.id]));
    }
    return providers;
  }
  private blockedReference(ref: Model3DModelRef | undefined, providers: readonly CustomProviderDetails[]): boolean {
    if (!ref) return false;
    if (isMeshyModelReference(ref)) return true;
    const provider = providers.find(provider => provider.id === ref.provider);
    if (provider) {
      const definition = provider.models.find(model => model.id === ref.id);
      return isMeshyProviderConfiguration(provider) || !!definition && this.blockedDefinition(provider, definition);
    }
    if (isNative3DProvider(ref.provider)) {
      const definition = this.options.nativeModels(ref.provider).find(model => model.id === ref.id);
      return !!definition && (definition.settings.protocol === "meshy" || isMeshyEndpoint(definition.settings.baseUrl));
    }
    return this.#blockedReferences.has(JSON.stringify([ref.provider, ref.id]));
  }
  /** Early synchronous policy check. Cached metadata is not authority for a fresh custom dispatch. */
  validateOperationSelection(ref?: Model3DModelRef): void {
    const selected = ref ?? this.options.defaultModel();
    if (isMeshyModelReference(selected) || selected && (this.#blockedProviders.has(selected.provider) || this.#blockedReferences.has(JSON.stringify([selected.provider, selected.id])))) this.disabled();
  }
  /** Fresh configuration-only policy admission; never reads credentials or provider discovery. */
  async assertGenerationAllowed(ref?: Model3DModelRef): Promise<void> {
    await this.assertReferenceAllowed(ref ?? this.options.defaultModel());
  }
  /** Required before starting/retrying an operation; dispatch still performs fresh checks. */
  async assertOperationAllowed(ref?: Model3DModelRef): Promise<void> {
    await this.assertReferenceAllowed(ref ?? this.options.defaultModel());
  }
  private async assertReferenceAllowed(ref: Model3DModelRef | undefined): Promise<void> {
    if (isMeshyModelReference(ref)) this.disabled();
    if (ref && this.blockedReference(ref, await this.customProviders())) this.disabled();
  }

  async catalog(): Promise<MediaModelCatalog<Model3DModel>> {
    const models: Model3DModel[] = [];
    const providers: MediaModelCatalog<Model3DModel>["providers"] = [];
    for (const provider of Object.keys(NATIVE_3D_PROVIDER_NAMES) as Native3DProviderId[]) {
      if (isMeshyModelReference({ provider }) || !this.options[provider]?.configured() || !this.options.isEnabled(provider)) continue;
      const configured = this.nativeModels(provider);
      models.push(...configured);
      providers.push({ provider, providerName: provider === "hyper3d" ? "Hyper3D · API key" : NATIVE_3D_PROVIDER_NAMES[provider], state: configured.length ? "ready" : "empty", ...(!configured.length ? { message: "Enable 3D models in Models." } : {}) });
    }
    const customProviders = await this.customProviders();
    for (const provider of customProviders) {
      const allowed = provider.models.filter(model => model.usages?.["3d"] && !this.blockedDefinition(provider, model));
      if (!this.options.isEnabled(provider.id) || !allowed.length || !(await this.options.runtime()).hasConfiguredAuth(provider.id)) continue;
      const configured = allowed.filter((model) => !provider.hiddenModelIds.includes(model.id)).flatMap((model) => {
        const value = customModel3D(provider, model);
        return value ? [value] : [];
      });
      models.push(...configured);
      providers.push({ provider: provider.id, providerName: provider.name, state: configured.length ? "ready" : "empty",
        ...(!configured.length ? { message: "Enable 3D models in Models." } : {}) });
    }
    if (this.options.cloud) {
      const catalog = await this.options.cloud.catalog();
      for (const model of catalog.models) if (isMeshyModelReference(model)) this.#blockedReferences.add(JSON.stringify([model.provider, model.id]));
      const visible = catalog.models.filter((model) => !isMeshyModelReference(model) && this.options.isEnabled(model.provider) && this.options.isVisible(model));
      models.push(...visible);
      providers.push(...catalog.providers.filter((provider) => !isMeshyProviderConfiguration({ id: provider.provider }) && this.options.isEnabled(provider.provider) && catalog.models.some(model => model.provider === provider.provider && !isMeshyModelReference(model))).map((provider) =>
        provider.state === "ready" && !visible.some((model) => model.provider === provider.provider)
          ? { ...provider, state: "empty" as const, message: "Enable 3D models in Models." } : provider));
    }
    const savedDefault = this.options.defaultModel();
    const defaultModel = this.blockedReference(savedDefault, customProviders) ? undefined : savedDefault;
    const resolvedDefault = defaultModel && resolveModel3D(defaultModel, models);
    const index = resolvedDefault ? models.indexOf(resolvedDefault) : -1;
    if (index > 0) models.unshift(...models.splice(index, 1));
    return { models, providers, ...(defaultModel ? { defaultModel } : {}) };
  }

  async resolveModel(ref?: Model3DModelRef): Promise<Model3DModel | undefined> {
    if (isMeshyModelReference(ref) || ref && this.blockedReference(ref, await this.customProviders())) return undefined;
    const catalog = await this.catalog();
    const selected = ref ?? catalog.defaultModel;
    return resolveModel3D(selected, catalog.models);
  }

  async generate(input: Model3DGenerationInput, signal?: AbortSignal) {
    await this.assertReferenceAllowed(input.model);
    if (!this.options.isEnabled(input.model.provider)) throw new Model3DGenerationError("The selected 3D provider is disabled", 409);
    if ((input.operation === undefined || input.operation === "image" || input.operation === "text") && !this.options.isVisible(input.model)) throw new Model3DGenerationError("The selected 3D model is hidden", 409);
    const selected = await this.resolveOperationModel(input.model, input.operation ?? "image");
    if (!selected) throw new Model3DGenerationError("The selected connection does not support this 3D operation", 400);
    if (isMeshyModelReference(selected)) this.disabled();
    if (selected.provider.startsWith("cloud-") && selected.protocol === undefined && this.options.cloud) {
      if (input.execution?.recoveryOnly) throw new Model3DGenerationError("This 3D provider cannot recover recorded tasks without submitting a new request", 409);
      if (input.operation && input.operation !== "image") throw new Model3DGenerationError("Cloud currently supports image-to-3D only", 400);
      return this.options.cloud.generate(input, signal);
    }
    const { generator, settings } = await this.connection(selected, signal);
    return generator.generate(input, signal, settings);
  }

  private nativeModels(provider: Native3DProviderId): Model3DModel[] {
    return this.options.nativeModels(provider).filter((model) => !isMeshyModelReference({ provider, id: model.id, protocol: model.settings.protocol }) && !isMeshyEndpoint(model.settings.baseUrl) && this.options.isVisible({ provider, id: model.id }))
      .map((model) => model3DModel(provider, provider === "hyper3d" ? "Hyper3D · API key" : NATIVE_3D_PROVIDER_NAMES[provider], model));
  }

  /** Operations use configured connections even when their generation models are hidden. */
  async operationModels(): Promise<Model3DModel[]> {
    const models: Model3DModel[] = [];
    for (const provider of Object.keys(NATIVE_3D_PROVIDER_NAMES) as Native3DProviderId[]) {
      if (isMeshyModelReference({ provider }) || !this.options[provider]?.configured() || !this.options.isEnabled(provider)) continue;
      const model = model3DModel(provider, NATIVE_3D_PROVIDER_NAMES[provider], {
        ...MODEL_3D_PRESETS[provider][0]!, id: MODEL3D_CONNECTION_ID, name: NATIVE_3D_PROVIDER_NAMES[provider],
      });
      models.push({ ...model, operations: model.operations!.filter((operation) => operation !== "image" && operation !== "text") });
    }
    for (const provider of await this.customProviders()) {
      const allowed = provider.models.filter(model => model.usages?.["3d"] && !this.blockedDefinition(provider, model));
      if (!this.options.isEnabled(provider.id) || !allowed.length || !(await this.options.runtime()).hasConfiguredAuth(provider.id)) continue;
      models.push(...allowed.flatMap((definition) => { const model = customModel3D(provider, definition); return model ? [model] : []; }));
    }
    return models;
  }
  async resolveOperationModel(ref: Model3DModelRef | undefined, operation: Model3DOperation): Promise<Model3DModel | undefined> {
    const providers = await this.customProviders();
    if (this.blockedReference(ref, providers)) return undefined;
    const models = operation === "image" || operation === "text" ? (await this.catalog()).models : await this.operationModels();
    const savedDefault = this.options.defaultModel();
    if (!ref && this.blockedReference(savedDefault, providers)) return undefined;
    const selected = ref ?? savedDefault;
    const model = selected ? (operation === "image" || operation === "text" ? resolveModel3D(selected, models) : resolveModel3DConnection(selected, models))
      : models.find((model) => model.provider === "tripo") ?? models[0];
    return model && (model.operations ?? ["image"]).includes(operation) ? model : undefined;
  }
  private async operationConnection(ref: Model3DModelRef | undefined, operation: Model3DOperation, signal?: AbortSignal) {
    await this.assertOperationAllowed(ref);
    const selected = await this.resolveOperationModel(ref, operation);
    if (!selected) throw new Model3DGenerationError("The selected 3D operation provider is unavailable", 503);
    return (await this.connection(selected, signal)).generator;
  }
  private async connection(model: Model3DModel, signal?: AbortSignal): Promise<{ generator: Connection; settings: CustomModel3DSettings }> {
    if (isMeshyModelReference(model)) this.disabled();
    if (isNative3DProvider(model.provider)) {
      const connection = this.options[model.provider];
      const settings = model.id === MODEL3D_CONNECTION_ID ? MODEL_3D_PRESETS[model.provider][0]!.settings
        : this.options.nativeModels(model.provider).find((definition) => definition.id === model.id)?.settings;
      if (settings && (settings.protocol === "meshy" || isMeshyEndpoint(settings.baseUrl))) this.disabled();
      if (!connection?.configured() || !settings) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
      return { generator: connection.generator, settings };
    }
    const provider = (await this.customProviders()).find((provider) => provider.id === model.provider);
    const settings = provider?.models.find((definition) => definition.id === model.id)?.usages?.["3d"];
    if (!provider || !settings) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
    const definition = provider.models.find(definition => definition.id === model.id)!;
    if (this.blockedDefinition(provider, definition)) this.disabled();
    const settingsSnapshot = structuredClone(settings);
    const providerSignature = JSON.stringify([provider.id, provider.preset, provider.baseUrl]);
    const source = await customMediaSource(await this.options.runtime(), provider, settingsSnapshot.baseUrl, signal);
    const current = (await this.customProviders()).find(item => item.id === model.provider), currentDefinition = current?.models.find(item => item.id === model.id);
    if (current && currentDefinition && this.blockedDefinition(current, currentDefinition)) { this.#customConnections.delete(JSON.stringify([provider.id, model.id])); this.disabled(); }
    if (!current || !currentDefinition || !isDeepStrictEqual(settingsSnapshot, currentDefinition.usages?.["3d"]) || JSON.stringify([current.id, current.preset, current.baseUrl]) !== providerSignature) throw new Model3DGenerationError("The selected 3D connection changed before dispatch", 409, true);
    if (settingsSnapshot.protocol === "meshy") this.disabled();
    const key = JSON.stringify([provider.id, model.id]), fingerprint = JSON.stringify([source, settingsSnapshot]);
    let cached = this.#customConnections.get(key);
    if (!cached || cached.fingerprint !== fingerprint) {
      const Provider = PROVIDERS[settingsSnapshot.protocol];
      cached = { fingerprint, generator: new Provider(() => source.apiKey, this.options.request ?? fetch, undefined,
        () => this.options.isEnabled(provider.id), { ...source, settings: settingsSnapshot }) };
      this.#customConnections.set(key, cached);
    }
    return { generator: cached.generator, settings: settingsSnapshot };
  }
  async animate(input: Model3DAnimationInput, signal?: AbortSignal) {
    const connection = await this.operationConnection(input.providerModel, "animate", signal);
    if (!("animate" in connection)) throw new Model3DGenerationError("This provider has no animation API", 400);
    return connection.animate(input, signal);
  }
  async animations(signal?: AbortSignal, model?: Model3DModelRef, options?: Model3DOptions) {
    const connection = await this.operationConnection(model, "animate", signal);
    if (!("animations" in connection)) throw new Model3DGenerationError("This provider has no animation library", 400);
    return connection.animations(signal, model, options);
  }
  async balance(model: Model3DModelRef, signal?: AbortSignal) {
    await this.assertReferenceAllowed(model);
    const selected = resolveModel3DConnection(model, await this.operationModels());
    if (!selected) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
    return (await this.connection(selected, signal)).generator.accountBalance(signal);
  }
}
