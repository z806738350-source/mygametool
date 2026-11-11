import { TEST_GLB } from "./model3d-fixture.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CustomProviderDetails, Model3DDefinition, Model3DModel } from "../src/shared/contracts.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { normalizeModel3DConfig, resolveModel3D } from "../src/shared/generation-config.js";
import { defaultModel3DSettings } from "../src/shared/custom-models.js";
import { ProviderModels3D } from "../src/daemon/provider-models3d.js";
import type { TripoProvider } from "../src/daemon/tripo-provider.js";
import type { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";

const directories: string[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(provider: "meshy" | "tripo" | "hyper3d", directory?: string) {
  directory ??= await mkdtemp(path.join(tmpdir(), "ohmygame-model3d-management-"));
  if (!directories.includes(directory)) directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://files.test/model.glb") return new Response(new Uint8Array(TEST_GLB));
    if (provider === "hyper3d") {
      if (String(url).endsWith("/rodin")) return Response.json({ uuid: "task", jobs: { subscription_key: "task-secret" } }, { status: 201 });
      if (String(url).endsWith("/status")) return Response.json({ jobs: [{ status: "Done" }] });
      return Response.json({ list: [{ name: "model.glb", url: "https://files.test/model.glb" }] });
    }
    if (provider === "meshy") return init?.method === "POST" ? Response.json({ result: "task" }) : Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.test/model.glb" } });
    if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: "file" } });
    return init?.method === "POST" ? Response.json({ code: 0, data: { task_id: "task" } }) : Response.json({ code: 0, data: { status: "success", output: { model_url: "https://files.test/model.glb" } } });
  });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, model3DFetch: request });
  apps.push(app);
  const root = `/settings/models/providers/${provider}/models`;
  return { app, directory, request, root };
}
async function generate(app: ReturnType<typeof createApp>, provider: string, id: string, options?: { texture?: boolean; pbr?: boolean }) {
  const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { model: { provider, id }, images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], ...options } });
  if (provider === "meshy") { expect(result.statusCode, result.body).toBe(410); expect(result.json().error).toBe(MESHY_DISABLED_MESSAGE); return { status: "failed", error: result.json().error }; }
  expect(result.statusCode, result.body).toBe(202);
  let job: { status: string; error?: string } | undefined;
  await vi.waitFor(async () => {
    job = (await app.inject("/tool-jobs")).json().find((job: { id: string }) => job.id === result.json().id);
    expect(job?.status).not.toBe("running");
  }, { timeout: 10_000 });
  return job!;
}

describe("native 3D model management", () => {
  it("adopts a newly bundled version without losing saved names, defaults, or visibility", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-preset-upgrade-")); directories.push(directory);
    const previous = { id: "meshy-6", name: "Saved Meshy 6", settings: { ...defaultModel3DSettings("standard", "meshy"),
      polycount: { ...defaultModel3DSettings("standard", "meshy").polycount, default: 1_200 }, defaults: { texture: false, pbr: false } } };
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: { meshy: [previous.id] },
      nativeModels3D: { meshy: [previous] }, defaultModel3D: { provider: "meshy", id: previous.id } }));
    const { app, root } = await fixture("meshy", directory);
    expect((await app.inject(root)).json().models).toEqual([]);
    expect((await app.inject("/model3d-models/catalog")).json().defaultModel).toBeUndefined();
    const saved = JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
    expect(saved.defaultModel3D).toEqual({ provider: "meshy", id: previous.id });
    expect(saved.nativeModels3D.meshy).toEqual([previous]);
    expect((await app.inject({ method: "PUT", url: `${root}/${previous.id}`, payload: previous })).statusCode).toBe(400);
  });
  it("accepts media model definitions without language-only token and reasoning fields", () => {
    const model = MODEL_3D_PRESETS.meshy[0]!;
    expect(normalizeCustomProviderModel({ id: model.id, name: model.name, usages: { "3d": model.settings } }, "openai-completions", "https://relay.test/v1")).toMatchObject({ usages: { "3d": model.settings }, reasoning: false, supportsImages: false });
  });
  it.each(["meshy", "tripo", "hyper3d"] as const)("preserves saved %s model metadata while refusing execution through retired independent credentials", async (provider) => {
    const definition: Model3DDefinition = { ...MODEL_3D_PRESETS[provider][0]!, id: "future-version", name: "My game assets",
      settings: { ...MODEL_3D_PRESETS[provider][0]!.settings, polycount: { min: 500, max: 5_000, default: 1_200, presets: [1_200, 5_000] }, defaults: { texture: false, pbr: false } } };
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-legacy-3d-"));
    await writeFile(path.join(directory, `${provider}.json`), JSON.stringify({ version: 1, apiKey: "native-test-key" }));
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, nativeModels3D: { [provider]: [definition] }, defaultModel3D: { provider, id: definition.id } }));
    const { app, request, root } = await fixture(provider, directory);
    expect((await app.inject(root)).json()).toMatchObject({ canAddCustomModel: false, ...(provider === "meshy" ? {} : { model3DProtocol: provider }) });
    expect((await app.inject({ method: "POST", url: `${root}/custom`, payload: { ...definition, id: "another" } })).statusCode).toBe(400);
    const selectedDefault = await app.inject({ method: "PUT", url: "/model3d-models/default", payload: { provider, id: definition.id } });
    expect(selectedDefault.statusCode, selectedDefault.body).toBe(400);
    expect(selectedDefault.json()).toEqual({ error: "Media model is not available" });
    // Legacy model metadata remains editable, but its independent vendor key cannot authorize Kunpo requests.
    expect(await generate(app, provider, definition.id)).toMatchObject({ status: "failed" });
    expect(await generate(app, provider, MODEL_3D_PRESETS[provider][0]!.id)).toMatchObject({ status: "failed" });
    expect(request).not.toHaveBeenCalled();
    const sdkConfig = await readFile(path.join(directory, "models.json"), "utf8").catch(() => "");
    expect(sdkConfig).not.toContain(definition.id);
    await app.inject({ method: "PUT", url: `${root}/visibility`, payload: { ids: [definition.id], visible: false } });
    request.mockClear();
    expect((await app.inject("/model3d-models/catalog")).json().models.some((model: Model3DModel) => model.id === definition.id)).toBe(false);
    expect(await generate(app, provider, definition.id)).toMatchObject({ status: "failed" });
    expect(request).not.toHaveBeenCalled();
    await app.close();
    const restored = await fixture(provider, directory);
    const settings = (await restored.app.inject(root)).json();
    if (provider === "meshy") {
      expect(settings.models).toEqual([]);
      expect(JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8")).nativeModels3D.meshy).toContainEqual(definition);
    } else expect(settings.models).toContainEqual(expect.objectContaining({ id: definition.id, name: definition.name, visible: false, model3d: definition }));
    expect((await restored.app.inject("/model3d-models/catalog")).json().defaultModel).toEqual(provider === "meshy" ? undefined : { provider, id: definition.id });
    expect((await restored.app.inject({ method: "DELETE", url: `${root}/custom/${definition.id}` })).statusCode).toBe(200);
    expect((await restored.app.inject(root)).json().models).toHaveLength(provider === "meshy" ? 0 : MODEL_3D_PRESETS[provider].length);
  }, 15_000);

  it("edits and restores official defaults, while enforcing official capabilities and the native connection", async () => {
    const { app, root } = await fixture("tripo");
    const original = MODEL_3D_PRESETS.tripo[0]!;
    const modified = { ...original, name: "Low-poly props", settings: { ...original.settings, polycount: { ...original.settings.polycount, default: 6_000 }, defaults: { texture: false, pbr: false } } };
    expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: modified })).statusCode).toBe(200);
    const edited = (await app.inject(root)).json().models.find((model: { id: string }) => model.id === original.id);
    expect(edited).toMatchObject({ source: "preset", custom: false, model3d: modified });
    for (const settings of [{ ...modified.settings, maxReferenceImages: 99 }, { ...modified.settings, baseUrl: "https://other.test" }, { ...modified.settings, polycount: { ...modified.settings.polycount, max: 3_000_000 } }]) {
      expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: { ...modified, settings } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: { ...modified, id: "different" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${root}/custom/${original.id}` })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: `${root}/visibility`, payload: { ids: [original.id], visible: false } });
    expect((await app.inject({ method: "DELETE", url: `${root}/${original.id}/overrides` })).statusCode).toBe(200);
    expect((await app.inject(root)).json().models.find((model: { id: string }) => model.id === original.id)).toMatchObject({ visible: false, model3d: original });
  });

  it("removes saved native model definitions when deleting a connection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-old-3d-custom-"));
    const model = { ...MODEL_3D_PRESETS.tripo[0]!, id: "my-version", name: "My version" };
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, nativeModels3D: { tripo: [model] } }));
    const { app, root } = await fixture("tripo", directory);
    expect((await app.inject(root)).json().models).toContainEqual(expect.objectContaining({ id: model.id }));
    await app.inject({ method: "DELETE", url: "/settings/models/providers/tripo" });
    expect((await app.inject(root)).json()).toMatchObject({ canAddCustomModel: false, models: MODEL_3D_PRESETS.tripo.map((model) => expect.objectContaining({ id: model.id, model3d: model })) });
  });

  it("uses runtime limits and defaults when Canvas normalizes a configured model", () => {
    const model: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "model", name: "Model", maxReferenceImages: 1,
      polycount: { min: 200, max: 2_000, default: 800, presets: [800] }, supportsTexture: true, supportsPbr: false, defaults: { texture: false, pbr: false } };
    expect(normalizeModel3DConfig({ model, targetPolycount: 4_000, pbr: true }, model)).toMatchObject({ targetPolycount: 800, texture: false, pbr: false });
    expect(resolveModel3D(undefined, [model])).toBe(model);
    expect(resolveModel3D(undefined, [])).toBeUndefined();
  });

  it.each(["meshy", "tripo", "hyper3d"] as const)("rejects an arbitrary remote %s endpoint under the Kunpo-only policy before any request", async (protocol) => {
    const { app, request } = await fixture(protocol);
    const model = { ...MODEL_3D_PRESETS[protocol][0]!, id: "studio-alias",
      settings: { ...MODEL_3D_PRESETS[protocol][0]!.settings, supportsPbr: false } };
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: {
      name: "Studio", preset: protocol, baseUrl: "https://studio.test/v1", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2,
      models: [{ id: model.id, name: model.name, usages: { "3d": model.settings } }],
    } });
    // This is an endpoint-policy test, not a live texture-generation contract test.
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.json().error).toMatch(protocol === "meshy" ? /Meshy is disabled/i : /endpoint/i);
    expect(request).not.toHaveBeenCalled();
  }, 15_000);
});

describe("disabled Meshy central routing", () => {
  function custom(): CustomProviderDetails {
    return { id: "studio", name: "Studio", baseUrl: "http://127.0.0.1:43199/v1", api: "openai-completions", authentication: "api_key", modelConfigurationVersion: 2, hiddenModelIds: [],
      models: [{ id: "geometry", name: "Geometry", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false,
        usages: { "3d": { ...MODEL_3D_PRESETS.meshy[0]!.settings, operations: ["text", "animate", "retexture", "remesh"] } } }] };
  }
  function central(providers: CustomProviderDetails[] = [], defaultModel?: { provider: string; id: string }) {
    const getAuth = vi.fn(async () => ({ auth: { apiKey: "fixture-only" } })), hasConfiguredAuth = vi.fn(() => true), runtime = vi.fn(async () => ({ getAuth, hasConfiguredAuth }) as unknown as ModelRuntime);
    const native = { generate: vi.fn(async () => ({ bytes: TEST_GLB, mediaType: "model/gltf-binary" as const })), animate: vi.fn(), animations: vi.fn(async () => []), accountBalance: vi.fn() };
    const meshyConfigured = vi.fn(() => true), request = vi.fn<typeof fetch>();
    const models = new ProviderModels3D({ runtime, request, customProviders: async () => providers, defaultModel: () => defaultModel,
      isEnabled: () => true, isVisible: () => true, nativeModels: provider => [...MODEL_3D_PRESETS[provider]],
      meshy: { generator: native as unknown as MeshyProvider, configured: meshyConfigured }, tripo: { generator: native as unknown as TripoProvider, configured: () => true } });
    return { models, native, meshyConfigured, getAuth, hasConfiguredAuth, runtime, request };
  }
  it("omits native Meshy without consulting its credentials and rejects every operation before dispatch", async () => {
    const f = central([], { provider: "meshy", id: "meshy-6" }), ref = { provider: "meshy", id: "meshy-6" };
    expect((await f.models.catalog()).models.every(model => model.provider !== "meshy")).toBe(true);
    expect((await f.models.catalog()).defaultModel).toBeUndefined();
    expect((await f.models.operationModels()).every(model => model.provider !== "meshy")).toBe(true);
    expect(await f.models.resolveModel(ref)).toBeUndefined();
    expect(await f.models.resolveOperationModel(ref, "animate")).toBeUndefined();
    expect(await f.models.resolveOperationModel(undefined, "animate")).toBeUndefined();
    for (const operation of [undefined, "text", "image", "retexture", "remesh"] as const) await expect(f.models.generate({ model: ref, images: [], operation, execution: { recoveryOnly: true, submitted: vi.fn() } })).rejects.toMatchObject({ statusCode: 410, notSubmitted: true });
    await expect(f.models.animate({ model: TEST_GLB, actionIds: [], providerModel: ref })).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    await expect(f.models.animations()).rejects.toMatchObject({ statusCode: 410 });
    await expect(f.models.balance(ref)).rejects.toMatchObject({ statusCode: 410 });
    expect(f.meshyConfigured).not.toHaveBeenCalled(); expect(f.runtime).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
  });
  it.each(["protocol", "preset", "provider-endpoint", "usage-endpoint", "model-id"] as const)("blocks arbitrary aliases by %s before auth including saved defaults", async kind => {
    const provider = custom();
    if (kind !== "protocol") provider.models[0]!.usages!["3d"] = { ...MODEL_3D_PRESETS.tripo[0]!.settings, operations: ["animate"] };
    if (kind === "preset") provider.preset = "meshy";
    if (kind === "provider-endpoint") provider.baseUrl = "https://api.meshy.ai/openapi";
    if (kind === "usage-endpoint") provider.models[0]!.usages!["3d"]!.baseUrl = "https://api.meshy.ai/openapi";
    if (kind === "model-id") provider.models[0]!.id = "meshy-6";
    const ref = { provider: provider.id, id: provider.models[0]!.id }, f = central([provider], ref);
    await expect(f.models.assertGenerationAllowed()).rejects.toMatchObject({ statusCode: 410 });
    await expect(f.models.assertOperationAllowed()).rejects.toMatchObject({ statusCode: 410 });
    expect((await f.models.catalog()).models.some(model => model.provider === provider.id)).toBe(false);
    expect((await f.models.catalog()).defaultModel).toBeUndefined();
    expect(await f.models.resolveModel(ref)).toBeUndefined(); expect(await f.models.resolveOperationModel(ref, "animate")).toBeUndefined();
    await expect(f.models.generate({ model: ref, images: [] })).rejects.toMatchObject({ statusCode: 410 });
    await expect(f.models.animations(undefined, ref)).rejects.toMatchObject({ statusCode: 410 });
    await expect(f.models.balance(ref)).rejects.toMatchObject({ statusCode: 410 });
    expect(f.getAuth).not.toHaveBeenCalled(); expect(f.hasConfiguredAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps Tripo and rejects a cached custom connection when its protocol changes to Meshy", async () => {
    const provider = custom(); provider.models[0]!.usages!["3d"] = { ...MODEL_3D_PRESETS.tripo[0]!.settings, operations: ["animate"] };
    const ref = { provider: provider.id, id: provider.models[0]!.id }, f = central([provider]);
    expect((await f.models.catalog()).models).toContainEqual(expect.objectContaining({ provider: "tripo", protocol: "tripo" }));
    expect(await f.models.animations(undefined, ref)).not.toHaveLength(0);
    const authCount = f.getAuth.mock.calls.length;
    provider.models[0]!.usages!["3d"]!.protocol = "meshy";
    await expect(f.models.animations(undefined, ref)).rejects.toMatchObject({ statusCode: 410 });
    expect(f.getAuth).toHaveBeenCalledTimes(authCount); expect(f.request).not.toHaveBeenCalled();
    await f.models.generate({ model: { provider: "tripo", id: MODEL_3D_PRESETS.tripo[0]!.id }, images: [] });
    expect(f.native.generate).toHaveBeenCalledOnce();
  });
  it("rechecks fresh custom policy after an in-flight credential lookup", async () => {
    const provider = custom(); provider.models[0]!.usages!["3d"] = { ...MODEL_3D_PRESETS.tripo[0]!.settings, operations: ["animate"] };
    const ref = { provider: provider.id, id: provider.models[0]!.id }, f = central([provider]);
    let resolveAuth!: (value: { auth: { apiKey: string } }) => void;
    f.getAuth.mockImplementationOnce(() => new Promise(resolve => { resolveAuth = resolve; }));
    const pending = f.models.animations(undefined, ref);
    await vi.waitFor(() => expect(f.getAuth).toHaveBeenCalledOnce());
    provider.models[0]!.usages!["3d"]!.protocol = "meshy"; resolveAuth({ auth: { apiKey: "fixture-only" } });
    await expect(pending).rejects.toMatchObject({ statusCode: 410 }); expect(f.request).not.toHaveBeenCalled();
  });
});
