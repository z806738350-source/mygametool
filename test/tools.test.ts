import { referenceWav } from "./audio-reference-fixture.js";
import { TEST_GLB } from "./model3d-fixture.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { temporaryTestDirectory } from "./temporary-test-directory.js";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ImageGenerationError, type ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { MAX_ANIMATION_ACTIONS, resolveModel3D } from "../src/shared/generation-config.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { TripoProvider } from "../src/daemon/tripo-provider.js";
import { Model3DGenerationError } from "../src/daemon/model3d.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";

const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("tool runner", () => {
  it("removes project media after reopening while preserving other owners, shared results and Library assets", async () => {
    const directory = await temporaryData(), runner = new ToolRunner(directory, fakeGenerator()); await runner.load();
    const ownedId = "a".repeat(64), scope = "b".repeat(64), sharedId = "c".repeat(64);
    const owned = await runner.run("generate-image", { prompt: "Owned" }, undefined, "project-a", { recoveryId: ownedId, agentCall: { scope, callId: "owned-call" } });
    expect(owned).not.toHaveProperty("recoveryId");
    const shared = await runner.run("generate-image", { prompt: "Shared" }, undefined, "project-a", { recoveryId: sharedId });
    await runner.agentMedia.trackProject("project-b", sharedId);
    const foreign = await runner.run("generate-image", { prompt: "Other" }, undefined, "project-b", { recoveryId: "other" });
    const global = await runner.run("generate-image", { prompt: "Global" });
    for (const kind of ["image-requests", "video-tasks", "model3d-tasks", "audio-attempts"]) {
      const folder = path.join(directory, "tools", kind); await mkdir(folder, { recursive: true });
      for (const id of [ownedId, sharedId, "other", "unattributed"]) await writeFile(path.join(folder, `${id}${kind === "image-requests" ? "-0" : ""}.json`), "retained");
    }
    const modelCache = path.join(directory, "tools/model3d-tasks", `${ownedId}.json.generate.result`); await writeFile(modelCache, "local-model");
    const library = new AssetLibrary(directory); await library.load(); const asset = await library.add("keep.png", referencePng());
    await runner.close();
    const reopened = new ToolRunner(directory, fakeGenerator()); await reopened.load();
    await reopened.removeProject("project-a");
    await expect(access(path.join(directory, "tools/runs", owned.id))).rejects.toMatchObject({ code: "ENOENT" });
    for (const run of [shared, foreign, global]) await expect(access(path.join(directory, "tools/runs", run.id))).resolves.toBeUndefined();
    for (const kind of ["image-requests", "video-tasks", "model3d-tasks", "audio-attempts"]) {
      const names = await readdir(path.join(directory, "tools", kind));
      expect(names.some(name => name.startsWith(ownedId))).toBe(false);
      expect(names.some(name => name.startsWith(sharedId))).toBe(true);
      expect(names.some(name => name.startsWith("other"))).toBe(true);
      expect(names.some(name => name.startsWith("unattributed"))).toBe(true);
    }
    await expect(access(path.join(directory, "tools/agent-media", scope))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(directory, "tools/agent-media/projects/project-a"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await library.content(asset.id)).asset.id).toBe(asset.id);
    await reopened.removeProject("project-a"); await reopened.close();
  });

  it.each([
    { toolId: "generate-image", input: { prompt: "Fixture" } },
    { toolId: "image-to-3d", input: { operation: "text" as const, prompt: "Fixture", images: [] } },
    { toolId: "generate-video", input: { prompt: "Fixture", model: TEST_VIDEO_MODEL } },
    { toolId: "generate-speech", input: { text: "Fixture" } },
  ])("finds the retained $toolId output after its final ownership update was interrupted", async ({ toolId, input }) => {
    const directory = await temporaryData();
    const runner = new ToolRunner(directory, fakeGenerator(),
      { generate: async () => ({ bytes: TEST_GLB, mediaType: "model/gltf-binary", requestId: "fixture" }) },
      { generate: async () => ({ bytes: Buffer.from("video"), mediaType: "video/mp4", requestId: "fixture" }) }, undefined, undefined,
      { catalog: () => ({ models: [], providers: [] }), generate: async () => ({ bytes: referenceWav(), mediaType: "audio/wav", model: { provider: "fixture", id: "audio" } }) });
    await runner.load();
    const track = runner.agentMedia.trackProject.bind(runner.agentMedia);
    vi.spyOn(runner.agentMedia, "trackProject").mockImplementation(async (projectId, recoveryId, update) => {
      if (update?.runId) throw new Error("Ownership write interrupted");
      await track(projectId, recoveryId, update);
    });
    await expect(runner.run(toolId, input, undefined, "interrupted-project", { recoveryId: "original-request" })).rejects.toThrow("Ownership write interrupted");
    const runs = await readdir(path.join(directory, "tools/runs"));
    expect(runs).toHaveLength(1);
    const retained = JSON.parse(await readFile(path.join(directory, "tools/runs", runs[0]!, "run.json"), "utf8"));
    await expect(access(path.join(directory, "tools/runs", runs[0]!, retained.files[0].name))).resolves.toBeUndefined();
    expect((await runner.agentMedia.projectRecords("interrupted-project"))[0]?.runIds).toEqual([]);
    await runner.close();
    const reopened = new ToolRunner(directory, fakeGenerator()); await reopened.load();
    await reopened.removeProject("interrupted-project");
    expect(await readdir(path.join(directory, "tools/runs"))).toEqual([]);
    await expect(access(path.join(directory, "tools/agent-media/projects/interrupted-project"))).rejects.toMatchObject({ code: "ENOENT" });
    await reopened.close();
  });

  it("cleans legacy scopes and canvas ownership but retains journals referenced by another copied project", async () => {
    const directory = await temporaryData(), runner = new ToolRunner(directory, fakeGenerator()); await runner.load();
    const projectId = "legacy", generationScope = "chat", toolId = "generate-image";
    const scope = createHash("sha256").update(JSON.stringify([projectId, generationScope, toolId])).digest("hex");
    const recoveryId = "d".repeat(64);
    await runner.agentMedia.adopt({ scope, callId: "old-call" }, recoveryId);
    const folder = path.join(directory, "tools/image-requests"); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${recoveryId}-0.json`), "retained");
    await writeFile(path.join(folder, "canvas-only-0.json"), "retained");
    for (const id of [projectId, "copy"]) {
      const canvas = path.join(directory, "projects", id, "workspace/canvas"); await mkdir(canvas, { recursive: true });
      await writeFile(path.join(canvas, "jobs.json"), JSON.stringify([{ id: "job", recoveryId: "canvas-only" }]));
    }
    await runner.removeProject(projectId, { workspacePath: path.join(directory, "projects", projectId, "workspace"), generationScopes: [generationScope] });
    await expect(access(path.join(folder, `${recoveryId}-0.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(folder, "canvas-only-0.json"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, "tools/agent-media", scope))).rejects.toMatchObject({ code: "ENOENT" });
    await runner.close();
  });

  it("deletes old project runs even after their jobs fall out of recent history", async () => {
    const directory = await temporaryData(), runner = new ToolRunner(directory, fakeGenerator()); await runner.load();
    for (let index = 0; index < 21; index++) runner.start("generate-image", { prompt: `Fixture ${index}` }, { context: { projectId: "history-project", nodeId: `node-${index}` } });
    await vi.waitFor(() => expect(runner.isProjectBusy("history-project")).toBe(false));
    expect(runner.jobs()).toHaveLength(20);
    expect(await readdir(path.join(directory, "tools/runs"))).toHaveLength(21);
    await runner.removeProject("history-project");
    expect(await readdir(path.join(directory, "tools/runs"))).toEqual([]);
    expect(runner.jobs()).toEqual([]); await runner.close();
  });

  it("preserves media if another owner's retained identity cannot be read safely", async () => {
    const directory = await temporaryData(), runner = new ToolRunner(directory, fakeGenerator()); await runner.load();
    const run = await runner.run("generate-image", { prompt: "Keep until ownership is known" }, undefined, "owner");
    const foreign = path.join(directory, "tools/agent-media/projects/other"); await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "receipt.json"), "invalid");
    await expect(runner.removeProject("owner")).rejects.toThrow();
    await expect(access(path.join(directory, "tools/runs", run.id))).resolves.toBeUndefined();
    await expect(runner.removeProject("../other")).rejects.toThrow("Invalid project");
    await runner.close();
  });

  it("waits for a cancelled image submission's late journal write before removing project records", async () => {
    const directory = await temporaryData(); let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const generator: ImageGenerator = { generate: async (input, signal) => {
      await input.execution!.submitted("fixture", {}, async () => {
        started(); await new Promise<void>(resolve => { finish = resolve; });
        return { url: "https://example.com/retained.png", generation: { model: "fixture", protocol: "openai-images", parameters: {} } };
      }, signal);
      return { bytes: referencePng(), mediaType: "image/png" };
    } };
    const runner = new ToolRunner(directory, generator); await runner.load();
    runner.start("generate-image", { prompt: "Fixture" }, { context: { projectId: "late-project", nodeId: "node" } }, false, "late-submission");
    await ready;
    let removed = false; const deletion = runner.removeProject("late-project").then(() => { removed = true; });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("cancelled"));
    expect(removed).toBe(false);
    finish(); await deletion;
    expect(runner.jobs()).toEqual([]);
    expect(await readdir(path.join(directory, "tools/image-requests"))).toEqual([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(await readdir(path.join(directory, "tools/image-requests"))).toEqual([]);
    await runner.close();
  });

  it.each([
    { toolId: "image-to-3d", operation: "text", options: { pose: "t-pose" }, key: "pose" },
    { toolId: "image-to-3d", operation: "image", options: { rigType: "quadruped" }, key: "rigType" },
    { toolId: "image-to-3d", operation: "retexture", options: { geometryQuality: "detailed" }, key: "geometryQuality" },
    { toolId: "image-to-3d", operation: "remesh", options: { textureQuality: "detailed" }, key: "textureQuality" },
    { toolId: "animate-3d", operation: "animate", options: { geometryQuality: "detailed" }, key: "geometryQuality" },
  ])("rejects incompatible $operation options before a task journal or provider call", async ({ toolId, operation, options, key }) => {
    const directory = await temporaryData(), generate = vi.fn(), animate = vi.fn();
    const runner = new ToolRunner(directory, fakeGenerator(), { generate, animate }); await runner.load();
    const model = { provider: "tripo", id: "v3.1-20260211" };
    const input = toolId === "animate-3d" ? { model, options, assetId: "not-read", actionIds: ["preset:walk"] } : { model, operation, options, prompt: "Fixture", images: [] };
    try {
      const failure = await runner.runPrepared(toolId, input as never).catch(error => error);
      expect(failure).toMatchObject({ statusCode: 400, notSubmitted: true });
      expect(failure.message).toContain(key);
      expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "invalid_media_options", disposition: "correctable" });
      expect(generate).not.toHaveBeenCalled(); expect(animate).not.toHaveBeenCalled();
      await expect(access(path.join(directory, "tools/model3d-tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await runner.close(); }
  });

  it("never derives option rejection evidence from policy, model lookup, protected input or recovery errors", async () => {
    const model = { provider: "tripo", id: "v3.1-20260211" }, input = { model, operation: "text" as const, prompt: "Fixture", images: [], options: { pose: "t-pose" as const } };
    for (const boundary of ["policy", "lookup"] as const) {
      const rejection = Object.assign(new Model3DGenerationError("These options are not supported by the selected 3D operation", 400, true), { preflightFailure: { effect: "none", reason: "invalid_media_options", disposition: "correctable" } });
      const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate: vi.fn(), ...(boundary === "policy" ? { assertGenerationAllowed: async () => { throw rejection; } } : { resolveModel: async () => { throw rejection; } }) });
      try { expect(getToolPreflightFailure(await runner.assertMediaInputOptions("image-to-3d", input).catch(error => error))).toBeUndefined(); }
      finally { await runner.close(); }
    }
    const directory = await temporaryData(), generate = vi.fn(), runner = new ToolRunner(directory, fakeGenerator(), { generate }); await runner.load();
    try {
      const recovery = await runner.runPrepared("image-to-3d", input, undefined, { recoveryId: "retained-input", model3DRecoveryOnly: true }).catch(error => error);
      expect(getToolPreflightFailure(recovery)).toBeUndefined(); expect(generate).not.toHaveBeenCalled();
      const secret = "fixture-3d-preflight-protected-content-long-value"; registerSensitiveValue(secret);
      const protectedInput = await runner.assertMediaInputOptions("image-to-3d", { ...input, prompt: secret }).catch(error => error);
      expect(getToolPreflightFailure(protectedInput)).toBeUndefined();
    } finally { await runner.close(); }
  });

  it("blocks known Meshy references before preparation, jobs, dispatch or journals", async () => {
    const directory = await temporaryData();
    const generate = vi.fn();
    const resolve = vi.fn(async (_tool: string, input: unknown) => input as never);
    const runner = new ToolRunner(directory, fakeGenerator(), { generate }, undefined, undefined, resolve);
    await runner.load();
    const refs = [
      { provider: "meshy", id: "custom" },
      { provider: "alias", id: "meshy-7.1" },
      { provider: "alias", id: "custom", protocol: "meshy" },
    ];
    for (const model of refs) {
      const input = { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], model };
      await expect(runner.prepare("image-to-3d", input as never)).rejects.toMatchObject({ statusCode: 410 });
      await expect(runner.runPrepared("image-to-3d", input as never)).rejects.toMatchObject({ statusCode: 410 });
      await expect(runner.run("image-to-3d", input as never)).rejects.toMatchObject({ statusCode: 410 });
      expect(() => runner.start("image-to-3d", input as never)).toThrow(/Meshy is disabled/);
    }
    for (const imageModel of refs) {
      const imageInput = { prompt: "fixture", model: undefined, imageModel };
      await expect(runner.prepare("generate-image", imageInput)).rejects.toMatchObject({ statusCode: 410 });
      await expect(runner.runPrepared("generate-image", imageInput)).rejects.toMatchObject({ statusCode: 410 });
      expect(() => runner.start("generate-image", imageInput)).toThrow(/Meshy is disabled/);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(runner.jobs()).toEqual([]);
    await expect(access(path.join(directory, "tools", "model3d-tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    await runner.close();
  });

  it.each(["generate-image", "generate-video"])("checks fresh %s policy before retaining or replacing a job", async (toolId) => {
    const directory = await temporaryData();
    let disabled = false;
    const assertGenerationAllowed = vi.fn(async () => { if (disabled) throw new ImageGenerationError("Meshy alias disabled", 410, false, true); });
    const generate = vi.fn(async () => { throw new Error("Fixture failure"); });
    const runner = new ToolRunner(directory, { generate, assertGenerationAllowed }, undefined, { generate, assertGenerationAllowed });
    await runner.load();
    const model = { provider: "ordinary-alias", id: "model" };
    const input = toolId === "generate-image" ? { prompt: "fixture", imageModel: model } : { prompt: "fixture", model };
    const original = runner.start(toolId, input);
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    disabled = true;
    await expect(runner.assertMediaAvailable(toolId, input)).rejects.toMatchObject({ statusCode: 410, notSubmitted: true });
    await expect(runner.prepare(toolId, input)).rejects.toThrow("Meshy alias disabled");
    await expect(runner.runPrepared(toolId, input)).rejects.toThrow("Meshy alias disabled");
    await expect(runner.retryJob(original.id)).rejects.toThrow("Meshy alias disabled");
    expect(runner.jobs().map(job => job.id)).toEqual([original.id]);
    expect(generate).toHaveBeenCalledOnce();
    await runner.close();
  });

  it("rejects a prepared Meshy reference returned by input resolution", async () => {
    const directory = await temporaryData();
    const generate = vi.fn();
    const resolve = vi.fn(async (_tool: string, input: unknown) => ({ ...(input as object), model: { provider: "meshy", id: "legacy" } } as never));
    const runner = new ToolRunner(directory, fakeGenerator(), { generate }, undefined, undefined, resolve);
    await runner.load();
    await expect(runner.prepare("image-to-3d", { images: [] })).rejects.toMatchObject({ statusCode: 410 });
    expect(resolve).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(runner.jobs()).toEqual([]);
    await expect(access(path.join(directory, "tools", "model3d-tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    await runner.close();
  });

  it("preserves a denied alias recovery and permits only one concurrent retry", async () => {
    const directory = await temporaryData();
    const model = { provider: "alias", id: "retained-model" };
    const base = resolveModel3D({ provider: "tripo", id: "v3.1-20260211" })!;
    let mode: "allow" | "deny" | "hold" = "allow";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assertGenerationAllowed = vi.fn(async () => {
      if (mode === "deny") throw new Error("Meshy alias disabled");
      if (mode === "hold") await gate;
    });
    const generate = vi.fn(async () => { throw new Error("Synthetic failure"); });
    const runner = new ToolRunner(directory, fakeGenerator(), { generate, assertGenerationAllowed, resolveModel: async () => ({ ...base, ...model }) });
    await runner.load();
    const first = runner.start("image-to-3d", { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], model });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    mode = "deny";
    await expect(runner.retryJob(first.id)).rejects.toThrow("Meshy alias disabled");
    expect(runner.jobs().map((job) => job.id)).toEqual([first.id]);
    expect(generate).toHaveBeenCalledOnce();
    mode = "hold";
    const retries = [runner.retryJob(first.id), runner.retryJob(first.id)];
    await vi.waitFor(() => expect(assertGenerationAllowed.mock.calls.length).toBeGreaterThanOrEqual(4));
    release();
    const results = await Promise.allSettled(retries);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(runner.jobs()).toHaveLength(1);
    expect(runner.jobs()[0]?.id).not.toBe(first.id);
    await runner.close();
  });

  it("does not recover a legacy 3D job without its explicit model binding", async () => {
    const generate = vi.fn(async () => { throw new Error("Synthetic failure"); });
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate });
    await runner.load();
    const first = runner.start("image-to-3d", { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    await expect(runner.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("no explicit connection binding") });
    expect(runner.jobs().map((job) => job.id)).toEqual([first.id]);
    expect(generate).toHaveBeenCalledOnce();
    await runner.close();
  });

  it("blocks new project generations while cleanup is pending and tracks direct work until it settles", async () => {
    let finish!: (value: { bytes: Buffer; mediaType: "image/png" }) => void;
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const runner = new ToolRunner(await temporaryData(), { generate }); await runner.load();
    let blocked = false;
    runner.setProjectAdmission(() => { if (blocked) throw new Error("Project deletion is pending"); });
    const request = { prompt: "Fixture image" };
    const direct = runner.run("generate-image", request, undefined, "project-1");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(runner.isProjectBusy("project-1")).toBe(true);
    expect(runner.isProjectBusy("project-2")).toBe(false);
    blocked = true;
    expect(() => runner.start("generate-image", request, { context: { projectId: "project-1", nodeId: "node-1" } })).toThrow("deletion is pending");
    await expect(runner.run("generate-image", request, undefined, "project-1")).rejects.toThrow("deletion is pending");
    await expect(runner.runPrepared("generate-image", request, undefined, { projectId: "project-1" })).rejects.toThrow("deletion is pending");
    finish({ bytes: Buffer.from("fixture"), mediaType: "image/png" });
    await direct;
    expect(runner.isProjectBusy("project-1")).toBe(false);
    await runner.close();
  });

  it("keeps a cancelled job busy until provider cleanup and persistence actually finish", async () => {
    let finish!: (value: { bytes: Buffer; mediaType: "image/png" }) => void;
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const runner = new ToolRunner(await temporaryData(), { generate }); await runner.load();
    const job = runner.start("generate-image", { prompt: "Fixture" }, { context: { projectId: "project-1", nodeId: "node-1" } });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    runner.cancelJob(job.id);
    expect(runner.isProjectBusy("project-1")).toBe(true);
    finish({ bytes: Buffer.from("fixture"), mediaType: "image/png" });
    await vi.waitFor(() => expect(runner.isProjectBusy("project-1")).toBe(false));
    await runner.close();
  });

  it("runs Image to 3D and persists its GLB output", async () => {
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const generate = vi.fn().mockResolvedValue({
      bytes: TEST_GLB,
      mediaType: "model/gltf-binary" as const,
      requestId: "tripo-task-1",
    });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), { generate }, undefined, library);
    await runner.load();
    const run = await runner.run("image-to-3d", {
      images: [{ mediaType: "image/png", data: "ZnJvbnQ=" }],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "tripo", id: "v3.1-20260211" },
      images: [
        { mediaType: "image/png", data: "ZnJvbnQ=" },
      ],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    }), undefined);
    expect(run).toMatchObject({
      toolId: "image-to-3d",
      files: [{ name: "model.glb", mediaType: "model/gltf-binary" }],
    });
    expect(await readFile(path.join(dataDirectory, "tools", "runs", run.id, "model.glb"))).toEqual(TEST_GLB);
    expect(library.get(run.files[0]!.assetId!)).toMatchObject({ origin: "generated", purpose: "asset", mediaType: "model" });
    expect(library.get(run.files[0]!.assetId!)?.prompt).toBeUndefined();
  });

  it("runs 3D generation with a target poly count", async () => {
    const generate = vi.fn().mockResolvedValue({
      bytes: TEST_GLB,
      mediaType: "model/gltf-binary" as const,
    });
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate });
    await runner.load();
    await runner.run("image-to-3d", {
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      model: { provider: "tripo", id: "v3.1-20260211" },
      targetPolycount: 4_000,
      texture: false,
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "tripo", id: "v3.1-20260211" },
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      targetPolycount: 4_000,
      texture: false,
    }), undefined);
  });

  it("requires a supported multi-view model for a concept turnaround and strips the local mode before dispatch", async () => {
    const generate = vi.fn().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" });
    const singleView = { provider: "tripo", id: "P1-20260311" };
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate, resolveModel: async (ref) => {
      const model = resolveModel3D(ref);
      return model && ref?.id === singleView.id ? { ...model, maxReferenceImages: 1 } : model;
    } });
    await runner.load();
    const images = [1, 2, 3].map(width => ({ mediaType: "image/png" as const, data: referencePng({ width, height: 2 }).toString("base64") }));
    const options = { referenceMode: "turnaround" as const };
    const model = { provider: "tripo", id: "v3.1-20260211" };
    await expect(runner.run("image-to-3d", { model: singleView, images, options })).rejects.toThrow("Choose a multi-view model");
    await expect(runner.run("image-to-3d", { model, images: images.slice(0, 2), options })).rejects.toThrow("front, left, and back");
    await expect(runner.run("image-to-3d", { model, images, options, prompt: "Tower concept" })).rejects.toThrow(/Omit prompt.*operation=text/);
    await expect(runner.run("image-to-3d", { model, images: [], operation: "text", prompt: "Tower", options })).rejects.toThrow("only to image-to-3D");
    expect(generate).not.toHaveBeenCalled();
    await runner.run("image-to-3d", { model, images, options: { ...options, pose: "a-pose" } });
    expect(generate.mock.calls[0]![0].options).toEqual({});
    await runner.run("image-to-3d", { model, images: images.slice(0, 1), options: { referenceMode: "provided-views" } });
    expect(generate.mock.calls[1]![0].options).not.toHaveProperty("referenceMode");
  });

  it("runs Tripo with several views and its own polycount range", async () => {
    const generate = vi.fn().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" as const });
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate });
    await runner.load();
    const views = Array.from({ length: 4 }, () => ({ mediaType: "image/png" as const, data: "aW1hZ2U=" }));
    await runner.run("image-to-3d", { images: views, model: { provider: "tripo", id: "v3.1-20260211" }, targetPolycount: 100_000 });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "tripo", id: "v3.1-20260211" }, images: views, targetPolycount: 100_000 }), undefined);
  });

  it("animates a Library GLB and stores the result as a new asset", async () => {
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const animate = vi.fn().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" as const });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), { generate: vi.fn(), animate }, undefined, library);
    await runner.load();

    const model = { provider: "tripo", id: "v3.1-20260211" };
    const run = await runner.run("animate-3d", { assetId: source.id, model, actionIds: ["idle", "walk"], heightMeters: 1.6 });

    expect(animate).toHaveBeenCalledWith(expect.objectContaining({ model: TEST_GLB, providerModel: model, actionIds: ["idle", "walk"], heightMeters: 1.6, execution: expect.any(Object) }), undefined);
    expect(run).toMatchObject({ toolId: "animate-3d", files: [{ name: "model.glb", mediaType: "model/gltf-binary" }] });
    expect(run.files[0]?.assetId).not.toBe(source.id);
    expect(await readFile(path.join(dataDirectory, "tools", "runs", run.id, "model.glb"))).toEqual(TEST_GLB);
  });

  it("rejects animation requests it cannot run", async () => {
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const model = await library.add("hero.glb", TEST_GLB);
    const image = await library.add("hero.png", Buffer.from("png"));
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), { generate: vi.fn(), animate: vi.fn() }, undefined, library);
    await runner.load();

    await expect(runner.run("animate-3d", { assetId: model.id, actionIds: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(runner.run("animate-3d", { assetId: model.id, actionIds: ["idle", "idle"] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(runner.run("animate-3d", { assetId: model.id, actionIds: Array.from({ length: MAX_ANIMATION_ACTIONS + 1 }, (_, index) => `action-${index}`) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(runner.run("animate-3d", { assetId: image.id, actionIds: ["idle"] })).rejects.toMatchObject({ statusCode: 400, message: "Only GLB models are supported" });
    await expect(runner.run("animate-3d", { assetId: "missing", actionIds: ["idle"] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(runner.run("animate-3d", { assetId: model.id, model: { provider: "unknown", id: "unknown" }, actionIds: ["idle"] })).rejects.toMatchObject({ statusCode: 400, message: "Choose an available animation provider" });
    const withoutAnimation = new ToolRunner(dataDirectory, fakeGenerator(), { generate: vi.fn() }, undefined, library);
    await expect(withoutAnimation.run("animate-3d", { assetId: model.id, actionIds: ["idle"] })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("loads animation libraries against the current connection and retries failures", async () => {
    const animations = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([{ id: 0, name: "Idle", category: "DailyActions", subCategory: "Idle" }]);
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate: vi.fn(), animations });

    await expect(runner.animationActions()).rejects.toThrow("offline");
    await expect(runner.animationActions()).resolves.toHaveLength(1);
    await expect(runner.animationActions()).resolves.toHaveLength(1);
    expect(animations).toHaveBeenCalledTimes(3);
    const provider = new TripoProvider(() => "fixture-key", vi.fn());
    const localFailure = await provider.animations(undefined, undefined, { rigModel: "v3.0-20260909", rigType: "quadruped" }).catch(error => error);
    animations.mockRejectedValueOnce(localFailure);
    const wrapped = await runner.animationActions().catch(error => error);
    expect(wrapped).toMatchObject({ statusCode: 400, notSubmitted: true });
    expect(getToolPreflightFailure(wrapped)?.reason).toBe("invalid_animation_action");
    animations.mockRejectedValueOnce(Object.assign(new Model3DGenerationError("Unknown animation", 400, true), { preflightFailure: { effect: "none", reason: "invalid_animation_action", disposition: "correctable" } }));
    expect(getToolPreflightFailure(await runner.animationActions().catch(error => error))).toBeUndefined();
    expect(animations).toHaveBeenCalledTimes(5);
  });

  it("runs the selected video model with a Library image reference", async () => {
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("video"),
      mediaType: "video/mp4" as const,
      requestId: "video-task-1",
    });
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const image = await library.add("frame.png", Buffer.from("image"));
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, { generate }, library);
    await runner.load();

    const run = await runner.run("generate-video", {
      prompt: "  A spaceship crossing a nebula  ",
      model: TEST_VIDEO_MODEL,
      references: [
        { type: "image", assetId: image.id },
      ],
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(generate).toHaveBeenCalledWith({
      prompt: "A spaceship crossing a nebula",
      model: TEST_VIDEO_MODEL,
      references: [
        expect.objectContaining({ type: "image", name: "frame.png", mediaType: "image/png" }),
      ],
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
      execution: expect.any(Object),
    }, undefined);
    expect(run).toMatchObject({
      toolId: "generate-video",
      files: [{ name: "output.mp4", mediaType: "video/mp4", assetId: expect.any(String) }],
    });
  });

  it("runs speech through the common audio generator and stores it in the Library", async () => {
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const model = { provider: "volcengine-tts", id: "seed-tts-2.0" } as const;
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("mp3-audio"),
      mediaType: "audio/mpeg" as const,
      model,
      metadata: { durationMs: 1_250 },
    });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, undefined, library, undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    await runner.load();

    const reference = await library.add("voice.wav", referenceWav(), { duration: 1, purpose: "reference" });
    const run = await runner.run("generate-speech", { text: "  Welcome, traveler  ", referenceAssetId: reference.id, model });

    expect(generate).toHaveBeenCalledWith({ operation: "speech", text: "  Welcome, traveler  ", referenceAssetId: reference.id, referenceAudio: { bytes: referenceWav(), mediaType: "audio/wav" }, model }, undefined);
    expect(run).toMatchObject({
      toolId: "generate-speech",
      model,
      files: [{ name: "output.mp3", mediaType: "audio/mpeg", assetId: expect.any(String) }],
    });
    const asset = library.get(run.files[0]!.assetId!);
    expect(asset).toMatchObject({ mediaType: "audio", contentType: "audio/mpeg", origin: "generated", prompt: "Welcome, traveler", duration: 1.25 });
  });

  it("allows explicit no-reference speech and voice candidates but refuses a changed bound reference", async () => {
    const dataDirectory = await temporaryData(), library = new AssetLibrary(dataDirectory); await library.load();
    const model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const generate = vi.fn(async () => ({ bytes: referenceWav(), mediaType: "audio/wav" as const, model }));
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, undefined, library, undefined, { catalog: () => ({ models: [], providers: [] }), generate }); await runner.load();
    await runner.run("generate-speech", { text: "Hello", model });
    expect(generate.mock.calls[0]).toEqual([{ operation: "speech", text: "Hello", model }, undefined]);
    const candidate = await runner.run("generate-speech", { text: "Sample", voiceDesign: true, voiceDescription: "Warm", model });
    expect(library.get(candidate.files[0]!.assetId!)?.prompt).toBe("Warm");
    const reference = await library.add("reference.wav", referenceWav());
    await expect(runner.run("generate-speech", { text: "Hello", model, referenceAssetId: reference.id, referenceSha256: "0".repeat(64) })).rejects.toThrow("selected audio changed");
    await expect(runner.run("generate-speech", { text: "Sample", voiceDesign: true, voiceDescription: "Warm", referenceAssetId: reference.id })).rejects.toThrow("no reference");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps valid audio in the Library when persisting its output run fails", async () => {
    const directory = await temporaryData(), library = new AssetLibrary(directory);
    await library.load();
    const runs = path.join(directory, "tools", "runs");
    const bytes = referenceWav(), model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const generate = vi.fn(async () => {
      await rm(runs, { recursive: true });
      await writeFile(runs, "Fixture blocking directory creation");
      return { bytes, model, mediaType: "audio/wav" as const };
    });
    const runner = new ToolRunner(directory, fakeGenerator(), undefined, undefined, library, undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    await runner.load();
    const registered = vi.spyOn(library, "add");
    await expect(runner.run("generate-speech", { text: "Hello", model })).rejects.toMatchObject({ submissionOutcome: "unknown", message: expect.stringContaining("retained in the Library") });
    const asset = await registered.mock.results[0]!.value;
    expect(await readFile((await library.content(asset.id)).absolutePath)).toEqual(bytes);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects an audio retry immediately on cancellation while the original paid request is still settling", async () => {
    const directory = await temporaryData();
    let rejectRequest!: (cause: Error) => void;
    const generate = vi.fn(() => new Promise<never>((_, reject) => { rejectRequest = reject; }));
    const runner = new ToolRunner(directory, fakeGenerator(), undefined, undefined, undefined, undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    await runner.load();
    const first = runner.start("generate-sound-effect", { prompt: "Rain" });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    try {
      expect(runner.cancelJob(first.id)).toMatchObject({ status: "cancelled", submissionOutcome: "unknown" });
      await expect(runner.retryJob(first.id)).rejects.toThrow("may have been billed");
    } finally {
      rejectRequest(new Error("Cancelled"));
      await runner.close();
    }
    expect(generate).toHaveBeenCalledOnce();
  });

  it("blocks concurrent and reopened audio call replays using a private write-ahead marker", async () => {
    const directory = await temporaryData(), model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const generate = vi.fn(async () => { throw new (await import("../src/daemon/audio-generation.js")).AudioGenerationError("Interrupted", 502, "unknown"); });
    const make = () => new ToolRunner(directory, fakeGenerator(), undefined, undefined, undefined, undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    const runner = make(); await runner.load();
    const input = { text: "Synthetic sample", voiceDesign: true, voiceDescription: "Warm", model }, options = { recoveryId: "same-agent-call" };
    const attempts = await Promise.allSettled([runner.run("generate-speech", input, undefined, undefined, options), runner.run("generate-speech", input, undefined, undefined, options)]);
    expect(attempts.every((value) => value.status === "rejected")).toBe(true); expect(generate).toHaveBeenCalledOnce();
    const reopened = make(); await reopened.load();
    await expect(reopened.run("generate-speech", { ...input, voiceDescription: "Changed" }, undefined, undefined, options)).rejects.toThrow("already attempted");
    expect(generate).toHaveBeenCalledOnce();
    const marker = path.join(directory, "tools/audio-attempts/same-agent-call.json");
    expect(await readFile(marker, "utf8")).toBe(JSON.stringify({ toolId: "generate-speech", attempted: true }));
    expect((await (await import("node:fs/promises")).stat(marker)).mode & 0o777).toBe(0o600);
  });

  it("remembers a definite audio rejection separately from an unknown receipt without reusing the old call", async () => {
    const directory = await temporaryData();
    const generate = vi.fn(async () => { throw new (await import("../src/daemon/audio-generation.js")).AudioGenerationError("Quota rejection", 429); });
    const make = () => new ToolRunner(directory, fakeGenerator(), undefined, undefined, undefined, undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    const first = make(); await first.load();
    const input = { text: "Read this" }, options = { recoveryId: "quota-denied" };
    await expect(first.run("generate-speech", input, undefined, undefined, options)).rejects.toMatchObject({ statusCode: 429, notSubmitted: true });
    const reopened = make(); await reopened.load();
    expect(await reopened.mediaWasAttempted("generate-speech", options.recoveryId)).toBe(false);
    await expect(reopened.run("generate-speech", input, undefined, undefined, options)).rejects.toThrow("already attempted");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects selected invalid, oversized, removed and linked speech references before generation", async () => {
    const directory = await temporaryData(), library = new AssetLibrary(directory); await library.load();
    const generate = vi.fn();
    const runner = new ToolRunner(directory, fakeGenerator(), undefined, undefined, library, undefined, { catalog: () => ({ models: [], providers: [] }), generate }); await runner.load();
    const invalid = await library.add("renamed.wav", Buffer.from("not a WAV"));
    const tooLong = await library.add("long.wav", referenceWav(30.1));
    const huge = await library.add("huge.wav", Buffer.alloc(10_000_001));
    const removed = await library.add("removed.wav", referenceWav()); await library.delete(removed.id);
    const linked = await library.add("linked.wav", referenceWav());
    const content = (await library.content(linked.id)).absolutePath, outside = path.join(directory, "outside.wav");
    await writeFile(outside, referenceWav()); await rm(content); await symlink(outside, content);
    for (const referenceAssetId of ["missing", invalid.id, tooLong.id, huge.id, removed.id, linked.id]) await expect(runner.run("generate-speech", { text: "Hello", referenceAssetId })).rejects.toBeDefined();
    for (const extra of [{ voiceId: "legacy-speaker" }, { referenceAudio: { bytes: [1, 2] } }, { audioPath: "/private/voice.wav" }]) await expect(runner.run("generate-speech", { text: "Hello", ...extra } as never)).rejects.toBeDefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects protected audio input, job metadata and recovery fields before execution or persistence", async () => {
    const directory = await temporaryData();
    const key = "sk-tool-input-private-canary-20261028";
    registerSensitiveValue(key);
    const generate = vi.fn();
    const runner = new ToolRunner(directory, fakeGenerator(), undefined, undefined, undefined, undefined, { generate, catalog: () => ({ models: [], providers: [] }) });
    await runner.load();
    const input = { text: `Read ${key}`, voiceId: "speaker" };
    expect(() => runner.start("generate-speech", input)).toThrow("protected credential");
    await expect(runner.run("generate-speech", input)).rejects.toThrow("protected credential");
    await expect(runner.prepare("generate-speech", input)).rejects.toThrow("protected credential");
    await expect(runner.runPrepared("generate-speech", input)).rejects.toThrow("protected credential");
    expect(() => runner.start("generate-speech", { text: "hello" }, { title: key })).toThrow("protected credential");
    await expect(runner.runPrepared("generate-speech", { text: "hello" }, undefined, { recoveryId: key })).rejects.toThrow("protected credential");
    const cyclic: { text: string; nested?: unknown } = { text: "hello" }; cyclic.nested = cyclic;
    expect(() => runner.start("generate-speech", cyclic)).toThrow("ordinary JSON");
    expect(runner.jobs()).toEqual([]);
    expect(await readdir(path.join(directory, "tools", "runs"))).toEqual([]);
    await expect(access(path.join(directory, "tools", "jobs.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a video asset mislabeled as an image reference", async () => {
    const generate = vi.fn();
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const video = await library.add("motion.mp4", Buffer.from("video"), { duration: 8 });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, { generate }, library);
    await runner.load();

    await expect(runner.run("generate-video", { prompt: "Animate", model: TEST_VIDEO_MODEL, references: [{ type: "image", assetId: video.id }] }))
      .rejects.toMatchObject({ statusCode: 400, message: "Reference motion.mp4 is not a image asset" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs the image tool and persists its output outside projects", async () => {
    const dataDirectory = await temporaryData();
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({
      bytes: Buffer.from([0, 1, 2, 255]),
      mediaType: "image/webp",
      requestId: "openai-request-1",
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const run = await runner.run("generate-image", { prompt: "  A forest game background  ", size: "1536x1024" });

    expect(generate).toHaveBeenCalledWith({ prompt: "A forest game background", size: "1536x1024", execution: expect.objectContaining({ submitted: expect.any(Function) }) }, undefined);
    expect(run).toMatchObject({
      toolId: "generate-image",
      files: [{ name: "output.webp", mediaType: "image/webp" }],
    });
    expect(run).not.toHaveProperty("requestId");
    expect(run).not.toHaveProperty("prompt");

    const runDirectory = path.join(dataDirectory, "tools", "runs", run.id);
    expect((await readdir(runDirectory)).sort()).toEqual(["output.webp", "run.json"]);
    expect(await readFile(path.join(runDirectory, "output.webp"))).toEqual(Buffer.from([0, 1, 2, 255]));
    const storedRun = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
    expect(storedRun).toMatchObject({
      version: 1,
      id: run.id,
    });
    expect(storedRun).not.toHaveProperty("prompt");
    expect(storedRun).not.toHaveProperty("requestId");
  });

  it("generates multiple configured images", async () => {
    const dataDirectory = await temporaryData();
    let sequence = 0;
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(async () => ({
      bytes: Buffer.from(`image-${++sequence}`),
      mediaType: "image/webp",
    }));
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const run = await runner.run("generate-image", { prompt: "Four icons", resolution: "1K", aspectRatio: "1:1", outputs: 2 });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledWith({ prompt: "Four icons", resolution: "1K", aspectRatio: "1:1", execution: expect.objectContaining({ submitted: expect.any(Function) }) }, undefined);
    expect(run.files).toEqual([
      { name: "output-1.webp", mediaType: "image/webp" },
      { name: "output-2.webp", mediaType: "image/webp" },
    ]);

    expect((await readdir(path.join(dataDirectory, "tools", "runs", run.id))).sort()).toEqual(["output-1.webp", "output-2.webp", "run.json"]);
  });

  it("names generated images by their actual format", async () => {
    const dataDirectory = await temporaryData();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    const outputs = [png, jpeg];
    // A proxy can ignore the requested format. Journal setup may schedule concurrent requests in either order.
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(async () => ({
      bytes: outputs.shift()!,
      mediaType: "image/webp",
    }));
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const run = await runner.run("generate-image", { prompt: "Two icons", resolution: "1K", aspectRatio: "1:1", outputs: 2 });

    expect(run.files.map((file) => file.mediaType).sort()).toEqual(["image/jpeg", "image/png"]);
    const runDirectory = path.join(dataDirectory, "tools", "runs", run.id);
    for (const [index, file] of run.files.entries()) {
      const expected = file.mediaType === "image/png" ? png : jpeg;
      expect(file.name).toBe(`output-${index + 1}.${file.mediaType === "image/png" ? "png" : "jpg"}`);
      expect(await readFile(path.join(runDirectory, file.name))).toEqual(expected);
      await expect(runner.file(run.id, file.name)).resolves.toMatchObject({ bytes: expected, mediaType: file.mediaType });
    }
  });

  it("validates requests and reports missing configuration", async () => {
    const runner = new ToolRunner(await temporaryData(), fakeGenerator());
    await runner.load();

    await expect(runner.run("missing", { prompt: "image" })).rejects.toMatchObject({ statusCode: 404 });
    const invalid: Array<[string, unknown]> = [
      ["generate-image", { prompt: " " }],
      ["image-to-3d", { images: [{ mediaType: "image/webp", data: "aW1hZ2U=" }] }],
      ["image-to-3d", { prompt: "model", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }],
      ["image-to-3d", { prompt: "model" }],
      ["image-to-3d", { images: [] }],
      ["image-to-3d", { targetPolycount: 4_000 }],
      ["image-to-3d", { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], model: null }],
      ["image-to-3d", { images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], targetPolycount: 2_000_000 }],
      ["image-to-3d", { images: Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: "aW1hZ2U=" })), model: { provider: "tripo", id: "v3.1-20260211" } }],
      ["generate-image", { prompt: "image", size: "800x600" }],
      ["generate-image", { prompt: "image", size: "1024x1024", resolution: "1K", aspectRatio: "1:1" }],
      ["generate-image", { prompt: "image", resolution: "1K" }],
    ];
    for (const [toolId, input] of invalid) {
      await expect(runner.run(toolId, input as never)).rejects.toMatchObject({ statusCode: 400 });
    }

    const unconfigured = new ToolRunner(await temporaryData(), {
      generate: async () => { throw new ImageGenerationError("Image generation is not configured", 503); },
    });
    await unconfigured.load();
    await expect(unconfigured.run("generate-image", { prompt: "image" }))
      .rejects.toMatchObject({ statusCode: 503, message: "Image generation is not configured" });
  });

  it("passes the selected model through tool job requests", async () => {
    const generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("video"), mediaType: "video/mp4" as const });
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator(), videoGenerator: { generate } });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/generate-video/jobs",
      payload: { prompt: "A nebula", model: TEST_VIDEO_MODEL, duration: 6, aspectRatio: "16:9", resolution: "720p" },
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: TEST_VIDEO_MODEL }), expect.anything()));
  });

  it("limits tool request bodies", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/jobs",
      payload: { images: [{ mediaType: "image/png", data: "a".repeat(26 * 1024 * 1024) }] },
    });
    expect(response.statusCode).toBe(413);
  });

  it("cancels image generation without persisting a run", async () => {
    const dataDirectory = await temporaryData();
    const generate: ImageGenerator["generate"] = async (_input, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const controller = new AbortController();

    const run = runner.run("generate-image", { prompt: "A forest" }, controller.signal);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

  it("reads files from direct runs for Agent tools", async () => {
    const dataDirectory = await temporaryData();
    const runner = new ToolRunner(dataDirectory, fakeGenerator());
    await runner.load();

    const run = await runner.run("generate-image", { prompt: "A forest" });
    await expect(runner.file(run.id, "output.webp")).resolves.toEqual({
      bytes: Buffer.from("image"),
      mediaType: "image/webp",
    });
    await expect(runner.file("not-a-run", "output.webp")).resolves.toBeUndefined();
    await expect(runner.file(run.id, "../output.webp")).resolves.toBeUndefined();
    await runner.removeRun(run.id);
    await expect(runner.file(run.id, "output.webp")).resolves.toBeUndefined();
  });

  it("runs media generations as concurrent background jobs", async () => {
    const pending: Array<(value: { bytes: Buffer; mediaType: "image/webp" }) => void> = [];
    const generate: ImageGenerator["generate"] = async () => new Promise((resolve) => pending.push(resolve));
    const dataDirectory = await temporaryData();
    const app = createApp({ dataDirectory, imageGenerator: { generate } });
    apps.push(app);

    const projectId = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json().id;
    const first = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "First image", projectId, nodeId: "node-1" } });
    const second = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "Second image" } });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect((await app.inject({ method: "GET", url: "/tool-jobs" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.json().id, status: "running", title: "Second image" }),
      expect.objectContaining({ id: first.json().id, status: "running", title: "First image", context: { projectId, nodeId: "node-1" } }),
    ]));

    pending[0]!({ bytes: Buffer.from("first"), mediaType: "image/webp" });
    pending[1]!({ bytes: Buffer.from("second"), mediaType: "image/webp" });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.every((job: { status: string }) => job.status === "succeeded")).toBe(true);
    });
    const completed = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
    expect(completed).toHaveLength(2);
    expect(completed.every((job: { run?: unknown }) => Boolean(job.run))).toBe(true);
    for (const job of completed) {
      await expect(access(path.join(dataDirectory, "tools", "runs", job.run.id))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("requires Canvas job context to include both project and node", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/generate-image/jobs",
      payload: { prompt: "Image", projectId: "project-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Project and node context must be provided together" });
  });

  it("cancels and retries a background generation job", async () => {
    let attempt = 0;
    const generate: ImageGenerator["generate"] = async (_input, signal) => {
      attempt += 1;
      if (attempt > 1) return { bytes: Buffer.from("retried"), mediaType: "image/webp" };
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: { generate } });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "Retry me" } });

    await vi.waitFor(() => expect(attempt).toBe(1));
    const cancelled = await app.inject({ method: "POST", url: `/tool-jobs/${created.json().id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    await vi.waitFor(async () => {
      const [job] = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(job.status).toBe("cancelled");
    });
    const retried = await app.inject({ method: "POST", url: `/tool-jobs/${created.json().id}/retry` });
    expect(retried.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.find((job: { id: string }) => job.id === retried.json().id)?.status).toBe("succeeded");
      expect(jobs.some((job: { id: string }) => job.id === created.json().id)).toBe(false);
    });
  });

  it("freezes a resolved model for retries and shares resolution with direct project calls", async () => {
    let current = { provider: "studio", id: "first" };
    const resolve = vi.fn(async (_tool: string, input: object, projectId?: string) => ({ ...input, prompt: "Icon", imageModel: { ...current, provider: projectId ?? current.provider } }));
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockRejectedValueOnce(new ImageGenerationError("Temporary failure", 502))
      .mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const runner = new ToolRunner(await temporaryData(), { generate }, undefined, undefined, undefined, resolve);
    await runner.load();
    const first = runner.start("generate-image", { prompt: "Icon" });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    current = { provider: "another-studio", id: "second" };
    await runner.retryJob(first.id);
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("succeeded"));
    expect(generate.mock.calls.map(([input]) => input.imageModel)).toEqual([{ provider: "studio", id: "first" }, { provider: "studio", id: "first" }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    await runner.run("generate-image", { prompt: "Icon" }, undefined, "project-1");
    expect(generate.mock.calls.at(-1)?.[0].imageModel).toEqual({ provider: "project-1", id: "second" });
  });

  it("logs each finished generation without its prompt", async () => {
    const lines: { level: string; message: string; details: Record<string, unknown> }[] = [];
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockRejectedValueOnce(new ImageGenerationError("The provider rejected the request", 400))
      .mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const runner = new ToolRunner(await temporaryData(), { generate });
    runner.setLogger({
      info: (details, message) => lines.push({ level: "info", message, details: details as Record<string, unknown> }),
      warn: (details, message) => lines.push({ level: "warn", message, details: details as Record<string, unknown> }),
    });
    await runner.load();

    runner.start("generate-image", { prompt: "A secret castle", imageModel: { provider: "openai", id: "gpt-image-1" } }, { context: { projectId: "p1", nodeId: "n1" } });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    runner.start("generate-image", { prompt: "A secret castle", imageModel: { provider: "openai", id: "gpt-image-1" } });
    await vi.waitFor(() => expect(lines).toHaveLength(2));

    expect(lines).toEqual([
      { level: "warn", message: "Generation failed", details: { toolId: "generate-image", model: "openai/gpt-image-1", projectId: "p1", durationMs: expect.any(Number), error: "The provider rejected the request" } },
      { level: "info", message: "Generation succeeded", details: { toolId: "generate-image", model: "openai/gpt-image-1", durationMs: expect.any(Number) } },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret castle");
  });

  it("keeps only recent completed background jobs", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);

    await Promise.all(Array.from({ length: 21 }, (_, index) => app.inject({
      method: "POST",
      url: "/tools/generate-image/jobs",
      payload: { prompt: `Image ${index}` },
    })));
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs).toHaveLength(20);
      expect(jobs.every((job: { status: string }) => job.status === "succeeded")).toBe(true);
    });
  });

  it("preserves the latest unresolved contextual receipt through ordinary history churn and reopening", async () => {
    const directory = await temporaryData(), context = { projectId: "forest", boardId: "art", nodeId: "moth" };
    const audio = vi.fn(async () => { throw new (await import("../src/daemon/audio-generation.js")).AudioGenerationError("Lost response", 502, "unknown"); });
    const make = () => new ToolRunner(directory, fakeGenerator(), undefined, undefined, undefined, undefined, { catalog: () => ({ models: [], providers: [] }), generate: audio });
    const runner = make(); await runner.load();
    const failed = runner.start("generate-speech", { text: "Hello" }, { context });
    await vi.waitFor(() => expect(runner.jobs()[0]).toMatchObject({ status: "failed", submissionOutcome: "unknown" }));
    runner.start("generate-image", { prompt: "An icon" }, { context });
    for (let i = 0; i < 20; i++) runner.start("generate-image", { prompt: `Landscape ${i}` });
    await vi.waitFor(() => {
      expect(runner.jobs().filter((job) => job.status === "succeeded")).toHaveLength(20);
      expect(runner.jobs().some((job) => job.status === "running")).toBe(false);
    });
    await runner.close();
    const reopened = make(); await reopened.load();
    expect(reopened.jobs().find((job) => job.id === failed.id)?.submissionOutcome).toBe("unknown");
    expect(() => reopened.start("generate-speech", { text: "Updated" }, { context })).toThrow("may have been billed");
    expect(() => reopened.start("generate-speech", { text: "Updated" }, { context, confirmedJobId: "stale-job" })).toThrow("out of date");
    expect(audio).toHaveBeenCalledOnce();
  });

  it("logs direct agent and prepared canvas generations once with project context", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockResolvedValueOnce({ bytes: Buffer.from("image"), mediaType: "image/png" })
      .mockRejectedValueOnce(new ImageGenerationError("Provider failed", 502))
      .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    const runner = new ToolRunner(await temporaryData(), { generate });
    const info = vi.fn(), warn = vi.fn();
    runner.setLogger({ info, warn });
    await runner.load();
    try {
      const request = { prompt: "A private castle", imageModel: { provider: "openai", id: "gpt-image-1" } };
      await runner.run("generate-image", request, undefined, "agent-project");
      await expect(runner.runPrepared("generate-image", request, undefined, { projectId: "canvas-project" })).rejects.toThrow("Provider failed");
      await expect(runner.runPrepared("generate-image", request)).rejects.toThrow("Cancelled");
      expect(info.mock.calls).toEqual([
        [expect.objectContaining({ toolId: "generate-image", model: "openai/gpt-image-1", projectId: "agent-project", durationMs: expect.any(Number) }), "Generation succeeded"],
        [expect.objectContaining({ toolId: "generate-image" }), "Generation cancelled"],
      ]);
      expect(warn.mock.calls).toEqual([[expect.objectContaining({ projectId: "canvas-project", error: "Provider failed" }), "Generation failed"]]);
      expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain("private castle");
    } finally { await runner.close(); }
  });

  it("keeps generation results and persisted jobs when the logger throws", async () => {
    const dataDirectory = await temporaryData();
    const failure = new ImageGenerationError("Provider failed", 502);
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockResolvedValueOnce({ bytes: Buffer.from("image"), mediaType: "image/png" })
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const runner = new ToolRunner(dataDirectory, { generate });
    runner.setLogger({ info: () => { throw new Error("Logger failed"); }, warn: () => { throw new Error("Logger failed"); } });
    await runner.load();
    try {
      const request = { prompt: "fixture" };
      await expect(runner.run("generate-image", request)).resolves.toMatchObject({ toolId: "generate-image" });
      await expect(runner.run("generate-image", request)).rejects.toMatchObject({ message: failure.message, statusCode: failure.statusCode });
      const job = runner.start("generate-image", request);
      await vi.waitFor(() => expect(runner.jobs().find(({ id }) => id === job.id)?.status).toBe("succeeded"));
    } finally { await runner.close(); }
    expect(JSON.parse(await readFile(path.join(dataDirectory, "tools", "jobs.json"), "utf8"))).toMatchObject([{ status: "succeeded" }]);
  });

  it("records direct and background preparation failures without calling the provider", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>();
    const runner = new ToolRunner(await temporaryData(), { generate }, undefined, undefined, undefined, async () => { throw new Error("Provider is disabled"); });
    const warn = vi.fn();
    runner.setLogger({ info: vi.fn(), warn });
    await runner.load();
    try {
      await expect(runner.run("generate-image", { prompt: "fixture" }, undefined, "p1")).rejects.toThrow("Provider is disabled");
      const job = runner.start("generate-image", { prompt: "fixture" });
      await vi.waitFor(() => expect(runner.jobs().find(({ id }) => id === job.id)?.status).toBe("failed"));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", error: "Provider is disabled" }), "Generation failed");
      expect(generate).not.toHaveBeenCalled();
    } finally { await runner.close(); }
  });

});

function temporaryData(): Promise<string> {
  return temporaryTestDirectory("ohmygame-tools-");
}

function fakeGenerator(): ImageGenerator {
  return { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) };
}
