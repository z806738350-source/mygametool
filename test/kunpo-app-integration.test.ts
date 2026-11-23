import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { referenceWav } from "./audio-reference-fixture.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import * as agentRuntime from "../src/daemon/agent.js";
import * as piToolSearch from "../src/daemon/pi-tool-search.js";
import { promptContextBlock } from "../src/daemon/prompt-context.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { createLocalModelRuntime, LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { kunpoRuntimeProvider } from "../src/daemon/provider-model-settings.js";
import { VolcengineSeedAudioSettingsStore } from "../src/daemon/volcengine-seed-audio-settings.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { SeedanceSettingsStore } from "../src/daemon/seedance-settings.js";
import { ModelAuthManager } from "../src/daemon/model-auth.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { TEST_GLB } from "./model3d-fixture.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import type { AudioRequestDiagnostic, ConversationDetail, ToolJob } from "../src/shared/contracts.js";
import { referencePng, pngScanlines } from "./video-reference-png-fixture.js";
import * as pngPreparation from "../src/daemon/video-reference-png.js";
import * as jpegPreparation from "../src/daemon/video-reference-jpeg.js";
import * as canvasFiles from "../src/daemon/canvas-files.js";
import * as continuation from "../src/daemon/agent-auto-continue.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import * as kunpoModels from "../src/shared/kunpo-models.js";

// App wiring and real local credential storage, with no socket or external DNS/HTTP.
const appArtifactDns = vi.hoisted(() => vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]));
vi.mock("node:dns/promises", async (original) => ({ ...await original<typeof import("node:dns/promises")>(),
  lookup: appArtifactDns,
}));

const KEY = "sk-kunpo-app-integration-canary-20261028";
const LEGACY_KEY = "sk-legacy-vendor-app-canary-20261028";
const ACCESS_TOKEN = "local-kunpo-integration-token";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const MP4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]);
const DEFAULTS = {
  agent: { provider: "kunpo", id: "gpt-5.6-sol" },
  image: { provider: "openai", id: "gpt-image-2.5-sunburst" },
  video: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" },
  "sound-effect": { provider: "volcengine-seed-audio", id: "seed-audio-1.0" },
  speech: { provider: "volcengine-tts", id: "seed-audio-1.0" },
  "3d-generation": { provider: "tripo", id: "v3.1-20260211" },
  "3d-remesh": { provider: "tripo", id: "v3.0" },
  "3d-rig": { provider: "tripo", id: "v3.0-20260909" },
  "3d-texture": { provider: "tripo", id: "v3.5-20260815" },
};

const applications: ReturnType<typeof createApp>[] = [], directories: string[] = [];
afterEach(async () => {
  appArtifactDns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  await Promise.all(applications.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-app-"));
  directories.push(directory); return directory;
}

function transport() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["llm.ziy.cc", "kunpoapiimg.ziy.cc"].includes(url.hostname)) throw new Error("Unexpected non-Kunpo HTTP request");
    if (url.hostname === "kunpoapiimg.ziy.cc") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    if (url.pathname === "/v1/audio/speech") return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    if (url.pathname === "/doubao/api/v3/contents/generations/tasks") return Response.json({ id: "task_app_video" });
    if (url.pathname === "/doubao/api/v3/contents/generations/tasks/task_app_video") return Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/app-video.mp4" } });
    if (url.pathname === "/tripo/v3/files") return Response.json({ code: 0, data: { file_token: "file_app_model_reference" } });
    if (url.pathname === "/tripo/v3/generation/image-to-model" && init?.method === "POST") return Response.json({ code: 0, data: { task_id: "task_app_model" } });
    if (url.pathname === "/tripo/v3/tasks/task_app_model") return Response.json({ code: 0, data: { status: "success", output: {} } });
    if (url.pathname === "/v1/tasks/task_app_model/artifacts") return Response.json({ task_id: "task_app_model", artifacts: [{ key: "model", mime_type: "model/gltf-binary", content_url: "https://llm.ziy.cc/v1/tasks/task_app_model/artifacts/model/content" }] });
    if (url.pathname === "/v1/tasks/task_app_model/artifacts/model/content") return new Response(new Uint8Array(TEST_GLB));
    throw new Error("Unexpected Kunpo test route");
  });
}

async function fixture(existingDirectory?: string, answerKey = true, provider = kunpoRuntimeProvider()) {
  const directory = existingDirectory ?? await temporary();
  const request = transport();
  vi.stubGlobal("fetch", request);
  const app = createApp({
    dataDirectory: directory, piAgentDirectory: directory, accessToken: ACCESS_TOKEN,
    imageFetch: request, audioFetch: request, videoFetch: request, model3DFetch: request,
    cloudFetch: request, publishFetch: request, modelDiscoveryFetch: request,
    createModelRuntime: async () => {
      const runtime = await createLocalModelRuntime(path.join(directory, "local-api-keys.json"), async () => [provider]);
      const login = runtime.login.bind(runtime);
      // Answer the local secret prompt inside the fixture; no HTTP listener/SSE approval is needed.
      if (answerKey) runtime.login = (id, method, interaction, options) => login(id, method, {
        ...interaction, prompt: async () => {
          if (id !== "kunpo" || method !== "api_key") throw new Error("Unexpected credential operation");
          return KEY;
        },
      }, options);
      return runtime;
    },
  });
  applications.push(app);
  const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({
    method, url, ...(payload === undefined ? {} : { payload }), headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const connect = async () => {
    const result = await inject("POST", "/settings/models/providers/kunpo/login", { method: "api_key" });
    expect(result.statusCode, result.body).toBe(202);
    await vi.waitFor(async () => {
      const providers = (await inject("GET", "/settings/providers")).json();
      expect(providers.find((provider: { id: string }) => provider.id === "kunpo")?.configured).toBe(true);
    });
    const operationId = result.json().operationId as string;
    const completed = await inject("GET", `/settings/model-auth/${operationId}/events`);
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.body).toContain('"type":"completed"');
    expect(completed.body).not.toContain(KEY);
    return operationId;
  };
  return { app, directory, request, inject, connect };
}

async function finishJob(inject: Awaited<ReturnType<typeof fixture>>["inject"], id: string) {
  let job: { id: string; status: string; error?: string; model?: object; submissionOutcome?: string; audioDiagnostic?: AudioRequestDiagnostic } | undefined;
  await vi.waitFor(async () => {
    job = (await inject("GET", "/tool-jobs")).json().find((candidate: { id: string }) => candidate.id === id);
    expect(job?.status).not.toBe("running");
  }, { timeout: 3_000, interval: 20 });
  return job!;
}

async function expectNoPublicKey(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await expectNoPublicKey(file);
    else if (entry.isFile()) expect(await readFile(file, "utf8"), file).not.toContain(KEY);
  }
}

async function pngCanvasFixture(bytes = referencePng(), id: string = DEFAULTS.video.id, frame: boolean | 1 = false) {
  const setup = await fixture(); await setup.connect();
  const { inject, directory } = setup;
  const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Synthetic PNG canvas" })).json();
  const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
  const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
  const jobsFile = path.join(directory, "projects", project.id, "workspace", "canvas", "jobs.json");
  const node = createAssetGenerationNode("video", { x: 0, y: 0 }); if (node.type !== "video") throw new Error();
  const refs = [];
  for (let index = 0; index < (frame === true ? 2 : 1); index++) {
    const reply = await inject("POST", "/library/assets", { name: `synthetic-${index}.png`, image: { mediaType: "image/png", data: bytes.toString("base64") } });
    expect(reply.statusCode, reply.body).toBe(201); refs.push({ type: "library" as const, assetId: reply.json().id });
  }
  Object.assign(node.data, { prompt: "synthetic-prompt-not-in-summary", model: { provider: id === DEFAULTS.video.id ? "volcengine-ark" : "kunpo", id }, resolution: id === "minimax-video-h3" ? "768p" : "480p", aspectRatio: "adaptive", duration: 4, referenceMode: frame ? "frame" : "reference", references: refs });
  const detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
  expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
  const start = () => inject("POST", `${boardPath}/nodes/${node.id}/generate`);
  const finish = async (jobId: string, status: string) => {
    let job: any;
    await vi.waitFor(async () => { job = (await inject("GET", jobsPath)).json().find((entry: { id: string }) => entry.id === jobId); expect(job?.status).toBe(status); }, { timeout: 5000, interval: 20 });
    return job;
  };
  return { ...setup, bytes, refs, node, project, boardPath, jobsPath, jobsFile, start, finish };
}

function expectClosedPngSummary(summary: any) {
  expect(Object.keys(summary).sort()).toEqual(["version", "optimized", "unchanged", "unsupported", "invalid", "limited", "originalBytes", "sentBytes", ...(summary.version !== 1 ? ["jpegConverted", "jpegSkipped", "jpegTransparent", "jpegLimited", "jpegResized", "jpegOriented", "jpegQuality", "jpegMaxEdge", "requestBytes", "originalRequestBytes"] : []), ...(summary.version === 3 ? ["requestBudgetBytes", "requestBudgetMet", "requestBudgetPasses", "requestBudgetConverted", "requestBudgetResized", "requestBudgetQuality", "requestBudgetMaxEdge"] : [])].sort());
  expect(Object.entries(summary).every(([key, value]) => key === "requestBudgetMet" ? typeof value === "boolean" : typeof value === "number" && Number.isSafeInteger(value) && value >= 0)).toBe(true);
  for (const privateValue of [KEY, "data:", "https:", "synthetic-prompt-not-in-summary"]) expect(JSON.stringify(summary)).not.toContain(privateValue);
}

// Only the upstream stream is synthetic. Pi parses it and invokes the packaged local guide.
function kunpoAgentReply(model: string, reply: string | { name: string; arguments: object; id?: string; textBeforeCall?: string }) {
  const tool = typeof reply === "object";
  const name = tool ? reply.name : "", args = tool ? JSON.stringify(reply.arguments) : "", id = tool ? reply.id ?? "call_guide" : "call_guide";
  const text = tool ? "" : reply;
  let events: Array<{ type: string } & Record<string, unknown>>;
  if (model.startsWith("claude-")) {
    const intro = tool && reply.textBeforeCall;
    const index = intro ? 1 : 0;
    events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      ...(intro ? [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: intro } },
        { type: "content_block_stop", index: 0 },
      ] : []),
      { type: "content_block_start", index, content_block: tool ? { type: "tool_use", id, name, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: tool ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text } },
      { type: "content_block_stop", index },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  } else {
    const responseId = tool ? "resp_tool" : "resp_answer";
    const call = { type: "function_call", id: "fc_guide", call_id: id, name, arguments: args, status: "completed" };
    const answer = { type: "message", id: "msg_guide", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    events = [
      { type: "response.created", response: { id: responseId, status: "in_progress" } },
      ...(tool ? [
        { type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: args },
      ] : [
        { type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: answer.id, delta: text },
      ]),
      { type: "response.output_item.done", output_index: 0, item: tool ? call : answer },
      { type: "response.completed", response: { id: responseId, status: "completed", output: [tool ? call : answer], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
  }
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("Kunpo app integration", () => {
  it.skipIf(!process.env.BLENDER_EXECUTABLE)("saves and revises a script in Pi batches, inspecting real headless Blender pixels after each run", async () => {
    const { inject, connect, request } = await fixture(await realpath(await temporary())); await connect();
    const model = "gpt-6.2-astra";
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Offline proof test" })).json();
    const chat = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id: model } })).json();
    const base = `/projects/${project.id}/conversations/${chat.id}`;
    const script = [
      "import bpy, json, sys", "from pathlib import Path",
      "output = Path(sys.argv[sys.argv.index('--output-dir') + 1])",
      "shade = 0.25",
      "img = bpy.data.images.new('proof', width=8, height=8)",
      "img.pixels[:] = [shade, 0.0, 0.0, 1.0] * 64",
      "img.filepath_raw = str(output / 'proof.png')", "img.file_format = 'PNG'", "img.save()",
      "(output / 'report.json').write_text(json.dumps({'headless': bpy.app.background, 'shade': shade}))",
    ].join("\n");
    const scriptPath = "proof.py", workflow = "offline-review";
    const runs = `assets/blender/${workflow}/runs`;
    const seen = new Set<string>(), evidence: string[] = [];
    for (const phase of ["create", "revise", "failed-edit"] as const) {
      const revision = phase !== "create";
      // Repeating this exact edit after the successful revision must fail, leaving a runnable old file on disk.
      const save = revision ? { name: "edit", arguments: { path: scriptPath, edits: [{ oldText: "shade = 0.25", newText: "shade = 0.75" }] } }
        : { name: "write", arguments: { path: scriptPath, content: script } };
      const output = [save, { name: "run_blender", arguments: { workflow, stage: "custom", scriptPath } }].map((call, i) => ({
        type: "function_call", id: `fc_${phase}_${i}`, call_id: `call_${phase}_${i}`,
        status: "completed", name: call.name, arguments: JSON.stringify(call.arguments),
      }));
      const events = [
        { type: "response.created", response: { id: "resp_batch", status: "in_progress" } },
        ...output.flatMap((item, output_index) => [
          { type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } },
          { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
          { type: "response.output_item.done", output_index, item },
        ]),
        { type: "response.completed", response: { id: "resp_batch", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      request.mockClear().mockResolvedValueOnce(new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
      if (phase === "failed-edit") request.mockResolvedValueOnce(kunpoAgentReply(model, "Save failed"));
      else request.mockImplementationOnce(async () => {
          const directory = path.join(project.workspacePath, runs);
          const fresh = (await readdir(directory)).filter(id => !seen.has(id));
          expect(fresh).toHaveLength(1);
          const id = fresh[0]!; seen.add(id);
          const recipe = await readFile(path.join(directory, id, "recipe/script.py"), "utf8");
          expect(recipe).toBe(revision ? script.replace("shade = 0.25", "shade = 0.75") : script);
          expect(JSON.parse(await readFile(path.join(directory, id, "report.json"), "utf8"))).toEqual({ headless: true, shade: revision ? 0.75 : 0.25 });
          evidence.push((await readFile(path.join(directory, id, "proof.png"))).toString("base64"));
          return kunpoAgentReply(model, { name: "read", arguments: { path: `${runs}/${id}/proof.png` }, id: `call_review_${revision}` });
        })
        .mockResolvedValueOnce(kunpoAgentReply(model, "Proof received"));
      const started = await inject("POST", `${base}/turns`, { prompt: revision ? "@Blender Revise the proof and inspect it." : "@Blender Create a local proof and inspect it.",
        mentions: [{ name: "blender", displayName: "Blender", marketplaceId: "ohmygame" }] });
      expect(started.statusCode, started.body).toBe(202);
      const detail = await vi.waitFor(async () => {
        const detail = (await inject("GET", base)).json<ConversationDetail>();
        const turn = detail.turns.at(-1);
        expect(turn?.status).toMatch(/^(completed|failed|interrupted)$/);
        return detail;
      }, { interval: 100, timeout: 25_000 });
      const items = detail.turns.at(-1)?.items;
      if (phase === "failed-edit") {
        expect(items).toContainEqual(expect.objectContaining({ type: "dynamicToolCall", tool: "edit", status: "failed" }));
        expect(items).toContainEqual(expect.objectContaining({ type: "dynamicToolCall", tool: "run_blender", status: "failed", output: expect.stringContaining("Blender did not start") }));
        expect((await readdir(path.join(project.workspacePath, runs))).sort()).toEqual([...seen].sort());
        continue;
      }
      expect(items, JSON.stringify(items)).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "Proof received", status: "completed" }));
      expect(request).toHaveBeenCalledTimes(3);
      const [target, init] = request.mock.calls[2]!;
      const wire = init?.body ? await new Response(init.body).text() : await (target as Request).clone().text();
      expect(wire).toContain(`data:image/png;base64,${evidence.at(-1)}`);
    }
    expect(evidence[0]).not.toBe(evidence[1]);
  }, 60_000);

  it("omits a receipt-bound legacy canvas inventory on a resumed chat and keeps user markup, snapshots and image identity", async () => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { name: "Legacy canvas chat" })).json();
    const id = "gpt-6.2-astra";
    const session = SessionManager.create(project.workspacePath, path.join(path.dirname(project.workspacePath), "session"));
    session.appendModelChange("kunpo", id);
    const header = "Game design: Original design. Source: canvas/documents/game.md. Revision: ab123.";
    const inventory = (boards: string) => `${header}\nCanvas workspace: canvas/AGENTS.md; index: canvas/index.json; assets: canvas/assets.json. Boards: ${boards}. Documents: []`;
    const unsigned = promptContextBlock([], inventory("unsigned-user-example"));
    session.appendMessage({ role: "user", timestamp: 1, content: "An example without a receipt" + unsigned });
    const prompt = "Here is my own example" + promptContextBlock([], inventory("user-authored-example"));
    const privateContext = promptContextBlock([
      { kind: "design-document", label: "Explicit draft", text: "Document snapshot: keep the original bright garden." },
    ], inventory("obsolete-inventory-".repeat(1500)));
    const wire = prompt + '\n\n<workspace-file-references>\n["canvas/documents/game.md"]\n</workspace-file-references>' + privateContext;
    session.appendCustomEntry("ohmygame-user-prompt", {
      version: 1, wirePromptHash: createHash("sha256").update(wire).digest("hex"), prompt, mentions: [],
      references: [{ type: "workspace-file", path: "canvas/documents/game.md" }], attachments: [], attachmentContext: privateContext,
    });
    const image = referencePng({ width: 16, height: 16, color: 2 }).toString("base64");
    const imageEntry = session.appendMessage({ role: "user", timestamp: 2, content: [{ type: "text", text: wire }, { type: "image", mimeType: "image/png", data: image }] });
    session.appendMessage({ role: "assistant", api: "openai-responses", provider: "kunpo", model: id, stopReason: "stop", timestamp: 3,
      content: [{ type: "text", text: "Original design reviewed" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const chat = `/projects/${project.id}/conversations/${session.getSessionId()}`;
    request.mockClear().mockResolvedValueOnce(kunpoAgentReply(id, "Ready"));
    expect((await inject("POST", `${chat}/turns`, { prompt: "A brief question" })).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await inject("GET", chat)).json<ConversationDetail>().turns.at(-1)?.items)
      .toContainEqual(expect.objectContaining({ type: "agentMessage", text: "Ready" })));
    expect(request).toHaveBeenCalledOnce();
    const [input, init] = request.mock.calls[0]!;
    const body = await (init?.body ? new Response(init.body) : (input as Request).clone()).json();
    const history = JSON.stringify(body.input);
    expect(history).not.toContain("obsolete-inventory-");
    for (const required of [header, "unsigned-user-example", "user-authored-example", "Document snapshot: keep the original bright garden.", "<workspace-file-references>", `Session image: ${imageEntry}:0`]) expect(history).toContain(required);
    expect(history).not.toContain(image);
    expect(await readFile(session.getSessionFile()!, "utf8")).toContain("obsolete-inventory-");
  });
  it("refuses a text-only model for image history and permits switching to each image-enabled Kunpo Agent", async () => {
    const text = { provider: "kunpo", id: "fixture-text-only" };
    const provider = kunpoRuntimeProvider();
    provider.config.models!.push({ ...provider.config.models![0]!, id: text.id, name: text.id, input: ["text"] });
    const { inject, connect, request } = await fixture(undefined, true, provider); await connect();
    const project = (await inject("POST", "/projects", { name: "Image history preflight" })).json();
    const model = DEFAULTS.agent;
    const catalog = (await inject("GET", "/models")).json();
    expect(catalog.models.find((entry: any) => entry.id === text.id)).toMatchObject({ supportsImages: false });
    expect(catalog.models.find((entry: any) => entry.id === model.id)).toMatchObject({ supportsImages: true });
    // Seed history without starting an Agent/checkpoint job; this test exercises model selection only.
    const session = SessionManager.create(project.workspacePath, path.join(path.dirname(project.workspacePath), "session"));
    session.appendModelChange(model.provider, model.id);
    const png = referencePng({ width: 16, height: 16, color: 2 });
    session.appendMessage({ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] } as never);
    session.appendMessage({ role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
      content: [{ type: "text", text: "Ready" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
    const base = `/projects/${project.id}/conversations/${session.getSessionId()}`;
    request.mockClear();
    const rejected = await inject("PUT", `${base}/model`, text);
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().code).toBe("image_history_incompatible");
    expect((await inject("GET", base)).json().settings.model).toEqual(model);
    const fresh = (await inject("POST", `/projects/${project.id}/conversations`, { model })).json();
    expect((await inject("PUT", `/projects/${project.id}/conversations/${fresh.id}/model`, text)).statusCode).toBe(200);
    for (const id of ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.2-astra"]) {
      expect((await inject("PUT", `${base}/model`, { provider: "kunpo", id })).statusCode).toBe(200);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("switches existing tool history to Fable and Astra and preserves it when the next model disables tools", async () => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { name: "Tool history" })).json();
    const model = DEFAULTS.agent;
    const session = SessionManager.create(project.workspacePath, path.join(path.dirname(project.workspacePath), "session"));
    session.appendModelChange(model.provider, model.id);
    session.appendMessage({ role: "user", timestamp: 1, content: "Read my file" });
    session.appendMessage({ role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "index.html" } }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    session.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "Done" }], isError: false, timestamp: 3 });
    const base = `/projects/${project.id}/conversations/${session.getSessionId()}`;
    request.mockClear();
    for (const id of ["claude-fable-5-2", "gpt-6.2-astra"]) {
      const changed = await inject("PUT", `${base}/model`, { provider: "kunpo", id });
      expect(changed.statusCode, changed.body).toBe(200);
    }
    const original = kunpoModels.kunpoModelOption;
    vi.spyOn(kunpoModels, "kunpoModelOption").mockImplementation((role, ref) => {
      const entry = original(role, ref);
      return entry?.id === model.id ? { ...entry, capabilities: { ...entry.capabilities, tools: false } } : entry;
    });
    const response = await inject("PUT", `${base}/model`, model);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("tool_history_incompatible");
    expect((await inject("GET", base)).json().settings.model).toEqual({ provider: "kunpo", id: "gpt-6.2-astra" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["gpt-6.2-astra", "claude-fable-5-2"])("keeps authorized tool declarations stable while searching and executing with %s", async id => {
    const { inject, connect, request } = await fixture();
    await connect();
    const start = async () => {
      const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Tool discovery" })).json();
      const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id } })).json();
      return `/projects/${project.id}/conversations/${conversation.id}`;
    };
    const ask = async (base: string, prompt: string, done: string, mode = "normal") => {
      const result = await inject("POST", `${base}/turns`, { prompt, mode });
      expect(result.statusCode, result.body).toBe(202);
      await vi.waitFor(async () => {
        const detail = (await inject("GET", base)).json<ConversationDetail>();
        expect(detail.agent.status).toBe("idle");
        expect(detail.turns.at(-1)?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: done }));
      });
      return Promise.all(request.mock.calls.map(([target, init]) =>
        init?.body ? new Response(init.body).json() : (target as Request).clone().json()));
    };
    const regular = "What is a texture mipmap?";
    const baseline = vi.spyOn(piToolSearch, "projectToolSearch").mockImplementation(() => {});
    let full;
    try {
      request.mockClear().mockResolvedValueOnce(kunpoAgentReply(id, "Answer"));
      [full] = await ask(await start(), regular, "Answer");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      baseline.mockRestore();
    }
    const base = await start();
    request.mockClear().mockResolvedValueOnce(kunpoAgentReply(id, "Answer"));
    const [plain] = await ask(base, regular, "Answer");
    const names = (body: { tools: Array<{ name: string }> }) => body.tools.map(tool => tool.name);
    expect(request).toHaveBeenCalledTimes(1);
    expect(names(plain)).toContain("tool_search");
    expect(names(full)).toContain("generate_3d_asset");
    expect(names(plain)).toContain("generate_3d_asset");
    const parameterHelp = "Exact assetId from this project's model bindings";
    expect(JSON.stringify(full.tools)).toContain(parameterHelp);
    expect(JSON.stringify(plain.tools)).not.toContain(parameterHelp);
    const blender = plain.tools.find((tool: { name: string }) => tool.name === "run_blender");
    const schema = blender.parameters ?? blender.input_schema;
    expect(schema.required).toEqual(expect.arrayContaining(["workflow", "stage"]));
    expect(schema.properties.stage.enum).toEqual(["inspect", "parts", "clean", "joints", "rig", "animate", "static-review", "export", "custom"]);
    expect(Buffer.byteLength(JSON.stringify(plain))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)));
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "tool_search", arguments: { query: "model resources" }, id: "call_search" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "tool_search", arguments: { query: "get_model_asset", limit: 1 }, id: "call_details" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "get_model_asset", arguments: {}, id: "call_list" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Listed"));
    const calls = await ask(base, "List the models in this project.", "Listed");
    expect(request).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(calls[1])).toContain("Matching tools:");
    expect(JSON.stringify(calls[1])).not.toContain(parameterHelp);
    expect(JSON.stringify(calls[2])).toContain(parameterHelp);
    for (const body of calls) expect(body.tools).toEqual(plain.tools);
    const detail = (await inject("GET", base)).json<ConversationDetail>();
    expect(detail.turns.at(-1)?.items).toContainEqual(expect.objectContaining({ type: "dynamicToolCall", tool: "get_model_asset", status: "completed" }));
    request.mockClear().mockResolvedValueOnce(kunpoAgentReply(id, "Answered again"));
    const [next] = await ask(base, regular, "Answered again");
    expect(request).toHaveBeenCalledTimes(1);
    expect(next.tools).toEqual(plain.tools);
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "tool_search", arguments: { query: "generate_image" }, id: "call_planning" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Planning only"));
    const planning = await ask(base, "Plan an image.", "Planning only", "planning");
    for (const body of planning) {
      expect(names(body)).not.toContain("generate_image");
      expect(names(body)).not.toContain("tool_search");
      expect(names(body)).toEqual(expect.arrayContaining(["blender_status", "list_media_capabilities", "read_workflow_guide"]));
    }
    const planned = (await inject("GET", base)).json<ConversationDetail>();
    expect(planned.turns.at(-1)?.items).toContainEqual(expect.objectContaining({ type: "dynamicToolCall", tool: "tool_search", status: "failed" }));
  });

  it.each(["claude-fable-5-2", "gpt-6.2-astra"])("sends @Blender a reference image, executes the guide locally, and returns its result to %s", async id => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Blender guide test" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id } })).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    const messages = id === "claude-fable-5-2";
    const level = messages ? "low" : "xhigh";
    expect((await inject("PUT", `${base}/reasoning`, { level })).json()).toEqual({ level });
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "read_workflow_guide", arguments: { guide: "blender-assets" } }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Guide received"));
    const image = { mediaType: "image/png", data: referencePng({ width: 16, height: 16, color: 2 }).toString("base64") };
    const started = await inject("POST", `${base}/turns`, { prompt: "Use @Blender to inspect this reference.",
      mentions: [{ name: "blender", displayName: "Blender", marketplaceId: "ohmygame" }], images: [image] });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(async () => {
      const detail = (await inject("GET", base)).json<ConversationDetail>();
      expect(detail.agent.status, JSON.stringify(detail.agent)).toBe("idle");
      expect(detail.settings.reasoningLevel).toBe(level);
      expect(detail.turns.flatMap(turn => turn.items)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "dynamicToolCall", status: "completed", tool: "read_workflow_guide", arguments: { guide: "blender-assets" } }),
        expect.objectContaining({ type: "agentMessage", status: "completed", text: "Guide received" }),
      ]));
    }, { timeout: 5000 });
    expect(request).toHaveBeenCalledTimes(2);
    const bodies = await Promise.all(request.mock.calls.map(async ([target, init]) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      expect(url.origin + url.pathname).toBe(`https://llm.ziy.cc/v1/${messages ? "messages" : "responses"}`);
      const body = init?.body ? await new Response(init.body).json() : await (target as Request).clone().json();
      expect(body).toMatchObject({ model: id, stream: true });
      expect(body).toMatchObject(messages ? { output_config: { effort: level } } : { reasoning: { effort: level } });
      expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["read_workflow_guide", "blender_status", "tool_search"]));
      return body;
    }));
    const [first, next] = bodies;
    if (messages) {
      expect(first.messages).toContainEqual(expect.objectContaining({ role: "user", content: expect.arrayContaining([
        expect.objectContaining({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }),
      ]) }));
      const result = next.messages.flatMap((message: { content: unknown[] }) => message.content)
        .find((part: { type?: string; tool_use_id?: string }) => part.type === "tool_result" && part.tool_use_id === "call_guide");
      expect(JSON.stringify(result?.content)).toContain("# Blender Assets");
    } else {
      expect(first.input).toContainEqual(expect.objectContaining({ role: "user", content: expect.arrayContaining([
        expect.objectContaining({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` }),
      ]) }));
      expect(next.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_guide", output: expect.stringContaining("# Blender Assets") }));
    }
    const imageId = /Session image: ([\w-]+:\d+)/.exec(JSON.stringify(first.messages ?? first.input))?.[1];
    expect(imageId).toBeTruthy();
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "recall_image", arguments: { imageId }, id: "call_recall" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Original recalled"));
    const followUp = await inject("POST", `${base}/turns`, { prompt: "Check the previous reference again." });
    expect(followUp.statusCode, followUp.body).toBe(202);
    await vi.waitFor(async () => expect((await inject("GET", base)).json<ConversationDetail>().turns.at(-1)?.items)
      .toContainEqual(expect.objectContaining({ type: "agentMessage", text: "Original recalled" })), { timeout: 5000 });
    expect(request).toHaveBeenCalledTimes(2);
    const [beforeRecall, afterRecall] = await Promise.all(request.mock.calls.map(async ([target, init]) =>
      init?.body ? new Response(init.body).json() : (target as Request).clone().json()));
    const history = JSON.stringify(beforeRecall.messages ?? beforeRecall.input);
    expect(history).toContain(imageId);
    expect(history).not.toContain(image.data);
    expect(JSON.stringify(afterRecall.messages ?? afterRecall.input).split(image.data)).toHaveLength(2);
  });

  it.each(["gpt-6.2-astra", "claude-fable-5-2"])("answers a follow-up without replaying a large script and can recall its exact text with %s", async id => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Script history" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id } })).json();
    const chat = `/projects/${project.id}/conversations/${conversation.id}`;
    const script = "# Part of the archived Blender script.\n".repeat(600) + "# private middle marker\n" + "# End of the archived script.\n".repeat(600);
    const send = async (prompt: string, answer: string) => {
      const started = await inject("POST", `${chat}/turns`, { prompt });
      expect(started.statusCode).toBe(202);
      await vi.waitFor(async () => {
        const detail = (await inject("GET", chat)).json<ConversationDetail>();
        expect(detail.agent.status, JSON.stringify(detail.agent)).toBe("idle");
        expect(detail.turns.at(-1)?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: answer }));
      }, { timeout: 5000 });
    };
    const wireHistory = async () => {
      const [input, init] = request.mock.calls.at(-1)!;
      const body = await (init?.body ? new Response(init.body) : (input as Request).clone()).json();
      return JSON.stringify(body.messages ?? body.input);
    };
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "write", arguments: { path: "model.py", content: script }, id: "save_script" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "read", arguments: { path: "model.py" }, id: "inspect_script" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Saved and inspected model.py"));
    await send("Save this Blender script and inspect it.", "Saved and inspected model.py");
    expect(await wireHistory()).toContain("private middle marker");
    request.mockClear().mockResolvedValueOnce(kunpoAgentReply(id, "Texture answer"));
    await send("How much memory does a 4K texture use?", "Texture answer");
    expect(request).toHaveBeenCalledOnce();
    const followup = await wireHistory();
    expect(followup).not.toContain("private middle marker");
    expect(followup).toContain("Saved and inspected model.py");
    const refs = [...followup.matchAll(/recall_tool_text ref=([\w-]+:\d+(?::\w+)?)/g)].map(match => match[1]);
    expect(refs).toHaveLength(2);
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "recall_tool_text", arguments: { ref: refs[0], offset: 22000 }, id: "recall_script" }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Recovered original text"));
    await send("Look up the middle of that saved script.", "Recovered original text");
    expect(await wireHistory()).toContain("private middle marker");
    expect(await readFile(path.join(project.workspacePath, "model.py"), "utf8")).toBe(script);
  });

  it("returns the selected Canvas JPEG to Astra after a read with text line arguments", async () => {
    const id = "gpt-6.2-astra";
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Canvas reference" })).json();
    const base = `/projects/${project.id}`;
    const jpeg = await sharp(referencePng()).jpeg().toBuffer();
    const upload = await inject("POST", "/library/assets", { name: "reference.jpg", image: { mediaType: "image/jpeg", data: jpeg.toString("base64") } });
    expect(upload.statusCode, upload.body).toBe(201);
    const boardId = (await inject("GET", `${base}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `${base}/canvas/boards/${boardId}`;
    const detail = (await inject("GET", boardPath)).json();
    const node = { id: "reference", type: "asset", position: { x: 0, y: 0 }, data: { assetId: upload.json().id, mediaType: "image" } };
    detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
    const saved = await inject("PUT", boardPath, detail);
    expect(saved.statusCode, saved.body).toBe(200);
    const manifest = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/assets.json"), "utf8"));
    const args = { path: manifest.assets[node.data.assetId].path, offset: 1, limit: 1 };
    const conversation = (await inject("POST", `${base}/conversations`, { model: { provider: "kunpo", id } })).json();
    const chat = `${base}/conversations/${conversation.id}`;
    request.mockClear()
      .mockResolvedValueOnce(kunpoAgentReply(id, { name: "read", arguments: args }))
      .mockResolvedValueOnce(kunpoAgentReply(id, "Image received"));
    const started = await inject("POST", `${chat}/turns`, { prompt: "Use @Blender to inspect the selected reference.",
      mentions: [{ name: "blender", displayName: "Blender", marketplaceId: "ohmygame" }],
      contexts: [{ kind: "canvas-board", label: "Canvas", text: `Current canvas board: canvas/boards/${boardId}.json\nSelected nodes: ${node.id}\nAsset paths and descriptions: canvas/assets.json` }] });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(async () => {
      const history = (await inject("GET", chat)).json<ConversationDetail>();
      expect(history.turns.flatMap(turn => turn.items)).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "Image received" }));
    }, { timeout: 5000 });
    expect(request).toHaveBeenCalledTimes(2);
    const [first, next] = await Promise.all(request.mock.calls.map(async ([target, init]) =>
      init?.body ? new Response(init.body).json() : (target as Request).clone().json()));
    for (const [name, required] of [["read", ["path"]], ["read_workflow_guide", ["guide"]]] as const) {
      expect(first.tools.find((tool: { name: string }) => tool.name === name))
        .toMatchObject({ strict: false, parameters: { required } });
    }
    expect(JSON.stringify(first.input)).not.toContain("input_image");
    expect(next.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_guide",
      output: expect.arrayContaining([expect.objectContaining({ type: "input_image", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` })]) }));
  });

  it("keeps small visual revisions at their originating tools, then hands off the completed design on the Astra wire", async () => {
    const { inject, connect, request } = await fixture(); await connect();
    const model = "gpt-6.2-astra";
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Design review" })).json();
    const base = `/projects/${project.id}/conversations`;
    const chat = (await inject("POST", base, { model: { provider: "kunpo", id: model } })).json();
    const notes = "assets/canvas/notes.md", originalPath = "assets/canvas/concept.png";
    const initial = "Match the original costume silhouette.\n".repeat(25);
    const imagePaths = ["front", "left", "back"].map(view => `assets/canvas/${view}.png`);
    const paths = [originalPath, ...imagePaths];
    const pictures = paths.map((_, i) => referencePng({ width: 32 + i, height: 32, color: 2 }));
    await mkdir(path.join(project.workspacePath, "assets/canvas"), { recursive: true });
    await Promise.all(paths.map((file, i) => writeFile(path.join(project.workspacePath, file), pictures[i]!)));
    await writeFile(path.join(project.workspacePath, notes), initial);

    const call = (name: string, id: string, args: object) =>
      request.mockResolvedValueOnce(kunpoAgentReply(model, { name, id, arguments: args }));
    const turn = async (prompt: string, answer: string) => {
      request.mockResolvedValueOnce(kunpoAgentReply(model, answer));
      const started = await inject("POST", `${base}/${chat.id}/turns`, { prompt });
      expect(started.statusCode, started.body).toBe(202);
      await vi.waitFor(async () => {
        const detail = (await inject("GET", `${base}/${chat.id}`)).json<ConversationDetail>();
        expect(detail.turns.at(-1)?.items, JSON.stringify(detail.agent)).toContainEqual(expect.objectContaining({ type: "agentMessage", text: answer }));
      }, { timeout: 5_000 });
      return Promise.all(request.mock.calls.map(async ([target, init]) => {
        const wire = await (init?.body ? new Response(init.body) : (target as Request).clone()).json();
        return wire.input as Array<{ type?: string; call_id?: string; output?: string | Array<{ type: string; image_url?: string }> }>;
      }));
    };
    request.mockClear();
    call("read", "notes", { path: notes });
    imagePaths.forEach((file, i) => call("read", `view_${i}`, { path: file }));
    call("inspect_3d_views", "inspect", { originalPath, imagePaths });
    call("recall_image", "release", { releaseReviewedImages: true });
    const history = await turn("Check the design notes and three views before delivery.", "The design is ready for review.");
    expect(history).toHaveLength(7);
    const allImages = (input: typeof history[number]) => input.flatMap(item => Array.isArray(item.output)
      ? item.output.filter(block => block.type === "input_image").map(block => [item.call_id, block.image_url]) : []);
    const url = (i: number) => "data:image/png;base64," + pictures[i]!.toString("base64");
    expect(allImages(history[4]!)).toEqual(imagePaths.map((_, i) => [`view_${i}`, url(i + 1)]));
    expect(allImages(history[5]!)).toEqual(paths.map((_, i) => ["inspect", url(i)]));
    expect(allImages(history[6]!)).toEqual([]);
    expect(history[6]!.find(item => item.call_id === "notes" && item.type === "function_call_output")?.output).toContain(initial.trim());

    const revised = "Match the revised collar.";
    await writeFile(path.join(project.workspacePath, notes), revised);
    request.mockClear();
    call("read", "updated_notes", { path: notes });
    const followUp = await turn("Please revise the collar using the latest notes.", "I have the revised notes.");
    expect(followUp).toHaveLength(2);
    const earlierNotes = followUp[0]!.find(item => item.call_id === "notes" && item.type === "function_call_output");
    expect(earlierNotes?.output).toEqual(expect.any(String));
    expect(earlierNotes!.output).not.toContain("Match the original costume silhouette.");
    expect(allImages(followUp[0]!)).toEqual([]);
    expect(followUp[1]!.find(item => item.call_id === "updated_notes" && item.type === "function_call_output")?.output).toContain(revised);
    const ref = /recall_tool_text ref=([\w-]+:\d+)/.exec(String(earlierNotes!.output))?.[1];
    expect(ref).toBeTruthy();
    request.mockClear();
    call("recall_tool_text", "original_notes", { ref });
    const recalled = await turn("Check the original notes from delivery.", "I have both versions.");
    expect(recalled[1]!.find(item => item.call_id === "original_notes" && item.type === "function_call_output")?.output).toContain(initial.trim());
  });

  it.each([false, true])("reviews the views before Tripo and the saved initial model before continuing (request changes first: %s)", async rejectInitial => {
    const { inject, connect, request } = await fixture(); await connect();
    const model = "claude-fable-5-2";
    const project = (await inject("POST", "/projects", { type: "web-game", name: "Character turnaround" })).json();
    const base = `/projects/${project.id}`;
    const conversation = (await inject("POST", `${base}/conversations`, { model: { provider: "kunpo", id: model } })).json();
    const chat = `${base}/conversations/${conversation.id}`, jobs = `${base}/canvas/jobs`;
    const originalPath = "assets/canvas/design.png", original = referencePng({ width: 28, height: 32, color: 2 });
    const angles = ["front", "left", "back"];
    const imagePaths = angles.map(angle => `assets/canvas/${angle}.png`);
    const images = angles.map((_, index) => referencePng({ width: 32 + index, height: 32, color: 2 }));
    await mkdir(path.join(project.workspacePath, "assets/canvas"), { recursive: true });
    await writeFile(path.join(project.workspacePath, originalPath), original);
    await Promise.all(imagePaths.map((file, index) => writeFile(path.join(project.workspacePath, file), images[index]!)));
    const fallback = request.getMockImplementation()!;
    const replies: Response[] = [], mediaPaths: string[] = [], approvedUploads: Buffer[] = [];
    request.mockClear().mockImplementation(async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.pathname === "/v1/messages") {
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected model continuation");
        return reply;
      }
      mediaPaths.push(url.pathname);
      if (url.pathname === "/tripo/v3/files") {
        const form = init?.body instanceof FormData ? init.body : await new Response(init?.body, { headers: init?.headers }).formData();
        approvedUploads.push(Buffer.from(await (form.get("file") as Blob).arrayBuffer()));
      }
      if (url.pathname === "/tripo/v3/generation/multiview-to-model")
        return Response.json({ code: 0, data: { task_id: "task_app_model" } });
      return fallback(target, init);
    });
    const toolReply = (name: string, id: string, textBeforeCall?: string) => kunpoAgentReply(model, { name, id, arguments: name === "inspect_3d_views" ? { imagePaths, originalPath } : { imagePaths }, textBeforeCall });
    const reviewedReplies = (id: string) => [
      toolReply("inspect_3d_views", `inspect_${id}`),
      toolReply("generate_3d_from_views", `generate_${id}`, "The front and back silhouettes align. The side view shows the revised character proportions."),
    ];
    const start = async (prompt: string) => {
      const result = await inject("POST", `${chat}/turns`, { prompt: `@Blender ${prompt}`, mentions: [{ name: "blender", displayName: "Blender", marketplaceId: "ohmygame" }] });
      expect(result.statusCode, result.body).toBe(202);
    };
    const detail = async () => (await inject("GET", chat)).json<ConversationDetail>();
    const waitForReview = () => vi.waitFor(async () => {
      const items = (await detail()).turns.flatMap(turn => turn.items);
      const item = items.find(item => item.type === "approvalRequest" && item.status === "inProgress");
      if (item?.type !== "approvalRequest" || !item.request.turnaroundReview) {
        const failed = items.filter(item => item.type === "dynamicToolCall" && item.status === "failed");
        throw new Error("Waiting for turnaround review. " + JSON.stringify(failed));
      }
      expect(item.request).toMatchObject({ kind: "turnaroundReview", canAllowSession: false });
      const review = item.request.turnaroundReview;
      expect(item.requestId).toBe(review.reviewId);
      expect(review.original?.path).toBe(originalPath);
      expect((await inject("GET", review.original!.url)).rawPayload).toEqual(original);
      expect(review.views.map(view => [view.angle, view.path])).toEqual(angles.map((angle, index) => [angle, imagePaths[index]]));
      for (const [index, view] of review.views.entries()) {
        const snapshot = await inject("GET", view.url);
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.rawPayload).toEqual(images[index]);
      }
      const [target, init] = request.mock.calls.at(-1)!;
      const wire = init?.body ? await new Response(init.body).json() : await (target as Request).clone().json();
      const returned = wire.messages.at(-1).content.find((part: { type: string }) => part.type === "tool_result");
      const visible = returned.content.filter((part: { type: string }) => part.type === "image")
        .map((part: { source: { data: string } }) => Buffer.from(part.source.data, "base64"));
      expect(visible).toEqual([original, ...images]);
      return { id: item.requestId, review };
    }, { timeout: 5000 });
    const decide = (id: string, decision: string) => inject("POST", `${chat}/approvals/${encodeURIComponent(id)}`, { decision });
    const noSubmission = async () => {
      expect(mediaPaths).toEqual([]);
      expect((await inject("GET", jobs)).json()).toEqual([]);
    };

    replies.push(toolReply("generate_3d_from_views", "skip_inspection"), kunpoAgentReply(model, "I need to inspect the three images."));
    await start("Use Blender to make the character from these views.");
    await vi.waitFor(async () => expect((await detail()).turns.flatMap(turn => turn.items)).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "I need to inspect the three images." })), { timeout: 5000 });
    expect((await detail()).turns.flatMap(turn => turn.items).some(item => item.type === "approvalRequest")).toBe(false);
    await noSubmission();

    replies.push(...reviewedReplies("first"));
    await start("Inspect the turnaround and present it for review.");
    const first = await waitForReview(); await noSubmission();
    expect((await decide(first.id, "allow-session")).statusCode).toBe(409);
    expect((await decide(first.id, "deny")).statusCode).toBe(204);
    await vi.waitFor(async () => expect((await detail()).turns.at(-1)?.status).toBe("cancelled"), { timeout: 5000 });
    await noSubmission();

    images[1] = referencePng({ width: 36, height: 32, color: 2 });
    await writeFile(path.join(project.workspacePath, imagePaths[1]!), images[1]);
    replies.push(...reviewedReplies("revised"));
    await start("I revised the side view. Review these three again.");
    const revised = await waitForReview();
    expect(revised.review.reviewId).not.toBe(first.review.reviewId);
    expect(revised.review.views[1]!.url).not.toBe(first.review.views[1]!.url);
    expect((await decide(first.id, "allow")).statusCode).toBe(409);
    await noSubmission();
    const boardId = (await inject("GET", `${base}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `${base}/canvas/boards/${boardId}`;
    const board = (await inject("GET", boardPath)).json();
    board.board.editorLayout.viewport.x -= 400;
    const savedLayout = await inject("PUT", boardPath, board);
    expect(savedLayout.statusCode, savedLayout.body).toBe(200);
    expect(savedLayout.json().revision).not.toBe(board.revision);
    expect((await decide(revised.id, "allow")).statusCode).toBe(204);
    const waitForInitialModel = () => vi.waitFor(async () => {
      const item = (await detail()).turns.at(-1)?.items.find(item => item.type === "approvalRequest" && item.status === "inProgress");
      if (item?.type !== "approvalRequest" || !item.request.tripoModelReview) throw new Error("Waiting for initial model review");
      expect(item.request).toMatchObject({ kind: "tripoModelReview", canAllowSession: false });
      expect(item.requestId).toBe(item.request.tripoModelReview.reviewId);
      return item.request.tripoModelReview;
    }, { timeout: 5000 });
    const initial = await waitForInitialModel();
    expect((await inject("GET", jobs)).json()).toEqual([expect.objectContaining({ status: "succeeded", run: expect.objectContaining({ files: [expect.objectContaining({ assetId: initial.assetId })] }) })]);
    expect((await detail()).turns.at(-1)?.items).not.toContainEqual(expect.objectContaining({ type: "agentMessage", text: "The reviewed model is ready." }));
    const preview = await inject("GET", `/library/assets/${initial.assetId}/content?preview=${initial.fbx}&sha256=${initial.previewSha256}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.rawPayload.subarray(0, 4).toString()).toBe("glTF");
    expect((await decide(initial.reviewId, "allow-session")).statusCode).toBe(409);
    let accepted = initial;
    if (rejectInitial) {
      expect((await decide(initial.reviewId, "deny")).statusCode).toBe(204);
      await vi.waitFor(async () => expect((await detail()).turns.at(-1)?.status).toBe("cancelled"), { timeout: 5000 });
      expect((await inject("GET", jobs)).json()).toEqual([expect.objectContaining({ status: "succeeded" })]);
      replies.push(kunpoAgentReply(model, { name: "review_tripo_model", id: "review_initial_again", arguments: { sourceAssetId: initial.assetId } }));
      await start("Show the same saved model again so I can check the details before deciding.");
      accepted = await waitForInitialModel();
      expect(accepted).toMatchObject({ assetId: initial.assetId, previewSha256: initial.previewSha256 });
      expect(accepted.reviewId).not.toBe(initial.reviewId);
      expect((await decide(initial.reviewId, "allow")).statusCode).toBe(409);
    }
    replies.push(kunpoAgentReply(model, "The reviewed model is ready."));
    expect((await decide(accepted.reviewId, "allow")).statusCode).toBe(204);
    await vi.waitFor(async () => {
      const finished = await detail();
      expect(finished.agent.status).toBe("idle");
      expect(finished.turns.at(-1)?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "The reviewed model is ready." }));
      expect((await inject("GET", jobs)).json()).toEqual([expect.objectContaining({ status: "succeeded" })]);
    }, { timeout: 5000 });
    const [target, init] = request.mock.calls.at(-1)!;
    const wire = init?.body ? await new Response(init.body).json() : await (target as Request).clone().json();
    const delivered = wire.messages.at(-1).content.find((part: { tool_use_id?: string }) => part.tool_use_id === (rejectInitial ? "review_initial_again" : "generate_revised"));
    if (!rejectInitial) expect(JSON.stringify(delivered?.content)).toContain("The user approved these reference views on the review card");
    expect(JSON.stringify(delivered?.content)).toContain("The user accepted this exact Tripo original");
    expect(approvedUploads).toEqual(images);
    expect(mediaPaths.filter(p => p.includes("/generation/"))).toEqual(["/tripo/v3/generation/multiview-to-model"]);
  });

  it("rejects incompatible resolved 3D options before app effects and retains one corrected text generation", async () => {
    const { inject, connect, request, directory } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "web-game" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, {})).json();
    const session = vi.spyOn(agentRuntime, "createPiSession").mockRejectedValue(new Error("Offline 3D tool capture"));
    await inject("POST", `/projects/${project.id}/conversations/${conversation.id}/turns`, { prompt: "Inspect configured 3D options" });
    await vi.waitFor(() => expect(session).toHaveBeenCalled());
    const registered = session.mock.calls[0]![2]!, guard = new continuation.AutoContinueTools(registered);
    const tool = guard.wrap().find(entry => entry.name === "generate_3d_asset")!;
    const catalog = registered.find(entry => entry.name === "list_media_capabilities")!;
    request.mockClear();
    const capabilities = await catalog.execute("3d-catalog", {}, undefined, undefined, {} as never);
    expect(capabilities.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"optionFieldsByOperation"') });
    const all = JSON.parse((capabilities.content[0] as { text: string }).text);
    for (const capability of Object.keys(all)) {
      const scoped = await catalog.execute("scoped-catalog", { capability }, undefined, undefined, {} as never);
      expect(scoped.content).toEqual([{ type: "text", text: JSON.stringify({ [capability]: all[capability] }) }]);
      expect(scoped.details).toEqual({ mediaCapabilities: { [capability]: all[capability] } });
    }
    const video = vi.spyOn(ProviderVideos.prototype, "catalog").mockRejectedValue(new Error("Unrelated catalog offline"));
    await expect(catalog.execute("image-catalog", { capability: "image" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { mediaCapabilities: { image: all.image } },
    });
    expect(video).not.toHaveBeenCalled();
    video.mockRestore();
    const canvasPath = `/projects/${project.id}/canvas`, before = (await inject("GET", `${canvasPath}/workspace`)).json();
    const input = { operation: "text", prompt: "A hero in a neutral T-pose", targetPolycount: 30000, texture: true, pbr: false,
      options: { geometryQuality: "detailed", textureQuality: "detailed", pose: "t-pose" } };
    const failure = await tool.execute("invalid-text-pose", input, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("invalid_media_options");
    expect(request).not.toHaveBeenCalled();
    expect((await inject("GET", `${canvasPath}/workspace`)).json()).toEqual(before);
    expect((await inject("GET", `${canvasPath}/jobs`)).json()).toEqual([]);
    await expect(readdir(path.join(directory, "tools/model3d-tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => new URL(String(url)).pathname === "/tripo/v3/generation/text-to-model"
      ? Response.json({ code: 0, data: { task_id: "task_app_model" } }) : fallback(url, init));
    const generated = await tool.execute("corrected-text-pose", { ...input, options: { geometryQuality: "detailed", textureQuality: "detailed" } }, undefined, undefined, {} as never);
    expect(JSON.stringify(generated.content)).not.toContain("approved these reference views");
    await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
    const submissions = request.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/generation/"));
    expect(submissions).toHaveLength(1);
    const body = JSON.parse(submissions[0]![1]!.body as string);
    expect(body).not.toHaveProperty("pose");
    expect((await inject("GET", `${canvasPath}/jobs`)).json()).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(guard.recoverySummary).toContain("not_executed (invalid_media_options)");
  });

  it.each(["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"])("runs the selected %s through the Agent, saved canvas and image library", async id => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "web-game" })).json();
    const model = { provider: "openai", id };
    expect((await inject("PATCH", `/projects/${project.id}/model-selections`, { image: model })).statusCode).toBe(200);
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, {})).json();
    const session = vi.spyOn(agentRuntime, "createPiSession").mockRejectedValue(new Error("Offline image tool capture"));
    await inject("POST", `/projects/${project.id}/conversations/${conversation.id}/turns`, { prompt: "Draw a vector icon" });
    await vi.waitFor(() => expect(session).toHaveBeenCalled());
    const registered = session.mock.calls[0]![2]!;
    const tool = registered.find(entry => entry.name === "generate_image")!;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="red"/></svg>';
    request.mockClear().mockImplementation(async () => Response.json({ data: [{ b64_json: Buffer.from(svg).toString("base64") }] }));
    const invalid = await tool.execute("invalid-svg", { prompt: "Draw", outputFormat: "svg", imagePaths: ["reference.png"], resolution: "1K", aspectRatio: "1:1" }, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(invalid)).toMatchObject({ effect: "none", reason: "invalid_media_options" });
    expect(request).not.toHaveBeenCalled();
    await tool.execute("vector-icon", { prompt: "Draw", outputFormat: "svg", background: "transparent", complexity: "medium", svgReasoningEffort: "medium", pixelSize: "256x256" }, undefined, undefined, {} as never);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toMatch(/\/images\/generations$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: id, output_format: "svg", n: 1, background: "transparent", size: "256x256", complexity: "medium", svg: { model: "gpt-6-sol", reasoning: { effort: "medium" } } });
    const canvas = `/projects/${project.id}/canvas`;
    const jobs = (await inject("GET", `${canvas}/jobs`)).json();
    expect(jobs).toEqual([expect.objectContaining({ status: "succeeded" })]);
    const { context: { boardId, nodeId }, run } = jobs[0];
    const board = (await inject("GET", `${canvas}/boards/${boardId}`)).json().board;
    expect(board.nodes.find((node: { id: string }) => node.id === nodeId)?.data).toMatchObject({ outputFormat: "svg", svgReasoningEffort: "medium", pixelSize: "256x256", assetId: run.files[0].assetId });
    const original = await inject("GET", `/library/assets/${run.files[0].assetId}/content`);
    expect(original.statusCode).toBe(200);
    expect(original.body).toBe(svg);
  });

  it("lets an Agent read the current project's effective media models before sending any provider request", async () => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "web-game" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, {})).json();
    // Capture exactly the tools handed to Pi, stopping before the language model is called.
    const session = vi.spyOn(agentRuntime, "createPiSession").mockRejectedValue(new Error("Offline tool capture"));
    await inject("POST", `/projects/${project.id}/conversations/${conversation.id}/turns`, { prompt: "Inspect configured media" });
    await vi.waitFor(() => expect(session).toHaveBeenCalled());
    const registered = session.mock.calls[0]![2]!;
    expect(registered.some(entry => entry.name === "web_search")).toBe(false);
    const tool = registered.find(entry => entry.name === "list_media_capabilities")!;
    const read = async () => {
      const result = await tool.execute("catalog", {}, undefined, undefined, {} as never);
      const block = result.content[0]!;
      if (block.type !== "text") throw new Error("Expected model catalog");
      expect(block.text).not.toContain(KEY);
      expect(block.text).not.toContain("https://");
      return JSON.parse(block.text);
    };
    request.mockClear();
    expect(await read()).toMatchObject({
      image: { effectiveModel: DEFAULTS.image, candidates: expect.arrayContaining([expect.objectContaining({ ...DEFAULTS.image, qualities: expect.arrayContaining(["high"]) })]) },
      video: { effectiveModel: DEFAULTS.video, candidates: expect.arrayContaining([expect.objectContaining({ ...DEFAULTS.video, frameAspectRatios: ["adaptive"], textAspectRatios: expect.arrayContaining(["16:9"]) })]) },
      speech: { status: "locally-configured", effectiveModel: DEFAULTS.speech },
      "sound-effect": { effectiveModel: DEFAULTS["sound-effect"] },
      music: { status: "explicit-selection-required", projectSelection: null, effectiveModel: null },
      "3d-generation": { effectiveModel: DEFAULTS["3d-generation"], candidates: expect.arrayContaining([
        expect.objectContaining({ ...DEFAULTS["3d-generation"], referenceImageLabels: ["Front", "Left", "Back", "Right"], optionFieldsByOperation: {
          image: ["referenceMode", "pose", "quad", "geometryQuality", "textureModel", "textureQuality"],
          text: ["quad", "geometryQuality", "textureModel", "textureQuality"],
          retexture: ["textureModel", "textureQuality"], remesh: ["quad", "smartUv"], animate: ["rigModel", "rigType", "animateInPlace"],
        } }),
      ]) },
      "3d-processing": { projectRig: DEFAULTS["3d-rig"], animationConnection: { provider: "tripo" } },
    });
    const changed = { provider: "volcengine-tts", id: "seed-audio-1.0-multilingual" };
    expect((await inject("PATCH", `/projects/${project.id}/model-selections`, { speech: changed })).statusCode).toBe(200);
    expect((await read()).speech).toMatchObject({ projectSelection: changed, effectiveModel: changed });
    const submitted = await inject("POST", "/tools/generate-speech/jobs", { text: "Hello", model: { provider: "kunpo", id: "seed-tts-2.0" }, projectId: project.id, nodeId: "invalid-choice" });
    expect(submitted.statusCode, submitted.body).toBe(400);
    expect(submitted.json()).toMatchObject({ error: expect.stringContaining("list_media_capabilities") });
    expect(submitted.body).not.toContain("Connect an audio provider");
    expect((await inject("GET", "/tool-jobs")).json()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it("fits a local JPEG through the direct video jobs HTTP entry before its single paid POST", async () => {
    const setup = await fixture(); await setup.connect(); const { inject, request, directory } = setup;
    const bytes = await sharp(referencePng({ width: 1024, height: 1024, color: 2, noise: true })).blur(0.7).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    const uploaded = await inject("POST", "/library/assets", { name: "synthetic.jpg", image: { mediaType: "image/jpeg", data: bytes.toString("base64") } }); expect(uploaded.statusCode).toBe(201);
    const original = request.getMockImplementation()!; request.mockClear();
    request.mockImplementation(async (address, init) => { if (init?.method === "POST") expect(Buffer.byteLength(String(init.body))).toBeLessThanOrEqual(786432); return original(address, init); });
    const started = await inject("POST", "/tools/generate-video/jobs", { prompt: "Synthetic movement", model: DEFAULTS.video, duration: 4, resolution: "480p", aspectRatio: "adaptive", references: [{ type: "image", assetId: uploaded.json().id }] }); expect(started.statusCode).toBe(202);
    let finished: any;
    await vi.waitFor(async () => { finished = (await inject("GET", "/tool-jobs")).json().find((job: any) => job.id === started.json().id); expect(finished?.status, finished?.error).toBe("succeeded"); }, { timeout: 20_000, interval: 20 });
    expect(finished.run.generation.parameters.referenceBudgetBytes).toBe(786432); expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(await readFile(path.join(directory, "library/files", `${uploaded.json().id}.jpg`))).toEqual(bytes);
  });

  it.each([
    ["gpt-5.6-sol", "HTTP 500"], ["claude-opus-5-5", "HTTP 500"], ["claude-fable-5-2", "HTTP 500"],
    ["gpt-6.2-astra", "HTTP 500"], ["gpt-6.2-astra", "ECONNRESET"],
  ] as const)("continues %s after a guarded %s through the app and does not replay it after reopening", async (id, failure) => {
    const { inject, connect, request, directory, app } = await fixture(); await connect();
    vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true);
    const project = (await inject("POST", "/projects", { name: "Offline continuation" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id } })).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    const chatWire = 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    request.mockClear();
    if (failure === "ECONNRESET") {
      request.mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("PRIVATE_ERROR_BODY"), { code: failure }) }));
    } else {
      request.mockResolvedValueOnce(Response.json({ error: { type: "api_error", message: "PRIVATE_ERROR_BODY" } }, { status: 500, headers: { "x-request-id": "req_auto_500" } }));
    }
    request.mockImplementation(async () => id === "gpt-5.6-sol"
        ? new Response(chatWire, { headers: { "content-type": "text/event-stream" } }) : kunpoAgentReply(id, "Done"));
    const started = await inject("POST", `${base}/turns`, { prompt: "AUTO_CONTINUE_CANARY_TASK" }); expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await inject("GET", base), detail = response.json<ConversationDetail>();
      expect(detail.agent.status).toBe("idle");
      expect(detail.turns.flatMap(turn => turn.items)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "retry", status: "completed", attempt: 1 })]));
      expect(detail.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage")).toHaveLength(1);
      expect(response.body).not.toMatch(new RegExp(`${KEY}|PRIVATE_ERROR_BODY`));
    }, { timeout: 10_000 });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [target, init] of request.mock.calls) {
      const raw = init?.body ?? (target instanceof Request ? await target.clone().text() : "");
      const body = raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : String(raw);
      if (id === "claude-fable-5-2") {
        expect(new URL(target instanceof Request ? target.url : String(target)).pathname).toBe("/v1/messages");
        expect(JSON.parse(body)).toMatchObject({ model: id, stream: true });
        expect(JSON.parse(body).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read_workflow_guide" })]));
      }
      expect(body.match(/AUTO_CONTINUE_CANARY_TASK/g)).toHaveLength(1);
    }
    await app.close(); applications.splice(applications.indexOf(app), 1);
    const reopened = await fixture(directory); const restored = await reopened.inject("GET", base);
    expect(restored.statusCode, restored.body).toBe(200); expect(restored.json().agent.status).toBe("idle");
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each([
    ["active", undefined],
    ["idle", "sse_idle_timeout"],
    ["malformed", "sse_validation_failed"],
    ["disconnected", "sse_connection_interrupted"],
    ["incomplete", "sse_connection_interrupted"],
  ] as const)("handles the %s SSE case with classified continuation and no replayed user turn", async (scenario, expectedError) => {
    const { inject, connect, request } = await fixture();
    await connect();
    const recoverable = scenario === "idle" || scenario === "disconnected";
    const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true);
    const project = (await inject("POST", "/projects", { name: "SSE simulation" })).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: DEFAULTS.agent })).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; } });
    const send = (event: string) => controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
    let onSubmission!: () => void;
    const submitted = new Promise<void>(resolve => { onSubmission = resolve; });
    request.mockClear().mockImplementation(async () => new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}', 'data: [DONE]', '',
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })).mockImplementationOnce(async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      onSubmission();
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const started = await inject("POST", `${base}/turns`, { prompt: "Test the stream" });
      expect(started.statusCode, started.body).toBe(202);
      await submitted;
      const [target, init] = request.mock.calls[0]!;
      expect(new URL(target instanceof Request ? target.url : String(target)).pathname).toBe("/v1/chat/completions");
      expect(init?.method ?? (target instanceof Request ? target.method : undefined)).toBe("POST");
      await vi.advanceTimersByTimeAsync(0);
      const delta = '{"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}';
      send(delta);
      if (scenario === "active") {
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(110_000);
          send(delta);
        }
        send('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
        send("[DONE]");
        controller.close();
      } else if (scenario === "idle") {
        await vi.advanceTimersByTimeAsync(180_001);
      } else if (scenario === "disconnected") {
        controller.error(new Error("private transport details"));
      } else {
        if (scenario === "malformed") send('{"private unfinished event"');
        controller.close();
      }
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => {
      const response = await inject("GET", base);
      const { agent, turns } = response.json<ConversationDetail>();
      expect(agent.status).toBe(expectedError && !recoverable ? "error" : "idle");
      const reply = turns.flatMap(turn => turn.items).findLast(item => item.type === "agentMessage");
      expect(reply).toMatchObject(recoverable ? { status: "completed", text: "RECOVERED" } : expectedError
        ? { status: "failed", error: { code: expectedError } }
        : { status: "completed", text: "OKOKOKOK" });
      expect(turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage")).toHaveLength(1);
      if (recoverable) expect(turns.flatMap(turn => turn.items)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "retry", status: "completed", attempt: 1 })]));
      expect(response.body).not.toMatch(/private transport details|private unfinished event/);
    }, { timeout: 5000 });
    expect(request).toHaveBeenCalledTimes(recoverable ? 2 : 1);
    expect(wait).toHaveBeenCalledTimes(recoverable ? 1 : 0);
  });

  it.each(["gpt-5.6-sol", "claude-opus-5-5", "claude-fable-5-2", "gpt-6.2-astra"])("sends current generated and uploaded references through %s and keeps recall IDs on the next turn", async id => {
    const requestLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const directory = await temporary(); await new LocalApiKeyStore(path.join(directory, "local-api-keys.json")).modify("kunpo", async () => ({ type: "api_key", key: KEY }));
    const bytes = referencePng({ width: 128, height: 128, color: 2 });
    const sourceUrl = "https://kunpoapiimg.ziy.cc/agent-http.png?signature=fake-http-origin";
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === sourceUrl) return new Response(new Uint8Array(bytes));
      if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ url: sourceUrl }] });
      if (url.pathname === "/v1/chat/completions") return new Response([
        'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}',
        'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/v1/messages" || url.pathname === "/v1/responses") return kunpoAgentReply(id, "Ready");
      throw Error(`Unexpected synthetic test route: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", request);
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, accessToken: ACCESS_TOKEN, imageFetch: request, generateProjectName: async () => undefined }); applications.push(app);
    const inject = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${ACCESS_TOKEN}` }, ...(payload ? { payload } : {}) });
    const project = (await inject("POST", "/projects", { name: "Synthetic agent origins" })).json();
    const generated = await inject("POST", "/tools/generate-image/jobs", { prompt: "Synthetic", size: "1024x1024" });
    await finishJob(inject as Awaited<ReturnType<typeof fixture>>["inject"], generated.json().id);
    const assetId = (await inject("GET", "/tool-jobs")).json().find((job: ToolJob) => job.id === generated.json().id).run.files[0].assetId;
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, { model: { provider: "kunpo", id } })).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    request.mockClear();
    const turnIds: string[] = [];
    for (const payload of [{ prompt: "Inspect", images: [{ mediaType: "image/png", data: bytes.toString("base64"), libraryAssetId: assetId }, { mediaType: "image/png", data: bytes.toString("base64") }] }, { prompt: "Continue from the same images" }]) {
      const started = await inject("POST", `${base}/turns`, payload); expect(started.statusCode, started.body).toBe(202);
      turnIds.push(started.json().turnId);
      await vi.waitFor(async () => { const detail = await inject("GET", base); expect(detail.json().agent.status, JSON.stringify(detail.json().agent)).toBe("idle"); expect(detail.body).toContain("Ready"); expect(detail.body).not.toContain("fake-http-origin"); }, { timeout: 5000 });
    }
    expect(request.mock.calls).toHaveLength(2);
    const observed = requestLog.mock.calls.filter(([line]) => typeof line === "string" && line.startsWith('{"msg":"Provider request",')).map(([line]) => JSON.parse(String(line)))
      .filter(entry => entry.event === "finished" && entry.protocol !== "provider-http");
    expect(observed).toHaveLength(2);
    expect(observed.map(entry => entry.turnId)).toEqual(turnIds);
    expect(observed.every(entry => entry.projectId === project.id && entry.conversationId === conversation.id && entry.outcome === "completed")).toBe(true);
    expect(new Set(observed.map(entry => entry.localRequestId)).size).toBe(2);
    expect(JSON.stringify(observed)).not.toMatch(/Inspect|Continue from|Ready|fake-http-origin|sk-kunpo|data:image/);
    const astra = id === "gpt-6.2-astra", sol = id === "gpt-5.6-sol";
    const inline = `data:image/png;base64,${bytes.toString("base64")}`;
    for (const [index, [target, init]] of request.mock.calls.entries()) {
      const url = new URL(target instanceof Request ? target.url : String(target));
      expect(url.pathname).toBe(astra ? "/v1/responses" : sol ? "/v1/chat/completions" : "/v1/messages");
      const body = init?.body ? await new Response(init.body).json() : await (target as Request).clone().json();
      const imageType = astra ? "input_image" : sol ? "image_url" : "image";
      const parts = (body.input ?? body.messages).flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === imageType) : []);
      const sources = parts.map((part: any) => {
        if (astra) return part.image_url;
        if (sol) return part.image_url.url;
        return part.source.type === "url" ? part.source.url : `data:${part.source.media_type};base64,${part.source.data}`;
      });
      if (index === 0) {
        expect(sources).toEqual([sol || id === "claude-opus-5-5" ? sourceUrl : inline, inline]);
      } else {
        expect(sources).toEqual([]);
        const history = JSON.stringify(body.input ?? body.messages);
        expect(new Set(history.match(/Session image: [\w-]+:\d+/g)).size).toBe(2);
        expect(history).not.toContain(sourceUrl);
        expect(history).not.toContain(bytes.toString("base64"));
      }
      expect(JSON.stringify(body)).not.toContain("libraryAssetId");
    }
  });

  it.each(["text", "document"])("sends verified generated CDN and identical uploaded pixels through actual canvas %s + Chat SDK without rewriting history", async kind => {
    const setup = await pngCanvasFixture(PNG), { inject, request, boardPath, project } = setup;
    const sourceUrl = "https://kunpoapiimg.ziy.cc/canvas-vision.png?signature=fake-canvas-vision", original = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.href === sourceUrl) return new Response(PNG);
      if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ url: sourceUrl }] });
      if (url.pathname === "/v1/chat/completions") return new Response([
        'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Synthetic description"},"finish_reason":null}]}',
        'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      return original(input, init);
    });
    const generated = await inject("POST", "/tools/generate-image/jobs", { prompt: "Synthetic", size: "1024x1024" }); await finishJob(inject, generated.json().id);
    const assetId = (await inject("GET", "/tool-jobs")).json().find((job: ToolJob) => job.id === generated.json().id).run.files[0].assetId;
    const generatedNode = createAssetGenerationNode("image", { x: 0, y: 0 }), uploadedNode = createAssetGenerationNode("image", { x: 300, y: 0 });
    if (generatedNode.type !== "image" || uploadedNode.type !== "image") throw Error(); generatedNode.data.assetId = assetId; uploadedNode.data.assetId = setup.refs[0]!.assetId;
    const references = [generatedNode, uploadedNode].map(node => ({ type: "node" as const, nodeId: node.id }));
    const document = kind === "document" ? (await inject("POST", `/projects/${project.id}/canvas/documents`, { title: "Synthetic" })).json() : undefined;
    const target: any = { id: "source-description", type: kind, position: { x: 0, y: 300 }, data: kind === "text" ? { text: "", instruction: "Describe", references } : { documentId: document.document.id, references } };
    const detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [generatedNode, uploadedNode, target]; detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node: any) => [node.id, node.position]));
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockClear();
    const result = await inject("POST", `/projects/${project.id}/canvas/${kind === "text" ? "text" : `documents/${document.document.id}`}/generate`, { instruction: "Describe the images", model: DEFAULTS.agent, referenceSource: { boardId: boardPath.split("/").at(-1), nodeId: target.id }, ...(document ? { revision: document.revision } : {}) });
    expect(result.statusCode, result.body).toBe(200);
    const posts = request.mock.calls.filter(([, init]) => init?.method === "POST"); expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]![1]!.body));
    const sent = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : []);
    expect(sent).toEqual([sourceUrl, `data:image/png;base64,${PNG.toString("base64")}`]);
    for (const endpoint of [boardPath, setup.jobsPath]) expect((await inject("GET", endpoint)).body).not.toContain("fake-canvas-vision");
  });

  it.each(["sunburst", "flare", "nano", "3d-single", "3d-multi"])("routes generated and uploaded image origins through the actual %s canvas", async role => {
    const setup = await pngCanvasFixture(PNG);
    const { inject, request, node: old, boardPath, finish, refs } = setup;
    const original = request.getMockImplementation()!, sourceUrl = "https://kunpoapiimg.ziy.cc/cross-role.png?signature=fake-cross-role";
    request.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.href === sourceUrl) return new Response(PNG);
      if (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") return Response.json({ data: [{ url: sourceUrl }] });
      if (url.pathname.startsWith("/tripo/v3/generation/") && init?.method === "POST") return Response.json({ code: 0, data: { task_id: "task_app_model" } });
      return original(input, init);
    });
    const generated = await inject("POST", "/tools/generate-image/jobs", { prompt: "Synthetic", size: "1024x1024" });
    expect((await finishJob(inject, generated.json().id)).status).toBe("succeeded");
    const sourceId = (await inject("GET", "/tool-jobs")).json().find((job: ToolJob) => job.id === generated.json().id).run.files[0].assetId;
    const sourceNode = createAssetGenerationNode("image", { x: 0, y: 300 }); if (sourceNode.type !== "image") throw Error(); sourceNode.data.assetId = sourceId;
    const node = createAssetGenerationNode(role.startsWith("3d") ? "model-3d" : "image", old.position);
    if (node.type === "image") Object.assign(node.data, { prompt: "Synthetic edit", model: { provider: "openai", id: role === "nano" ? "Image-GI2.1" : `gpt-image-2.5-${role}` }, images: [{ type: "node", nodeId: sourceNode.id }, refs[0]] });
    else if (node.type === "model-3d") Object.assign(node.data, { model: DEFAULTS["3d-generation"], operation: "image", images: [{ type: "node", nodeId: sourceNode.id }, ...(role === "3d-multi" ? [refs[0]] : [])] });
    else throw Error();
    const detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [node, sourceNode]; detail.board.editorLayout.nodes = { [node.id]: node.position, [sourceNode.id]: sourceNode.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockClear(); const started = await inject("POST", `${boardPath}/nodes/${node.id}/generate`); expect(started.statusCode, started.body).toBe(202);
    const done = await finish(started.json().id, "succeeded");
    const posts = request.mock.calls.filter(([, init]) => init?.method === "POST");
    if (!role.startsWith("3d")) {
      expect(posts).toHaveLength(1); const body = JSON.parse(String(posts[0]![1]!.body));
      expect(body.images).toEqual([sourceUrl, `data:image/png;base64,${PNG.toString("base64")}`]);
      expect(done.run.generation.parameters).toMatchObject({ referenceUrlCount: 1, referenceLocalCount: 1 });
      expect(String(posts[0]![0]).endsWith(role === "nano" ? "/generations" : "/edits")).toBe(true);
    } else {
      const uploads = posts.filter(([url]) => String(url).endsWith("/files")); expect(uploads).toHaveLength(role === "3d-multi" ? 1 : 0);
      const submission = posts.filter(([url]) => String(url).includes("/generation/")); expect(submission).toHaveLength(1);
      const body = JSON.parse(String(submission[0]![1]!.body));
      if (role === "3d-multi") expect(body.inputs).toEqual([{ front: sourceUrl }, { left: "file_app_model_reference" }]); else expect(body.input).toBe(sourceUrl);
    }
    for (const endpoint of [boardPath, setup.jobsPath, "/tool-jobs"]) expect((await inject("GET", endpoint)).body).not.toContain("fake-cross-role");
  });

  it.each([DEFAULTS.video.id, "tencent-vod-vs-2.5", "minimax-video-h3"].flatMap(id => [
    { frame: false, remote: [0] }, { frame: false, remote: [1] }, { frame: false, remote: [0, 1] },
    { frame: 1, remote: [0] }, { frame: true, remote: [0] }, { frame: true, remote: [1] }, { frame: true, remote: [0, 1] },
  ].map(mode => ({ id, ...mode }))))("selects real generated provenance in $id canvas mode=$frame remote=$remote, without uploads", async ({ id, frame, remote }) => {
    const setup = await pngCanvasFixture(PNG, id, frame as boolean | 1);
    const { inject, request, directory, boardPath, node, refs, start, finish } = setup;
    const original = request.getMockImplementation()!;
    const sourceUrl = "https://kunpoapiimg.ziy.cc/source.png?signature=fixture-private-url";
    request.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ url: sourceUrl }] });
      if (url.href === sourceUrl) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      if (url.pathname === "/v1/videos" && init?.method === "POST") return Response.json({ id: "task_source" });
      if (url.pathname === "/v1/videos/task_source") return Response.json({ status: "completed" });
      if (url.pathname === "/v1/videos/task_source/content") return new Response(MP4);
      return original(input, init);
    });
    const imageJob = await inject("POST", "/tools/generate-image/jobs", { prompt: "Synthetic image", size: "1024x1024" });
    expect(imageJob.statusCode, imageJob.body).toBe(202);
    const imageDone = await finishJob(inject, imageJob.json().id); expect(imageDone.status, imageDone.error).toBe("succeeded");
    const history = (await inject("GET", "/tool-jobs")).json();
    const assetId = history.find((job: ToolJob) => job.id === imageDone.id).run.files[0].assetId;
    const imageNode = createAssetGenerationNode("image", { x: 0, y: 300 }); if (imageNode.type !== "image") throw new Error();
    imageNode.data.assetId = assetId;
    const localRefs = frame === 1 ? refs.slice(0, 1) : refs.length === 1 ? [refs[0], refs[0]] : refs;
    node.data.references = localRefs.map((reference, index) => remote.includes(index) ? { type: "node", nodeId: imageNode.id } : reference);
    const detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [node, imageNode];
    detail.board.editorLayout.nodes[imageNode.id] = imageNode.position;
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    const before = request.mock.calls.length;
    const started = await start(); expect(started.statusCode, started.body).toBe(202);
    const done = await finish(started.json().id, "succeeded");
    const calls = request.mock.calls.slice(before), posts = calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1); // No upload API and no implicit generation retry.
    const body = JSON.parse(String(posts[0]![1]!.body));
    const native = id === DEFAULTS.video.id;
    const sent = id === "tencent-vod-vs-2.5" ? frame ? [body.first_frame_url, body.last_frame_url].filter(Boolean) : body.images
      : body.content.filter((part: { type: string }) => part.type === "image_url").map((part: any) => part.image_url.url);
    expect(sent).toHaveLength(localRefs.length);
    sent.forEach((url: string, index: number) => expect(url).toBe(remote.includes(index) ? sourceUrl : `data:image/png;base64,${PNG.toString("base64")}`));
    if (id !== "tencent-vod-vs-2.5") expect(body.content.filter((part: any) => part.type === "image_url").map((part: any) => part.role)).toEqual(frame ? localRefs.map((_, i) => i ? "last_frame" : "first_frame") : localRefs.map(() => "reference_image"));
    expect(done.run.generation.parameters).toMatchObject({ referenceUrlCount: remote.length, referenceLocalCount: localRefs.length - remote.length });
    expect(new URL(String(posts[0]![0])).pathname).toBe(native ? "/doubao/api/v3/contents/generations/tasks" : "/v1/videos");
    for (const endpoint of [boardPath, setup.jobsPath, "/tool-jobs", "/library/assets"]) {
      const response = await inject("GET", endpoint);
      for (const secret of [KEY, sourceUrl, "fixture-private-url"]) expect(response.body, endpoint).not.toContain(secret);
    }
    const sourceFile = path.join(directory, "library/provider-image-sources", `${assetId}.json`);
    expect((await stat(sourceFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(sourceFile, "utf8")).url).toBe(sourceUrl);
  });

  it.each(["workspace-edit", "node-replacement", "restart"])("uses the current canvas image after %s instead of a stale origin URL", async mode => {
    const setup = await pngCanvasFixture();
    const { inject, request, directory, project, boardPath, node } = setup;
    const sourceUrl = "https://kunpoapiimg.ziy.cc/versioned.png?signature=fixture-version";
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) => String(input) === sourceUrl ? new Response(PNG) : new URL(String(input)).pathname === "/v1/images/generations" ? Response.json({ data: [{ url: sourceUrl }] }) : normal(input, init));
    const imageJob = await inject("POST", "/tools/generate-image/jobs", { prompt: "Synthetic image", size: "1024x1024" });
    expect((await finishJob(inject, imageJob.json().id)).status).toBe("succeeded");
    const assetId = (await inject("GET", "/tool-jobs")).json().find((job: ToolJob) => job.id === imageJob.json().id).run.files[0].assetId;
    const imageNode = createAssetGenerationNode("image", { x: 0, y: 300 }); if (imageNode.type !== "image") throw new Error();
    imageNode.data.assetId = assetId; node.data.references = [{ type: "node", nodeId: imageNode.id }];
    let detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [node, imageNode]; detail.board.editorLayout.nodes[imageNode.id] = imageNode.position;
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    const replacement = referencePng({ width: 1, height: 1, color: 2 });
    if (mode === "workspace-edit") {
      const workspace = path.join(directory, "projects", project.id, "workspace");
      const manifest = JSON.parse(await readFile(path.join(workspace, "canvas/assets.json"), "utf8"));
      await writeFile(path.join(workspace, manifest.assets[assetId].path), replacement);
    }
    if (mode === "node-replacement") {
      const uploaded = await inject("POST", "/library/assets", { name: "replacement.png", image: { mediaType: "image/png", data: replacement.toString("base64") } });
      imageNode.data.assetId = uploaded.json().id;
      detail = (await inject("GET", boardPath)).json(); detail.board.nodes = [node, imageNode];
      expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    }
    let active = setup;
    if (mode === "restart") { await setup.app.close(); const reopened = await fixture(directory); active = { ...setup, ...reopened }; }
    active.request.mockClear();
    const started = await active.inject("POST", `${boardPath}/nodes/${node.id}/generate`); expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await active.inject("GET", setup.jobsPath)).json().find((job: ToolJob) => job.id === started.json().id)?.status).toBe("succeeded"));
    const posts = active.request.mock.calls.filter(([, init]) => init?.method === "POST"); expect(posts).toHaveLength(1);
    const sent = JSON.parse(String(posts[0]![1]!.body)).content[1].image_url.url;
    if (mode === "restart") expect(sent).toBe(sourceUrl);
    else { expect(sent).toMatch(/^data:image\/png;base64,/); expect(pngScanlines(Buffer.from(sent.split(",")[1], "base64"))).toEqual(pngScanlines(replacement)); }
  });

  it.each([DEFAULTS.video.id, "tencent-vod-vs-2.5", "minimax-video-h3"].flatMap((id) => [false, 1, true].map((frame) => ({ id, frame: frame as boolean | 1 }))))("uses a JPEG copy through the actual $id canvas; reference/first/frame=$frame", async ({ id, frame }) => {
    const bytes = await sharp(referencePng({ width: 512, height: 512, color: 2, noise: true })).blur(0.6).png().toBuffer();
    const { app, request, directory, jobsFile, jobsPath, start, finish, refs } = await pngCanvasFixture(bytes, id, frame);
    let summary: any;
    request.mockReset().mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        summary = JSON.parse(await readFile(jobsFile, "utf8"))[0].videoReferencePreparation; expectClosedPngSummary(summary);
        expect(summary).toMatchObject({ jpegConverted: frame === true ? 2 : 1, jpegQuality: 95, jpegMaxEdge: 2048 });
        expect([2, 3]).toContain(summary.version); if (summary.version === 3) expect(summary.requestBudgetMet).toBe(true);
        const body = JSON.parse(String(init.body)), urls = id === "tencent-vod-vs-2.5" ? frame ? [body.first_frame_url, body.last_frame_url].filter(Boolean) : body.images : body.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
        expect(summary.requestBytes).toBe(Buffer.byteLength(String(init.body)));
        expect(urls).toHaveLength(frame === true ? 2 : 1);
        let sent = 0; for (const value of urls) { expect(value.startsWith("data:image/jpeg;base64,")).toBe(true); const data = Buffer.from(value.split(",")[1], "base64"); expect(data[0]).toBe(255); expect(data[1]).toBe(216); sent += data.length; }
        expect(summary.sentBytes).toBe(sent); expect(sent).toBeLessThan(summary.originalBytes); return Response.json({ id: "task_jpeg_canvas" });
      }
      const address = new URL(String(url));
      if (address.hostname === "kunpoapiimg.ziy.cc" || address.pathname.endsWith("/content")) return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      return Response.json(id === DEFAULTS.video.id ? { status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/synthetic-jpeg.mp4" } } : { status: "completed" });
    });
    const first = (await start()).json(), completed = await finish(first.id, "succeeded"); expect(completed.videoReferencePreparation).toEqual(summary);
    expect(completed.run.generation.parameters.referenceJpegConverted).toBe(frame === true ? 2 : 1);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    for (const reference of refs) expect(await readFile(path.join(directory, "library/files", `${reference.assetId}.png`))).toEqual(bytes);
    await app.close(); const reopened = await fixture(directory); expect((await reopened.inject("GET", jobsPath)).json()[0].videoReferencePreparation).toEqual(summary); expect(reopened.request).not.toHaveBeenCalled();
  });

  it("keeps JPEG preparation after download failure and resumes only the saved original fingerprint", async () => {
    const bytes = await sharp(referencePng({ width: 512, height: 512, color: 2, noise: true })).blur(0.6).png().toBuffer();
    const { app, request, directory, jobsFile, jobsPath, start, finish } = await pngCanvasFixture(bytes, DEFAULTS.video.id, true);
    request.mockReset().mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ id: "task_jpeg_recovery" }) : new URL(String(url)).hostname === "kunpoapiimg.ziy.cc" ? new Response("Unavailable", { status: 503 }) : Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/synthetic-jpeg.mp4" } }));
    const first = (await start()).json(), failed = await finish(first.id, "failed"); expect(failed.videoReferencePreparation.jpegConverted).toBe(2); expect(failed.canRecoverVideo, failed.error).toBe(true); await app.close();
    const stored = JSON.parse(await readFile(jobsFile, "utf8"))[0], journalFile = path.join(directory, "tools/video-tasks", `${stored.recoveryId}.json`), before = await readFile(journalFile, "utf8");
    const reopened = await fixture(directory), codec = vi.spyOn(jpegPreparation, "prepareVideoReferenceJpeg");
    reopened.request.mockReset().mockImplementation(async (url, init) => { expect(init?.method ?? "GET").toBe("GET"); return new URL(String(url)).hostname === "kunpoapiimg.ziy.cc" ? new Response(MP4, { headers: { "content-type": "video/mp4" } }) : Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/synthetic-jpeg.mp4" } }); });
    const resumed = (await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).json();
    await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === resumed.id)?.status).toBe("succeeded"));
    const final = (await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === resumed.id); expect(final.videoReferencePreparation).toEqual(failed.videoReferencePreparation);
    expect(codec).not.toHaveBeenCalled(); expect(await readFile(journalFile, "utf8")).toBe(before); expect(reopened.request).toHaveBeenCalledTimes(2);
  });

  it("persists a failed JPEG submission without replaying and cancels a new JPEG preparation before POST", async () => {
    const setup = await pngCanvasFixture(referencePng({ width: 512, height: 512, color: 2, noise: true }));
    const { app, request, directory, jobsPath, jobsFile, start, finish } = setup;
    request.mockReset().mockResolvedValue(Response.json({ error: { code: "bad_response_status_code" } }, { status: 500 }));
    const first = (await start()).json(), failed = await finish(first.id, "failed");
    expect(failed.videoReferencePreparation.jpegConverted).toBe(1); expectClosedPngSummary(failed.videoReferencePreparation);
    expect(failed.canRecoverVideo).toBe(false); await app.close();
    const reopened = await fixture(directory); expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(reopened.request).not.toHaveBeenCalled();
    expect((await reopened.inject("GET", jobsPath)).json()[0].videoReferencePreparation).toEqual(failed.videoReferencePreparation);
    let preparing = false;
    vi.spyOn(jpegPreparation, "prepareVideoReferenceJpeg").mockImplementation(async (_bytes, signal) => {
      preparing = true; return new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new Error("Synthetic JPEG cancellation")), { once: true }); });
    });
    const generatePath = `${setup.boardPath}/nodes/${setup.node.id}/generate`;
    expect((await reopened.inject("POST", generatePath)).statusCode).toBe(409);
    expect(preparing).toBe(false); expect(reopened.request).not.toHaveBeenCalled();
    const confirmed = await reopened.inject("POST", generatePath, { confirmedJobId: first.id });
    expect(confirmed.statusCode).toBe(202);
    const second = confirmed.json(); await vi.waitFor(() => expect(preparing).toBe(true));
    expect((await reopened.inject("POST", `${jobsPath}/${second.id}/cancel`)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === second.id)?.status).toBe("cancelled"));
    expect(reopened.request).not.toHaveBeenCalled();
    const records = JSON.parse(await readFile(jobsFile, "utf8")); expect(records.find((job: any) => job.id === second.id).videoReferencePreparation).toBeUndefined();
  });

  it("keeps transparent frame bytes intact and blocks an oversized mixture before any paid request", async () => {
    const opaque = referencePng({ width: 512, height: 512, color: 2, noise: true }), transparent = referencePng({ width: 512, height: 512, color: 6, noise: true });
    const { app, inject, request, directory, boardPath, jobsPath, start, finish } = await pngCanvasFixture(opaque, DEFAULTS.video.id, true);
    const uploaded = await inject("POST", "/library/assets", { name: "synthetic-alpha.png", image: { mediaType: "image/png", data: transparent.toString("base64") } }); expect(uploaded.statusCode).toBe(201);
    const detail = (await inject("GET", boardPath)).json(); detail.board.nodes[0].data.references[1] = { type: "library", assetId: uploaded.json().id }; expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockReset();
    const first = (await start()).json(), failed = await finish(first.id, "failed");
    expect(failed.videoReferencePreparation).toMatchObject({ version: 3, jpegConverted: 1, jpegTransparent: 1, requestBudgetMet: false });
    expectClosedPngSummary(failed.videoReferencePreparation); expect(request).not.toHaveBeenCalled(); expect(failed.videoSubmission).toBe("not-submitted");
    expect(failed.error).toContain("local 768 KiB request target");
    expect(await readFile(path.join(directory, "library/files", `${uploaded.json().id}.png`))).toEqual(transparent);
    expect(failed.canRecoverVideo).toBe(false); await app.close();
    const reopened = await fixture(directory); expect((await reopened.inject("GET", jobsPath)).json()[0].videoReferencePreparation).toEqual(failed.videoReferencePreparation);
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each([DEFAULTS.video.id, "tencent-vod-vs-2.5", "minimax-video-h3"].flatMap((id) => [false, true].map((frame) => ({ id, frame }))))("persists actual canvas PNG preparation before the $id frame=$frame POST and retains it across reload", async ({ id, frame }) => {
    const setup = await pngCanvasFixture(referencePng(), id, frame), { app, request, directory, jobsFile, jobsPath, start, finish, bytes, refs } = setup;
    let summary: any, wireBytes = 0;
    request.mockReset().mockImplementation(async (url, init) => {
      const address = new URL(String(url));
      if (init?.method === "POST") {
        summary = JSON.parse(await readFile(jobsFile, "utf8"))[0].videoReferencePreparation;
        expectClosedPngSummary(summary); expect(summary.optimized).toBe(frame ? 2 : 1); expect(summary.sentBytes).toBeLessThan(summary.originalBytes);
        const body = JSON.parse(String(init.body));
        const urls = id === "tencent-vod-vs-2.5" ? frame ? [body.first_frame_url, body.last_frame_url] : body.images : body.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
        for (const value of urls) { const prepared = Buffer.from(value.split(",")[1], "base64"); wireBytes += prepared.length; expect(pngScanlines(prepared)).toEqual(pngScanlines(bytes)); }
        expect(summary.sentBytes).toBe(wireBytes);
        return Response.json({ id: "task_canvas_png" });
      }
      if (address.hostname === "kunpoapiimg.ziy.cc" || address.pathname.endsWith("/content")) return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      return Response.json(id === DEFAULTS.video.id ? { status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/synthetic.mp4" } } : { status: "completed" });
    });
    const first = (await start()).json(), completed = await finish(first.id, "succeeded");
    expect(completed.videoReferencePreparation).toEqual(summary); expect(completed.run.generation.parameters.referencePngOptimized).toBe(frame ? 2 : 1);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    for (const reference of refs) expect(await readFile(path.join(directory, "library/files", `${reference.assetId}.png`))).toEqual(bytes);
    await app.close(); const reopened = await fixture(directory);
    const saved = (await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === first.id);
    expect(saved.videoReferencePreparation).toEqual(summary); expectClosedPngSummary(saved.videoReferencePreparation); expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "unsupported", "invalid", "limited"] as const)("persists canvas %s preparation even when submission returns 400, without replaying", async (status) => {
    const bytes = status === "unchanged" ? referencePng({ level: 9, noise: true }) : status === "unsupported" ? referencePng({ metadata: [["vpAg", Buffer.alloc(8)]] }) : referencePng();
    if (status === "invalid") bytes[35]! ^= 1;
    if (status === "limited") vi.spyOn(pngPreparation, "optimizeVideoReferencePng").mockImplementation(async (original) => ({ bytes: original, status: "limited" }));
    const { app, request, directory, jobsPath, jobsFile, start, finish } = await pngCanvasFixture(bytes);
    request.mockReset().mockImplementation(async () => {
      const summary = JSON.parse(await readFile(jobsFile, "utf8"))[0].videoReferencePreparation;
      expectClosedPngSummary(summary); expect(summary[status]).toBe(1); expect(summary.sentBytes).toBe(bytes.length);
      return Response.json({ error: { message: `${KEY} data:image/png;base64,private-provider-payload`, code: "unknown-private-reason" } }, { status: 400 });
    });
    const first = (await start()).json(), failed = await finish(first.id, "failed");
    expect(failed.videoReferencePreparation[status]).toBe(1); expect(failed.canRecoverVideo).toBe(false); expect(request).toHaveBeenCalledOnce();
    await app.close(); const reopened = await fixture(directory);
    const history = await reopened.inject("GET", jobsPath); expect(history.json()[0].videoReferencePreparation).toEqual(failed.videoReferencePreparation);
    expect(history.body).not.toContain(KEY); expect(history.body).not.toContain("private-provider-payload");
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains canvas preparation through cancellation and GET-only recovery; legacy=%s", async (legacy) => {
    const { app, request, directory, jobsPath, jobsFile, start, finish } = await pngCanvasFixture(referencePng(), DEFAULTS.video.id, true);
    request.mockReset().mockImplementation(async (_url, init) => init?.method === "POST" ? Response.json({ id: "task_cancel_png" }) : new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Synthetic status cancelled")), { once: true });
    }));
    const first = (await start()).json(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(await readFile(jobsFile, "utf8"))[0].videoReferencePreparation.optimized).toBe(2);
    const cancelled = await setupCancel(); await finish(first.id, "cancelled"); expect(cancelled.statusCode).toBe(200); await app.close();
    async function setupCancel() { return app.inject({ method: "POST", url: `${jobsPath}/${first.id}/cancel`, headers: { authorization: `Bearer ${ACCESS_TOKEN}` } }); }
    const stored = JSON.parse(await readFile(jobsFile, "utf8")), journalFile = path.join(directory, "tools/video-tasks", `${stored[0].recoveryId}.json`);
    if (legacy) { delete stored[0].videoReferencePreparation; await writeFile(jobsFile, JSON.stringify(stored)); const journal = JSON.parse(await readFile(journalFile, "utf8")); delete journal.generate.task.pngPreparation; await writeFile(journalFile, JSON.stringify(journal), { mode: 0o600 }); }
    const before = await readFile(journalFile, "utf8"), reopened = await fixture(directory), optimizer = vi.spyOn(pngPreparation, "optimizeVideoReferencePng");
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    reopened.request.mockReset().mockImplementation(async (url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      if (new URL(String(url)).hostname === "kunpoapiimg.ziy.cc") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      await gate; return Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/synthetic.mp4" } });
    });
    const replies = await Promise.all([0, 1].map(() => reopened.inject("POST", `${jobsPath}/${first.id}/retry`))); release();
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    const resumed = replies.find((reply) => reply.statusCode === 200)!.json();
    await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === resumed.id)?.status).toBe("succeeded"));
    const history = (await reopened.inject("GET", jobsPath)).json().find((job: any) => job.id === resumed.id);
    if (legacy) expect(history.videoReferencePreparation).toBeUndefined(); else { expect(history.videoReferencePreparation.optimized).toBe(2); expectClosedPngSummary(history.videoReferencePreparation); }
    expect(optimizer).not.toHaveBeenCalled(); expect(await readFile(journalFile, "utf8")).toBe(before); expect(reopened.request).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe persisted canvas summaries without exposing them or changing legacy task records", async () => {
    const { app, request, directory, jobsFile, jobsPath, start, finish } = await pngCanvasFixture();
    request.mockReset().mockResolvedValue(Response.json({ error: {} }, { status: 400 }));
    const first = (await start()).json(); await finish(first.id, "failed"); await app.close();
    const entries = JSON.parse(await readFile(jobsFile, "utf8")); entries[0].videoReferencePreparation = { ...entries[0].videoReferencePreparation, key: KEY, url: "https://private.invalid/?signature=hidden-signature", image: "data:image/png;base64,hidden-image", prompt: "hidden-summary-prompt" };
    await writeFile(jobsFile, JSON.stringify(entries));
    const reopened = await fixture(directory), history = await reopened.inject("GET", jobsPath);
    expect(history.json()[0].videoReferencePreparation).toBeUndefined();
    for (const value of [KEY, "hidden-signature", "hidden-image", "hidden-summary-prompt"]) expect(history.body).not.toContain(value);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it("does not submit a canvas video when preparation history cannot be saved", async () => {
    const { request, start, finish } = await pngCanvasFixture();
    const original = canvasFiles.writeCanvasJson;
    vi.spyOn(canvasFiles, "writeCanvasJson").mockImplementation(async (...args) => {
      const [workspace, file, value] = args;
      if (file === "jobs.json" && Array.isArray(value) && value[0]?.status === "running" && value[0]?.videoReferencePreparation) throw new Error("Synthetic history write failure");
      return original(workspace, file, value);
    });
    request.mockClear(); const first = (await start()).json(), failed = await finish(first.id, "failed");
    expect(failed.canRecoverVideo).toBe(false); expect(failed.error).toContain("no generation request was submitted"); expect(request).not.toHaveBeenCalled();
  });

  it("keeps the canvas preparation summary for an uncertain 500 response but never retries its POST", async () => {
    const { app, request, directory, jobsPath, start, finish } = await pngCanvasFixture();
    request.mockReset().mockResolvedValue(Response.json({ error: { code: "bad_response_status_code" } }, { status: 500 }));
    const first = (await start()).json(), failed = await finish(first.id, "failed");
    expect(failed.videoReferencePreparation.optimized).toBe(1); expect(failed.canRecoverVideo).toBe(false); expect(request).toHaveBeenCalledOnce();
    await app.close(); const reopened = await fixture(directory), history = await reopened.inject("GET", jobsPath);
    expect(history.json()[0].videoReferencePreparation).toEqual(failed.videoReferencePreparation);
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(reopened.request).not.toHaveBeenCalled();
  });

  it("cancels PNG preparation from the actual canvas before any POST without inventing a completed summary", async () => {
    const { inject, request, jobsPath, start, finish } = await pngCanvasFixture();
    let preparing = false;
    vi.spyOn(pngPreparation, "optimizeVideoReferencePng").mockImplementation(async (_bytes, signal) => {
      preparing = true;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("Synthetic preparation cancelled"));
        else signal?.addEventListener("abort", () => reject(new Error("Synthetic preparation cancelled")), { once: true });
      });
    });
    request.mockClear(); const first = (await start()).json(); await vi.waitFor(() => expect(preparing).toBe(true));
    expect((await inject("POST", `${jobsPath}/${first.id}/cancel`)).statusCode).toBe(200);
    const cancelled = await finish(first.id, "cancelled");
    expect(cancelled.videoReferencePreparation).toBeUndefined(); expect(cancelled.canRecoverVideo).toBe(false); expect(request).not.toHaveBeenCalled();
    expect((await inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(request).not.toHaveBeenCalled();
  });

  it("runs voice design and pinned speech through actual canvas/API wiring without a paid cascade", async () => {
    const { app, inject, connect, request, directory } = await fixture(); await connect();
    const wav = referenceWav();
    request.mockReset().mockImplementation(async (_url, init) => new Response(JSON.parse(String(init?.body)).audio_config.format === "wav" ? new Uint8Array(wav) : MP3, { headers: { "content-type": JSON.parse(String(init?.body)).audio_config.format === "wav" ? "audio/wav" : "audio/mpeg" } }));
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Voice versions" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json(), voiceId = randomUUID(), speechId = randomUUID();
    detail.board.nodes = [{ id: voiceId, type: "voice", position: { x: 0, y: 0 }, data: { description: "Warm adult voice", sampleText: "Good morning", model: DEFAULTS.speech } }, { id: speechId, type: "speech", position: { x: 600, y: 0 }, data: { text: "Start the adventure", model: DEFAULTS.speech } }];
    detail.board.editorLayout.nodes = { [voiceId]: { x: 0, y: 0 }, [speechId]: { x: 600, y: 0 } };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    async function generate(id: string) {
      const started = await inject("POST", `${boardPath}/nodes/${id}/generate`); expect(started.statusCode, started.body).toBe(202);
      let job!: ToolJob;
      await vi.waitFor(async () => { job = (await inject("GET", jobsPath)).json().find((item: ToolJob) => item.id === started.json().id); expect(job?.status).not.toBe("running"); });
      expect(job.status, job.error).toBe("succeeded"); return job;
    }
    await generate(voiceId);
    let current = (await inject("GET", boardPath)).json();
    const first = current.board.nodes.find((node: { id: string }) => node.id === voiceId).data.assetId;
    const digest = createHash("sha256").update(wav).digest("hex");
    Object.assign(current.board.nodes[0].data, { selectedAssetId: first, selectedSha256: digest });
    Object.assign(current.board.nodes[1].data, { referenceAssetId: first, referenceSha256: digest, voiceSourceNodeId: voiceId });
    expect((await inject("PUT", boardPath, current)).statusCode).toBe(200); expect(request).toHaveBeenCalledOnce();
    await generate(voiceId);
    current = (await inject("GET", boardPath)).json();
    expect(current.board.nodes[0].data.assetId).not.toBe(first);
    expect(current.board.nodes[0].data.selectedAssetId).toBe(first);
    expect(current.board.nodes[1].data.referenceAssetId).toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
    await generate(speechId);
    const conditioned = JSON.parse(String(request.mock.calls[2]![1]?.body));
    expect(conditioned.references).toEqual([{ audio_data: wav.toString("base64") }]);
    current = (await inject("GET", boardPath)).json();
    delete current.board.nodes[1].data.referenceAssetId; delete current.board.nodes[1].data.referenceSha256; delete current.board.nodes[1].data.voiceSourceNodeId;
    expect((await inject("PUT", boardPath, current)).statusCode).toBe(200);
    await generate(speechId);
    expect(JSON.parse(String(request.mock.calls[3]![1]?.body))).not.toHaveProperty("references");
    expect(request).toHaveBeenCalledTimes(4);
    const history = await inject("GET", jobsPath); expect(history.body).not.toContain(KEY); expect(history.body).not.toContain(wav.toString("base64"));
    await expectNoPublicKey(path.join(directory, "projects", project.id)); await app.close();
    const reopened = await fixture(directory), restored = (await reopened.inject("GET", boardPath)).json();
    expect(restored.board.nodes[0].data.selectedAssetId).toBe(first); expect(reopened.request).not.toHaveBeenCalled();
  });

  it("generates speech from private local reference bytes and retires Speaker settings without paid preview", async () => {
    const { app, inject, connect, request } = await fixture(); await connect();
    const uploaded = await app.inject({ method: "POST", url: "/library/assets/upload?name=voice.wav&mediaType=audio%2Fwav&purpose=reference&duration=1", payload: referenceWav(), headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/octet-stream" } });
    expect(uploaded.statusCode, uploaded.body).toBe(201); expect(request).not.toHaveBeenCalled();
    const reference = uploaded.json();
    expect((await inject("GET", "/settings/models/providers/volcengine-tts")).json()).toEqual({ configured: true });
    expect((await inject("PUT", "/settings/models/providers/volcengine-tts", { defaultVoiceId: "old-id" })).statusCode).toBe(410);
    expect((await inject("POST", "/settings/models/providers/volcengine-tts/preview", { text: "Hello" })).statusCode).toBe(410);
    expect((await inject("POST", "/tools/generate-speech/jobs", { text: "Hello", voiceId: "old-id", model: DEFAULTS.speech })).statusCode).toBe(400);
    expect(request).not.toHaveBeenCalled();
    const started = await inject("POST", "/tools/generate-speech/jobs", { text: "Hello traveler", referenceAssetId: reference.id, model: DEFAULTS.speech });
    expect(started.statusCode, started.body).toBe(202);
    expect(await finishJob(inject, started.json().id)).toMatchObject({ status: "succeeded", model: DEFAULTS.speech });
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body.references).toEqual([{ audio_data: referenceWav().toString("base64") }]);
    expect(body.text_prompt).toContain("@音频1"); expect(body.text_prompt).toContain("Hello traveler");
    const history = await inject("GET", "/tool-jobs");
    for (const hidden of [KEY, "audio_data", referenceWav().toString("base64"), "old-id"]) expect(history.body).not.toContain(hidden);
  });

  it.each(["http", "bad-response", "timeout"])("persists sanitized video %s diagnostics across reopen without exposing provider text", async (kind) => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const privateText = `${KEY} https://example.invalid?signature=private-error data:image/png;base64,private-image`;
    request.mockReset();
    if (kind !== "timeout") request.mockResolvedValue(Response.json({ error: { code: kind === "http" ? "invalid_parameter" : "bad_response_status_code", message: privateText }, request_id: privateText }, { status: 400 }));
    else request.mockRejectedValue(new Error(privateText, { cause: Object.assign(new Error(privateText), { code: "UND_ERR_HEADERS_TIMEOUT" }) }));
    const diagnostic = kind !== "timeout" ? { phase: "submission", category: "http", httpStatus: 400, providerCode: kind === "http" ? "invalid-request" : "bad-response-status" } : { phase: "submission", category: "timeout", timeoutKind: "headers" };
    const started = await inject("POST", "/tools/generate-video/jobs", { prompt: "Fixture", model: DEFAULTS.video, duration: 4, resolution: "480p", aspectRatio: "16:9" });
    expect(started.statusCode).toBe(202);
    expect(await finishJob(inject, started.json().id)).toMatchObject({ status: "failed", videoDiagnostic: diagnostic });
    expect(request).toHaveBeenCalledOnce(); await app.close();
    const reopened = await fixture(directory);
    const history = await reopened.inject("GET", "/tool-jobs");
    expect(history.json()[0].videoDiagnostic).toEqual(diagnostic);
    for (const secret of [KEY, "signature=private-error", "private-image", "request_id"]) expect(history.body).not.toContain(secret);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["http", "timeout"])("persists safe reference-audio %s diagnostics across reopen without replay or private payloads", async (kind) => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const bytes = referenceWav();
    const reference = (await app.inject({ method: "POST", url: "/library/assets/upload?name=reference.wav&mediaType=audio%2Fwav&purpose=reference&duration=1", payload: bytes, headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/octet-stream" } })).json();
    const privateText = `${KEY} https://private.invalid/?signature=private-audio data:audio/private private-script`;
    request.mockReset();
    if (kind === "http") request.mockResolvedValue(Response.json({ error: { code: "bad_response_status_code", message: privateText, param: privateText }, request_id: privateText }, { status: 400 }));
    else request.mockRejectedValue(new Error(privateText, { cause: Object.assign(new Error(privateText), { code: "UND_ERR_HEADERS_TIMEOUT" }) }));
    const expected = kind === "http" ? { phase: "body", category: "http", httpStatus: 400, providerCode: "bad-response-status" } : { phase: "request", category: "timeout", timeoutKind: "headers" };
    const started = await inject("POST", "/tools/generate-speech/jobs", { text: "Hello traveler", model: DEFAULTS.speech, referenceAssetId: reference.id });
    expect(started.statusCode).toBe(202);
    const job = await finishJob(inject, started.json().id);
    expect(job).toMatchObject({ status: "failed", audioDiagnostic: { ...expected, requestBytes: expect.any(Number), elapsedMs: expect.any(Number) }, ...(kind === "timeout" ? { submissionOutcome: "unknown" } : {}) });
    expect(JSON.stringify(job.audioDiagnostic)).not.toContain("Hello traveler");
    if (kind === "timeout") expect((await inject("POST", `/tool-jobs/${started.json().id}/retry`)).statusCode).toBe(409);
    expect(request).toHaveBeenCalledOnce(); await app.close();
    const reopened = await fixture(directory), history = await reopened.inject("GET", "/tool-jobs");
    expect(history.json()[0].audioDiagnostic).toEqual(job.audioDiagnostic);
    for (const secret of [KEY, "private-script", "signature=private-audio", "data:audio", "audio_data", bytes.toString("base64"), "request_id"]) expect(history.body).not.toContain(secret);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["generate-video", "image-to-3d"])("refuses %s before submitting when same-origin artifact DNS is unsafe", async (toolId) => {
    const { inject, connect, request } = await fixture(); await connect();
    appArtifactDns.mockResolvedValue([{ address: "198.18.0.11", family: 4 }]);
    const input = toolId === "generate-video" ? { prompt: "A rolling ball", model: { provider: "kunpo", id: "tencent-vod-vs-2.5" }, duration: 4, resolution: "480p", aspectRatio: "16:9" }
      : { operation: "text", prompt: "A simple stone cube", model: DEFAULTS["3d-generation"], images: [] };
    const started = await inject("POST", `/tools/${toolId}/jobs`, input);
    expect(started.statusCode, started.body).toBe(202);
    expect(await finishJob(inject, started.json().id)).toMatchObject({ status: "failed" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["sound-effect", "speech", "voice"] as const)("marks cancelled canvas %s as unknown and refuses unconfirmed replay", async (type) => {
    const { inject, connect, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Audio cancellation" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json(), id = randomUUID();
    detail.board.nodes = [{ id, type, position: { x: 0, y: 0 }, data: type === "sound-effect" ? { prompt: "Quiet rain", model: DEFAULTS["sound-effect"] } : type === "speech" ? { text: "Hello", model: DEFAULTS.speech } : { description: "Warm", sampleText: "Hello", model: DEFAULTS.speech } }];
    detail.board.editorLayout.nodes = { [id]: { x: 0, y: 0 } };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockReset().mockImplementation((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }));
    const first = (await inject("POST", `${boardPath}/nodes/${id}/generate`)).json();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect((await inject("POST", `${jobsPath}/${first.id}/cancel`)).json()).toMatchObject({ status: "cancelled", submissionOutcome: "unknown" });
    expect((await inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409);
    expect((await inject("POST", `${boardPath}/nodes/${id}/generate`)).statusCode).toBe(409);
    expect((await inject("POST", `${boardPath}/nodes/${id}/generate`, { confirmedAudioJobId: "wrong-job" })).statusCode).toBe(409);
    expect(request).toHaveBeenCalledOnce();
    const next = await inject("POST", `${boardPath}/nodes/${id}/generate`, { confirmedAudioJobId: first.id });
    expect(next.statusCode, next.body).toBe(202);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await inject("POST", `${jobsPath}/${next.json().id}/cancel`);
  });

  it.each(["retry", "generate", "cancel-after-response", "different-node", "history-churn"])("recovers only the owning node’s paid canvas audio across restart without further submissions (%s)", async (action) => {
    const { app, directory, inject, connect, request } = await fixture();
    await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Local audio recovery" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json();
    const node = { id: randomUUID(), type: "sound-effect", position: { x: 0, y: 0 }, data: { prompt: "Rustling leaves", model: DEFAULTS["sound-effect"] } };
    const other = { ...node, id: randomUUID() };
    detail.board.nodes = [node, other]; detail.board.editorLayout.nodes = { [node.id]: node.position, [other.id]: other.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    const generate = `${boardPath}/nodes/${node.id}/generate`;
    const savingAudio = AssetLibrary.prototype.add;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const cancelled = action === "cancel-after-response";
    const save = cancelled
      ? vi.spyOn(AssetLibrary.prototype, "add").mockImplementationOnce(async function(this: AssetLibrary, ...args) {
        await paused;
        return savingAudio.apply(this, args);
      })
      : vi.spyOn(ProjectManager.prototype, "materializeLibraryAsset").mockRejectedValueOnce(new Error("Fixture disk fault"));
    let first: ToolJob;
    try {
      const started = await inject("POST", generate);
      expect(started.statusCode, started.body).toBe(202);
      first = started.json();
      if (cancelled) {
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        expect((await inject("POST", `${jobsPath}/${first.id}/cancel`)).statusCode).toBe(200);
        release();
      }
      await vi.waitFor(async () => {
        first = (await inject("GET", jobsPath)).json().find((job: ToolJob) => job.id === first.id);
        expect(first).toMatchObject({ status: cancelled ? "cancelled" : "failed", run: { files: [{ assetId: expect.any(String) }] } });
      });
    } finally { release(); save.mockRestore(); }
    expect(request.mock.calls.filter(([url]) => String(url).includes("/audio/speech"))).toHaveLength(1);
    await app.close();
    const historyFile = path.join(directory, "projects", project.id, "workspace", "canvas", "jobs.json");
    const history = JSON.parse(await readFile(historyFile, "utf8"));
    history[0].run.files[0].assetId = randomUUID(); // Only the private run's output may be attached.
    if (action === "different-node") history[0].context.nodeId = other.id;
    if (action === "history-churn") history.unshift(...Array.from({ length: 80 }, () => ({
      id: randomUUID(), toolId: "generate-sound-effect", context: { projectId: project.id, boardId, nodeId: other.id },
      createdAt: new Date().toISOString(), title: "Earlier successful job", status: "succeeded",
    })));
    await writeFile(historyFile, JSON.stringify(history));
    const reopened = await fixture(directory);
    if (action === "history-churn") {
      expect((await reopened.inject("POST", `${boardPath}/nodes/${other.id}/generate`)).statusCode).toBe(202);
      await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json()[0].status).toBe("succeeded"));
      expect(reopened.request).toHaveBeenCalledOnce();
      reopened.request.mockClear();
    }
    const explicitRetry = action !== "generate";
    const resumed = await reopened.inject("POST", explicitRetry ? `${jobsPath}/${first.id}/retry` : generate);
    if (action === "different-node") {
      expect(resumed.statusCode, resumed.body).toBe(409);
      expect(resumed.json()).toMatchObject({ error: expect.stringContaining("original generation input does not match this job") });
      expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual(history);
      expect((await reopened.inject("GET", boardPath)).json().board.nodes[1].data.assetId).toBeUndefined();
      expect(reopened.request).not.toHaveBeenCalled();
      return;
    }
    expect(resumed.statusCode, resumed.body).toBe(explicitRetry ? 200 : 202);
    await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json()[0]).toMatchObject({ status: "succeeded", run: { id: first.run!.id } }));
    expect((await reopened.inject("GET", boardPath)).json().board.nodes[0].data.assetId).toBe(first.run!.files[0]!.assetId);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["speech", "sound-effect", "music"] as const)("persists unknown canvas %s outcomes and refuses a paid retry across reopen", async (kind) => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Audio unknown result" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json();
    const reference = kind === "speech" ? (await app.inject({ method: "POST", url: "/library/assets/upload?name=voice.wav&mediaType=audio%2Fwav&purpose=reference&duration=1", payload: referenceWav(), headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/octet-stream" } })).json() : undefined;
    const node = { id: randomUUID(), type: kind, position: { x: 0, y: 0 }, data: { model: kind === "speech" ? DEFAULTS.speech : DEFAULTS["sound-effect"], ...(kind === "speech" ? { text: "Hello", referenceAssetId: reference.id } : { prompt: "Quiet rain", ...(kind === "music" ? { instrumental: true, lyrics: "" } : {}) }) } };
    detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockReset().mockResolvedValue(Response.json({ unexpected: "no usable binary result" }));
    const first = (await inject("POST", `${boardPath}/nodes/${node.id}/generate`)).json();
    await vi.waitFor(async () => expect((await inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === first.id)).toMatchObject({ status: "failed", submissionOutcome: "unknown" }));
    const diagnostic = (await inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === first.id).audioDiagnostic;
    expect(diagnostic).toMatchObject({ phase: "body", category: "invalid-response", httpStatus: 200, requestBytes: expect.any(Number), elapsedMs: expect.any(Number) });
    expect((await inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await app.close();
    const reopened = await fixture(directory);
    expect((await reopened.inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === first.id).audioDiagnostic).toEqual(diagnostic);
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["http400", "connection", "missing-id", "local-dns"] as const)("persists a private-safe video transport receipt for %s without replay on recovery", async mode => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Submission receipt" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
    if (node.type !== "video") throw new Error();
    Object.assign(node.data, { prompt: "Synthetic receipt fixture", model: DEFAULTS.video, resolution: "480p", aspectRatio: "16:9", duration: 4, referenceMode: "reference" });
    detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockReset().mockImplementation(async (_url, init) => {
      expect(init?.method).toBe("POST");
      const saved = JSON.parse(await readFile(path.join(directory, "projects", project.id, "workspace/canvas/jobs.json"), "utf8"));
      expect(saved.find((job: ToolJob) => job.context?.nodeId === node.id).videoSubmission).toBe("attempted");
      if (mode === "connection") throw new Error("Synthetic transport loss");
      return mode === "http400" ? Response.json({ error: { type: "bad_response_status_code" } }, { status: 400 }) : Response.json({});
    });
    if (mode === "local-dns") appArtifactDns.mockRejectedValue(new Error("Synthetic DNS unavailable"));
    const first = (await inject("POST", `${boardPath}/nodes/${node.id}/generate`)).json();
    await vi.waitFor(async () => expect((await inject("GET", jobsPath)).json().find((job: ToolJob) => job.id === first.id)?.status).toBe("failed"));
    const outcome = (await inject("GET", jobsPath)).json().find((job: ToolJob) => job.id === first.id);
    expect(outcome).toMatchObject({ videoSubmission: mode === "local-dns" ? "not-submitted" : "attempted", canRecoverVideo: false });
    expect(request).toHaveBeenCalledTimes(mode === "local-dns" ? 0 : 1);
    const publicHistory = await inject("GET", jobsPath); expect(publicHistory.body).not.toContain(KEY); expect(publicHistory.body).not.toContain("authorization");
    await app.close(); appArtifactDns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const reopened = await fixture(directory);
    expect((await reopened.inject("GET", jobsPath)).json().find((job: ToolJob) => job.id === first.id).videoSubmission).toBe(outcome.videoSubmission);
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409); expect(reopened.request).not.toHaveBeenCalled();
  });

  it.each(["16:9", "adaptive"] as const)("resumes a saved %s canvas video across restart without another paid POST", async (aspectRatio) => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Video recovery" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`, jobsPath = `/projects/${project.id}/canvas/jobs`;
    const detail = (await inject("GET", boardPath)).json();
    const node = createAssetGenerationNode("video", { x: 0, y: 0 });
    if (node.type !== "video") throw new Error();
    Object.assign(node.data, { prompt: "A cube rolls", model: DEFAULTS.video, resolution: "480p", aspectRatio, duration: 4, referenceMode: "reference" });
    if (aspectRatio === "adaptive") {
      const reference = await inject("POST", "/library/assets", { name: "reference.png", image: { mediaType: "image/png", data: PNG.toString("base64") } });
      expect(reference.statusCode, reference.body).toBe(201);
      node.data.references = [{ type: "library", assetId: reference.json().id }];
    }
    detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    request.mockReset().mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ id: "task_saved_video" })
      : new URL(String(url)).hostname === "kunpoapiimg.ziy.cc" ? new Response("Download failed", { status: 503 })
      : Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/saved.mp4?signature=private-video-capability" } }));
    const first = (await inject("POST", `${boardPath}/nodes/${node.id}/generate`)).json();
    await vi.waitFor(async () => expect((await inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === first.id)).toMatchObject({ status: "failed", canRecoverVideo: true }));
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    if (aspectRatio === "adaptive") {
      const body = JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
      expect(body.ratio).toBe("adaptive");
      expect(body.content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` }, role: "reference_image" });
      const draft = (await inject("GET", boardPath)).json();
      Object.assign(draft.board.nodes[0].data, { prompt: "A different draft", aspectRatio: "16:9", duration: 8, resolution: "720p", references: [] });
      expect((await inject("PUT", boardPath, draft)).statusCode).toBe(200);
    }
    await app.close();
    const reopened = await fixture(directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    reopened.request.mockReset().mockImplementation(async (url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      if (new URL(String(url)).hostname === "kunpoapiimg.ziy.cc") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      }
      await gate;
      return Response.json({ status: "succeeded", content: { video_url: "https://kunpoapiimg.ziy.cc/saved.mp4?signature=private-video-capability" } });
    });
    const replies = await Promise.all([0, 1].map(() => reopened.inject("POST", `${jobsPath}/${first.id}/retry`)));
    release();
    expect(replies.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const resumedId = replies.find((response) => response.statusCode === 200)!.json().id;
    await vi.waitFor(async () => expect((await reopened.inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === resumedId)).toMatchObject({ status: "succeeded", videoRecoveryOnly: true }));
    expect((await reopened.inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409);
    expect(reopened.request.mock.calls).toHaveLength(2);
    const saved = (await reopened.inject("GET", boardPath)).json();
    expect(saved.board.nodes[0].data).toMatchObject(aspectRatio === "adaptive" ? { prompt: "A different draft", duration: 8, aspectRatio: "16:9", resolution: "720p", references: [] } : { prompt: "A cube rolls", duration: 4, aspectRatio });
    expect(saved.board.nodes[0].data.assetId).toBeTruthy();
    const assets = (await reopened.inject("GET", "/library/assets")).json();
    expect(assets.find((asset: { id: string }) => asset.id === saved.board.nodes[0].data.assetId).generation.parameters).toMatchObject({ aspectRatio, referenceCount: aspectRatio === "adaptive" ? 1 : 0 });
    const history = await reopened.inject("GET", jobsPath);
    for (const secret of [KEY, "private-video-capability", "recoveryId", '"input"']) expect(history.body).not.toContain(secret);
  });

  it("exits DNS failures, refuses empty recovery, and lets a new node work after DNS is healthy", async () => {
    const { app, inject, connect, request } = await fixture();
    appArtifactDns.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
    const statusPath = "/settings/models/providers/openai/images/download-status";
    expect((await app.inject({ method: "GET", url: statusPath })).statusCode).toBe(401);
    expect((await inject("GET", statusPath)).json()).toEqual({ state: "fake-ip" });
    expect(request).not.toHaveBeenCalled();
    await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "DNS gate test" })).json();
    const boardId = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json().boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`;
    const detail = (await inject("GET", boardPath)).json();
    const nodes = [0, 1].map((i) => { const node = createAssetGenerationNode("image", { x: i * 500, y: 0 }); if (node.type !== "image") throw new Error(); node.data.prompt = "A small test icon"; node.data.model = DEFAULTS.image; return node; });
    detail.board.nodes = nodes; detail.board.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [node.id, node.position]));
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    const jobsPath = `/projects/${project.id}/canvas/jobs`;
    for (const node of nodes) {
      const first = (await inject("POST", `${boardPath}/nodes/${node.id}/generate`)).json();
      await vi.waitFor(async () => expect((await inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === first.id)).toMatchObject({ status: "failed", canRecoverImage: false }));
      const count = (await inject("GET", jobsPath)).json().length;
      expect((await inject("POST", `${jobsPath}/${first.id}/retry`)).statusCode).toBe(409);
      expect((await inject("GET", jobsPath)).json()).toHaveLength(count);
    }
    expect(request).not.toHaveBeenCalled();
    appArtifactDns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    expect((await inject("GET", statusPath)).json()).toEqual({ state: "ready" });
    expect(request).not.toHaveBeenCalled();
    const next = (await inject("POST", `${boardPath}/nodes/${nodes[1]!.id}/generate`)).json();
    await vi.waitFor(async () => expect((await inject("GET", jobsPath)).json().find((job: { id: string }) => job.id === next.id)).toMatchObject({ status: "succeeded" }));
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await inject("GET", jobsPath)).json().some((job: { status: string }) => job.status === "running")).toBe(false);
  });
  it("recovers a canvas image after app restart using only the saved signed URL", async () => {
    const { app, inject, connect, directory, request } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas", name: "Recovery test" })).json();
    const workspace = (await inject("GET", `/projects/${project.id}/canvas/workspace`)).json();
    const boardId = workspace.boards[0].id;
    const boardPath = `/projects/${project.id}/canvas/boards/${boardId}`;
    const detail = (await inject("GET", boardPath)).json();
    const node = createAssetGenerationNode("image", { x: 0, y: 0 });
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "A blue chest"; node.data.model = DEFAULTS.image;
    detail.board.nodes = [node]; detail.board.editorLayout.nodes = { [node.id]: node.position };
    expect((await inject("PUT", boardPath, detail)).statusCode).toBe(200);
    const signed = "https://kunpoapiimg.ziy.cc/canvas.png?signature=private-canvas-capability";
    request.mockReset().mockImplementation(async (_url, options) => options?.method === "POST"
      ? Response.json({ data: [{ url: signed }] }, { headers: { "x-request-id": "canvas-result-id" } })
      : new Response("Unavailable", { status: 503 }));
    const first = await inject("POST", `${boardPath}/nodes/${node.id}/generate`);
    expect(first.statusCode, first.body).toBe(202);
    const firstId = first.json().id;
    const waitCanvas = async (call: typeof inject, jobId: string) => {
      let job: { id: string; status: string; run?: { files: unknown[] } } | undefined;
      await vi.waitFor(async () => { job = (await call("GET", `/projects/${project.id}/canvas/jobs`)).json().find((job: { id: string }) => job.id === jobId); expect(job?.status).not.toBe("running"); });
      return job!;
    };
    expect(await waitCanvas(inject, firstId)).toMatchObject({ status: "failed", canRecoverImage: true });
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    const history = await inject("GET", `/projects/${project.id}/canvas/jobs`);
    for (const secret of [KEY, signed, "private-canvas-capability", "recoveryId", '"input"']) expect(history.body).not.toContain(secret);
    await app.close();
    const reopened = await fixture(directory);
    reopened.request.mockReset().mockImplementation(async (_url, options) => {
      expect(options?.method).toBe("GET");
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    });
    const retry = await reopened.inject("POST", `/projects/${project.id}/canvas/jobs/${firstId}/retry`);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await waitCanvas(reopened.inject, retry.json().id)).toMatchObject({ status: "succeeded" });
    expect(reopened.request.mock.calls).toHaveLength(1);
    expect(reopened.request.mock.calls[0]?.[0]).toBe(signed);
    const saved = (await reopened.inject("GET", boardPath)).json();
    expect(saved.board.nodes[0].data.assetId).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain("private-canvas-capability");
  });

  it("offers one credential boundary for all capabilities without background HTTP", async () => {
    const { inject, request } = await fixture();
    const response = await inject("GET", "/settings/providers");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((provider: { id: string }) => provider.id)).toEqual(["kunpo"]);
    expect(response.json()[0]).toMatchObject({ id: "kunpo", name: "KunpoAPI", configured: false, capabilities: ["language", "image", "video", "audio", "3d"] });
    expect(response.body).not.toContain(KEY);
    expect(request).not.toHaveBeenCalled();
  });

  it("stores the literal Kunpo key only in daemon private storage and never returns it in public settings or auth events", async () => {
    const { inject, connect, directory, request } = await fixture();
    const operation = await connect();
    const keyFile = path.join(directory, "local-api-keys.json");
    expect(JSON.parse(await readFile(keyFile, "utf8"))).toMatchObject({ kunpo: { type: "api_key", key: KEY } });
    if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o077).toBe(0);
    for (const url of ["/settings/providers", "/settings/models/providers/kunpo/custom", "/audio-models/catalog", `/settings/model-auth/${operation}/events`]) {
      const response = await inject("GET", url);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(KEY);
    }
    expect(request).not.toHaveBeenCalled();
    const oauth = await inject("POST", "/settings/models/providers/kunpo/login", { method: "oauth" });
    expect([400, 403]).toContain(oauth.statusCode);
  });

  it("does not enable Kunpo adapters from stored legacy vendor credentials", async () => {
    const directory = await temporary();
    await new VolcengineSeedAudioSettingsStore(directory).update(LEGACY_KEY);
    await writeFile(path.join(directory, "volcengine-tts.json"), JSON.stringify({ version: 1, apiKey: LEGACY_KEY, defaultVoiceId: "legacy_voice" }), { mode: 0o600 });
    await new MediaProviderKeyStore(directory, "tripo", "Tripo").update(LEGACY_KEY);
    await new SeedanceSettingsStore(directory).update("volcengine-ark", LEGACY_KEY);
    const { inject, request } = await fixture(directory);
    for (const url of ["/image-models/catalog", "/audio-models/catalog", "/video-models/catalog", "/model3d-models/catalog"]) {
      const response = await inject("GET", url);
      expect(response.statusCode, response.body).toBe(200);
      expect.soft(response.json().models.map(({ provider, id }: { provider: string; id: string }) => ({ provider, id })), url).toEqual([]);
      expect(response.body).not.toContain(LEGACY_KEY);
    }
    const started = await inject("POST", "/tools/generate-sound-effect/jobs", { prompt: "Rain" });
    expect(started.statusCode).toBe(202);
    expect(await finishJob(inject, started.json().id)).toMatchObject({ status: "failed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("snapshots the agreed defaults only for newly created projects and preserves legacy projects", async () => {
    const directory = await temporary(), oldId = randomUUID(), chosenId = randomUUID();
    const explicit = { agent: { provider: "kunpo", id: "gpt-6.1-sol" }, image: { provider: "legacy-image-provider", id: "legacy-explicit-image" } };
    for (const [id, extra] of [[oldId, {}], [chosenId, { modelSelections: explicit, mediaModelDefaults: { image: explicit.image } }]] as const) {
      const projectDirectory = path.join(directory, "projects", id);
      await mkdir(path.join(projectDirectory, "workspace"), { recursive: true });
      await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ version: 1, id, name: "Existing", type: "web-game", updatedAt: "2026-01-01T00:00:00.000Z", ...extra }));
    }
    const { inject } = await fixture(directory);
    expect((await inject("GET", `/projects/${oldId}`)).json().modelSelections).toBeUndefined();
    expect((await inject("GET", `/projects/${chosenId}`)).json()).toMatchObject({ modelSelections: explicit, mediaModelDefaults: { image: explicit.image } });
    const conversations = `/projects/${chosenId}/conversations`;
    const historical = await inject("POST", conversations, {});
    expect(historical.statusCode, historical.body).toBe(201);
    expect((await inject("GET", `${conversations}/${historical.json().id}`)).json().settings.model).toEqual(explicit.agent);
    const fable = { provider: "kunpo", id: "claude-fable-5-2" };
    expect((await inject("PATCH", `/projects/${chosenId}/model-selections`, { agent: fable })).statusCode).toBe(200);
    const fresh = await inject("POST", conversations, {});
    expect((await inject("GET", `${conversations}/${fresh.json().id}`)).json().settings.model).toEqual(fable);
    const created = await inject("POST", "/projects", { name: "New Kunpo project" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().modelSelections).toEqual(DEFAULTS);
    expect(created.json().modelSelections.music).toBeUndefined();
    const disk = JSON.parse(await readFile(path.join(directory, "projects", oldId, "project.json"), "utf8"));
    expect(disk.modelSelections).toBeUndefined();
  });

  it("validates model roles without mutating saved selections on invalid requests", async () => {
    const { inject } = await fixture();
    const project = (await inject("POST", "/projects", {})).json();
    for (const payload of [
      { unknownRole: DEFAULTS.image },
      { image: DEFAULTS.video },
      { image: { provider: "openai", id: "unreviewed-image" } },
      { image: { ...DEFAULTS.image, apiKey: KEY } },
    ]) {
      const result = await inject("PATCH", `/projects/${project.id}/model-selections`, payload);
      expect(result.statusCode, result.body).toBe(400);
      expect((await inject("GET", `/projects/${project.id}`)).json().modelSelections).toEqual(DEFAULTS);
    }
  });

  it("persists an explicit alternate selection through reopening without overwriting other roles", async () => {
    const { app, directory, inject } = await fixture();
    const project = (await inject("POST", "/projects", {})).json();
    const alternate = { provider: "openai", id: "gpt-image-2.5-flare" };
    const changed = await inject("PATCH", `/projects/${project.id}/model-selections`, { image: alternate });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().modelSelections).toEqual({ ...DEFAULTS, image: alternate });
    await app.close();
    const reopened = await fixture(directory);
    expect((await reopened.inject("GET", `/projects/${project.id}`)).json().modelSelections).toEqual({ ...DEFAULTS, image: alternate });
  });

  it("offers the four current Kunpo Agents and rejects new selections of retired IDs", async () => {
    const { inject, request, connect } = await fixture(); await connect();
    const project = (await inject("POST", "/projects", {})).json();
    const catalog = (await inject("GET", "/models")).json();
    expect(catalog.models.filter((model: { provider: string }) => model.provider === "kunpo").map((model: { id: string }) => model.id).sort())
      .toEqual(["claude-fable-5-2", "claude-opus-5-5", "gpt-5.6-sol", "gpt-6.2-astra"]);
    request.mockClear();
    for (const id of ["gpt-6.1-sol", "gemini-3.8-flash", "claude-sonnet-5-5", "kimi-k3.1-pro"]) {
      const model = { provider: "kunpo", id };
      expect((await inject("PATCH", `/projects/${project.id}/model-selections`, { agent: model })).statusCode).toBe(400);
      expect((await inject("POST", `/projects/${project.id}/conversations`, { model })).statusCode).toBe(400);
    }
    expect((await inject("GET", `/projects/${project.id}`)).json().modelSelections.agent).toEqual(DEFAULTS.agent);
    expect((await inject("GET", `/projects/${project.id}/conversations`)).json()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([200, 500, 502])("persists an unknown audio outcome and rejects automatic retry after HTTP %i", async (status) => {
    const { app, directory, inject, connect, request } = await fixture();
    await connect();
    request.mockImplementation(async () => new Response(status === 200 ? "not audio" : "upstream failure", {
      status, headers: { "content-type": status === 200 ? "audio/mpeg" : "application/json" },
    }));
    const project = (await inject("POST", "/projects", {})).json();
    const started = await inject("POST", "/tools/generate-sound-effect/jobs", { prompt: "Rain", projectId: project.id, nodeId: "audio-unknown" });
    expect(started.statusCode, started.body).toBe(202);
    const id = started.json().id;
    expect(await finishJob(inject, id)).toMatchObject({ status: "failed", submissionOutcome: "unknown" });
    const retry = await inject("POST", `/tool-jobs/${id}/retry`);
    expect(retry.statusCode, retry.body).toBe(409);
    expect(request).toHaveBeenCalledTimes(1);
    await app.close();
    const reopened = await fixture(directory);
    expect(await finishJob(reopened.inject, id)).toMatchObject({ status: "failed", submissionOutcome: "unknown" });
    const afterReopen = await reopened.inject("POST", `/tool-jobs/${id}/retry`);
    expect(afterReopen.statusCode, afterReopen.body).toBe(409);
    expect(reopened.request).not.toHaveBeenCalled();
  });

  it("allows an explicit retry after a definite quota rejection without submitting automatically", async () => {
    const { inject, connect, request } = await fixture();
    await connect();
    request.mockReset().mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(MP3, { headers: { "content-type": "audio/mpeg" } }));
    const project = (await inject("POST", "/projects", {})).json();
    const started = await inject("POST", "/tools/generate-sound-effect/jobs", { prompt: "Rain", projectId: project.id, nodeId: "audio-quota" });
    expect(started.statusCode, started.body).toBe(202);
    const job = await finishJob(inject, started.json().id);
    expect(job).toMatchObject({ status: "failed" });
    expect(job.submissionOutcome).not.toBe("unknown");
    expect(request).toHaveBeenCalledTimes(1);
    const retry = await inject("POST", `/tool-jobs/${job.id}/retry`);
    expect(retry.statusCode, retry.body).toBe(202);
    expect(await finishJob(inject, retry.json().id)).toMatchObject({ status: "succeeded", model: DEFAULTS["sound-effect"] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects protected credentials before creating public audio jobs or persisted history", async () => {
    const { inject, connect, request, directory } = await fixture();
    await connect();
    const project = (await inject("POST", "/projects", {})).json();
    const response = await inject("POST", "/tools/generate-sound-effect/jobs", { prompt: `Rain ${KEY}`, projectId: project.id, nodeId: "protected-audio" });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).not.toContain(KEY);
    const publicHistory = await inject("GET", "/tool-jobs");
    expect(publicHistory.json()).toEqual([]);
    expect(publicHistory.body).not.toContain(KEY);
    const jobs = await readFile(path.join(directory, "tools", "jobs.json"), "utf8").catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "[]";
      throw cause;
    });
    expect(jobs).not.toContain(KEY);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses known keys in conversation prompts, queued context and edits before history writes", async () => {
    const { inject, connect, request, directory } = await fixture();
    await connect();
    const project = (await inject("POST", "/projects", {})).json();
    const conversation = (await inject("POST", `/projects/${project.id}/conversations`, {})).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    const before = (await inject("GET", base)).body;
    for (const [method, url, payload] of [
      ["POST", `${base}/turns`, { prompt: `Inspect ${KEY}` }],
      ["POST", `${base}/turns`, { prompt: "Inspect", contexts: [{ kind: "playable-node", label: "Node", text: KEY }] }],
      ["POST", `${base}/revise-last`, { prompt: KEY }],
      ["PATCH", base, { title: KEY }],
      ["POST", `${base}/turns`, { prompt: "Inspect", [KEY]: "must not be stripped before inspection" }],
    ] as const) {
      const result = await inject(method, url, payload);
      expect(result.statusCode, result.body).toBe(400);
      expect(result.body).toContain("protected credential data");
      expect(result.body).not.toContain(KEY);
    }
    expect((await inject("GET", base)).body).toBe(before);
    expect((await inject("GET", "/tool-jobs")).json()).toEqual([]);
    await expectNoPublicKey(path.join(directory, "projects", project.id));
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects known keys in canvas documents, boards and URL parameters before persistence", async () => {
    const { inject, connect, request, directory } = await fixture();
    await connect();
    const project = (await inject("POST", "/projects", { type: "asset-canvas" })).json();
    const base = `/projects/${project.id}/canvas`;
    const workspace = (await inject("GET", `${base}/workspace`)).json();
    const boardUrl = `${base}/boards/${workspace.boards[0].id}`;
    const beforeBoard = (await inject("GET", boardUrl)).json();
    const document = await inject("POST", `${base}/documents`, { title: "Safe notes" });
    expect(document.statusCode, document.body).toBe(201);
    const beforeDocument = document.json();
    const board = structuredClone(beforeBoard.board);
    board.nodes.push({ id: "protected", type: "text", position: { x: 0, y: 0 }, data: { text: KEY, instruction: "" } });
    for (const [method, url, payload] of [
      ["PUT", boardUrl, { board, revision: beforeBoard.revision }],
      ["PUT", `${base}?documentId=${beforeDocument.document.id}`, { document: { ...beforeDocument.document, markdown: KEY }, revision: beforeDocument.revision }],
      ["GET", `${base}?documentId=${encodeURIComponent(KEY)}`, undefined],
      ["GET", `/projects?search=${encodeURIComponent(KEY)}`, undefined],
      ["GET", `/projects/${KEY.replace("s", "%73")}`, undefined],
    ] as const) {
      const result = await inject(method, url, payload);
      expect(result.statusCode, result.body).toBe(400);
      expect(result.body).toContain("protected credential data");
      expect(result.body).not.toContain(KEY);
    }
    expect((await inject("GET", boardUrl)).json()).toEqual(beforeBoard);
    expect((await inject("GET", `${base}?documentId=${beforeDocument.document.id}`)).json()).toEqual(beforeDocument);
    await expectNoPublicKey(path.join(directory, "projects", project.id));
    expect(request).not.toHaveBeenCalled();
  });

  it("permits only an active Kunpo secret response field while refusing auth payload smuggling", async () => {
    registerSensitiveValue(KEY);
    let manager!: ModelAuthManager;
    const start = ModelAuthManager.prototype.start;
    vi.spyOn(ModelAuthManager.prototype, "start").mockImplementation(function (this: ModelAuthManager, ...args) {
      manager = this;
      return start.apply(this, args);
    });
    const { inject, request, directory } = await fixture(undefined, false);
    const started = await inject("POST", "/settings/models/providers/kunpo/login", { method: "api_key" });
    expect(started.statusCode, started.body).toBe(202);
    const operationId = started.json().operationId;
    let promptId = "";
    await vi.waitFor(() => {
      const prompt = manager.eventsSince(operationId, 0).find((event) => event.type === "prompt");
      if (prompt?.type === "prompt") promptId = prompt.promptId;
      expect(promptId).not.toBe("");
    });
    const url = `/settings/model-auth/${operationId}/respond`;
    const smuggled = await inject("POST", url, { promptId, value: KEY, extra: { prompt: KEY } });
    expect(smuggled.statusCode, smuggled.body).toBe(400);
    expect(smuggled.body).toContain("protected credential data");
    expect(smuggled.body).not.toContain(KEY);
    const accepted = await inject("POST", url, { promptId, value: KEY });
    expect(accepted.statusCode, accepted.body).toBe(204);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(directory, "local-api-keys.json"), "utf8"))).toMatchObject({ kunpo: { type: "api_key", key: KEY } }));
    expect(manager.acceptsSecretResponse(operationId, promptId)).toBe(false);
    const stale = await inject("POST", url, { promptId, value: KEY });
    expect(stale.statusCode, stale.body).toBe(400);
    expect(stale.body).not.toContain(KEY);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves the new project defaults through image, sound, video and 3D adapters with one fake Kunpo key", async () => {
    const { inject, connect, request } = await fixture();
    await connect();
    const project = (await inject("POST", "/projects", { name: "Mock integration" })).json();
    const conversation = await inject("POST", `/projects/${project.id}/conversations`, {});
    expect(conversation.statusCode, conversation.body).toBe(201);
    const detail = await inject("GET", `/projects/${project.id}/conversations/${conversation.json().id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().settings.model).toEqual(DEFAULTS.agent);
    for (const [url, expected] of [
      ["/image-models/catalog", DEFAULTS.image], ["/audio-models/catalog", DEFAULTS["sound-effect"]],
      ["/video-models/catalog", DEFAULTS.video], ["/model3d-models/catalog", DEFAULTS["3d-generation"]],
    ] as const) {
      const catalog = await inject("GET", url);
      expect(catalog.statusCode, catalog.body).toBe(200);
      expect.soft(catalog.json().models.map(({ provider, id }: { provider: string; id: string }) => ({ provider, id })), url).toContainEqual(expected);
      expect(catalog.body).not.toContain(KEY);
    }
    for (const [tool, input, expected] of [
      ["generate-image", { prompt: "A test icon", size: "1024x1024" }, DEFAULTS.image],
      ["generate-sound-effect", { prompt: "A stone door shuts" }, DEFAULTS["sound-effect"]],
      ["generate-video", { prompt: "A cube rolls", duration: 4, resolution: "480p", aspectRatio: "16:9" }, DEFAULTS.video],
      ["image-to-3d", { images: [{ mediaType: "image/png", data: PNG.toString("base64") }], texture: true }, DEFAULTS["3d-generation"]],
    ] as const) {
      const started = await inject("POST", `/tools/${tool}/jobs`, { ...input, projectId: project.id, nodeId: `test-${tool}` });
      expect(started.statusCode, started.body).toBe(202);
      const job = await finishJob(inject, started.json().id);
      const paths = request.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname);
      expect(job, `${tool}: ${job.error ?? ""}; observed routes: ${paths.join(", ")}`).toMatchObject({ status: "succeeded", model: expected });
    }
    const posts = request.mock.calls.filter(([, init]) => init?.method === "POST" && typeof init.body === "string");
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(expect.arrayContaining([
      "gpt-image-2.5-sunburst", "seed-audio-1.0", "doubao-seedance-2-5-260628", "v3.1-20260211",
    ]));
    for (const [input, init] of request.mock.calls) {
      const target = new URL(input instanceof Request ? input.url : String(input));
      expect(["llm.ziy.cc", "kunpoapiimg.ziy.cc"]).toContain(target.hostname);
      expect(new Headers(init?.headers).get("authorization")).toBe(target.hostname === "llm.ziy.cc" ? `Bearer ${KEY}` : null);
    }
    const publicHistory = await inject("GET", "/tool-jobs");
    expect(publicHistory.body).not.toContain(KEY);
    expect(publicHistory.body).not.toContain(LEGACY_KEY);
  });
});
