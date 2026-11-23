import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createLocalModelRuntime, LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { kunpoRuntimeProvider } from "../src/daemon/provider-model-settings.js";
import { kunpoImagePayload, localModelFetch } from "../src/daemon/model-network-policy.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { createAgentTools, projectPiToolNames } from "../src/daemon/agent-tools.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { rememberKunpoImageSource } from "../src/daemon/provider-image-source.js";
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-local-auth-"));
  directories.push(value);
  return value;
}
const provider = {
  id: "custom-local",
  config: { name: "Reviewed gateway", api: "openai-responses" as const, baseUrl: "https://llm.ziy.cc/v1", models: [{
    id: "fixture-model", name: "Fixture", input: ["text" as const], reasoning: true, contextWindow: 32_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] },
};
const testRoutes = [
  { providerId: "kunpo", id: "gpt-5.6-sol" },
  { providerId: "kunpo", id: "claude-opus-5-5" },
  { providerId: "kunpo", id: "claude-fable-5-2" },
  { providerId: "kunpo", id: "gpt-6.2-astra" },
  { providerId: provider.id, id: "fixture-model" },
];
const responsesSse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const responseUsage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };

describe("local literal API key storage and model runtime", () => {
  it("rejects Meshy registration, saved aliases and direct requests before authentication", async () => {
    const root = await directory();
    const prompt = vi.fn(async () => "never-used"), request = vi.fn<typeof fetch>();
    const mixed = { ...provider, config: { ...provider.config, models: [...provider.config.models, { ...provider.config.models[0]!, id: "meshy-7.1" }] } };
    const runtime = await createLocalModelRuntime(path.join(root, "keys.json"), async () => [mixed, { ...provider, id: "meshy" }]);
    expect(runtime.getModels("custom-local").map(item => item.id)).toEqual(["fixture-model"]);
    expect(runtime.getModel("meshy", "fixture-model")).toBeUndefined();
    expect(() => runtime.registerProvider("meshy", provider.config)).toThrow("Meshy is disabled");
    await expect(runtime.login("meshy", "api_key", { prompt, notify: () => {} })).rejects.toThrow("Meshy is disabled");
    const valid = runtime.getModel("custom-local", "fixture-model")!;
    const forbidden = { ...valid, id: "meshy-7.1" };
    expect(() => runtime.streamSimple(forbidden, { messages: [] }, { fetch: request })).toThrow("Meshy is disabled");
    expect(() => runtime.stream(forbidden, { messages: [] }, { fetch: request })).toThrow("Meshy is disabled");
    expect(prompt).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expect(access(path.join(root, "keys.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  describe.each(testRoutes)("passive protocol monitoring for $id", ({ providerId, id }) => {
    it.each(["completed", "incomplete", "missing-terminal"])("records %s from the actual SDK and guarded fetch without retaining content or resubmitting", async outcome => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const root = await directory();
      const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider(), provider]);
      await runtime.login(providerId, "api_key", { prompt: async () => "CANARY_MONITOR_SDK_ONLY", notify: () => {} });
      const model = runtime.getModel(providerId, id)!;
      const missing = outcome === "missing-terminal", limited = outcome === "incomplete";
      let wire: string;
      if (model.api === "openai-completions") wire = [
        'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"PRIVATE_REPLY"},"finish_reason":null}]}',
        ...missing ? [] : [`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: limited ? "length" : "stop" }] })}`], "data: [DONE]", "",
      ].join("\n\n");
      else if (model.api === "anthropic-messages") wire = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"PRIVATE_REPLY"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: limited ? "max_tokens" : "end_turn" }, usage: { output_tokens: 1 } })}`,
        ...missing ? [] : ['event: message_stop\ndata: {"type":"message_stop"}'], "",
      ].join("\n\n");
      else wire = [
        'data: {"type":"response.created","response":{"id":"fixture","status":"in_progress"}}',
        ...missing ? [] : [`data: ${JSON.stringify({ type: limited ? "response.incomplete" : "response.completed", response: { id: "fixture", status: limited ? "incomplete" : "completed", output: [], usage: responseUsage, ...(limited ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } })}`], "",
      ].join("\n\n");
      const request = vi.fn<typeof fetch>(async () => new Response(wire, { headers: { "content-type": "text/event-stream", "request-id": "req_protocol_fixture" } }));
      await runtime.completeSimple(model, { messages: [{ role: "user", timestamp: 1, content: "PRIVATE_PROMPT" }] }, { fetch: localModelFetch(model, request), maxRetries: 2 });
      const records = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.msg === "Provider request");
      const end = records.filter(entry => entry.event === "finished");
      expect(end).toHaveLength(1);
      expect(end[0]).toMatchObject({ protocol: model.api, statusCode: 200, wireComplete: true, responseValidated: true, receivedBytes: Buffer.byteLength(wire), providerRequestId: "req_protocol_fixture", outcome: missing ? "stream_interrupted" : outcome });
      expect(request).toHaveBeenCalledOnce();
      expect(records).toHaveLength(4);
      expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|CANARY_|https:|authorization|responseId|prompt|sha256/);
    });
  });

  it.each(["guard-bypass", "synthesized-stop"])("does not claim completion after %s in a mock SDK transport", async mode => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider()]);
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_MONITOR_BOUNDARY_ONLY", notify: () => {} });
    const configured = runtime.getModel("kunpo", "gpt-5.6-sol")!;
    const model = { ...configured, compat: { ...configured.compat, supportsFinishReason: false } };
    const request = vi.fn<typeof fetch>(async () => new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"PRIVATE_REPLY"},"finish_reason":null}]}',
      ...(mode === "guard-bypass" ? ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'] : []), "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", timestamp: 1, content: "PRIVATE_PROMPT" }] }, { fetch: mode === "guard-bypass" ? request : localModelFetch(model, request) });
    expect(result.stopReason).toBe("stop"); // Monitoring must not change the SDK result.
    const finished = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.event === "finished");
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toBe(mode === "guard-bypass" ? "unobserved_transport" : "stream_interrupted");
    expect(request).toHaveBeenCalledOnce();
  });

  it("advertises distinct new and recovery inputs on the main Agent's Kunpo Chat transport", async () => {
    const root = await directory(), projects = new ProjectManager(root), library = new AssetLibrary(root);
    const project = await projects.create("Media contract", "web-game");
    const runner = new ToolRunner(root, { generate: vi.fn() });
    const store = new CanvasStore(projects, library, runner);
    const tools = createAgentTools(project, runner, projects, undefined, undefined, store);
    const names = tools.map(tool => tool.name);
    const active = projectPiToolNames("normal", ["generate-image", "image-to-3d"], names);
    const planning = projectPiToolNames("planning", ["generate-image", "image-to-3d"], names);
    expect(projectPiToolNames("normal", ["generate-image"], names)).not.toContain("generate_3d_from_views");
    for (const name of ["generate_reference_image", "generate_3d_from_views", "recover_media", "generate_canvas_media", "recover_canvas_media", "replace_canvas_media"]) {
      expect(active).toContain(name);
      expect(planning).not.toContain(name);
    }
    const runtime = await createLocalModelRuntime(path.join(root, "auth-fixture.json"), async () => [kunpoRuntimeProvider()]);
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_MEDIA_TOOLS_TEST_ONLY", notify: () => {} });
    const model = runtime.getModel("kunpo", "gpt-5.6-sol")!;
    const request = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    try {
      await runtime.completeSimple(model, { messages: [{ role: "user", timestamp: 1, content: "Inspect local tools" }], tools: tools.filter(tool => active.includes(tool.name)) }, { fetch: localModelFetch(model, request) });
      expect(request).toHaveBeenCalledOnce();
      const sent = JSON.parse(String(request.mock.calls[0]![1]?.body)).tools.map((entry: { function: { name: string; parameters: object } }) => [entry.function.name, entry.function.parameters]);
      const schemas = Object.fromEntries(sent);
      expect(Object.keys(schemas.generate_canvas_media.properties).sort()).toEqual(["boardId", "nodeId"]);
      expect(schemas.generate_canvas_media.required).toEqual(["boardId", "nodeId"]);
      expect(schemas.generate_image.required).toContain("prompt");
      expect(schemas.generate_image.properties).not.toHaveProperty("recoverCallId");
      expect(schemas.generate_image.properties).not.toHaveProperty("size");
      expect(schemas.generate_reference_image.required).toEqual(expect.arrayContaining(["imagePaths", "prompt"]));
      for (const unused of ["maskPath", "outputCompression", "recoverCallId"]) {
        expect(schemas.generate_reference_image.properties).not.toHaveProperty(unused);
      }
      const views = schemas.generate_3d_from_views;
      expect(views.required).toEqual(["imagePaths"]);
      expect(views.properties.imagePaths).toMatchObject({ minItems: 3, maxItems: 4 });
      expect(Object.keys(views.properties).sort()).toEqual(["imagePaths", "model", "options", "pbr", "targetPolycount", "texture"]);
      expect(Object.keys(views.properties.options.properties).sort()).toEqual(["geometryQuality", "pose", "quad", "textureModel", "textureQuality"]);
      expect(schemas.recover_media.properties.tool.anyOf).toContainEqual(expect.objectContaining({ const: "generate_3d_from_views" }));
      expect(schemas.recover_media.required).toContain("recoverCallId");
      expect(schemas.recover_canvas_media.required).toContain("recoverJobId");
      expect(schemas.replace_canvas_media.required).toContain("confirmedAudioJobId");
    } finally { await store.close(); }
  });

  it("uses the actual Chat SDK's payload hook for verified origins, mixed identical uploads, edited bytes, and tool continuation", async () => {
    const root = await directory(), library = new AssetLibrary(root); await library.load();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"), generated = { bytes };
    const url = "https://kunpoapiimg.ziy.cc/sdk-source.png?signature=fake-sdk-source"; rememberKunpoImageSource(generated, url, "https://llm.ziy.cc/v1");
    const asset = await library.add("sdk.png", bytes, { origin: "generated" }); expect(await library.bindGeneratedImageSource(asset.id, generated)).toBe(true);
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider()], library);
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_IMAGE_SOURCE_SDK_ONLY", notify: () => {} });
    const model = runtime.getModel("kunpo", "gpt-5.6-sol")!;
    const images = [
      { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") },
      { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64"), libraryAssetId: asset.id },
      { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64"), libraryAssetId: "11111111-1111-4111-8111-111111111111" },
      { type: "image" as const, mimeType: "image/png", data: Buffer.concat([bytes, Buffer.from("edit")]).toString("base64"), libraryAssetId: asset.id },
    ];
    const user = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "Inspect" }, ...images] };
    const tools = [{ name: "inspect", description: "Inspect the fixture", parameters: { type: "object", properties: {} } }];
    const request = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_source","type":"function","function":{"name":"inspect","arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}', "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })).mockImplementationOnce(async () => new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const options = { fetch: localModelFetch(model, request), maxRetries: 0, onPayload: (payload: unknown) => { expect(JSON.stringify(payload)).not.toContain("fake-sdk-source"); } };
    const result = await runtime.completeSimple(model, { messages: [user], tools }, options); expect(result.stopReason).toBe("toolUse");
    const done = await runtime.completeSimple(model, { messages: [user, result, { role: "toolResult", toolCallId: "call_source", toolName: "inspect", timestamp: 2, isError: false, content: [{ type: "text", text: "Inspected" }] }], tools }, options);
    expect(done.stopReason).toBe("stop"); expect(request).toHaveBeenCalledTimes(2);
    for (const [target, init] of request.mock.calls) {
      expect(String(target)).toBe("https://llm.ziy.cc/v1/chat/completions");
      const body = JSON.parse(String(init!.body));
      const sent = body.messages[0].content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
      expect(sent).toEqual([`data:image/png;base64,${images[0]!.data}`, url, `data:image/png;base64,${images[2]!.data}`, `data:image/png;base64,${images[3]!.data}`]);
      expect(JSON.stringify(body)).not.toContain("libraryAssetId");
    }
    expect(JSON.stringify(user)).not.toContain("fake-sdk-source");
    for (const api of ["anthropic-messages", "openai-responses"] as const) {
      const payload = { messages: [{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${images[1]!.data}` } }] }] };
      expect(await kunpoImagePayload({ id: "unreviewed-vision-fixture", api, baseUrl: model.baseUrl }, { messages: [user] }, payload, undefined, library)).toBe(payload);
      expect(JSON.stringify(payload)).not.toContain("fake-sdk-source");
    }
  });

  it("does not migrate old auth or execute command-shaped keys", async () => {
    const root = await directory(), marker = path.join(root, "command-was-executed");
    const commandKey = `!touch ${marker}`;
    await writeFile(path.join(root, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: commandKey } }));
    const store = new LocalApiKeyStore(path.join(root, "local-api-keys.json"));
    expect(await store.read("openai")).toBeUndefined();
    await store.modify("custom-local", async () => ({ type: "api_key", key: commandKey }));
    expect(await store.read("custom-local")).toEqual({ type: "api_key", key: commandKey });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list()).toEqual([{ providerId: "custom-local", type: "api_key" }]);
    if (process.platform !== "win32") expect((await stat(path.join(root, "local-api-keys.json"))).mode & 0o777).toBe(0o600);
    await expect(store.modify("custom-local", async () => ({ type: "oauth", access: "CANARY_ACCESS", refresh: "CANARY_REFRESH", expires: 0 }))).rejects.toThrow("literal");
  });

  it("serializes mutations and strips credential environment fields", async () => {
    const store = new LocalApiKeyStore(path.join(await directory(), "local-api-keys.json"));
    await Promise.all(["one", "two"].map((id) => store.modify(id, async () => ({ type: "api_key", key: `CANARY_${id}`, env: { SECRET_COMMAND: "!echo bad" } }))));
    expect((await store.list()).map(({ providerId }) => providerId).sort()).toEqual(["one", "two"]);
    expect(await store.read("one")).toEqual({ type: "api_key", key: "CANARY_one" });
    await store.delete("one");
    expect(await store.read("one")).toBeUndefined();
  });

  it("has no OAuth, ambient credential lookup or automatic catalogs", async () => {
    const root = await directory();
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OPENAI_API_KEY", "CANARY_AMBIENT_MUST_NOT_BE_READ");
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [provider]);
    expect(await runtime.getAuth("openai")).toBeUndefined();
    expect(runtime.getProviders().every((entry) => !entry.auth.oauth && !entry.refreshModels)).toBe(true);
    await runtime.refresh({ allowNetwork: true });
    expect(request).not.toHaveBeenCalled();
    const interaction = { prompt: async () => "CANARY_LITERAL_KEY", notify: () => {} };
    await expect(runtime.login("openai", "oauth", interaction)).rejects.toThrow("unavailable");
    await runtime.login(provider.id, "api_key", interaction);
    expect(await runtime.getAuth(provider.id)).toMatchObject({ auth: { apiKey: "CANARY_LITERAL_KEY" } });
    expect((await runtime.getAvailable()).map((model) => model.id)).toContain("fixture-model");
    expect(await readFile(path.join(root, "local-api-keys.json"), "utf8")).not.toContain("CANARY_AMBIENT");
    expect(() => runtime.registerProvider("bad", { apiKey: "!echo bad" })).toThrow("unavailable");
    expect(() => runtime.registerProvider("bad", { headers: { Authorization: "!echo bad" } })).toThrow("unavailable");
  });

  it("retains each reviewed Kunpo model API and sends the default chat image/tool contract without invented reasoning controls", async () => {
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider()]);
    expect(runtime.getModels("kunpo").map((model) => [model.id, model.api, model.baseUrl])).toEqual([
      ["gpt-5.6-sol", "openai-completions", "https://llm.ziy.cc/v1"],
      ["claude-opus-5-5", "anthropic-messages", "https://llm.ziy.cc"],
      ["claude-fable-5-2", "anthropic-messages", "https://llm.ziy.cc"],
      ["gpt-6.2-astra", "openai-responses", "https://llm.ziy.cc/v1"],
    ]);
    expect(await runtime.getAuth("kunpo")).toBeUndefined();
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_KUNPO_TEST_ONLY", notify: () => {} });
    const toolResponse = [
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"inspect","arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]", "",
    ].join("\n\n");
    const finalResponse = [
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}',
      'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]", "",
    ].join("\n\n");
    const request = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(toolResponse, { headers: { "content-type": "text/event-stream" } }))
      .mockImplementationOnce(async () => new Response(finalResponse, { headers: { "content-type": "text/event-stream" } }));
    const model = runtime.getModel("kunpo", "gpt-5.6-sol")!;
    const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const user = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "Inspect this screenshot" }, { type: "image" as const, mimeType: "image/png", data: screenshot }] };
    const tools = [{ name: "inspect", description: "Inspect the fixture", parameters: { type: "object", properties: {} } }];
    const guarded = localModelFetch(model, request);
    const result = await runtime.completeSimple(model, { messages: [user], tools }, { fetch: guarded, maxRetries: 0 });
    expect(result.stopReason).toBe("toolUse");
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]![0])).toBe("https://llm.ziy.cc/v1/chat/completions");
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages[0].content).toContainEqual(expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: `data:image/png;base64,${screenshot}` }) }));
    expect(body.tools[0].function.name).toBe("inspect");
    const completed = await runtime.completeSimple(model, { messages: [user, result, {
      role: "toolResult", toolCallId: "call_fixture", toolName: "inspect", content: [{ type: "text", text: "Fixture inspected" }], isError: false, timestamp: 2,
    }], tools }, { fetch: guarded, maxRetries: 0 });
    expect(completed.stopReason).toBe("stop");
    expect(request).toHaveBeenCalledTimes(2);
    const continued = JSON.parse(String(request.mock.calls[1]![1]?.body));
    expect(continued.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call_fixture", content: "Fixture inspected" }));
  });

  it("does not revive a retired Kunpo Agent through an old registration or an already-resolved model", async () => {
    const root = await directory();
    const stale = { ...provider.config, models: [{ ...provider.config.models[0]!, id: "gpt-6.1-sol" }] };
    const runtime = await createLocalModelRuntime(path.join(root, "keys.json"), async () => [kunpoRuntimeProvider(), { id: provider.id, config: stale }]);
    const otherRoute = runtime.getModel(provider.id, "gpt-6.1-sol")!;
    expect(otherRoute).toBeDefined();
    runtime.registerProvider("kunpo", stale);
    expect(runtime.getModel("kunpo", "gpt-6.1-sol")).toBeUndefined();
    const request = vi.fn<typeof fetch>();
    expect(() => runtime.streamSimple({ ...otherRoute, provider: "kunpo" }, { messages: [] }, { fetch: request })).toThrow("no longer available");
    expect(request).not.toHaveBeenCalled();
  });

  it("sends Fable text turns using native Messages authentication, implicit thinking, and only documented effort", async () => {
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "keys.json"), async () => [kunpoRuntimeProvider()]);
    const key = "FABLE_TEST_FIXTURE";
    await runtime.login("kunpo", "api_key", { prompt: async () => key, notify: () => {} });
    const model = runtime.getModel("kunpo", "claude-fable-5-2")!;
    const events = [
      { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const request = vi.fn<typeof fetch>(async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const context: Context = { systemPrompt: "Use plain text", messages: [{ role: "user", timestamp: 1, content: "First turn" }] };
    for (const reasoning of [undefined, "low", "high"] as const) {
      const reply = await runtime.completeSimple(model, context, { fetch: localModelFetch(model, request), maxTokens: 100, cacheRetention: "long", temperature: 0.1, reasoning });
      expect(reply).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Ready" }] });
      const [input, init] = request.mock.calls.at(-1)!;
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://llm.ziy.cc/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(key);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: model.id, stream: true, max_tokens: 100, messages: expect.any(Array), system: expect.any(Array), ...(reasoning === "low" ? { output_config: { effort: "low" } } : {}) });
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual(context.messages.map(message => message.role));
      expect(JSON.stringify(body)).not.toContain('"1h"');
      context.messages.push(reply, { role: "user", timestamp: 2, content: "Follow up" });
    }
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(testRoutes)("cancels $id pending SDK stream and its upstream body without retrying", async ({ providerId, id }) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider(), provider]);
    const key = "CANARY_KUNPO_CANCEL_TEST_ONLY";
    await runtime.login(providerId, "api_key", { prompt: async () => key, notify: () => {} });
    const model = runtime.getModel(providerId, id)!;
    const cancelled = vi.fn(), upstreamAborted = vi.fn();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.addEventListener("abort", upstreamAborted, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const event = model.api === "openai-responses" ? { type: "response.created", response: { id: "resp_cancel", status: "in_progress" } }
            : model.api === "anthropic-messages" ? { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }
            : { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Unverified partial" }, finish_reason: null }] };
          controller.enqueue(new TextEncoder().encode(`${model.api === "anthropic-messages" ? "event: message_start\n" : ""}data: ${JSON.stringify(event)}\n\n`));
        },
        cancel: cancelled,
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const controller = new AbortController();
    const pending = runtime.completeSimple(model, { messages: [{ role: "user", timestamp: 1, content: "Inspect the fixture" }] },
      { fetch: localModelFetch(model, request), maxRetries: 0, signal: controller.signal });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort();
    const result = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
    expect(upstreamAborted).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(key);
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ model: id, stream: true });
    const finished = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.event === "finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: "cancelled", statusCode: 200, wireComplete: false });
  });

  it("continues Responses tools with distinct item IDs and call IDs through the actual SDK", async () => {
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [provider]);
    await runtime.login(provider.id, "api_key", { prompt: async () => "CANARY_RESPONSES_TEST_ONLY", notify: () => {} });
    const call = { type: "function_call", id: "fc_fixture_item", call_id: "call_fixture", name: "inspect", arguments: '{"label":"fixture"}', status: "completed" };
    const answer = { type: "message", id: "msg_fixture_answer", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Ready", annotations: [] }] };
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => responsesSse(
        { type: "response.created", response: { id: "resp_fixture_tool", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: '{"label":' },
        { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: '"fixture"}' },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { id: "resp_fixture_tool", status: "completed", output: [call], usage: responseUsage } },
      ))
      .mockImplementationOnce(async () => responsesSse(
        { type: "response.created", response: { id: "resp_fixture_answer", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: answer.id, output_index: 0, content_index: 0, delta: "Ready" },
        { type: "response.output_item.done", output_index: 0, item: answer },
        { type: "response.completed", response: { id: "resp_fixture_answer", status: "completed", output: [answer], usage: responseUsage } },
      ));
    const model = runtime.getModel(provider.id, "fixture-model")!;
    const user = { role: "user" as const, timestamp: 1, content: "Inspect the text fixture" };
    const tools = [{ name: "inspect", description: "Inspect text", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }];
    const options = { fetch: localModelFetch(model, request), maxRetries: 2, reasoning: "high" as const, maxTokens: 512 };
    const first = await runtime.completeSimple(model, { messages: [user], tools }, options);
    expect(first).toMatchObject({ stopReason: "toolUse", responseId: "resp_fixture_tool", content: [{ type: "toolCall", id: "call_fixture|fc_fixture_item", name: "inspect", arguments: { label: "fixture" } }] });
    const completed = await runtime.completeSimple(model, { messages: [user, first, {
      role: "toolResult", toolCallId: "call_fixture|fc_fixture_item", toolName: "inspect", content: [{ type: "text", text: "Fixture inspected" }], isError: false, timestamp: 2,
    }], tools }, options);
    expect(completed).toMatchObject({ stopReason: "stop", responseId: "resp_fixture_answer", content: [{ type: "text", text: "Ready" }] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([input]) => String(input) === "https://llm.ziy.cc/v1/responses")).toBe(true);
    const firstBody = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(firstBody).toMatchObject({ model: "fixture-model", stream: true, reasoning: { effort: "high" }, max_output_tokens: 512, tools: [{ type: "function", name: "inspect" }] });
    expect(firstBody.tools[0]).not.toHaveProperty("strict");
    expect(firstBody.temperature).toBeUndefined();
    const secondBody = JSON.parse(String(request.mock.calls[1]![1]?.body));
    expect(secondBody.input).toContainEqual(expect.objectContaining({ type: "function_call", id: "fc_fixture_item", call_id: "call_fixture", name: "inspect", arguments: '{"label":"fixture"}' }));
    expect(secondBody.input).toContainEqual({ type: "function_call_output", call_id: "call_fixture", output: "Fixture inspected" });
    expect(secondBody.previous_response_id).toBeUndefined();
  });

  it.each(["incomplete", "missing-terminal"] as const)("does not treat a Responses %s stream as a completed answer or retry it", async (terminal) => {
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [provider]);
    await runtime.login(provider.id, "api_key", { prompt: async () => "CANARY_RESPONSES_TEST_ONLY", notify: () => {} });
    const partial = { type: "message", id: "msg_partial", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "Partial", annotations: [] }] };
    const events: unknown[] = [
      { type: "response.created", response: { id: "resp_incomplete", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...partial, content: [] } },
      { type: "response.output_item.done", output_index: 0, item: partial },
    ];
    if (terminal === "incomplete") events.push({ type: "response.incomplete", response: { id: "resp_incomplete", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [partial], usage: responseUsage } });
    const request = vi.fn<typeof fetch>(async () => responsesSse(...events));
    const model = runtime.getModel(provider.id, "fixture-model")!;
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", timestamp: 1, content: "Inspect the text fixture" }] }, { fetch: localModelFetch(model, request), maxRetries: 2 });
    expect(result.stopReason).toBe(terminal === "incomplete" ? "length" : "error");
    if (terminal === "incomplete") expect(result.rawStopReason).toBe("incomplete.max_output_tokens");
    else expect(result.errorMessage).toContain("terminal response event");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["user", "toolResult"] as const)("refuses text-only Responses %s images before the SDK can replace them with placeholders", async (role) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [provider]);
    await runtime.login(provider.id, "api_key", { prompt: async () => "CANARY_RESPONSES_TEST_ONLY", notify: () => {} });
    const model = runtime.getModel(provider.id, "fixture-model")!;
    const content = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const message = role === "user" ? { role, timestamp: 1, content }
      : { role, toolCallId: "call_fixture|fc_fixture", toolName: "game_use", content, isError: false, timestamp: 1 };
    for (const method of ["complete", "completeSimple"] as const) {
      const request = vi.fn<typeof fetch>();
      const options = { fetch: localModelFetch(model, request), maxRetries: 2 };
      const result = method === "complete" ? await runtime.complete(model, { messages: [message] }, options) : await runtime.completeSimple(model, { messages: [message] }, options);
      expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("image input") });
      expect(request).not.toHaveBeenCalled();
    }
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records.filter(entry => entry.event === "finished").map(entry => entry.outcome)).toEqual(["validation_error", "validation_error"]);
    expect(records.every(entry => !entry.statusCode && !entry.requestBytes)).toBe(true);
  });

  it("constructs standard Responses user and tool-result images in an isolated hypothetical image-enabled connection", async () => {
    const root = await directory();
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [provider]);
    await runtime.login(provider.id, "api_key", { prompt: async () => "CANARY_RESPONSES_IMAGE_FIXTURE_ONLY", notify: () => {} });
    const configured = runtime.getModel(provider.id, "fixture-model")!;
    expect(configured.input).not.toContain("image");
    const enabled = { ...configured, input: ["text", "image"] as ("text" | "image")[] };
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const request = vi.fn<typeof fetch>(async () => responsesSse(
      { type: "response.created", response: { id: "resp_image_fixture", status: "in_progress" } },
      { type: "response.completed", response: { id: "resp_image_fixture", status: "completed", output: [], usage: responseUsage } },
    ));
    await runtime.completeSimple(enabled, { messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Inspect the synthetic image" }, image] },
      { role: "assistant", api: enabled.api, provider: enabled.provider, model: enabled.id, stopReason: "toolUse", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: "call_image|fc_image", name: "inspect", arguments: {} }] },
      { role: "toolResult", toolCallId: "call_image|fc_image", toolName: "inspect", timestamp: 3, isError: false, content: [{ type: "text", text: "Synthetic screenshot" }, image] },
    ] }, { fetch: localModelFetch(enabled, request), maxRetries: 0 });
    expect(request).toHaveBeenCalledOnce();
    const payload = await new Response(request.mock.calls[0]![1]!.body).json();
    const user = payload.input.find((item: any) => item.role === "user");
    expect(user.content).toContainEqual({ type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" });
    expect(payload.input).toContainEqual({ type: "function_call_output", call_id: "call_image", output: [
      { type: "input_text", text: "Synthetic screenshot" }, { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
    ] });
    expect(JSON.stringify(payload)).not.toContain("see attached image");
    expect(configured.input).not.toContain("image");
  });

  describe.each(testRoutes)("billed request retry boundary for $id", ({ providerId, id }) => {
    it.each(["http-503", "connection-reset"] as const)("never retries %s through complete or completeSimple even when requested", async (failure) => {
      const root = await directory();
      const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider(), provider]);
      const key = "CANARY_KUNPO_NO_RETRY_TEST_ONLY";
      await runtime.login(providerId, "api_key", { prompt: async () => key, notify: () => {} });
      const model = runtime.getModel(providerId, id)!;
      for (const method of ["complete", "completeSimple"] as const) {
        const request = vi.fn<typeof fetch>(async () => {
          if (failure === "connection-reset") throw new TypeError("Simulated upstream connection reset");
          return Response.json({ error: { type: "overloaded_error", message: "Simulated service interruption" } }, { status: 503 });
        });
        const context = { messages: [{ role: "user" as const, timestamp: 1, content: "Inspect the fixture" }] };
        const options = { fetch: localModelFetch(model, request), maxRetries: 2, signal: AbortSignal.timeout(2_000) };
        const result = method === "complete" ? await runtime.complete(model, context, options) : await runtime.completeSimple(model, context, options);
        expect(result.stopReason).toBe("error");
        expect(request).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).not.toContain(key);
        const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
        expect(body.model).toBe(id);
      }
    });
  });

  it.each([
    { id: "claude-opus-5-5", useImageUrl: true, thinking: "adaptive", effort: "medium" },
    { id: "claude-fable-5-2", useImageUrl: false, thinking: undefined, effort: undefined },
  ])("sends $id images and tools and replays signed thinking with an image tool result", async ({ id, useImageUrl, thinking, effort }) => {
    const root = await directory();
    const library = new AssetLibrary(root); await library.load();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"), generated = { bytes };
    const url = "https://kunpoapiimg.ziy.cc/opus.png?signature=fake-opus-source"; rememberKunpoImageSource(generated, url, "https://llm.ziy.cc");
    const asset = await library.add("opus.png", bytes, { origin: "generated" }); await library.bindGeneratedImageSource(asset.id, generated);
    const runtime = await createLocalModelRuntime(path.join(root, "local-api-keys.json"), async () => [kunpoRuntimeProvider()], library);
    await runtime.login("kunpo", "api_key", { prompt: async () => "CANARY_KUNPO_TEST_ONLY", notify: () => {} });
    const model = runtime.getModel("kunpo", id)!;
    const messageStart = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}`;
    const endResponse = [
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ready"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}', "",
    ].join("\n\n");
    const toolResponse = [
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspect the fixture"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"fixture_signature"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_fixture","name":"inspect","input":{}}}',
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"label":"fixture"}' } })}`,
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}', "",
    ].join("\n\n");
    const request = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(toolResponse, { headers: { "content-type": "text/event-stream" } }))
      .mockImplementationOnce(async () => new Response(endResponse, { headers: { "content-type": "text/event-stream" } }));
    const known = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64"), libraryAssetId: asset.id }, uploaded = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
    const user = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "Inspect the fixture" }, known, uploaded] };
    const parameters = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    const tools = [{ name: "inspect", description: "Inspect the fixture", parameters }];
    const guarded = localModelFetch(model, request);
    const result = await runtime.completeSimple(model, { messages: [user], tools }, { fetch: guarded, maxRetries: 0 });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call_fixture", name: "inspect", arguments: { label: "fixture" } }));
    expect(request).toHaveBeenCalledOnce();
    expect(new URL(String(request.mock.calls[0]![0])).pathname).toBe("/v1/messages");
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body.model).toBe(id);
    expect(body.tools).toContainEqual(expect.objectContaining({ name: "inspect", input_schema: expect.objectContaining(parameters) }));
    expect(body.thinking?.type).toBe(thinking);
    expect(body.output_config?.effort).toBe(effort);
    expect(body.temperature).toBeUndefined();
    const inline = { type: "base64", media_type: "image/png", data: uploaded.data };
    const expectedSources = [useImageUrl ? { type: "url", url } : inline, inline];
    expect(body.messages[0].content.filter((part: any) => part.type === "image").map((part: any) => part.source)).toEqual(expectedSources);
    const completed = await runtime.completeSimple(model, { messages: [user, result, {
      role: "toolResult", toolCallId: "call_fixture", toolName: "inspect", content: [{ type: "text", text: "Fixture inspected" }, known, uploaded], isError: false, timestamp: 2,
    }], tools }, { fetch: guarded, maxRetries: 0 });
    expect(completed.stopReason).toBe("stop");
    expect(request).toHaveBeenCalledTimes(2);
    const continued = JSON.parse(String(request.mock.calls[1]![1]?.body));
    expect(continued.messages.find((message: { role: string }) => message.role === "assistant").content).toContainEqual({ type: "thinking", thinking: "Inspect the fixture", signature: "fixture_signature" });
    expect(continued.messages.at(-1).content).toContainEqual(expect.objectContaining({ type: "tool_result", tool_use_id: "call_fixture" }));
    const returned = continued.messages.flatMap((message: any) => message.content.filter((part: any) => part.type === "tool_result")).flatMap((part: any) => part.content).filter((part: any) => part.type === "image");
    expect(returned.map((part: any) => part.source)).toEqual(expectedSources);
    expect(JSON.stringify(user) + JSON.stringify(result)).not.toContain("fake-opus-source");
    expect(JSON.stringify(continued)).not.toContain("libraryAssetId");
  });
});
