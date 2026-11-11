import { defaultImageSettings } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomProviderDetails } from "../src/shared/contracts.js";
import { describe, expect, it, vi } from "vitest";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { seedreamModels, seedreamRequestOptions } from "../src/daemon/seedream-models.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

describe("ProviderImages", () => {
  it("leaves remote-only catalogs and CLI discovery untouched when the Agent requests local capabilities", async () => {
    const request = vi.fn<typeof fetch>(), cli = vi.fn();
    const images = new ProviderImages(async () => openRouterRuntime(), request, undefined, undefined, {
      openAIConnection: async () => ({ source: { baseUrl: "http://127.0.0.1:43199/v1", apiKey: "fixture" } }),
      codexImages: { generate: vi.fn(), catalog: cli },
    });
    const deferred = new Set<string>();
    expect((await images.catalog(undefined, deferred)).models).toEqual([]);
    expect([...deferred].sort()).toEqual(["openai", "openrouter"]);
    expect(request).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
  });
  it("never contacts retired native provider endpoints even when legacy keys remain", async () => {
    const request = vi.fn<typeof fetch>();
    for (const provider of ["openai", "openrouter", "volcengine-ark"] as const) {
      const baseUrl = provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1";
      const legacy = { getProvider: (id: string) => id === provider ? { id, name: id, baseUrl } : undefined,
        hasConfiguredAuth: (id: string) => id === provider, isUsingOAuth: () => false,
        getAuth: async () => ({ auth: { apiKey: "legacy-provider-fake-key" } }) } as unknown as ModelRuntime;
      const images = new ProviderImages(async () => legacy, request, () => provider === "volcengine-ark" ? "legacy-seedream-fake-key" : undefined);
      await expect(images.generate({ prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider, id: provider === "volcengine-ark" ? "doubao-seedream-5-0-pro-260628" : "gpt-image-2.5-sunburst" } })).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("retains the Seedream adapter through an explicitly configured loopback fixture", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("seedream").toString("base64"), output_format: "png" }],
    }));
    const images = seedreamImages(request);

    const catalog = await images.catalog();
    expect(catalog.providers).toEqual([
      { provider: "openai", providerName: "OpenAI", state: "ready" },
    ]);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "doubao-seedream-5-0-pro-260628",
      "doubao-seedream-5-0-flash-260915",
      "doubao-seedream-5-0-260128",
    ]);
    expect(catalog.models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "doubao-seedream-5-0-lite-260128" }),
    ]));

    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openai", id: "doubao-seedream-5-0-flash-260915" },
      resolution: "1K",
      aspectRatio: "1:1",
    })).resolves.toMatchObject({ bytes: Buffer.from("seedream"), mediaType: "image/png" });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43199/v1/images/generations");
  });

  it("maps a legacy pixel size to generation options for Seedream models", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("seedream").toString("base64"), output_format: "png" }],
    }));
    const images = seedreamImages(request);

    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openai", id: "doubao-seedream-5-0-flash-260915" },
      size: "1536x1024",
    })).resolves.toMatchObject({ bytes: Buffer.from("seedream"), mediaType: "image/png" });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as { size?: string };
    expect(body.size).toBe(seedreamRequestOptions("doubao-seedream-5-0-flash-260915", "1K", "3:2")?.size);
  });

  it("maps a legacy pixel size to the nearest resolution a Seedream model offers", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("seedream").toString("base64"), output_format: "png" }],
    }));
    const images = seedreamImages(request);

    // Seedream 5.0 offers 2K and 4K only.
    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openai", id: "doubao-seedream-5-0-260128" },
      size: "1024x1536",
    })).resolves.toMatchObject({ bytes: Buffer.from("seedream") });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as { size?: string };
    expect(body.size).toBe(seedreamRequestOptions("doubao-seedream-5-0-260128", "2K", "2:3")?.size);
  });

  it("lists and generates with a configured OpenRouter image model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/images/models")
      ? Response.json({ data: [{
          id: "openai/gpt-image-2.5-flare",
          name: "OpenAI: GPT Image 2.5 Flare",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
          supported_parameters: {
            resolution: { type: "enum", values: ["1K", "2K"] },
            aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
          },
        }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] }));
    const images = new ProviderImages(async () => openRouterRuntime(), request);

    await expect(images.models()).resolves.toEqual([
      expect.objectContaining({ provider: "openrouter", id: "openai/gpt-image-2.5-flare", protocol: "openrouter-images" }),
    ]);
    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openrouter", id: "openai/gpt-image-2.5-flare" },
      resolution: "2K",
      aspectRatio: "16:9",
    })).resolves.toMatchObject({ bytes: PNG, mediaType: "image/png" });
    expect(request.mock.calls.find(([input]) => String(input).endsWith("/images"))?.[0]).toBe("http://127.0.0.1:43200/v1/images");
  });

  it("lists supported image models for each connected provider", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      vi.fn(async () => Response.json({ data: [{ id: "gpt-image-2.5-flare" }, { id: "text-only" }] })),
    );

    const models = await images.models();
    expect(models).toEqual([
      expect.objectContaining({ provider: "openai", providerName: "OpenAI", id: "gpt-image-2.5-flare" }),
    ]);
    const gpt = models.find((model) => model.id === "gpt-image-2.5-flare");
    expect(new Set(gpt?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K", "4K"]));
  });

  it("explains that a ChatGPT sign-in cannot generate images without asking OpenAI", async () => {
    const request = vi.fn<typeof fetch>();
    const images = new ProviderImages(
      async () => ({ ...runtime(), isUsingOAuth: () => true }) as unknown as ModelRuntime,
      request,
    );

    const catalog = await images.catalog();

    expect(catalog.models).toEqual([]);
    expect(catalog.providers).toEqual([expect.objectContaining({ provider: "openai", state: "empty", message: expect.stringContaining("choose another image provider") })]);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports an OpenAI catalog failure", async () => {
    const images = new ProviderImages(async () => runtime(), vi.fn(async () => new Response("{}", { status: 500 })));

    expect((await images.catalog()).providers).toEqual([expect.objectContaining({ provider: "openai", state: "error", message: "Model request failed (500)" })]);
  });

  it("reports a connected provider without supported image models", async () => {
    const images = new ProviderImages(
      async () => ({ ...runtime(), listCredentials: async () => [] }) as unknown as ModelRuntime,
      vi.fn(async () => Response.json({ data: [{ id: "text-only" }] })),
    );

    expect((await images.catalog()).providers).toEqual([
      { provider: "openai", providerName: "OpenAI", state: "empty", message: "This OpenAI key or endpoint lists no GPT Image models." },
    ]);
  });

  it("uses the explicitly selected provider and model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-2.5-flare" }] });
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(Object.fromEntries(new Headers(generation?.[1]?.headers))).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
    expect(request.mock.calls.filter(([input]) => String(input) === "http://127.0.0.1:43199/v1/models")).toHaveLength(1);
  });

  it("prefers the model supplied by a generation request", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openai", id: "gpt-image-2.5-flare" },
      resolution: "1K",
      aspectRatio: "1:1",
    })).resolves.toBeDefined();

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(Object.fromEntries(new Headers(generation?.[1]?.headers))).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
  });

  it("uses a configured BYOK model before the legacy Account model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(Object.fromEntries(new Headers(generation?.[1]?.headers))).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(true);
  });

  it("queries OpenAI models once when selecting its default", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gemini-3.1-flash-image" }, { id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(request.mock.calls.filter(([input]) => String(input) === "http://127.0.0.1:43199/v1/models")).toHaveLength(1);
    expect(request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"))?.[0])
      .toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(JSON.parse(String(request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"))?.[1]?.body))).toMatchObject({ model: "gpt-image-2.5-flare" });
  });

  it("validates the selected model's supported sizes", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      vi.fn(async (input) => String(input).endsWith("/models") ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] }) : Response.json({ data: [] })),
    );

    await expect(images.generate({ prompt: "A game icon", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "invalid" as never }))
      .rejects.toMatchObject({ message: "Image size is not supported by the selected model", statusCode: 400 });
  });

  it("validates configured resolution and aspect-ratio combinations", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    const imageModel = { provider: "openai", id: "gpt-image-2.5-flare" };
    await expect(images.generate({ prompt: "A game icon", imageModel, resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
  });

  it("keeps an explicit provider ahead of the default, and refuses unavailable defaults without changing providers", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-1" }, { id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    let defaultModel = { provider: "openai", id: "gpt-image-1" };
    const images = new ProviderImages(async () => runtime(), request, undefined, undefined, { defaultModel: () => defaultModel });
    expect((await images.catalog()).models[0]?.id).toBe("gpt-image-1");
    await images.generate({ prompt: "Default", size: "1024x1024" });
    await images.generate({ prompt: "Explicit", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "1024x1024" });
    const generated = request.mock.calls.filter(([input]) => String(input).endsWith("/images/generations"));
    expect(generated.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["gpt-image-1", "gpt-image-2.5-flare"]);
    defaultModel = { provider: "missing-provider", id: "gpt-image-1" };
    await expect(images.generate({ prompt: "Unavailable", size: "1024x1024" })).rejects.toThrow("selected image model is unavailable");
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/images/generations"))).toHaveLength(2);
  });

  it("automatically skips failed provider catalogs, while an explicit provider failure never changes routes", async () => {
    const custom: CustomProviderDetails[] = ["failed-relay", "working-relay"].map((id, index) => ({ id: `custom-${id}`, name: id, api: "openai-completions", baseUrl: `http://127.0.0.1:${43197 + index}/v1`, authentication: "api_key", models: [], hiddenModelIds: [] }));
    const providers = [
      { id: "openrouter", name: "OpenRouter", baseUrl: "http://127.0.0.1:43201/v1" },
      { id: "openai", name: "OpenAI", baseUrl: "http://127.0.0.1:43202/v1" },
      ...custom,
    ];
    const modelRuntime = {
      ...runtime(),
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      hasConfiguredAuth: (id: string) => providers.some((provider) => provider.id === id),
    } as unknown as ModelRuntime;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:43198/v1/models") return Response.json({ data: [{ id: "gpt-image-1" }] });
      if (url === "http://127.0.0.1:43198/v1/images/generations") return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
      return new Response("{}", { status: 503 });
    });
    const images = new ProviderImages(async () => modelRuntime, request, undefined, undefined, { customProviders: async () => custom });
    await expect(images.generate({ prompt: "Automatic", size: "1024x1024" })).resolves.toMatchObject({ bytes: PNG });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/images/generations"))).toHaveLength(1);
    request.mockClear();
    await expect(images.generate({ prompt: "Explicit", imageModel: { provider: "openai", id: "gpt-image-1" } })).rejects.toThrow("Model request failed (503)");
    expect(request.mock.calls.some(([input]) => String(input).includes(":43198/"))).toBe(false);
  });

  it("stops automatic selection when the request is canceled", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error("Canceled by user"));
      throw controller.signal.reason;
    });
    const images = new ProviderImages(async () => runtime(), request, () => "seedream-key");
    await expect(images.generate({ prompt: "Canceled" }, controller.signal)).rejects.toThrow("Canceled by user");
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/images/generations"))).toBe(false);
  });
});

describe("Kunpo image integration", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const provider: CustomProviderDetails = {
    id: "kunpo", name: "KunpoAPI", api: "openai-completions", baseUrl: "http://127.0.0.1:43199/v1", authentication: "api_key", modelConfigurationVersion: 2, hiddenModelIds: [],
    models: ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "Image-GI2.1"].map((id) => ({ id, name: id, api: "openai-completions", contextWindow: 128_000, maxTokens: 8192, reasoning: false, supportsImages: false,
      usages: { image: { protocol: "openai-images", resolutions: ["1K", "2K"], aspectRatios: ["1:1", "4:5"], maxReferenceImages: id === "Image-GI2.1" ? 14 : 16, maxOutputs: 1 } } })),
  };
  const modelRuntime = { hasConfiguredAuth: (id: string) => id === "kunpo", getAuth: async () => ({ auth: { apiKey: "kunpo-test-canary" } }) } as unknown as ModelRuntime;

  it("uses the chosen default without discovery and records the resolved provider", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const images = new ProviderImages(async () => modelRuntime, request, undefined, undefined, { customProviders: async () => [provider], defaultModel: () => ({ provider: "kunpo", id: "gpt-image-2.5-sunburst" }) });
    const result = await images.generate({ prompt: "Transparent game item", resolution: "1K", aspectRatio: "1:1", background: "transparent", outputFormat: "png" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toMatchObject({ model: "gpt-image-2.5-sunburst", background: "transparent", output_format: "png" });
    expect(result.generation).toMatchObject({ provider: "kunpo", model: "gpt-image-2.5-sunburst", protocol: "openai-images" });
  });

  it("preserves explicit selections and refuses GI2.1 transparency without a request", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const images = new ProviderImages(async () => modelRuntime, request, undefined, undefined, { customProviders: async () => [provider], defaultModel: () => ({ provider: "kunpo", id: "gpt-image-2.5-sunburst" }) });
    await images.generate({ prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: "kunpo", id: "gpt-image-2.5-flare" } });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).model).toBe("gpt-image-2.5-flare");
    request.mockClear();
    await expect(images.generate({ prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: "kunpo", id: "Image-GI2.1" }, background: "transparent" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });
});

function runtime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openai"
      ? { name: "OpenAI", baseUrl: "http://127.0.0.1:43199/v1" }
      : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openai",
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "sk-openai" }, source: "test" }),
    listCredentials: async () => [{ providerId: "openai", type: "api_key" }],
  } as unknown as ModelRuntime;
}

function openRouterRuntime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openrouter"
      ? { id: provider, name: "OpenRouter", baseUrl: "http://127.0.0.1:43200/v1" }
      : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openrouter",
    getAuth: async () => ({ auth: { apiKey: "sk-openrouter" }, source: "test" }),
  } as unknown as ModelRuntime;
}

function seedreamImages(request: typeof fetch): ProviderImages {
  return new ProviderImages(async () => { throw new Error("Runtime unavailable"); }, request, undefined, undefined, { openAIConnection: async () => ({ source: { baseUrl: "http://127.0.0.1:43199/v1", apiKey: "fixture-seedream-key" }, models: seedreamModels().map((model) => ({ ...model, provider: "openai", providerName: "OpenAI" })) }) });
}

describe("ProviderImages Meshy policy", () => {
  function provider(): CustomProviderDetails {
    return { id: "studio", name: "Studio", baseUrl: "http://127.0.0.1:43199/v1", api: "openai-completions", authentication: "api_key", modelConfigurationVersion: 2, hiddenModelIds: [],
      models: [{ id: "art", name: "Art", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false, usages: { image: defaultImageSettings() } }] };
  }
  function setup(custom: CustomProviderDetails) {
    const getAuth = vi.fn(async () => ({ auth: { apiKey: "fixture-only" } })), hasConfiguredAuth = vi.fn(() => true), request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const runtime = vi.fn(async () => ({ getAuth, hasConfiguredAuth }) as unknown as ModelRuntime);
    const images = new ProviderImages(runtime, request, undefined, id => id === custom.id, { customProviders: async () => [custom], defaultModel: () => ({ provider: custom.id, id: custom.models[0]!.id }) });
    return { images, getAuth, hasConfiguredAuth, runtime, request };
  }
  it.each(["provider-id", "model-id", "preset", "provider-endpoint", "image-endpoint"] as const)("rejects %s without auth, discovery, fallback or transport", async kind => {
    const custom = provider();
    if (kind === "provider-id") custom.id = "meshy-relay";
    if (kind === "model-id") custom.models[0]!.id = "meshy-6";
    if (kind === "preset") custom.preset = "meshy";
    if (kind === "provider-endpoint") custom.baseUrl = "https://api.meshy.ai/openapi";
    if (kind === "image-endpoint") custom.models[0]!.usages!.image!.baseUrl = "https://api.meshy.ai/openapi";
    const f = setup(custom), ref = { provider: custom.id, id: custom.models[0]!.id };
    await expect(f.images.assertGenerationAllowed(ref)).rejects.toMatchObject({ statusCode: 410 });
    expect(f.runtime).not.toHaveBeenCalled();
    const catalog = await f.images.catalog(); expect(catalog.models).toEqual([]); expect(catalog.defaultModel).toBeUndefined();
    await expect(f.images.generate({ prompt: "Icon", imageModel: ref })).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    await expect(f.images.generate({ prompt: "Icon" })).rejects.toMatchObject({ statusCode: 410 });
    expect(f.getAuth).not.toHaveBeenCalled(); expect(f.hasConfiguredAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps a legitimate image usage when only a separate 3D usage is Meshy", async () => {
    const custom = provider(); custom.models[0]!.usages!["3d"] = MODEL_3D_PRESETS.meshy[0]!.settings;
    const f = setup(custom); expect((await f.images.catalog()).models).toHaveLength(1);
    await expect(f.images.generate({ prompt: "Icon", size: "1024x1024" })).resolves.toMatchObject({ bytes: PNG }); expect(f.request).toHaveBeenCalledOnce();
  });
  it("does not trust a prior catalog after configuration changes to Meshy", async () => {
    const custom = provider(), f = setup(custom); expect((await f.images.catalog()).models).toHaveLength(1);
    custom.models[0]!.usages!.image!.baseUrl = "https://api.meshy.ai/openapi";
    await expect(f.images.generate({ prompt: "Icon" })).rejects.toMatchObject({ statusCode: 410 }); expect(f.getAuth).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("rechecks usage policy after asynchronous credential resolution", async () => {
    const custom = provider(), f = setup(custom); let resolveAuth!: (value: { auth: { apiKey: string } }) => void;
    f.getAuth.mockImplementationOnce(() => new Promise(resolve => { resolveAuth = resolve; }));
    const pending = f.images.generate({ prompt: "Icon" }); await vi.waitFor(() => expect(f.getAuth).toHaveBeenCalledOnce());
    custom.models[0]!.usages!.image!.baseUrl = "https://api.meshy.ai/openapi"; resolveAuth({ auth: { apiKey: "fixture-only" } });
    await expect(pending).rejects.toMatchObject({ statusCode: 410 }); expect(f.request).not.toHaveBeenCalled();
  });
});
