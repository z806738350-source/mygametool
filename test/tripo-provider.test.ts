import { TEST_GLB, fbxFixture } from "./model3d-fixture.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolCall, type AgentToolCall } from "@earendil-works/pi-agent-core";
import { createApp } from "../src/daemon/app.js";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { TripoProvider } from "./local-secure-provider-fixtures.js";
import { defaultModel3DSettings, normalizeModelUsages } from "../src/shared/custom-models.js";
import { MODEL_3D_MODELS } from "../src/shared/generation-config.js";
import { model3DJournal } from "../src/daemon/model3d-journal.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { TripoProvider as DirectTripo } from "../src/daemon/tripo-provider.js";
import { rememberKunpoImageSource, copyProviderImageSource } from "../src/daemon/provider-image-source.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";

// Native Kunpo routes use fake HTTP and deterministic DNS; no test leaves this process.
vi.mock("node:dns/promises", async (original) => ({ ...await original<typeof import("node:dns/promises")>(),
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const model = { provider: "tripo", id: "P1-20260311" };
const image = { mediaType: "image/png" as const, data: Buffer.from("reference").toString("base64") };
const BASE = "http://127.0.0.1:43199/v3";
const GLB = "http://127.0.0.1:43199/model.glb?signature=example";
function service() {
  let uploads = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === "/model.glb") return new Response(new Uint8Array(TEST_GLB));
    if (/^\/v1\/tasks\/[^/]+\/artifacts$/.test(target.pathname)) return Response.json({ task_id: "task_1", artifacts: [{ key: "model", mime_type: "model/gltf-binary", content_url: `${target.origin}/model.glb?access=artifact-token` }] });
    if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: `file_${++uploads}` } });
    if (init?.method === "POST") return Response.json({ code: 0, data: { task_id: "task_1" } });
    return Response.json({ code: 0, data: { status: "success", output: { model_url: `${target.origin}/model.glb?signature=example` } } });
  });
}
async function temporary() { const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-tripo-")); directories.push(directory); return directory; }
async function appFixture(request: typeof fetch, key?: string) {
  const directory = await temporary();
  if (key) await new LocalApiKeyStore(path.join(directory, "local-api-keys.json")).modify("kunpo", async () => ({ type: "api_key", key }));
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, model3DFetch: request });
  apps.push(app);
  return { app, directory };
}
async function waitForJob(app: ReturnType<typeof createApp>, id: string) {
  let job;
  await vi.waitFor(async () => {
    job = (await app.inject({ method: "GET", url: "/tool-jobs" })).json().find((job: { id: string }) => job.id === id);
    expect(job.status).not.toBe("running");
  });
  return job! as { status: string; error?: string; model?: object };
}

describe("Tripo V3 generation", () => {
  it("checks neutral-pose character references before any upload and keeps pose out of the paid request", async () => {
    const request = service(), { app } = await appFixture(request, "fixture-key");
    const views: Array<{ mediaType: "image/png" | "image/jpeg"; data: string }> = [1, 2, 3].map(width => ({ mediaType: "image/png", data: referencePng({ width, height: 2 }).toString("base64") }));
    views.push({ mediaType: "image/jpeg", data: (await sharp(referencePng({ width: 4, height: 2 })).jpeg().toBuffer()).toString("base64") });
    async function run(images: typeof views, pose: "t-pose" | "a-pose" = "t-pose", referenceMode?: "provided-views") {
      const response = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { model, images, options: { pose, referenceMode } } });
      expect(response.statusCode, response.body).toBe(202);
      return waitForJob(app, response.json().id);
    }
    for (const images of [[views[0]!], views.slice(0, 2), [views[0]!, views[1]!, { ...views[0]!, data: views[0]!.data + "\n" }],
      [views[0]!, views[1]!, { ...views[2]!, data: "YmFk" }]]) {
      expect(await run(images)).toMatchObject({ status: "failed", error: expect.stringMatching(/front, left, and back/) });
    }
    expect(await run([views[0]!], "a-pose", "provided-views")).toMatchObject({ status: "failed", error: expect.stringMatching(/front, left, and back/) });
    const reencoded = referencePng({ width: 1, height: 2, metadata: [["tEXt", Buffer.from("Title\0Back view")]], level: 1 });
    expect(await run([views[0]!, views[1]!, { ...views[0]!, data: reencoded.toString("base64") }])).toMatchObject({ status: "failed", error: expect.stringMatching(/same image/) });
    const corruptPng = Buffer.from(views[2]!.data, "base64").subarray(0, 36);
    expect(await run([views[0]!, views[1]!, { ...views[2]!, data: corruptPng.toString("base64") }])).toMatchObject({ status: "failed", error: expect.stringMatching(/decode a reference/) });
    expect(request).not.toHaveBeenCalled();
    for (const count of [3, 4]) {
      expect(await run(views.slice(0, count), count === 3 ? "t-pose" : "a-pose")).toMatchObject({ status: "succeeded" });
      const submitted = request.mock.calls.filter(([url, init]) => String(url).includes("/generation/") && init?.method === "POST");
      expect(submitted).toHaveLength(1);
      expect(String(submitted[0]![0])).toMatch(/\/multiview-to-model$/);
      const body = JSON.parse(String(submitted[0]![1]?.body));
      expect(body.inputs).toEqual(["front", "left", "back", "right"].slice(0, count).map((view, index) => ({ [view]: `file_${index + (count === 3 ? 1 : 4)}` })));
      expect(body).not.toHaveProperty("pose");
      expect(body).not.toHaveProperty("pose_mode");
      request.mockClear();
    }
  });

  it.each(["generate_3d_from_views", "generate_3d_asset"])("submits a corrected Agent turnaround via %s once and recovers the same GLB after a download failure", async generate => {
    const directory = await temporary(), projects = new ProjectManager(directory);
    const project = await projects.create("Turnaround", "web-game");
    const views = ["front", "left", "back"];
    const originals = views.map((_, index) => referencePng({ width: 20 + index, height: 24 }));
    const imagePaths = await Promise.all(views.map((view, i) => projects.addGeneratedAsset(project.id, view + ".png", originals[i]!)));
    const request = service(), respond = request.getMockImplementation()!;
    let allowDownload = false;
    request.mockImplementation(async (url, init) => {
      if (!allowDownload && new URL(String(url)).pathname === "/model.glb") return new Response(null, { status: 503 });
      return respond(url, init);
    });
    const runner = new ToolRunner(directory, { generate: vi.fn() }, new TripoProvider(() => "fixture-key", request, 0));
    await runner.load();
    const tools = createAgentTools(project, runner, projects);
    async function call(name: string, id: string, args: AgentToolCall["arguments"]) {
      const tool = tools.find(entry => entry.name === name)!;
      return runToolCall({ type: "toolCall", name, id, arguments: args }, {
        tools: [{ ...tool, execute: (callId, input) => tool.execute(callId, input, undefined, undefined, { model: { input: ["text", "image"] } } as never) }],
        assistantMessage: {} as never, context: { messages: [] },
      });
    }
    const options = { referenceMode: "turnaround", pose: "t-pose", quad: false, geometryQuality: "standard", textureModel: "v3.5-20260815", textureQuality: "standard" };
    const args = { operation: "image", imagePath: "", sourcePath: "", imagePaths, model: { provider: "tripo", id: "v3.1-20260211" }, targetPolycount: 12000, texture: true, pbr: false, options };
    const rejected = await call("generate_3d_asset", "mixed-intent", { ...args, prompt: "Keep the cloak and lantern from the reference art.", options: { ...options, smartUv: false } });
    expect(rejected.isError).toBe(true);
    const guidance = rejected.result.content.map(block => block.type === "text" ? block.text : "").join("\n");
    expect(guidance).toMatch(/prompt/i);
    expect(request).not.toHaveBeenCalled();

    const candidate = guidance.match(/generate_3d_from_views with this object: (\{.*\})\. No generation was submitted\.$/s);
    expect(candidate, guidance).not.toBeNull();
    const corrected = JSON.parse(candidate![1]!);
    const { referenceMode: _mode, ...expectedOptions } = options;
    expect(corrected).toEqual({ imagePaths, model: args.model, targetPolycount: 12000, texture: true, pbr: false, options: expectedOptions });
    const creation = generate === "generate_3d_from_views" ? corrected : { ...args, options: { ...options, smartUv: false } };
    const first = await call(generate, "image-only", creation);
    expect(first.isError).toBe(true);
    const uploads = request.mock.calls.filter(([url]) => String(url).endsWith("/files"));
    expect(uploads).toHaveLength(3);
    for (const [i, [, init]] of uploads.entries()) {
      const file = (init?.body as FormData).get("file") as Blob;
      expect(Buffer.from(await file.arrayBuffer())).toEqual(originals[i]);
    }
    const tasks = request.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/generation/"));
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0]![0])).toBe(BASE + "/generation/multiview-to-model");
    expect(JSON.parse(String(tasks[0]![1]?.body))).toEqual({
      model: args.model.id, inputs: [{ front: "file_1" }, { left: "file_2" }, { back: "file_3" }],
      face_limit: 12000, texture: true, pbr: false, quad: false, geometry_quality: "standard", texture_version: options.textureModel, texture_quality: "standard",
    });

    allowDownload = true;
    request.mockClear();
    const recovered = await call("recover_media", "download-again", { tool: generate, recoverCallId: "image-only", originalArguments: creation });
    expect(recovered.isError, JSON.stringify(recovered.result.content)).toBe(false);
    const details = recovered.result.details as { artifact: { path: string } };
    expect(await readFile(path.join(project.workspacePath, details.artifact.path))).toEqual(TEST_GLB);
    expect(request.mock.calls.length).toBeGreaterThan(0);
    expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(await Promise.all(imagePaths.map(file => readFile(path.join(project.workspacePath, file))))).toEqual(originals);
  });

  it("recovers a pre-turnaround single-view task without checking new view requirements or resubmitting", async () => {
    const request = service(), runner = new ToolRunner(await temporary(), { generate: vi.fn() }, new TripoProvider(() => "fixture-key", request, 0));
    await runner.load();
    const input = { model, images: [image] }, recoveryId = "legacy-single-view";
    await runner.runPrepared("image-to-3d", input, undefined, { recoveryId });
    request.mockClear();
    const run = await runner.runPrepared("image-to-3d", { ...input, options: { referenceMode: "turnaround" } }, undefined, { recoveryId, model3DRecoveryOnly: true });
    expect(run.files[0]?.mediaType).toBe("model/gltf-binary");
    expect(request).not.toHaveBeenCalled();
  });

  it("never reuploads or resubmits an ambiguous 3D task that used a generated URL", async () => {
    const directory = await temporary(), generated = { bytes: Buffer.from("synthetic image") };
    rememberKunpoImageSource(generated, "https://kunpoapiimg.ziy.cc/unknown.png?signature=fake-unknown", "https://llm.ziy.cc/v1");
    const reference = copyProviderImageSource(generated, { mediaType: "image/png" as const, data: generated.bytes.toString("base64") });
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("Synthetic lost response"));
    const input = { model, images: [reference] }, provider = new DirectTripo(() => "fake-tripo-key", request, 0);
    await expect(provider.generate({ ...input, execution: await model3DJournal(directory, "unknown-url") })).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce(); expect(String(request.mock.calls[0]![0])).toContain("/generation/image-to-model");
    request.mockClear();
    const error = await provider.generate({ ...input, images: [{ ...reference }], execution: await model3DJournal(directory, "unknown-url", true) }).catch(cause => cause);
    expect(error).toMatchObject({ statusCode: 409 }); expect(request).not.toHaveBeenCalled();
    expect(error.message).not.toContain("fake-unknown");
  });

  it.each(["image", "retexture"] as const)("uses and durably resumes a generated URL for %s without image reupload or new tasks", async operation => {
    const directory = await temporary(), url = "https://kunpoapiimg.ziy.cc/tripo-reference.png?signature=fake-tripo";
    const generated = { bytes: Buffer.from("synthetic image") }; rememberKunpoImageSource(generated, url, "https://llm.ziy.cc/v1");
    const reference = copyProviderImageSource(generated, { mediaType: "image/png" as const, data: generated.bytes.toString("base64") });
    const request = service(), base = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) => {
      const target = new URL(String(input));
      if (/\/artifacts$/.test(target.pathname)) return Response.json({ artifacts: [{ key: "model", mime_type: "model/gltf-binary", content_url: "https://llm.ziy.cc/v1/tasks/task_1/artifacts/model/content" }] });
      if (target.pathname.endsWith("/content")) return new Response(new Uint8Array(TEST_GLB));
      return base(input, init);
    });
    const provider = new DirectTripo(() => "fake-tripo-key", request, 0);
    const input = { model: { provider: "tripo", id: "v3.1-20260211" }, operation, images: [reference], ...(operation === "retexture" ? { source: TEST_GLB } : {}) };
    await provider.generate({ ...input, execution: await model3DJournal(directory, "source-url") });
    const uploads = request.mock.calls.filter(([value]) => String(value).endsWith("/files")); expect(uploads).toHaveLength(operation === "retexture" ? 1 : 0);
    const task = request.mock.calls.find(([value]) => String(value).endsWith(operation === "retexture" ? "/models/texture" : "/generation/image-to-model"))!;
    const body = JSON.parse(String(task[1]!.body)); expect(operation === "retexture" ? body.texture_prompt.image : body.input).toBe(url);
    const savedFile = path.join(directory, "source-url.json"), saved = await readFile(savedFile, "utf8"); expect((await stat(savedFile)).mode & 0o777).toBe(0o600);
    request.mockClear();
    const plain = { ...reference }; // Restart loses the optional in-memory source capability.
    await provider.generate({ ...input, images: [plain], execution: await model3DJournal(directory, "source-url", true) });
    expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(await readFile(savedFile, "utf8")).toBe(saved);
  });

  it.each([1, 2, 4])("uploads %i views, selects the matching endpoint and retrieves GLB without leaking credentials", async (count) => {
    const request = service();
    const result = await new TripoProvider(() => "tripo-test-key", request, 0).generate({ model, images: Array(count).fill(image), targetPolycount: 4_000, texture: true, pbr: true });
    expect(result).toMatchObject({ bytes: TEST_GLB, mediaType: "model/gltf-binary", requestId: "task_1", metadata: { forwardAxis: "+X",
      generation: { model: model.id, protocol: "tripo-v3", parameters: { face_limit: 4_000, texture: true, pbr: true }, taskId: "task_1" } } });
    expect(request.mock.calls.slice(0, count).every(([url, init]) => String(url) === `${BASE}/files` && init?.body instanceof FormData)).toBe(true);
    const uploaded = (request.mock.calls[0]![1]!.body as FormData).get("file") as Blob;
    expect(uploaded.type).toBe("image/png"); expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(Buffer.from("reference"));
    const [url, init] = request.mock.calls[count]!;
    expect(url).toBe(`${BASE}/generation/${count === 1 ? "image-to-model" : "multiview-to-model"}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tripo-test-key");
    expect(JSON.parse(String(init?.body))).toEqual({ model: model.id, face_limit: 4_000, texture: true, pbr: true,
      ...(count === 1 ? { input: "file_1" } : { inputs: ["front", "left", "back", "right"].slice(0, count).map((view, index) => ({ [view]: `file_${index + 1}` })) }),
    });
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(count + 1);
  });

  it("retries transient polls without submitting another paid generation", async () => {
    const request = service();
    const original = request.getMockImplementation()!;
    let polls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/") && ++polls === 1) throw new Error("ECONNRESET");
      return original(url, init);
    });
    await new TripoProvider(() => "key", request, 0).generate({ model, images: [image] });
    expect(polls).toBe(2);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
  });

  it("accepts pending and queries Kunpo's archived model with auth only on the control request", async () => {
    const request = service(), original = request.getMockImplementation()!;
    let polls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/tripo/v3/tasks/task_1") && ++polls === 1) return Response.json({ code: 0, data: { status: "pending" } });
      return original(url, init);
    });
    const provider = new TripoProvider(() => "kunpo-canary-key", request, 0, () => true, { baseUrl: "http://127.0.0.1:43199/tripo/v3", apiKey: "kunpo-canary-key" });
    const result = await provider.generate({ model: { provider: "tripo", id: "v3.1-20260211" }, operation: "text", prompt: "A stone tower", images: [] });
    expect(result.bytes).toEqual(TEST_GLB);
    expect(polls).toBe(2);
    const artifactQuery = request.mock.calls.find(([url]) => String(url).endsWith("/v1/tasks/task_1/artifacts"))!;
    expect(new Headers(artifactQuery[1]?.headers).get("authorization")).toBe("Bearer kunpo-canary-key");
    const downloaded = request.mock.calls.at(-1)!;
    expect(String(downloaded[0])).toBe("http://127.0.0.1:43199/model.glb?access=artifact-token");
    expect(downloaded[1]?.headers).toBeUndefined();
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses v3.0 triangle remesh options and validates face limits before upload", async () => {
    const request = service(), provider = new TripoProvider(() => "key", request, 0);
    await provider.generate({ model, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 20_000, options: { quad: false, smartUv: true } });
    const submitted = request.mock.calls.find(([url]) => String(url).endsWith("/mesh/decimate"))!;
    expect(JSON.parse(String(submitted[1]?.body))).toEqual({ input: "file_1", model: "v3.0", face_limit: 20_000, quad: false, smart_uv: true, bake: true });
    request.mockClear();
    await expect(provider.generate({ model, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 10_001, options: { quad: true } })).rejects.toThrow("500 and 10000");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["image", "text", "remesh"] as const)("preserves the FBX original from quad %s jobs", async (operation) => {
    const request = service(), original = request.getMockImplementation()!, fbx = fbxFixture();
    request.mockImplementation(async (url, init) => new URL(String(url)).pathname === "/model.glb" ? new Response(new Uint8Array(fbx)) : original(url, init));
    const provider = new TripoProvider(() => "fake-key", request, 0);
    const input = { model: { provider: "tripo", id: "v3.1-20260211" }, operation, images: operation === "image" ? [image, image, image] : [],
      prompt: operation === "text" ? "A goose" : undefined, source: operation === "remesh" ? TEST_GLB : undefined,
      targetPolycount: operation === "remesh" ? 4_000 : 30_000, options: { quad: true } };
    const execution = await model3DJournal(await temporary(), "new-quad");
    expect(await provider.generate({ ...input, execution })).toMatchObject({ mediaType: "application/vnd.autodesk.fbx", bytes: fbx });
    const paid = request.mock.calls.filter(([url, init]) => init?.method === "POST" && !String(url).endsWith("/files"));
    expect(paid).toHaveLength(1); expect(JSON.parse(String(paid[0]![1]?.body)).quad).toBe(true);
  });

  it("keeps legacy quad tasks recoverable with GET only and never labels FBX as GLB", async () => {
    const directory = await temporary(), execution = await model3DJournal(directory, "legacy-quad"), key = "fake-key";
    const scope = JSON.stringify([BASE, key, undefined, undefined]);
    await execution.submitted("image-upload-0", scope, { bytes: image.data, mediaType: image.mediaType }, async () => ({ token: "file_1" }));
    const body = { model: "v3.1-20260211", face_limit: 30_000, texture: true, pbr: false, quad: true, input: "file_1" };
    await execution.submitted("generate", scope, { endpoint: "generation/image-to-model", body }, async () => ({ taskId: "task_1" }));
    const journalFile = path.join(directory, "legacy-quad.json"), before = await readFile(journalFile, "utf8");
    const request = service(), original = request.getMockImplementation()!;
    const fbx = fbxFixture();
    request.mockImplementation(async (url, init) => new URL(String(url)).pathname === "/model.glb" ? new Response(new Uint8Array(fbx)) : original(url, init));
    const provider = new TripoProvider(() => key, request, 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await provider.generate({ model: { provider: "tripo", id: "v3.1-20260211" }, images: [image], targetPolycount: 30_000,
        options: { quad: true }, execution: await model3DJournal(directory, "legacy-quad", true) })).toMatchObject({ mediaType: "application/vnd.autodesk.fbx", bytes: fbx });
      expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
      if (attempt === 1) expect(request).not.toHaveBeenCalled();
      request.mockClear(); request.mockRejectedValue(new Error("offline: expired provider task"));
    }
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(await readFile(journalFile, "utf8")).toBe(before);
  });

  it("keeps an explicitly selected processing version instead of replacing it with a new default", async () => {
    const request = service(), provider = new TripoProvider(() => "key", request, 0);
    const selected = { provider: "tripo", id: "v3.0-20250812" };
    const result = await provider.generate({ model: selected, operation: "retexture", source: TEST_GLB, images: [], prompt: "Blue ceramic" });
    const call = request.mock.calls.find(([url]) => String(url).endsWith("/models/texture"))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: selected.id });
    expect(result.metadata?.generation?.model).toBe(selected.id);
    expect(await provider.animations(undefined, { provider: "tripo", id: "v1.0-20240301" })).toContainEqual(expect.objectContaining({ id: "preset:biped:walk" }));
  });

  it("forwards documented generation options and rejects incompatible geometry parameters", async () => {
    const request = service(), provider = new TripoProvider(() => "key", request, 0);
    const h3 = { provider: "tripo", id: "v3.1-20260211" };
    await provider.generate({ model: h3, operation: "text", prompt: "A hero", images: [], targetPolycount: 2_000_000, texture: true,
      options: { textureQuality: "fast", geometryQuality: "detailed" } });
    const body = JSON.parse(String(request.mock.calls.find(([url]) => String(url).endsWith("/generation/text-to-model"))![1]?.body));
    expect(body).toMatchObject({ model: h3.id, texture_version: "v3.5-20260815", texture_quality: "fast", geometry_quality: "detailed", face_limit: 2_000_000 });
    request.mockClear();
    await expect(provider.generate({ model, images: [image], options: { quad: true } })).rejects.toThrow("does not support quad");
    await expect(provider.generate({ model, images: [image], options: { geometryQuality: "detailed" } })).rejects.toThrow("requires Tripo H v3");
    await expect(provider.generate({ model: h3, images: [image], options: { smartUv: true } })).rejects.toThrow("not supported");
    await expect(provider.generate({ model: h3, images: [image], texture: false, options: { textureQuality: "fast" } })).rejects.toThrow("Enable textures");
    await expect(provider.generate({ model: h3, operation: "retexture", source: TEST_GLB, images: [] })).rejects.toThrow("Choose one texture image or a prompt");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps all paid stage IDs on cancel and resumes after reopening without another POST", async () => {
    const directory = await temporary(), request = service(), original = request.getMockImplementation()!;
    const controller = new AbortController();
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/tasks/task_1")) { controller.abort(); return Response.json({ code: 0, data: { status: "pending" } }); }
      return original(url, init);
    });
    const input = { model, images: [image] };
    await expect(new TripoProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(directory, "cancel-resume") }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const postCount = request.mock.calls.filter(([, init]) => init?.method === "POST").length;
    request.mockImplementation(original);
    expect((await new TripoProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(directory, "cancel-resume") })).bytes).toEqual(TEST_GLB);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(postCount);
    expect(request.mock.calls.some(([url]) => /cancel/.test(String(url)))).toBe(false);
  });

  it("does not re-submit an ambiguous paid response, even with two queued callers", async () => {
    const directory = await temporary();
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/generation/")) throw new Error("lost POST response");
      return original(url, init);
    });
    const provider = new TripoProvider(() => "key", request, 0), execution = await model3DJournal(directory, "unknown-response"), input = { model, images: [image], execution };
    const results = await Promise.allSettled([provider.generate(input), provider.generate(input)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
    await expect(provider.generate({ ...input, execution: await model3DJournal(directory, "unknown-response") })).rejects.toThrow("could not be confirmed");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
  });

  it("does not label FBX as GLB or repeat a completed remesh when its artifact is unsupported", async () => {
    const directory = await temporary(), request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => new URL(String(url)).pathname === "/model.glb" ? new Response("Kaydara FBX Binary", { headers: { "content-type": "application/octet-stream" } }) : original(url, init));
    const input = { model, operation: "remesh" as const, source: TEST_GLB, images: [] };
    const provider = new TripoProvider(() => "key", request, 0);
    await expect(provider.generate({ ...input, execution: await model3DJournal(directory, "fbx-result") })).rejects.toThrow("non-GLB artifact");
    await expect(provider.generate({ ...input, execution: await model3DJournal(directory, "fbx-result") })).rejects.toThrow("non-GLB artifact");
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/mesh/decimate"))).toHaveLength(1);
  });

  it.each([
    { output: { riggable: false, rig_type: "quadruped" }, message: "source model is not riggable" },
    { output: { rig_type: "quadruped" }, message: "did not return a confirmed riggable result" },
    { output: { riggable: "true", rig_type: "quadruped" }, message: "did not return a confirmed riggable result" },
    { output: { riggable: true, rig_type: "biped" }, message: "reported rig type biped; the request selected quadruped" },
    { output: { riggable: true }, message: "reported rig type unconfirmed" },
  ])("retains the submitted rig-check and distinguishes its result: $message", async ({ output, message }) => {
    const directory = await temporary(), request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/animations/rig-check")) return Response.json({ code: 0, data: { task_id: "check-existing" } });
      if (String(url).endsWith("/tasks/check-existing")) return Response.json({ code: 0, data: { status: "success", output } });
      return original(url, init);
    });
    const provider = new TripoProvider(() => "key", request, 0);
    const input = { model: TEST_GLB, actionIds: ["preset:quadruped:walk"], options: { rigModel: "v2.5-20260210" as const, rigType: "quadruped" as const } };
    const failure = await provider.animate({ ...input, execution: await model3DJournal(directory, "existing-rig-check") }).catch(error => error);
    expect(failure.message).toContain(message); expect(failure.message).toContain("existing check task is retained");
    expect(getToolPreflightFailure(failure)).toBeUndefined(); expect(failure.notSubmitted).toBe(false);
    await expect(provider.animate({ ...input, execution: await model3DJournal(directory, "existing-rig-check", true) })).rejects.toThrow(message);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/animations/rig-check"))).toHaveLength(1);
    expect(request.mock.calls.some(([url]) => /\/animations\/(rig|retarget)$/.test(String(url)))).toBe(false);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("uses the selected rig model consistently and leaves local cancellation separate from upstream cancellation", async () => {
    const request = service(), original = request.getMockImplementation()!;
    const endpoints = new Map<string, string>();
    let number = 0;
    request.mockImplementation(async (url, init) => {
      const target = String(url);
      if (init?.method === "POST" && !target.endsWith("/files")) {
        const taskId = `task_${++number}`; endpoints.set(taskId, target); return Response.json({ code: 0, data: { task_id: taskId } });
      }
      const taskId = target.split("/").at(-1)!;
      if (endpoints.get(taskId)?.endsWith("/rig-check")) return Response.json({ code: 0, data: { status: "success", output: { riggable: true, rig_type: "biped" } } });
      return original(url, init);
    });
    const provider = new TripoProvider(() => "key", request, 0);
    await provider.animate({ model: TEST_GLB, actionIds: ["preset:walk"] });
    for (const endpoint of ["rig-check", "rig", "retarget"]) {
      const call = request.mock.calls.find(([url]) => String(url).endsWith(`/animations/${endpoint}`))!;
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: "v3.0-20260909" });
    }
    const body = JSON.parse(String(request.mock.calls.find(([url]) => String(url).endsWith("/animations/retarget"))![1]?.body));
    expect(body).not.toHaveProperty("bake_animation");
    request.mockClear();
    const invalidRig = await provider.animations(undefined, undefined, { rigModel: "v3.0-20260909", rigType: "quadruped" }).catch(error => error);
    expect(invalidRig.message).toContain("use v2.5");
    expect(invalidRig.notSubmitted).toBe(true);
    expect(getToolPreflightFailure(invalidRig)?.reason).toBe("invalid_animation_action");
    expect(request).not.toHaveBeenCalled();
    expect(await provider.animations(undefined, undefined, { rigModel: "v2.5-20260210", rigType: "quadruped" })).toContainEqual(expect.objectContaining({ id: "preset:quadruped:walk" }));
    expect(await provider.animations(undefined, undefined, { rigModel: "v3.0-20260909", rigType: "others" })).toEqual([]);
    await expect(provider.animate({ model: TEST_GLB, actionIds: ["preset:idle", "preset:walk", "preset:run", "preset:dive", "preset:climb", "preset:jump"] })).rejects.toThrow("1 to 5 different");
    await expect(provider.animate({ model: TEST_GLB, actionIds: ["preset:walk", "preset:walk"] })).rejects.toThrow("1 to 5 different");
    expect(request).not.toHaveBeenCalled();
  });

  it("stops after three consecutive network failures without resubmitting the task", async () => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/")) throw new Error("ECONNRESET");
      return original(url, init);
    });
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("Could not reach Tripo");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/tasks/"))).toHaveLength(3);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
  });

  it.each([
    { endpoint: "/files", data: {}, message: "no upload token" },
    { endpoint: "/generation/image-to-model", data: {}, message: "no task ID" },
    { endpoint: "/tasks/task_1", data: { status: "success", output: {} }, message: "without a GLB artifact" },
  ])("reports malformed responses at $endpoint", async ({ endpoint, data, message }) => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => String(url).endsWith(endpoint) ? Response.json({ code: 0, data }) : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow(message);
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("keeps an unlisted state non-terminal and retries temporary HTTP polls without another submission", async () => {
    const request = service(), original = request.getMockImplementation()!;
    let polls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/tasks/task_1")) {
        polls++;
        if (polls === 1) return Response.json({ code: 0, data: { status: "submitted" } });
        if (polls === 2) return Response.json({ error: "rate limit" }, { status: 429 });
        if (polls === 3) return Response.json({ error: "temporary" }, { status: 503 });
      }
      return original(url, init);
    });
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).resolves.toMatchObject({ bytes: TEST_GLB });
    expect(polls).toBe(4);
    expect(request.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes("/generation/"))).toHaveLength(1);
  });

  it("rejects oversized GLB downloads before reading the body", async () => {
    const request = service(), original = request.getMockImplementation()!;
    const response = new Response("not read", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } });
    const read = vi.spyOn(response, "arrayBuffer");
    request.mockImplementation(async (url, init) => String(url) === GLB ? response : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("too large");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps texture disabled even when PBR was requested", async () => {
    const request = service();
    await new TripoProvider(() => "key", request, 0).generate({ model, images: [image], texture: false, pbr: true });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ texture: false, pbr: false });
  });

  it("passes custom endpoint headers only to the API and supports no-key authentication", async () => {
    const request = service();
    await new TripoProvider(() => undefined, request, 0, () => true, {
      baseUrl: "http://127.0.0.1:43199/tripo/v3", apiKey: "unused", authentication: "none", headers: { "x-studio": "custom-header" },
      settings: defaultModel3DSettings("standard", "tripo"),
    }).generate({ model: { provider: "studio", id: "studio-alias" }, images: [image] });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43199/tripo/v3/files");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("x-studio")).toBe("custom-header");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
  });

  it.each([
    { code: 1000, message: "Invalid key" },
    { code: 2010, message: "Insufficient credits" },
  ])("reports API errors including HTTP 200 with nonzero code: $code", async (body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow(body.code === 1000 ? "API key was rejected" : "Tripo request failed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled"])("reports terminal %s tasks", async (status) => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => String(url).includes("/tasks/") ? Response.json({ code: 0, data: { status, error_message: "Task could not complete" } }) : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("Tripo task failed");
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("honours cancellation during polling and stops before downloading", async () => {
    const controller = new AbortController(), request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/")) { controller.abort(); return Response.json({ code: 0, data: { status: "running" } }); }
      return original(url, init);
    });
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("rejects unsupported versions, too many views and oversized references before upload", async () => {
    const request = service(), provider = new TripoProvider(() => "key", request, 0);
    await expect(provider.generate({ model: { ...model, id: "unknown" }, images: [image] })).rejects.toThrow("unavailable");
    await expect(provider.generate({ model: { provider: "meshy", id: "meshy-t2" }, images: [image] })).rejects.toThrow("unavailable");
    await expect(provider.generate({ model, images: Array(5).fill(image) })).rejects.toThrow("1 to 4");
    await expect(provider.generate({ model, images: [{ ...image, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") }] })).rejects.toThrow("20 MB");
    await expect(provider.generate({ model, images: [image], targetPolycount: 50_000 })).rejects.toThrow("50 and 20000");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Tripo connection and custom models", () => {
  it("uses the private central Kunpo key, honours explicit defaults and fails disabled selections", async () => {
    const request = service(), { app, directory } = await appFixture(request, "kunpo-test-key");
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).body).not.toContain("kunpo-test-key");
    if (process.platform !== "win32")
      expect((await stat(path.join(directory, "local-api-keys.json"))).mode & 0o777).toBe(0o600);
    expect((await new LocalApiKeyStore(path.join(directory, "local-api-keys.json")).read("kunpo"))?.key).toBe("kunpo-test-key");
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual(MODEL_3D_MODELS.filter((model) => model.provider === "tripo"));
    expect((await app.inject({ method: "PUT", url: "/model3d-models/default", payload: model })).statusCode).toBe(204);
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image] } });
    const completed = await waitForJob(app, result.json().id);
    expect(completed, completed.error).toMatchObject({ status: "succeeded", model });
    await app.inject({ method: "PATCH", url: "/settings/models/providers/kunpo/enabled", payload: { enabled: false } });
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual([]);
    const disabled = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image], model } });
    expect((await waitForJob(app, disabled.json().id)).status).toBe("failed");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
    await app.inject({ method: "DELETE", url: "/settings/models/providers/kunpo/credential" });
    expect(await new LocalApiKeyStore(path.join(directory, "local-api-keys.json")).read("kunpo")).toBeUndefined();
    await app.inject({ method: "PATCH", url: "/settings/models/providers/kunpo/enabled", payload: { enabled: true } });
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual([]);
  });

  it("accepts V3.1 face counts above Meshy's limit through the tool API", async () => {
    const request = service(), { app } = await appFixture(request, "kunpo-test-key");
    const ref = { provider: "tripo", id: "v3.1-20260211" };
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image], model: ref, targetPolycount: 1_200_000 } });
    expect(result.statusCode, result.body).toBe(202);
    const completed = await waitForJob(app, result.json().id);
    expect(completed, completed.error).toMatchObject({ status: "succeeded", model: ref });
    const generation = request.mock.calls.find(([url]) => String(url).includes("/generation/"))!;
    expect(JSON.parse(String(generation[1]?.body))).toMatchObject({ model: ref.id, face_limit: 1_200_000 });
  });

  it("generates an arbitrary Tripo alias through a custom no-key endpoint", async () => {
    const request = service(), { app, directory } = await appFixture(request);
    const config = { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "http://127.0.0.1:43199/tripo/v3" };
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { name: "Local Tripo", preset: "tripo", baseUrl: "http://127.0.0.1:43199/v3", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2,
      models: [{ id: "studio-mesh-alias", name: "Studio mesh", reasoning: false, supportsImages: false, contextWindow: 32_000, maxTokens: 4_000, usages: { "3d": config } }],
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    const ref = { provider: saved.json().id, id: "studio-mesh-alias" };
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image, image], model: ref } });
    expect(await waitForJob(app, result.json().id)).toMatchObject({ status: "succeeded", model: ref });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43199/tripo/v3/files");
    const generation = request.mock.calls.find(([url]) => String(url).includes("/generation/"))!;
    expect(JSON.parse(String(generation[1]?.body)).model).toBe("studio-mesh-alias");
    expect(new Headers(generation[1]?.headers).has("authorization")).toBe(false);
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).toContain('"protocol": "tripo"');
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models[0].referenceImageLabels).toEqual(["Front", "Left", "Back", "Right"]);
    expect(() => normalizeModelUsages({ "3d": { ...config, modelType: "smart-topology" } })).toThrow("Smart topology is only supported by Meshy");
  });
});
