import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISessionTransport } from "../src/daemon/openai-session-transport.js";
import { OpenAISessionFiles } from "../src/daemon/openai-session-files.js";
import { IMAGE_OFFLOAD_ENTRY, IMAGE_ORIGINS_ENTRY, SessionImages, wireImages, type Json } from "../src/daemon/session-images.js";
import { installSessionImageRequests } from "../src/daemon/session-image-requests.js";
import { createLocalModelRuntime, LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import type { ResponsesTransportMode } from "../src/shared/contracts.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { rememberKunpoImageSource } from "../src/daemon/provider-image-source.js";
import { AgentManager, type CodingSession } from "../src/daemon/agent.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ConversationManager } from "../src/daemon/conversations.js";
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));

const BASE_URL = "http://127.0.0.1:43219/v1";
const completed = (output: unknown[] = [], id = "sse-response") => ({ type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
function answer(n = 1) {
  const item = { type: "message", id: `msg-${n}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Done", annotations: [] }] };
  return sse(
    { type: "response.created", response: { id: `resp-${n}`, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Done" },
    { type: "response.output_item.done", output_index: 0, item }, completed([item], `resp-${n}`),
  );
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(options: {
  tools?: ToolDefinition[];
  transportMode?: (provider: string) => ResponsesTransportMode;
  onStream?: (options: Parameters<AgentSession["agent"]["streamFunction"]>[2]) => void;
  imageLibrary?: AssetLibrary;
  chat?: boolean;
  sessionManager?: SessionManager;
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-image-requests-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const credentials = path.join(dir, "literal-api-keys.json");
  await new LocalApiKeyStore(credentials).modify("session-fixture", async () => ({ type: "api_key", key: "sk-SESSION_IMAGE_FAKE_CANARY" }));
  const runtime = await createLocalModelRuntime(credentials, async () => [{ id: "session-fixture", config: {
    api: options.chat ? "openai-completions" : "openai-responses", baseUrl: options.chat ? "https://llm.ziy.cc/v1" : BASE_URL, models: [{ id: "vision-fixture", name: "Local vision fixture", input: ["text", "image"], reasoning: false,
      contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } }], options.imageLibrary);
  const model = runtime.getModel("session-fixture", "vision-fixture")!;
  const manager = options.sessionManager ?? SessionManager.inMemory(dir);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: "idle" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  const images = new SessionImages(manager, dir);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: manager, customTools: [images.recallTool, ...(options.tools ?? [])] });
  cleanup.push(() => session.dispose());
  const original = session.agent.streamFunction;
  session.agent.streamFunction = (selected, context, streamOptions) => { options.onStream?.(streamOptions); return original(selected, context, streamOptions); };
  const socketFactory = vi.fn(() => { throw new Error("WebSocket must remain unavailable"); });
  const transport = new OpenAISessionTransport(images, new OpenAISessionFiles(dir), socketFactory);
  installSessionImageRequests(session, images, dir, { transport, transportMode: options.transportMode });
  return { session, manager, settings, socketFactory, images };
}
async function image() {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
  return { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
}
function capture(requests: Json[], respond: () => Response = () => answer(requests.length)) {
  const network = vi.fn<typeof fetch>(async (input, init) => { requests.push(await new Request(input, init).json()); return respond(); });
  vi.stubGlobal("fetch", network);
  return network;
}
const lastAssistant = (session: AgentSession) => session.messages.findLast((message) => message.role === "assistant");

describe("Pi session image request integration", () => {
  it("binds application Agent turns before SDK persistence and restores the correct image origins after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-origin-history-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const library = new AssetLibrary(root); await library.load(); const original = await image(), bytes = Buffer.from(original.data, "base64");
    const generated = { bytes }, url = "https://kunpoapiimg.ziy.cc/agent.png?signature=fake-agent-origin";
    rememberKunpoImageSource(generated, url, "https://llm.ziy.cc/v1"); const asset = await library.add("agent.png", bytes, { origin: "generated" }); await library.bindGeneratedImageSource(asset.id, generated);
    const projects = new ProjectManager(root, library), project = await projects.create("Synthetic origin", "web-game"), conversations = new ConversationManager();
    const conversation = await conversations.create(project), canonical = conversations.open(project, conversation);
    const first = await fixture({ chat: true, imageLibrary: library, sessionManager: canonical });
    const agents = new AgentManager(new RuntimeEventBus(), { createSession: async () => Object.assign(first.session, { emitsInitialUserMessage: true }) as unknown as CodingSession }); cleanup.push(() => agents.close());
    const requests: Json[] = []; const network = capture(requests, () => new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    await agents.prompt(project, conversation, "Inspect", [], [{ mediaType: "image/png", data: original.data, libraryAssetId: asset.id }, { mediaType: "image/png", data: original.data }]).result;
    expect(network).toHaveBeenCalledOnce();
    const expected = [url, `data:image/png;base64,${original.data}`];
    const urls = (request: Json) => (request.messages as any[]).flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
    expect(urls(requests[0]!)).toEqual(expected);
    const saved = await readFile(conversation.sessionPath, "utf8"); expect(saved).not.toContain("fake-agent-origin"); expect(saved).toContain("ohmygame-image-origins-v1");
    await agents.close();
    const restored = await fixture({ chat: true, imageLibrary: library, sessionManager: SessionManager.open(conversation.sessionPath, path.dirname(conversation.sessionPath), project.workspacePath) });
    const nextAgents = new AgentManager(new RuntimeEventBus(), { createSession: async () => Object.assign(restored.session, { emitsInitialUserMessage: true }) as unknown as CodingSession }); cleanup.push(() => nextAgents.close());
    await nextAgents.prompt(project, conversation, "Continue the previous images").result;
    expect(network).toHaveBeenCalledTimes(2); expect(urls(requests[1]!)).toEqual(expected);
    expect(await readFile(conversation.sessionPath, "utf8")).not.toContain("fake-agent-origin");
    const secondGenerated = { bytes }, secondUrl = "https://kunpoapiimg.ziy.cc/agent-b.png?signature=fake-agent-b-origin";
    rememberKunpoImageSource(secondGenerated, secondUrl, "https://llm.ziy.cc/v1"); const assetB = await library.add("agent-b.png", bytes, { origin: "generated" }); await library.bindGeneratedImageSource(assetB.id, secondGenerated);
    const respond = network.getMockImplementation()!; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    network.mockImplementationOnce(async (input, init) => { await gate; return respond(input, init); });
    const running = nextAgents.prompt(project, conversation, "Same prompt", [], [{ mediaType: "image/png", data: original.data, libraryAssetId: asset.id }]);
    try {
      await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3));
      const queued = nextAgents.prompt(project, conversation, "Same prompt", [], [{ mediaType: "image/png", data: original.data, libraryAssetId: assetB.id }]); await queued.result;
      const removed = nextAgents.prompt(project, conversation, "Same prompt", [], [{ mediaType: "image/png", data: original.data }]); await removed.result;
      expect(await nextAgents.removePending(project.id, conversation.summary.id, removed.turnId)).toBe(true);
      expect(await nextAgents.steerPending(project.id, conversation.summary.id, queued.turnId)).toBe(true);
    } finally { release(); }
    await running.result; expect(network).toHaveBeenCalledTimes(4);
    expect(urls(requests[3]!)).toEqual([...expected, url, secondUrl]);
    expect(restored.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === IMAGE_ORIGINS_ENTRY)).toHaveLength(3);
    const revised = await nextAgents.reviseLast(project, conversation, "Revised prompt, same image", async reference => reference); await revised.result;
    expect(network).toHaveBeenCalledTimes(5); expect(urls(requests[4]!).at(-1)).toBe(secondUrl);
    const final = await readFile(conversation.sessionPath, "utf8");
    for (const secret of [url, secondUrl, "sk-SESSION_IMAGE_FAKE_CANARY"]) expect(final).not.toContain(secret);
  });

  it("conservatively keeps real-session images inline when SDK normalization discards origin hints, including identical uploads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-source-session-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const library = new AssetLibrary(root); await library.load(); const reference = await image(), generated = { bytes: Buffer.from(reference.data, "base64") };
    const url = "https://kunpoapiimg.ziy.cc/session.png?signature=fake-session-source"; rememberKunpoImageSource(generated, url, "https://llm.ziy.cc/v1");
    const asset = await library.add("session.png", generated.bytes, { origin: "generated" }); await library.bindGeneratedImageSource(asset.id, generated);
    const { session, manager } = await fixture({ chat: true, imageLibrary: library });
    const requests: Json[] = []; const network = capture(requests, () => new Response([
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}',
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    await session.prompt("Inspect", { images: [{ ...reference, libraryAssetId: asset.id } as typeof reference, reference] });
    await session.prompt("Continue from the same images"); expect(network).toHaveBeenCalledTimes(2);
    for (const request of requests) {
      const urls = (request.messages as any[]).flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
      expect(urls).toEqual([`data:image/png;base64,${reference.data}`, `data:image/png;base64,${reference.data}`]);
    }
    expect(JSON.stringify(manager.getBranch())).not.toContain("fake-session-source");
    expect(JSON.stringify(manager.getBranch())).not.toContain("libraryAssetId");
  });

  it("sends complete canonical history over SSE and retains originals without Files or WebSocket requests", async () => {
    const { session, manager, settings, socketFactory } = await fixture();
    const requests: Json[] = [], network = capture(requests), original = await image();
    await session.prompt("Inspect this", { images: [original] }); await session.prompt("Inspect it again");
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls.every(([input, init]) => new Request(input, init).url === `${BASE_URL}/responses`)).toBe(true);
    expect(requests.every((request) => !Object.hasOwn(request, "previous_response_id"))).toBe(true);
    expect(JSON.stringify(requests[1].input)).toContain("Inspect this"); expect(JSON.stringify(requests[1].input)).toContain("Inspect it again");
    expect(JSON.stringify(requests[1].input)).toContain(original.data);
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")).toMatchObject({ message: { content: expect.arrayContaining([original]) } });
    expect(settings.getCacheWarmingMode()).toBe("off"); expect(socketFactory).not.toHaveBeenCalled();
  });

  it("reopens an omitted reference and sends the recalled original through the real Pi tool loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-recalled-reference-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const manager = SessionManager.create(root, path.join(root, "sessions")), original = await image();
    const first = await fixture({ sessionManager: manager });
    const initial: Json[] = []; capture(initial);
    await first.session.prompt("Inspect the attached reference", { images: [original] });
    const reference = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
    const imageId = `${reference.id}:0`;
    manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope: "inline", images: [imageId] });
    first.session.dispose();

    const reopened = SessionManager.open(manager.getSessionFile()!, path.join(root, "sessions"), root);
    const next = await fixture({ sessionManager: reopened });
    const requests: Json[] = [], recall = vi.spyOn(next.images.recallTool, "execute");
    const network = capture(requests, () => {
      if (requests.length !== 1) return answer(requests.length);
      const call = { type: "function_call", id: "fc-recall", call_id: "recall-reference", name: "recall_image", arguments: JSON.stringify({ imageId }), status: "completed" };
      return sse({ type: "response.created", response: { id: "resp-recall", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: call.arguments },
        { type: "response.output_item.done", output_index: 0, item: call }, completed([call], "resp-recall"));
    });
    await next.session.prompt("Read the retained reference again with recall_image");

    expect(network).toHaveBeenCalledTimes(2); expect(recall).toHaveBeenCalledOnce();
    expect(wireImages(requests[0])).toHaveLength(0);
    expect(JSON.stringify(requests[0])).toContain(`Image omitted from model context. Session image: ${imageId}`);
    expect(wireImages(requests[1])).toMatchObject([{ mime: original.mimeType, data: original.data }]);
    const result = reopened.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "recall-reference|fc-recall");
    expect(result).toMatchObject({ message: { isError: false, content: expect.arrayContaining([original]) } });
    expect(reopened.getEntry(reference.id)).toMatchObject({ message: { content: expect.arrayContaining([original]) } });
    expect(next.socketFactory).not.toHaveBeenCalled();
  });

  it.each(["another branch", "another session"] as const)("rejects a retained reference from %s without returning image bytes", async (scope) => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-reference-scope-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const original = await image(), source = SessionManager.create(root, path.join(root, "sessions"));
    const before = source.appendMessage({ role: "user", timestamp: 1, content: "Before the reference" });
    const hidden = source.appendMessage({ role: "user", timestamp: 2, content: [original] });
    // Flush the persistent session without asking a model or changing its branch.
    source.appendMessage({ role: "assistant", api: "openai-responses", provider: "session-fixture", model: "vision-fixture", content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
    const manager = scope === "another branch"
      ? SessionManager.open(source.getSessionFile()!, path.join(root, "sessions"), root)
      : SessionManager.inMemory(root);
    if (scope === "another branch") manager.branch(before);
    const { session, socketFactory } = await fixture({ sessionManager: manager });
    const requests: Json[] = [], network = capture(requests, () => {
      if (requests.length !== 1) return answer(requests.length);
      const call = { type: "function_call", id: "fc-unavailable", call_id: "recall-unavailable", name: "recall_image", arguments: JSON.stringify({ imageId: `${hidden}:0` }), status: "completed" };
      return sse({ type: "response.created", response: { id: "resp-unavailable", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: call.arguments },
        { type: "response.output_item.done", output_index: 0, item: call }, completed([call], "resp-unavailable"));
    });
    await session.prompt("Recall the requested reference");
    expect(network).toHaveBeenCalledTimes(2);
    expect(requests.flatMap(request => wireImages(request))).toHaveLength(0);
    const result = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "recall-unavailable|fc-unavailable");
    expect(result).toMatchObject({ message: { isError: true, content: [{ type: "text", text: expect.stringContaining("not available on this conversation branch") }] } });
    expect(source.getEntry(hidden)).toMatchObject({ message: { content: [original] } });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("rejects a reopened image history before HTTP when the selected model has no image input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-reference-model-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const manager = SessionManager.create(root, path.join(root, "sessions")), original = await image();
    const first = await fixture({ sessionManager: manager }); capture([]);
    await first.session.prompt("Inspect the attached reference", { images: [original] }); first.session.dispose();
    const reopened = SessionManager.open(manager.getSessionFile()!, path.join(root, "sessions"), root);
    const next = await fixture({ sessionManager: reopened });
    await next.session.setModel({ ...next.session.model!, input: ["text"] });
    const network = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", network);
    await next.session.prompt("Continue using the retained reference");
    expect(lastAssistant(next.session)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("does not have image input enabled") });
    expect(network).not.toHaveBeenCalled(); expect(next.socketFactory).not.toHaveBeenCalled();
    expect(reopened.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content)
      && entry.message.content.some(block => block.type === "image" && block.data === original.data))).toBe(true);
  });

  it("checks image budgets after extension payload transforms and fails before HTTP", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { session, socketFactory } = await fixture();
    const network = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", network);
    const upstream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => upstream(model, context, { ...options,
      onPayload: (payload) => ({ ...(payload as Json), input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(21 * 1024 * 1024)}` }] }] }),
    });
    await session.prompt("Too large");
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("local image/history budget") });
    expect(network).not.toHaveBeenCalled(); expect(socketFactory).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.event === "finished")).toMatchObject([{ outcome: "validation_error", receivedBytes: 0 }]);
  });

  it.each(["close", "network-error", "timeout", "invalid-event"])("does not resubmit an uncertain SSE %s", async (failure) => {
    const { session, socketFactory } = await fixture();
    const network = vi.fn<typeof fetch>(async () => {
      if (failure === "network-error") throw new Error("connection reset");
      if (failure === "timeout") throw new DOMException("fixture timeout", "TimeoutError");
      return failure === "close" ? sse({ type: "response.created", response: { id: "partial", status: "in_progress" } })
        : new Response("data: invalid JSON\n\n", { headers: { "content-type": "text/event-stream" } });
    }); vi.stubGlobal("fetch", network);
    const retries = vi.fn(); session.subscribe((event) => { if (event.type === "auto_retry_start") retries(); });
    await session.prompt("Continue");
    expect(network).toHaveBeenCalledOnce(); expect(retries).not.toHaveBeenCalled(); expect(socketFactory).not.toHaveBeenCalled();
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
  });

  it("keeps saved transport preferences inert and uses guarded HTTP for every next request", async () => {
    let mode: ResponsesTransportMode = "auto";
    const resolveMode = vi.fn(() => mode);
    const { session, socketFactory, settings } = await fixture({ transportMode: resolveMode });
    const requests: Json[] = [], network = capture(requests);
    for (const selected of ["auto", "websocket", "sse", "websocket"] as const) { mode = selected; await session.prompt(selected); }
    expect(network).toHaveBeenCalledTimes(4); expect(socketFactory).not.toHaveBeenCalled();
    expect(requests.every((request) => !Object.hasOwn(request, "previous_response_id"))).toBe(true);
    expect(settings.getCacheWarmingMode()).toBe("off"); expect(resolveMode).not.toHaveBeenCalled();
  });

  it("keeps warming off even with an explicit Pi SSE transport", async () => {
    const { session, settings, socketFactory } = await fixture(); session.agent.transport = "sse";
    const requests: Json[] = [], network = capture(requests); await session.prompt("Use SSE");
    expect(settings.getCacheWarmingMode()).toBe("off"); expect(network).toHaveBeenCalledOnce(); expect(socketFactory).not.toHaveBeenCalled();
  });

  it.each([301, 307, 308].flatMap((status) => (["auto", "sse", "websocket"] as const).map((mode) => ({ status, mode }))))(
    "refuses $status redirects and WebSocket for saved $mode mode", async ({ status, mode }) => {
      const { session, socketFactory } = await fixture({ transportMode: () => mode });
      const network = vi.fn<typeof fetch>(async () => new Response(null, { status, headers: { location: "https://author.example/collect" } })); vi.stubGlobal("fetch", network);
      await session.prompt("Do not forward credentials");
      expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0]?.[1]?.redirect).toBe("error");
      expect(new Request(network.mock.calls[0]![0], network.mock.calls[0]![1]).url).toBe(`${BASE_URL}/responses`);
      expect(lastAssistant(session)).toMatchObject({ stopReason: "error" }); expect(socketFactory).not.toHaveBeenCalled();
    },
  );

  it.each(["auto", "sse"] as const)("preserves encoded bytes and error redirect policy in %s mode", async (mode) => {
    let wrappedFetch: typeof fetch | undefined;
    const { session, images, socketFactory } = await fixture({ transportMode: () => mode, onStream: (options) => { wrappedFetch = options?.fetch; } });
    const network = vi.fn<typeof fetch>(async () => answer()); vi.stubGlobal("fetch", network); await session.prompt("Capture fetch");
    const budget = vi.spyOn(images, "budget"), encoded = gzipSync(JSON.stringify({ input: [{ role: "user", content: "Encoded request" }] }));
    await wrappedFetch!(new Request(`${BASE_URL}/responses`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: encoded }));
    const sent = new Request(network.mock.calls[1]![0], network.mock.calls[1]![1]);
    expect(sent.redirect).toBe("error"); expect(sent.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(encoded)); expect(budget).not.toHaveBeenCalled(); expect(socketFactory).not.toHaveBeenCalled();
  });

  it.each(["error", "failed", "before-start"])("does not resubmit a provider %s SSE rejection", async (kind) => {
    const { session, socketFactory } = await fixture(), error = { code: "server_error", message: "Fixture provider rejection" };
    const network = vi.fn<typeof fetch>(async () => sse(
      ...(kind === "before-start" ? [] : [{ type: "response.created", response: { id: "rejected", status: "in_progress" } }]),
      kind === "failed" ? { type: "response.failed", response: { id: "rejected", status: "failed", error } } : { type: "error", ...error },
    )); vi.stubGlobal("fetch", network); await session.prompt("Do not repeat a billed submission");
    expect(network).toHaveBeenCalledOnce(); expect(socketFactory).not.toHaveBeenCalled(); expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
  });

  it.each([401, 429, 400, 503])("does not retry HTTP %s or expose provider error credentials", async (status) => {
    const { session, socketFactory } = await fixture();
    const network = vi.fn<typeof fetch>(async () => new Response("sk-SESSION_IMAGE_FAKE_CANARY", { status })); vi.stubGlobal("fetch", network);
    await session.prompt("Rejected request"); expect(network).toHaveBeenCalledOnce(); expect(socketFactory).not.toHaveBeenCalled();
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error" }); expect(JSON.stringify(lastAssistant(session))).not.toContain("sk-SESSION_IMAGE_FAKE_CANARY");
  });

  it("does not resubmit after a failed SSE body", async () => {
    const { session } = await fixture();
    const network = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture response interrupted")); } }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", network); await session.prompt("Continue"); expect(network).toHaveBeenCalledOnce(); expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
  });

  it("cancels the buffered SSE body and upstream signal without retrying", async () => {
    const { session } = await fixture(), cancelled = vi.fn(), aborted = vi.fn();
    const network = vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.addEventListener("abort", aborted, { once: true });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"partial"}}\n\n')); }, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } });
    }); vi.stubGlobal("fetch", network); const pending = session.prompt("Cancel");
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce()); await session.abort(); await pending;
    expect(aborted).toHaveBeenCalledOnce(); expect(cancelled).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledOnce(); expect(lastAssistant(session)).toMatchObject({ stopReason: "aborted" });
  });

  it("retains completed tools but does not execute calls from an incomplete next response", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Completed tool result" }], details: {} }));
    const { session } = await fixture({ tools: [{ name: "test_tool", label: "Test tool", description: "Test tool", parameters: Type.Object({}), execute }] });
    const requests: Json[] = []; capture(requests, () => {
      const item = { type: "function_call", id: `fc-${requests.length}`, call_id: requests.length === 1 ? "completed-call" : "failed-call", name: "test_tool", arguments: "{}", status: "completed" };
      const events = [{ type: "response.created", response: { id: `resp-${requests.length}`, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }, { type: "response.output_item.done", output_index: 0, item }];
      return sse(...events, ...(requests.length === 1 ? [completed([item], "resp-1")] : []));
    });
    await session.prompt("Use tool"); expect(execute).toHaveBeenCalledOnce(); expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].input)).toContain("Completed tool result"); expect(JSON.stringify(requests[1].input)).toContain("completed-call");
    expect(JSON.stringify(requests[1].input)).not.toContain("failed-call"); expect(requests[1]).not.toHaveProperty("previous_response_id"); expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
  });

  it("shrinks HTTP 413 once and persists omission while keeping canonical originals", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { session, manager, images } = await fixture(), budget = vi.spyOn(images, "budget"), requests: Json[] = [];
    const network = capture(requests, () => requests.length === 2 ? new Response("too large", { status: 413 }) : answer(requests.length));
    const original = await image(); await session.prompt("First", { images: [original, original, original, original] }); await session.prompt("Second"); await session.prompt("Third");
    const count = (request: Json) => JSON.stringify(request).match(/data:image\/png;base64,/g)?.length ?? 0;
    expect(requests.map(count)).toEqual([4, 4, 3, 3]); expect(network).toHaveBeenCalledTimes(4); expect(budget).toHaveBeenCalledTimes(4);
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(entry => entry.event === "finished");
    expect(records.map(entry => entry.outcome)).toEqual(["completed", "http_error", "completed", "completed"]);
    expect(records[2].modelRequestId).toBe(records[1].localRequestId);
    expect(new Set(records.map(entry => entry.localRequestId)).size).toBe(4);
    expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
    expect(manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")).toMatchObject({ message: { content: expect.arrayContaining([original, original, original, original]) } });
    const firstUser = session.messages.find((message) => message.role === "user");
    expect(Array.isArray(firstUser?.content) ? firstUser.content.filter((block) => block.type === "image") : []).toEqual([original, original, original, original]);
  });

  it("stops after the single reduced request also receives HTTP 413", async () => {
    const { session, manager } = await fixture(), requests: Json[] = [];
    const network = capture(requests, () => requests.length === 1 ? answer() : new Response("too large", { status: 413 }));
    const original = await image();
    await session.prompt("First", { images: [original, original, original, original] });
    await session.prompt("Second");
    expect(network).toHaveBeenCalledTimes(3);
    expect(requests.map((request) => JSON.stringify(request).match(/data:image\/png;base64,/g)?.length ?? 0)).toEqual([4, 4, 3]);
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
    expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
  });

  it("does not resubmit HTTP 413 when every image belongs to the protected current turn", async () => {
    const { session, manager } = await fixture(), requests: Json[] = [];
    const network = capture(requests, () => new Response("too large", { status: 413 }));
    const original = await image(); await session.prompt("Current reference", { images: [original] });
    expect(network).toHaveBeenCalledOnce();
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("local image/history budget") });
    expect(manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(0);
    expect(manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")).toMatchObject({ message: { content: expect.arrayContaining([original]) } });
  });

  it.each(["google-generative-ai", "google-vertex"] as const)("rejects unreviewed %s before HTTP", async (api) => {
    const { session, socketFactory } = await fixture(); await session.setModel({ ...session.model!, api });
    const network = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", network); await session.prompt("Do not bypass HTTP guard");
    expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("network transport is isolated") });
    expect(network).not.toHaveBeenCalled(); expect(socketFactory).not.toHaveBeenCalled();
  });
});
