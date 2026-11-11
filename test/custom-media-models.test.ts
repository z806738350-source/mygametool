import { TEST_GLB } from "./model3d-fixture.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { defaultImageSettings, defaultModel3DSettings, defaultVideoSettings } from "../src/shared/custom-models.js";
import type { CustomProviderModel, SaveCustomProviderRequest, ToolId } from "../src/shared/contracts.js";
import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import { KUNPO_DEFAULT_MODEL_REFS } from "../src/shared/kunpo-models.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const connection = { name: "My studio", baseUrl: "http://127.0.0.1:43199/v1", api: "openai-completions", authentication: "api_key" as const, apiKey: "studio-test-key" };
// All compatible-provider success paths use explicit loopback transport mocks.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
const reference = { mediaType: "image/png", data: png.toString("base64") };
const model = (id: string, usages: CustomProviderModel["usages"]): CustomProviderModel => ({
  id, name: id, api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false, usages,
});
async function fixture(request: typeof fetch = vi.fn(async () => Response.json({ data: [] }))) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-custom-media-"));
  directories.push(directory);
  // This suite exercises only its simulated HTTP providers, regardless of local CLI logins.
  await writeFile(path.join(directory, "agent-runtimes.json"), JSON.stringify({ runtimes: { "codex-cli": { binaryPath: path.join(directory, "missing-codex") } } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime,
    imageFetch: request, videoFetch: request, model3DFetch: request, modelDiscoveryFetch: request });
  apps.push(app);
  const save = async (models: CustomProviderModel[], overrides: Partial<SaveCustomProviderRequest> = {}) => {
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, modelConfigurationVersion: 2, models, ...overrides } });
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { id: string };
  };
  return { app, runtime, directory, save };
}
async function generate(app: ReturnType<typeof createApp>, tool: ToolId, payload: Record<string, unknown>) {
  const result = await app.inject({ method: "POST", url: `/tools/${tool}/jobs`, payload });
  expect(result.statusCode, result.body).toBe(202);
  await vi.waitFor(async () => {
    const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
    const job = jobs.find((job: { id: string }) => job.id === result.json().id);
    expect(job?.status, job?.error).toBe("succeeded");
  });
}

describe("unified custom media models", () => {
  it.each([
    ["image", "https://images.test/v1"], ["video", "https://videos.test/api"],
    ["3d", "https://api.meshy.ai/openapi/v1"], ["video", "https://ohmygame.ai/v1"],
  ] as const)("rejects an unreviewed %s override %s before discovery or generation", async (usage, baseUrl) => {
    const request = vi.fn<typeof fetch>();
    const { app } = await fixture(request);
    const settings = usage === "image" ? { image: { ...defaultImageSettings(), baseUrl } }
      : usage === "video" ? { video: { ...defaultVideoSettings(), baseUrl } } : { "3d": { ...defaultModel3DSettings(), baseUrl } };
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: {
      ...connection, modelConfigurationVersion: 2, models: [model("blocked-model", settings)],
    } });
    expect(result.statusCode, result.body).toBe(400);
    expect(result.body).not.toContain(connection.apiKey);
    expect(request).not.toHaveBeenCalled();
  });

  it("saves a GPT Image default and sends all 16 references through the generation route", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const { app, save } = await fixture(request);
    const { id } = await save([model("gpt-image-2", { image: defaultImageSettings("openai-images", "gpt-image-2") })]);
    const images = Array.from({ length: 16 }, () => reference);
    const payload = { prompt: "Compose references", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: id, id: "gpt-image-2" }, images };
    await generate(app, "generate-image", payload);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(`${connection.baseUrl}/images/edits`);
    expect((request.mock.calls[0]?.[1]?.body as FormData).getAll("image[]")).toHaveLength(16);
    const rejected = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { ...payload, images: [...images, reference] } });
    expect(rejected.statusCode).toBe(400);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps saved single-image overrides and rejects extra references before contacting the endpoint", async () => {
    const request = vi.fn<typeof fetch>();
    const { app, save } = await fixture(request);
    const { id } = await save([model("gpt-image-2", { image: { ...defaultImageSettings("openai-images", "gpt-image-2"), maxReferenceImages: 1 } })]);
    const catalog = (await app.inject({ method: "GET", url: "/image-models/catalog" })).json();
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-image-2", maxReferenceImages: 1 }));
    const created = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: {
      prompt: "Compose references", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: id, id: "gpt-image-2" }, images: [reference, reference],
    } });
    expect(created.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.find((job: { id: string }) => job.id === created.json().id)).toMatchObject({ status: "failed", error: "The selected image model supports up to 1 reference images" });
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("persists every use, exposes only language models to the SDK, and honours visibility and defaults after restart", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("No model discovery should be needed"); });
    const { app, runtime, directory, save } = await fixture(request);
    const { id } = await save([
      model("same-model", { language: true, image: defaultImageSettings() }),
      model("my-video-alias", { video: defaultVideoSettings() }),
      model("my-mesh-alias", { "3d": defaultModel3DSettings() }),
      model("unassigned", {}),
    ], { hiddenModelIds: ["unassigned"] });
    expect(runtime.getModels(id).map((model) => model.id)).toEqual(["same-model"]);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, capabilities: ["language", "image", "video", "3d"] }));
    const details = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/models` })).json();
    expect(details.models.map((model: { id: string }) => model.id)).toEqual(["same-model", "my-video-alias", "my-mesh-alias", "unassigned"]);
    for (const [endpoint, modelId] of [["image", "same-model"], ["video", "my-video-alias"], ["model3d", "my-mesh-alias"]]) {
      const catalog = (await app.inject({ method: "GET", url: `/${endpoint}-models/catalog` })).json();
      expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: modelId }));
      expect((await app.inject({ method: "PUT", url: `/${endpoint}-models/default`, payload: { provider: id, id: modelId } })).statusCode).toBe(204);
    }
    const restored = new ProviderModelSettingsStore(directory, directory);
    await restored.load();
    expect((await restored.customProvider(id))?.models).toHaveLength(4);
    expect(restored.defaultImageModel()).toEqual({ provider: id, id: "same-model" });
    expect(restored.defaultVideoModel()).toEqual({ provider: id, id: "my-video-alias" });
    expect(restored.defaultModel3D()).toEqual({ provider: id, id: "my-mesh-alias" });
    expect((await app.inject({ method: "DELETE", url: "/video-models/default" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/video-models/catalog" })).json().defaultModel).toEqual(KUNPO_DEFAULT_MODEL_REFS.video);
    const cleared = new ProviderModelSettingsStore(directory, directory);
    await cleared.load();
    expect(cleared.defaultVideoModel()).toBeUndefined();
    expect((await app.inject({ method: "PUT", url: "/video-models/default", payload: { provider: id, id: "my-video-alias" } })).statusCode).toBe(204);
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).not.toContain(connection.apiKey);
    const hidden = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: ["same-model", "my-video-alias", "my-mesh-alias"], visible: false } });
    expect(hidden.statusCode, hidden.body).toBe(200);
    for (const endpoint of ["image", "video", "model3d"]) expect((await app.inject({ method: "GET", url: `/${endpoint}-models/catalog` })).json().models).toEqual([]);
    expect((await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: ["unassigned"], visible: true } })).statusCode).toBe(400);
    expect(request).not.toHaveBeenCalled();
    await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}/custom` });
    const removed = new ProviderModelSettingsStore(directory, directory);
    await removed.load();
    expect(removed.defaultImageModel()).toBeUndefined(); expect(removed.defaultVideoModel()).toBeUndefined(); expect(removed.defaultModel3D()).toBeUndefined();
  });

  it.each(["openai-images", "gemini-generate-content", "openrouter-images", "volcengine-images"] as const)("generates an arbitrary image alias with %s and its address override", async (protocol) => {
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    });
    const { app, save } = await fixture(request);
    const { id } = await save([model("totally-custom-image", { image: { ...defaultImageSettings(protocol), baseUrl: "http://127.0.0.1:43200/v1" } })]);
    await generate(app, "generate-image", { prompt: "A game icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: id, id: "totally-custom-image" } });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(protocol === "gemini-generate-content" ? "http://127.0.0.1:43200/v1beta/models/totally-custom-image:generateContent" : protocol === "openrouter-images" ? "http://127.0.0.1:43200/v1/images" : "http://127.0.0.1:43200/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${connection.apiKey}` });
    if (protocol !== "gemini-generate-content") expect(JSON.parse(String(init?.body)).model).toBe("totally-custom-image");
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/models"))).toBe(false);
  });

  it.each(["openrouter-videos", "seedance"] as const)("creates, polls and downloads a custom video alias with %s", async (protocol) => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === "http://127.0.0.1:43201/output.mp4") return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      if (init?.method === "POST") return Response.json({ id: "video-job" });
      return protocol === "seedance" ? Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43201/output.mp4" } })
        : Response.json({ status: "completed", unsigned_urls: ["http://127.0.0.1:43201/output.mp4"] });
    });
    const { app, save } = await fixture(request);
    const { id } = await save([model("custom-video", { video: { ...defaultVideoSettings(protocol), baseUrl: "http://127.0.0.1:43201/api" } })]);
    await generate(app, "generate-video", { prompt: "A game trailer", duration: 6, resolution: "720p", aspectRatio: "16:9", model: { provider: id, id: "custom-video" } });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual(protocol === "seedance"
      ? ["http://127.0.0.1:43201/api/contents/generations/tasks", "http://127.0.0.1:43201/api/contents/generations/tasks/video-job", "http://127.0.0.1:43201/output.mp4"]
      : ["http://127.0.0.1:43201/api/videos", "http://127.0.0.1:43201/api/videos/video-job", "http://127.0.0.1:43201/output.mp4"]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).model).toBe("custom-video");
  });

  it.each(["image-to-3d", "multi-image-to-3d"] as const)("rejects a new custom Meshy alias through %s before saving or submitting", async (operation) => {
    const request = vi.fn<typeof fetch>();
    const { app } = await fixture(request);
    const config = { ...defaultModel3DSettings("standard", "meshy"), operation, maxReferenceImages: operation === "multi-image-to-3d" ? 4 : 1, baseUrl: "http://127.0.0.1:43202/openapi/v1" };
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, modelConfigurationVersion: 2, models: [model("my-mesh-v5", { "3d": config })] } });
    expect(saved.statusCode).toBe(400); expect(saved.json().error).toBe(MESHY_DISABLED_MESSAGE);
    expect((await app.inject("/model3d-models/catalog")).json().models).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["image", "video", "3d"] as const)("resolves %s node, legacy project and global inheritance after explicitly clearing a new project's selection", async (usage) => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === "http://127.0.0.1:43199/model.glb") return new Response(new Uint8Array(TEST_GLB));
      if (String(url) === "http://127.0.0.1:43199/output.mp4") return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      if (usage === "3d") {
        if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: "file" } });
        if (init?.method === "POST") return Response.json({ code: 0, data: { task_id: "job" } });
        return Response.json({ code: 0, data: { status: "success", output: { model_url: "http://127.0.0.1:43199/model.glb" } } });
      }
      if (init?.method === "POST") return Response.json({ id: "job", result: "job" });
      return Response.json({ status: "completed", model_urls: { glb: "http://127.0.0.1:43199/model.glb" }, unsigned_urls: ["http://127.0.0.1:43199/output.mp4"] });
    });
    const { app, directory, save } = await fixture(request);
    const config = usage === "image" ? { image: defaultImageSettings() } : usage === "video" ? { video: defaultVideoSettings() } : { "3d": defaultModel3DSettings() };
    const { id } = await save(["global", "project", "node"].map((name) => model(name, config)));
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas", name: "Test canvas" } })).json();
    const projectId = project.id;
    const role = usage === "3d" ? "3d-generation" : usage;
    expect(project.modelSelections[role]).toEqual(KUNPO_DEFAULT_MODEL_REFS[role]);
    expect((await app.inject({ method: "PATCH", url: `/projects/${projectId}/model-selections`, payload: { [role]: null } })).statusCode).toBe(200);
    const ref = (name: string) => ({ provider: id, id: name });
    const endpoint = usage === "3d" ? "model3d" : usage;
    expect((await app.inject({ method: "PUT", url: `/${endpoint}-models/default`, payload: ref("global") })).statusCode).toBe(204);
    const settingsUrl = `/projects/${projectId}/settings/generation-models`;
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { [usage]: ref("project") } })).statusCode).toBe(200);
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(projectId)?.mediaModelDefaults).toEqual({ [usage]: ref("project") });
    const copied = (await app.inject({ method: "POST", url: `/projects/${projectId}/duplicate` })).json();
    expect(copied.mediaModelDefaults).toEqual({ [usage]: ref("project") });
    const tool = usage === "3d" ? "image-to-3d" : usage === "image" ? "generate-image" : "generate-video";
    const key = usage === "image" ? "imageModel" : "model";
    const input = usage === "3d" ? { images: [reference] } : usage === "image" ? { prompt: "Icon", resolution: "1K", aspectRatio: "1:1" } : { prompt: "Trailer" };
    const sentModels = () => request.mock.calls.filter(([, init]) => init?.method === "POST" && typeof init.body === "string").map(([, init]) => { const body = JSON.parse(String(init?.body)); return body.model ?? body.ai_model; });
    await generate(app, tool, { ...input, projectId, nodeId: "node-1", [key]: ref("node") });
    await generate(app, tool, { ...input, projectId, nodeId: "node-2" });
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: {} })).statusCode).toBe(200);
    await generate(app, tool, { ...input, projectId, nodeId: "node-3" });
    expect(sentModels()).toEqual(["node", "project", "global"]);
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { [usage]: ref("project") } })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: ["project"], visible: false } });
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { [usage]: ref("project") } })).statusCode).toBe(200);
    const unavailable = await app.inject({ method: "POST", url: `/tools/${tool}/jobs`, payload: { ...input, projectId, nodeId: "node-4" } });
    await vi.waitFor(async () => {
      const job = (await app.inject({ method: "GET", url: "/tool-jobs" })).json().find((job: { id: string }) => job.id === unavailable.json().id);
      expect(job.status).toBe("failed");
    });
    expect(sentModels()).toEqual(["node", "project", "global"]);
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { [usage]: ref("unknown") } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { language: ref("global") } })).statusCode).toBe(400);
  });

  it("uses explicit local Google-compatible authentication and no-key local image services", async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).includes(":generateContent")
      ? Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] })
      : Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const { app, save } = await fixture(request);
    const google = await save([model("native-image", { image: defaultImageSettings("gemini-generate-content") })], { preset: "google", api: "google-generative-ai" });
    await generate(app, "generate-image", { prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: google.id, id: "native-image" } });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": connection.apiKey });
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
    const local = await save([model("local-image", { image: defaultImageSettings() })], { name: "Local image service", authentication: "none", apiKey: undefined });
    await generate(app, "generate-image", { prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: local.id, id: "local-image" } });
    expect(request.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("retains unassigned and disabled models and never discovers or enables images behind the user's choices", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-image-1" }, { id: "unknown" }] }));
    const { app, save } = await fixture(request);
    const discovered = (await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: connection })).json();
    expect(discovered.models.map((model: { id: string }) => model.id)).toEqual(["gpt-image-1", "unknown"]);
    expect(discovered.models[1].usages).toEqual({});
    const { id } = await save(discovered.models, { hiddenModelIds: ["gpt-image-1", "unknown"] });
    request.mockClear();
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json().models).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    const invalid = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [model("unknown", {})] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("Assign a use");
  });

  it("imports legacy image access once and preserves the user's subsequent edits", async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url) === `${connection.baseUrl}/models` ? Response.json({ data: [{ id: "gpt-image-1" }] }) : Response.json({ data: [] }));
    const { app, directory } = await fixture(request);
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [{ ...model("chat", undefined) }] } });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-image-1" }));
    const store = new ProviderModelSettingsStore(directory, directory);
    await store.load();
    const settings = (await store.customProvider(id))!;
    expect(settings.modelConfigurationVersion).toBe(2);
    expect(settings.models.map((model) => model.id)).toEqual(["chat", "gpt-image-1"]);
    expect(settings.models.find((model) => model.id === "gpt-image-1")?.usages?.image?.maxReferenceImages).toBe(16);
    const updated = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...settings, hiddenModelIds: ["gpt-image-1"], models: settings.models.map((model) => model.id === "gpt-image-1" ? { ...model, name: "My image", usages: { image: { ...defaultImageSettings(), maxReferenceImages: 0 } } } : model) } });
    expect(updated.statusCode, updated.body).toBe(200);
    request.mockClear();
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains an existing language use when migrating a multimodal image model", async () => {
    const modelId = "gemini-3.1-flash-image";
    const request = vi.fn<typeof fetch>(async (url) => String(url) === `${connection.baseUrl}/models` ? Response.json({ data: [{ id: modelId }] }) : Response.json({ data: [] }));
    const { app, runtime } = await fixture(request);
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [{ ...model(modelId, undefined), name: "My existing model", supportsImages: true }] } });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: modelId }));
    const migrated = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json();
    expect(migrated.models).toHaveLength(1);
    expect(migrated.models[0]).toMatchObject({ id: modelId, name: "My existing model", usages: { language: true, image: { protocol: "gemini-generate-content", maxReferenceImages: 14 } } });
    expect(runtime.getModels(id).map((model) => model.id)).toEqual([modelId]);
  });
});

it("rejects hidden custom Meshy animation connections without forcing a credential or reviving recovery", async () => {
  const request = vi.fn<typeof fetch>();
  const { app } = await fixture(request);
  const base = { ...defaultModel3DSettings("standard", "meshy"), baseUrl: "http://127.0.0.1:43203/openapi/v1", operations: ["animate", "retexture"] as const };
  const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, authentication: "none", apiKey: undefined, modelConfigurationVersion: 2, hiddenModelIds: ["geometry"], models: [model("geometry", { "3d": { ...base, operations: [...base.operations] } })] } });
  expect(saved.statusCode).toBe(400); expect(saved.json().error).toBe(MESHY_DISABLED_MESSAGE);
  const response = await app.inject("/model3d-animations?provider=meshy&id=geometry");
  expect(response.statusCode).toBe(410); expect(response.json().error).toBe(MESHY_DISABLED_MESSAGE);
  expect(request).not.toHaveBeenCalled();
});
