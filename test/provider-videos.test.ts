import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MinimaxProvider, SeedanceProvider } from "./local-secure-provider-fixtures.js";
import { seedanceModel } from "../src/daemon/seedance-models.js";
import { minimaxModel } from "../src/daemon/minimax-models.js";
import { hasAttemptedVideoTask, videoTaskJournal } from "../src/daemon/video-task-journal.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { defaultVideoSettings } from "../src/shared/custom-models.js";
import type { CustomProviderDetails, VideoProtocol } from "../src/shared/contracts.js";

describe("ProviderVideos", () => {
  it("reports remote video discovery as deferred without fetching models or resolving a credential", async () => {
    const modelRuntime = runtime(), key = vi.spyOn(modelRuntime, "getAuth"), request = vi.fn<typeof fetch>();
    const deferred = new Set<string>();
    const catalog = await new ProviderVideos(async () => modelRuntime, request).catalog(undefined, deferred);
    expect(catalog.models).toEqual([]);
    expect([...deferred]).toEqual(["openrouter"]);
    expect(key).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["seedance", "minimax"] as const)("recovers a downloaded-task failure using only the original %s task", async (protocol) => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-task-recovery-"));
    try {
      const request = vi.fn<typeof fetch>();
      const provider = protocol === "seedance"
        ? new SeedanceProvider("volcengine-ark", () => "fixture-key", request, 0)
        : new MinimaxProvider("minimax-video-cn", () => "fixture-key", request, 0);
      const model = protocol === "seedance" ? seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")! : minimaxModel("minimax-video-cn", "MiniMax-H3")!;
      const artifact = "http://127.0.0.1:43199/result.mp4";
      const status = protocol === "seedance" ? { status: "succeeded", content: { video_url: artifact } } : { task: { status: "succeeded", content: { url: artifact } } };
      request.mockResolvedValueOnce(Response.json(protocol === "seedance" ? { id: "saved" } : { task_id: "saved" }))
        .mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(new Response("video"));
      expect(await hasAttemptedVideoTask(directory, "job")).toBe(false);
      const started = vi.fn(async () => {});
      await expect(provider.generate(model, { prompt: "forest", execution: await videoTaskJournal(directory, "job", false, undefined, started) })).rejects.toThrow("download failed");
      expect(await hasAttemptedVideoTask(directory, "job")).toBe(true);
      await expect(provider.generate(model, { prompt: "forest", execution: await videoTaskJournal(directory, "job", true, undefined, started) })).resolves.toMatchObject({ requestId: "saved" });
      expect(started).toHaveBeenCalledOnce();
      expect(request.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET", "GET", "GET", "GET"]);
      await writeFile(path.join(directory, "job.json"), "{");
      expect(await hasAttemptedVideoTask(directory, "job")).toBe(true);
      await expect(provider.generate(model, { prompt: "forest", execution: await videoTaskJournal(directory, "job", true) })).rejects.toThrow("could not be read safely");
      expect(request).toHaveBeenCalledTimes(5);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects the retired OpenRouter transport before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(async () => runtime(), request);

    await expect(videos.generate({
      prompt: "A cinematic game trailer",
      model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" },
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    })).rejects.toThrow(/not allowed|not available|unavailable/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the configured retired provider unavailable without contacting it", async () => {
    const request = vi.fn<typeof fetch>();
    const configured = new ProviderVideos(async () => runtime(), request);
    const unavailable = new ProviderVideos(async () => runtime(false), request);

    await expect(configured.catalog()).resolves.toMatchObject({ models: [], providers: [{ provider: "openrouter", state: "error" }] });
    await expect(unavailable.catalog()).resolves.toEqual({ models: [], providers: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it("lists only reviewed Kunpo Seedance 2.5 when the language runtime is unavailable", async () => {
    const request = vi.fn<typeof fetch>();
    const keys = (providerId: string) => providerId === "volcengine-ark" ? "fake-kunpo-key" : undefined;
    const videos = new ProviderVideos(async () => { throw new Error("Pi unavailable"); }, request, keys);
    const catalog = await videos.catalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["doubao-seedance-2-5-260628"]);
    expect(catalog.providers).toEqual([{ provider: "volcengine-ark", providerName: "Kunpo Seedance", state: "ready" }]);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unreviewed Seedance 2.0 on Kunpo without loading the language runtime or submitting", async () => {
    const runtimeFactory = vi.fn(async () => runtime());
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(runtimeFactory, request, () => "fake-kunpo-key");

    await expect(videos.generate({
      prompt: "A clockwork garden",
      model: { provider: "volcengine-ark", id: "doubao-seedance-2-0-260128" },
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["unreviewed-video", "openrouter-videos"], ["doubao-seedance-2-0-260128", "openrouter-videos"],
    ["unreviewed-video", "seedance"], ["unreviewed-video", "kunpo-videos"],
    ["doubao-seedance-2-5-260628", "openrouter-videos"], ["tencent-vod-vs-2.5", "seedance"],
  ] as const)("does not revive a legacy or mismatched paid path through custom Kunpo %s/%s", async (id, protocol: VideoProtocol) => {
    const getAuth = vi.fn(), request = vi.fn<typeof fetch>();
    const custom: CustomProviderDetails = { id: "custom-video", name: "Custom Kunpo", baseUrl: "https://llm.ziy.cc/v1", api: "openai-completions", authentication: "api_key", hiddenModelIds: [],
      models: [{ id, name: id, api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false, usages: { video: defaultVideoSettings(protocol) } }] };
    const videos = new ProviderVideos(async () => ({ getAuth, hasConfiguredAuth: () => true }) as unknown as ModelRuntime, request, undefined, undefined, { customProviders: async () => [custom] });
    await expect(videos.generate({ prompt: "Reviewed paths only", model: { provider: custom.id, id } })).rejects.toMatchObject({ statusCode: 400 });
    expect(getAuth).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

function runtime(configured = true): ModelRuntime {
  return {
    getProvider: (id: string) => id === "openrouter" ? { id, name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" } : undefined,
    hasConfiguredAuth: (id: string) => id === "openrouter" && configured,
    getAuth: async () => configured ? { auth: { apiKey: "fake-retired-key" }, source: "test" } : undefined,
  } as unknown as ModelRuntime;
}

describe("ProviderVideos Meshy policy", () => {
  function provider(): CustomProviderDetails {
    return { id: "studio", name: "Studio", baseUrl: "http://127.0.0.1:43199/v1", api: "openai-completions", authentication: "api_key", modelConfigurationVersion: 2, hiddenModelIds: [],
      models: [{ id: "movie", name: "Movie", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false, usages: { video: defaultVideoSettings() } }] };
  }
  function setup(custom: CustomProviderDetails) {
    const getAuth = vi.fn(async () => ({ auth: { apiKey: "fixture-only" } })), hasConfiguredAuth = vi.fn(() => true), request = vi.fn<typeof fetch>();
    const runtime = vi.fn(async () => ({ getAuth, hasConfiguredAuth }) as unknown as ModelRuntime);
    const videos = new ProviderVideos(runtime, request, undefined, id => id === custom.id, { customProviders: async () => [custom], defaultModel: () => ({ provider: custom.id, id: custom.models[0]!.id }) });
    return { videos, getAuth, hasConfiguredAuth, runtime, request };
  }
  it.each(["provider-id", "model-id", "preset", "provider-endpoint", "video-endpoint"] as const)("rejects %s before auth or any remote recovery", async kind => {
    const custom = provider();
    if (kind === "provider-id") custom.id = "meshy-relay";
    if (kind === "model-id") custom.models[0]!.id = "meshy-6";
    if (kind === "preset") custom.preset = "meshy";
    if (kind === "provider-endpoint") custom.baseUrl = "https://api.meshy.ai/openapi";
    if (kind === "video-endpoint") custom.models[0]!.usages!.video!.baseUrl = "https://api.meshy.ai/openapi";
    const f = setup(custom), ref = { provider: custom.id, id: custom.models[0]!.id };
    await expect(f.videos.assertGenerationAllowed(ref)).rejects.toMatchObject({ statusCode: 410 }); expect(f.runtime).not.toHaveBeenCalled();
    const catalog = await f.videos.catalog(); expect(catalog.models).toEqual([]); expect(catalog.defaultModel).toBeUndefined();
    await expect(f.videos.generate({ prompt: "Movie", model: ref, execution: { recoveryOnly: true, submitted: vi.fn() } })).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    await expect(f.videos.generate({ prompt: "Movie" })).rejects.toMatchObject({ statusCode: 410 });
    expect(f.getAuth).not.toHaveBeenCalled(); expect(f.hasConfiguredAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps legitimate video capability when only 3D uses Meshy", async () => {
    const custom = provider(); custom.models[0]!.usages!["3d"] = MODEL_3D_PRESETS.meshy[0]!.settings;
    const f = setup(custom); expect((await f.videos.catalog()).models).toHaveLength(1);
    await expect(f.videos.assertGenerationAllowed()).resolves.toBeUndefined(); expect(f.getAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("rechecks prior catalog entries before resolving a credential", async () => {
    const custom = provider(), f = setup(custom); expect((await f.videos.catalog()).models).toHaveLength(1);
    custom.models[0]!.usages!.video!.baseUrl = "https://api.meshy.ai/openapi";
    await expect(f.videos.generate({ prompt: "Movie" })).rejects.toMatchObject({ statusCode: 410 }); expect(f.getAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("rechecks policy after asynchronous credential resolution", async () => {
    const custom = provider(), f = setup(custom); let resolveAuth!: (value: { auth: { apiKey: string } }) => void;
    f.getAuth.mockImplementationOnce(() => new Promise(resolve => { resolveAuth = resolve; }));
    const pending = f.videos.generate({ prompt: "Movie" }); await vi.waitFor(() => expect(f.getAuth).toHaveBeenCalledOnce());
    custom.models[0]!.usages!.video!.baseUrl = "https://api.meshy.ai/openapi"; resolveAuth({ auth: { apiKey: "fixture-only" } });
    await expect(pending).rejects.toMatchObject({ statusCode: 410 }); expect(f.request).not.toHaveBeenCalled();
  });
});
