import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { normalizeCustomProviderModel, ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { MODEL_CATALOG_REFRESH_ERROR, ModelCatalogRefresh } from "../src/daemon/model-catalog-refresh.js";
import { createLocalModelRuntime } from "../src/daemon/local-model-runtime.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ConversationManager } from "../src/daemon/conversations.js";
import { defaultModel3DSettings } from "../src/shared/custom-models.js";

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Pi catalog refresh", () => {
  async function catalogFixture(providerId = "openai") {
    const { directory } = await fixture();
    await writeFile(path.join(directory, "auth.json"), JSON.stringify({ [providerId]: { type: "api_key", key: "fixture-key" } }));
    const request = vi.fn(async () => {});
    const createRuntime = async () => {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), allowModelNetwork: false });
      const provider = runtime.getProvider(providerId)!;
      const baseline = runtime.getModels(providerId)[0]!;
      let models = [baseline];
      runtime.registerNativeProvider({ ...provider,
        getModels: () => models,
        getAllModels: () => models,
        refreshModels: async (context) => {
          if (!context.allowNetwork) { models = context.stored?.models as typeof models ?? [baseline]; return; }
          await request();
          const remote = [...models.filter((model) => model.id !== "catalog-new"), { ...baseline, id: "catalog-new", name: "New remote model" }];
          await context.publish({ persist: { models: remote, checkedAt: Date.now() }, update: () => { models = remote; } });
        },
      });
      await runtime.refresh({ allowNetwork: false });
      return runtime;
    };
    const runtime = await createRuntime();
    vi.stubEnv("PI_OFFLINE", undefined);
    return { directory, runtime, request, createRuntime };
  }

  it("serves local models and preserves local choices across restart without a background catalog request", async () => {
    const { directory, runtime, request, createRuntime } = await catalogFixture();
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const first = await app.inject({ method: "GET", url: "/models" });
    expect(first.statusCode).toBe(200);
    expect(first.json().loadingProviders).toBeUndefined();
    expect(first.json().models.some((model: { id: string }) => model.id === "catalog-new")).toBe(false);
    const choice = first.json().models.find((item: { provider: string }) => item.provider === "openai");
    expect(choice).toBeDefined();
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model: { provider: "openai", id: choice.id }, reasoningLevel: choice.reasoningLevels[0] } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: { ...model, id: "user-model" } })).statusCode).toBe(201);
    const hidden = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: ["user-model"], visible: false } });
    expect(hidden.statusCode).toBe(200);
    const forced = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" });
    expect(forced.statusCode, forced.body).toBe(400);
    expect(runtime.getModel("openai", "user-model")).toMatchObject({ id: "user-model", contextWindow: model.contextWindow });
    expect((await app.inject({ method: "GET", url: "/models" })).json().defaultModel).toEqual({ provider: "openai", id: choice.id });
    const restored = await createRuntime();
    expect(restored.getModel("openai", "user-model")).toMatchObject({ id: "user-model", contextWindow: model.contextWindow });
    expect(restored.getModel("openai", "catalog-new")).toBeUndefined();
    const restarted = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => restored });
    apps.push(restarted);
    const providerModels = await restarted.inject({ method: "GET", url: "/settings/models/providers/openai/models" });
    expect(providerModels.statusCode).toBe(200);
    expect(providerModels.json().models).toContainEqual(expect.objectContaining({ id: "user-model", visible: false }));
    expect((await restarted.inject({ method: "GET", url: "/models" })).json().defaultModel).toEqual({ provider: "openai", id: choice.id });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses explicit SDK refresh without invoking or exposing the provider callback", async () => {
    const { directory, runtime, request } = await catalogFixture();
    request.mockRejectedValue(new Error("private-provider-token"));
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const initial = (await app.inject({ method: "GET", url: "/models" })).json();
    const failed = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("private-provider-token");
    const cached = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(cached.models).toEqual(initial.models);
    expect(runtime.getModel("openai", "catalog-new")).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not let elapsed cache time, saved credentials or an unset offline variable restore catalog networking", async () => {
    const { runtime, createRuntime } = await catalogFixture();
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    vi.stubEnv("PI_OFFLINE", undefined);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await new ModelCatalogRefresh(() => true).refresh(runtime, "openai");
    clock.mockReturnValue(now + 24 * 60 * 60_000);
    const restarted = await createRuntime();
    const refresh = new ModelCatalogRefresh(() => true);
    await refresh.refresh(restarted, "openai");
    expect(refresh.canRefresh(restarted, "openai")).toBe(false);
    expect(refresh.schedule(restarted)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects simultaneous forced refreshes without starting an automatic or manual SDK refresh", async () => {
    const { runtime, request } = await catalogFixture();
    const calls = vi.spyOn(runtime, "refresh");
    const refresh = new ModelCatalogRefresh(() => true);
    await expect(refresh.refresh(runtime, "openai")).resolves.toBeUndefined();
    const results = await Promise.allSettled([refresh.refresh(runtime, "openai", true), refresh.refresh(runtime, "openai", true)]);
    expect(results).toEqual([
      { status: "rejected", reason: new Error(MODEL_CATALOG_REFRESH_ERROR) },
      { status: "rejected", reason: new Error(MODEL_CATALOG_REFRESH_ERROR) },
    ]);
    expect(refresh.refreshing("openai")).toBe(false);
    expect(calls).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps account invalidation, offline toggles and shutdown from enabling remote catalogs", async () => {
    const { runtime, request } = await catalogFixture("openrouter");
    let enabled = true;
    const refresh = new ModelCatalogRefresh(() => enabled);
    await refresh.refresh(runtime, "openrouter");
    refresh.invalidate("openrouter");
    await refresh.refresh(runtime, "openrouter");
    enabled = false;
    expect(refresh.canRefresh(runtime, "openrouter")).toBe(false);
    enabled = true;
    vi.stubEnv("PI_OFFLINE", "1");
    expect(refresh.schedule(runtime)).toEqual([]);
    vi.stubEnv("PI_OFFLINE", undefined);
    expect(refresh.canRefresh(runtime, "openrouter")).toBe(false);
    await expect(refresh.refresh(runtime, "openrouter", true)).rejects.toThrow(MODEL_CATALOG_REFRESH_ERROR);
    refresh.close();
    expect(refresh.schedule(runtime)).toEqual([]);
    expect(refresh.refreshing("openrouter")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-provider-models-"));
  directories.push(directory);
  return { directory, store: new ProviderModelSettingsStore(directory, directory) };
}

const model = { id: "custom/test", name: "Custom test", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: true, supportsImages: true };

describe("provider model settings", () => {
  it("preserves legacy Meshy settings while refusing new activation and runtime models", async () => {
    const { directory, store } = await fixture();
    const preferences = JSON.stringify({ version: 1, hidden: {}, customProviders: { old: { authentication: "none", preset: "meshy" } }, defaultModel3D: { provider: "meshy", id: "meshy-t2" } });
    const models = JSON.stringify({ providers: { old: { name: "Old", api: "openai-completions", baseUrl: "https://llm.ziy.cc/v1", models: [] }, kunpo: { api: "openai-completions", baseUrl: "https://llm.ziy.cc/v1", models: [{ id: "meshy-7.1", name: "Old", contextWindow: 32000, maxTokens: 4000, reasoning: false, input: ["text"] }, { id: "good", name: "Good", contextWindow: 32000, maxTokens: 4000, reasoning: false, input: ["text"] }] } } });
    await writeFile(path.join(directory, "model-visibility.json"), preferences);
    await writeFile(path.join(directory, "models.json"), models);
    await store.load();
    expect(store.isEnabled("old")).toBe(false);
    expect((await store.customProvider("old"))?.preset).toBe("meshy");
    await expect(store.setEnabled("old", true)).rejects.toThrow("Meshy is disabled");
    await expect(store.setEnabled("meshy", true)).rejects.toThrow("Meshy is disabled");
    await expect(store.setDefaultMediaModel("3d", { provider: "meshy", id: "meshy-t2" })).rejects.toThrow("Meshy is disabled");
    await expect(store.addCustomModel("kunpo", { ...model, id: "meshy-7.1" })).rejects.toThrow("Meshy is disabled");
    const configured = await store.localRuntimeProviders();
    expect(configured.some(item => item.id === "old")).toBe(false);
    expect(configured.find(item => item.id === "kunpo")?.config.models?.map(item => item.id)).toEqual(["good"]);
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe(models);
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).toBe(preferences);
  });

  it("preserves a mixed provider's old Meshy 3D usage without blocking its language model", async () => {
    const { directory, store } = await fixture();
    const settings = { name: "Mixed", api: "openai-completions", baseUrl: "https://llm.ziy.cc/v1", authentication: "none" as const, modelConfigurationVersion: 2 as const,
      models: [{ ...model, id: "ordinary", usages: { language: true, "3d": { ...defaultModel3DSettings("standard", "meshy"), baseUrl: "https://api.meshy.ai/openapi/v1" } } }] };
    const preferences = JSON.stringify({ version: 1, hidden: {}, customProviders: { mixed: { authentication: "none", modelConfigurationVersion: 2, models: settings.models } } });
    await writeFile(path.join(directory, "model-visibility.json"), preferences);
    await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { mixed: { ...settings, models: [{ ...model, id: "ordinary", input: ["text"] }] } } }));
    await store.load();
    expect(store.isEnabled("mixed")).toBe(true);
    expect((await store.customProvider("mixed"))?.models[0]?.usages?.["3d"]?.baseUrl).toBe("https://api.meshy.ai/openapi/v1");
    expect((await store.localRuntimeProviders()).find(item => item.id === "mixed")?.config.models?.map(item => item.id)).toEqual(["ordinary"]);
    await expect(store.setDefaultMediaModel("3d", { provider: "mixed", id: "ordinary" })).rejects.toThrow("Meshy is disabled");
    await expect(store.setDefaultMediaModel("image", { provider: "mixed", id: "ordinary" })).resolves.toBeUndefined();
    await expect(store.saveCustomProvider("mixed", settings, async () => {})).resolves.toBeUndefined();
    await expect(store.saveCustomProvider("mixed", { ...settings, models: [{ ...settings.models[0]!, usages: { language: true, "3d": { ...settings.models[0]!.usages["3d"], maxReferenceImages: 2 } } }] }, async () => {})).rejects.toThrow("Meshy is disabled");
  });
  it("exposes the reviewed Kunpo catalog without a key or rewriting configuration", async () => {
    const { directory, store } = await fixture();
    await store.load();
    expect(store.isBuiltIn("kunpo")).toBe(true);
    expect((await store.customProviderCatalog()).find((provider) => provider.id === "kunpo")?.models.map((model) => model.id)).toContain("gpt-5.6-sol");
    const providers = await store.localRuntimeProviders();
    expect(providers.find((provider) => provider.id === "kunpo")?.config.models?.map((model) => model.id)).toEqual(["gpt-5.6-sol", "claude-opus-5-5", "gpt-6.1-sol"]);
    await expect(readFile(path.join(directory, "models.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.removeProviderSettings("kunpo", async () => {})).rejects.toThrow("built in");
  });

  it("does not replace pre-existing explicit Kunpo runtime model metadata", async () => {
    const { directory, store } = await fixture();
    const text = JSON.stringify({ providers: { kunpo: { api: "openai-completions", baseUrl: "https://llm.ziy.cc/v1", models: [{
      id: "explicit-existing", name: "Existing", contextWindow: 64_000, maxTokens: 4_000, reasoning: false, input: ["text"],
    }] } } });
    await writeFile(path.join(directory, "models.json"), text);
    const configured = (await store.localRuntimeProviders()).filter((provider) => provider.id === "kunpo");
    expect(configured).toHaveLength(1);
    expect(configured[0]!.config.models?.map((model) => model.id)).toEqual(["explicit-existing"]);
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe(text);
  });

  it("refuses pending Kunpo Agents from legacy models.json and persisted conversations", async () => {
    const { directory, store } = await fixture();
    const pending = { provider: "kunpo", id: "gemini-3.8-flash" };
    await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { kunpo: {
      api: "openai-completions", baseUrl: "https://llm.ziy.cc/v1", models: [{ id: pending.id, name: pending.id, contextWindow: 128_000, maxTokens: 4_000, reasoning: false, input: ["text", "image"] }],
    } } }));
    const runtime = await createLocalModelRuntime(path.join(directory, "local-api-keys.json"), () => store.localRuntimeProviders());
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_PENDING_GATE_TEST_ONLY", notify: () => {} });
    expect((await runtime.getAvailable("kunpo")).map((model) => model.id)).toContain(pending.id);
    const projects = new ProjectManager(directory);
    const project = await projects.create("Legacy pending Agent", "asset-canvas");
    const conversations = new ConversationManager();
    const conversation = await conversations.create(project, pending);
    conversations.open(project, conversation).appendMessage({ role: "user", content: "Earlier fixture message", timestamp: 1 });
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, generateProjectName: async () => undefined });
    apps.push(app);
    const explicit = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model: pending } });
    expect(explicit.statusCode, explicit.body).toBe(201);
    for (const id of [conversation.summary.id, explicit.json().id]) {
      const turn = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${id}/turns`, payload: { prompt: "Continue this fixture" } });
      expect(turn.statusCode, turn.body).toBe(202);
      await vi.waitFor(async () => {
        const detail = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${id}` })).json();
        expect(detail.agent).toMatchObject({ status: "error", error: expect.stringContaining("not integrated") });
        expect(detail.settings.model).toEqual(pending);
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("isolates inherited provider credentials while allowing explicit test credentials", async () => {
    const { directory } = await fixture();
    // A fresh process exercises the setup with inherited credentials before Pi
    // creates its availability snapshot, without changing this worker's environment.
    const script = `
      import assert from "node:assert/strict";
      import { ModelRuntime } from "@earendil-works/pi-coding-agent";
      const options = {
        authPath: ${JSON.stringify(path.join(directory, "auth.json"))},
        modelsPath: ${JSON.stringify(path.join(directory, "models.json"))},
        allowModelNetwork: false,
      };
      const inherited = await ModelRuntime.create(options);
      assert.equal(inherited.hasConfiguredAuth("anthropic"), true);
      await import("./test/provider-environment.ts");
      const isolated = await ModelRuntime.create(options);
      assert.deepEqual(await isolated.getAvailable(), []);
      await isolated.setRuntimeApiKey("anthropic", "fixture-key");
      assert.equal(isolated.hasConfiguredAuth("anthropic"), true);
      console.log("provider-environment-ok");
    `;
    const { stdout } = await promisify(execFile)(
      "node",
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GEMINI_API_KEY: "fixture-key",
          OPENAI_API_KEY: "fixture-key",
          HF_TOKEN: "fixture-token",
          COPILOT_GITHUB_TOKEN: "fixture-token",
          AWS_PROFILE: "fixture-profile",
          ANTHROPIC_FEDERATION_RULE_ID: "fixture-rule",
          ANTHROPIC_ORGANIZATION_ID: "fixture-org",
          ANTHROPIC_IDENTITY_TOKEN_FILE: path.join(directory, "identity-token"),
          ANTHROPIC_SERVICE_ACCOUNT_ID: "fixture-account",
          ANTHROPIC_WORKSPACE_ID: "fixture-workspace",
        },
        timeout: 15_000,
      },
    );
    expect(stdout.trim()).toBe("provider-environment-ok");
  });

  it("persists visibility per provider and serializes simultaneous updates", async () => {
    const { directory, store } = await fixture();
    await store.load();
    await Promise.all([store.setVisibility("openai", ["first"], false), store.setVisibility("openai", ["second"], false)]);
    const restored = new ProviderModelSettingsStore(directory, directory);
    await restored.load();
    expect(restored.isVisible({ provider: "openai", id: "first" })).toBe(false);
    expect(restored.isVisible({ provider: "openai", id: "second" })).toBe(false);
    expect(restored.isVisible({ provider: "other", id: "first" })).toBe(true);
    expect(restored.isVisible({ provider: "constructor", id: "first" })).toBe(true);
    await restored.setVisibility("openai", ["first"], true);
    expect(restored.isVisible({ provider: "openai", id: "first" })).toBe(true);
  });

  it("preserves JSONC comments, provider keys, overrides and unrelated models", async () => {
    const { directory, store } = await fixture();
    const modelsPath = path.join(directory, "models.json");
    await writeFile(modelsPath, '{\n  // Keep this comment\n  "providers": { "openai": { "apiKey": "KEY_ENV", "modelOverrides": { "existing": { "name": "Alias" } } }, "other": { "baseUrl": "https://other.example/v1" } }\n}\n');
    await store.addCustomModel("openai", model);
    expect((await readFile(modelsPath, "utf8"))).toContain("// Keep this comment");
    expect((await store.customModels("openai"))[0]).toMatchObject({ id: model.id, input: ["text", "image"], reasoning: true });
    await expect(store.addCustomModel("openai", model)).rejects.toThrow("already exists");
    await store.removeCustomModel("openai", model.id);
    const contents = await readFile(modelsPath, "utf8");
    expect(contents).toContain('"apiKey": "KEY_ENV"');
    expect(contents).toContain('"Alias"');
    expect(contents).toContain("https://other.example/v1");
    expect(await store.customModels("openai")).toEqual([]);
  });

  it("rejects broken config without replacing it", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "models.json"), "{broken");
    await expect(store.addCustomModel("openai", model)).rejects.toThrow("Invalid models.json");
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe("{broken");
  });

  it("validates token limits and endpoints and keeps the provider endpoint inherited", () => {
    expect(normalizeCustomProviderModel(model, "openai-completions", "https://api.openai.com/v1")).not.toHaveProperty("baseUrl");
    for (const patch of [{ maxTokens: 0 }, { contextWindow: 1.5 }, { maxTokens: 40_000 }, { baseUrl: "file:///tmp/model" }, { baseUrl: "https://user:secret@example.com" }, { api: "unsupported" }, { id: " " }, { thinkingLevelMap: null }, { thinkingLevelMap: { unknown: "high" } }, { thinkingLevelMap: { high: true } }]) expect(() => normalizeCustomProviderModel({ ...model, ...patch }, "openai-completions", "https://api.openai.com/v1")).toThrow();
  });

  it("adds and removes models in the real Pi runtime and filters the selector after restart", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { directory } = await fixture();
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const disconnected = await app.inject({ method: "GET", url: "/settings/models/providers/openai/models" });
    expect(disconnected.json().canAddCustomModel).toBe(false);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model })).statusCode).toBe(400);
    await runtime.setRuntimeApiKey("openai", "test-key");
    const added = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model });
    expect(added.statusCode, added.body).toBe(201);
    expect(runtime.getModel("openai", model.id)).toMatchObject({ id: model.id, reasoning: true, contextWindow: 32_000 });
    expect(added.json().models).toContainEqual(expect.objectContaining({ id: model.id, custom: true, visible: true }));
    const duplicate = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model });
    expect(duplicate.statusCode).toBe(409);
    const hidden = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: [model.id], visible: false } });
    expect(hidden.statusCode).toBe(200);
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(catalog.models.some((item: { id: string }) => item.id === model.id)).toBe(false);
    expect(catalog.hiddenModels).toContainEqual(expect.objectContaining({ id: model.id }));
    const invalid = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: ["unknown"], visible: true } });
    expect(invalid.statusCode).toBe(400);
    const restored = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(restored);
    expect((await restored.inject({ method: "GET", url: "/models" })).json().hiddenModels).toContainEqual(expect.objectContaining({ id: model.id }));
    const deleted = await app.inject({ method: "DELETE", url: `/settings/models/providers/openai/models/custom/${encodeURIComponent(model.id)}` });
    expect(deleted.statusCode).toBe(200);
    expect(runtime.getModel("openai", model.id)).toBeUndefined();
  });
});
