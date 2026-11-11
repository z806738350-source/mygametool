import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoModel, RunVideoToolRequest } from "../src/shared/contracts.js";
import { ProviderAudio, type AudioGenerator } from "../src/daemon/audio-generation.js";
import { KunpoVideoProvider } from "../src/daemon/kunpo-video-provider.js";
import { OpenAIImageGenerator, type ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunner } from "../src/daemon/tools.js";
import type { VideoGenerator } from "../src/daemon/video-generation.js";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";
import { AssetLibrary, AssetLibraryError } from "../src/daemon/asset-library.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { spawn } from "node:child_process";
import { singleSubmissionVideoTransport } from "../scripts/video-acceptance-transport.js";
import { FIXTURE_VIDEO_ID, openAcceptanceFixture } from "./fixtures/video-acceptance-crash.js";

const runners: ToolRunner[] = [];
const acceptanceFixtures: Awaited<ReturnType<typeof openAcceptanceFixture>>[] = [];
afterEach(async () => { await Promise.all(acceptanceFixtures.splice(0).map((fixture) => fixture.close())); await Promise.all(runners.splice(0).map((runner) => runner.close())); });
const fakeKey = "fake-lifecycle-canary-20261028";
const imageResult = { bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVxkAAAAASUVORK5CYII=", "base64"), mediaType: "image/png" as const };
const imageGenerator: ImageGenerator = { generate: async () => imageResult };
const videoModel: VideoModel = { provider: "volcengine-ark", providerName: "Kunpo Seedance", id: "doubao-seedance-2-5-260628", name: "Seedance 2.5", resolutions: ["720p"], durations: [5], aspectRatios: ["16:9", "adaptive"], maxImageReferences: 30, referenceModes: ["frame", "reference"] };
const videoInput: RunVideoToolRequest = { prompt: "A cube rolls", model: { provider: videoModel.provider, id: videoModel.id }, duration: 5, resolution: "720p", aspectRatio: "16:9", referenceMode: "reference" };
const mp4 = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } });
function videoGenerator(request: typeof fetch, model = videoModel): VideoGenerator {
  const adapter = new KunpoVideoProvider({ name: "KunpoAPI", baseUrl: "http://127.0.0.1:43199/doubao/api/v3", apiKey: fakeKey }, request, 0);
  return { generate: (input, signal) => adapter.generate(model, input, signal) };
}
function kunpoImages(request: typeof fetch): ImageGenerator {
  const adapter = new OpenAIImageGenerator(fakeKey, "http://127.0.0.1:43199/v1", request);
  return { generate: (input, signal) => adapter.generate({ ...input, model: input.imageModel?.id }, signal) };
}
async function directory() { return mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-lifecycle-")); }
async function runner(dataDirectory: string, videos?: VideoGenerator, audio?: AudioGenerator, images: ImageGenerator = imageGenerator, library?: AssetLibrary) {
  const instance = new ToolRunner(dataDirectory, images, undefined, videos, library, undefined, audio);
  runners.push(instance);
  await instance.load();
  return instance;
}

describe("Kunpo ToolRunner lifecycle", () => {
  it.each([false, true])("keeps acceptance responses unmodified, ignores diagnostic failures and blocks a second POST across restart; async=%s", async (asynchronous) => {
    const dataDirectory = await directory(), markerFile = path.join(dataDirectory, "post-attempted.json"), submissionUrl = "http://127.0.0.1:43199/task";
    const response = Response.json({ id: FIXTURE_VIDEO_ID, status: "queued" }), request = vi.fn<typeof fetch>().mockResolvedValue(response), observe = vi.fn(() => { if (asynchronous) return Promise.reject(new Error("Synthetic diagnostic failure")); throw new Error("Synthetic diagnostic failure"); });
    const wrapper = singleSubmissionVideoTransport(request, { submissionUrl, markerFile, privateRecoveryPermitted: true, observe });
    const returned = await wrapper(submissionUrl, { method: "POST" }); expect(returned === response).toBe(true); expect((await returned.json()).id === FIXTURE_VIDEO_ID).toBe(true);
    expect(observe).toHaveBeenCalledWith({ method: "POST", httpStatus: 200, elapsedMs: expect.any(Number) });
    const marker = await readFile(markerFile, "utf8"); expect(marker).not.toContain(FIXTURE_VIDEO_ID); expect(marker).not.toContain("http");
    await expect(wrapper(submissionUrl, { method: "POST" })).rejects.toThrow("only one");
    const reopened = singleSubmissionVideoTransport(request, { submissionUrl, markerFile, privateRecoveryPermitted: true });
    await expect(reopened(submissionUrl, { method: "POST" })).rejects.toThrow(); expect(request).toHaveBeenCalledOnce();
  });

  it("refuses acceptance setup without permission for private task persistence before any request", () => {
    const request = vi.fn<typeof fetch>();
    expect(() => singleSubmissionVideoTransport(request, { submissionUrl: "http://127.0.0.1:43199/task", markerFile: path.join(tmpdir(), "unused-marker"), privateRecoveryPermitted: false as unknown as true })).toThrow("private recovery");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers the actual canvas after an abrupt fixture exit, without another POST; missingId=%s", async (noId) => {
    const dataDirectory = await directory();
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), path.resolve("test/fixtures/video-acceptance-crash.ts"), dataDirectory, noId ? "no-id" : "with-id"], {
        cwd: path.resolve("."), env: { HOME: dataDirectory, TMPDIR: dataDirectory, PATH: "/usr/bin:/bin", PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { output += String(chunk); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned crash fixture exceeded its deadline")); }, 20000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(91);
    const checkpoint = JSON.parse(await readFile(path.join(dataDirectory, "crash-checkpoint.json"), "utf8")); expect(checkpoint.posts).toBe(1);
    const journalFile = path.join(dataDirectory, "tools/video-tasks", (await readdir(path.join(dataDirectory, "tools/video-tasks")))[0]!);
    const before = await readFile(journalFile, "utf8"), saved = JSON.parse(before);
    if (noId) expect(saved.generate.task).toBeUndefined(); else { expect(checkpoint.persistedIdMatchesResponse).toBe(true); expect(saved.generate.task.taskId === FIXTURE_VIDEO_ID).toBe(true); }
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const address = new URL(String(url));
      if (address.pathname === "/output.mp4") return mp4();
      expect(address.pathname.endsWith("/" + FIXTURE_VIDEO_ID)).toBe(true);
      return Response.json({ id: FIXTURE_VIDEO_ID, status: "succeeded", content: { video_url: "http://127.0.0.1:43199/output.mp4" } });
    });
    const reopened = await openAcceptanceFixture(dataDirectory, request); acceptanceFixtures.push(reopened);
    const history = await reopened.store.jobs(checkpoint.projectId), interrupted = history.find((job) => job.id === checkpoint.jobId)!;
    if (noId) {
      expect(interrupted.canRecoverVideo).toBe(false); await expect(reopened.store.retry(checkpoint.projectId, checkpoint.jobId)).rejects.toThrow("No saved video task");
      await expect(reopened.store.generateNode(checkpoint.projectId, checkpoint.boardId, checkpoint.nodeId)).rejects.toMatchObject({ statusCode: 409 });
      expect(request).not.toHaveBeenCalled();
      const fresh = await reopened.store.generateNode(checkpoint.projectId, checkpoint.boardId, checkpoint.nodeId, checkpoint.jobId); await reopened.store.waitForProject(checkpoint.projectId);
      expect((await reopened.store.jobs(checkpoint.projectId)).find((job) => job.id === fresh.id)?.status).toBe("failed"); expect(request).not.toHaveBeenCalled();
    } else {
      expect(interrupted.status).toBe("cancelled"); expect(interrupted.canRecoverVideo).toBe(true);
      const resumed = await reopened.store.retry(checkpoint.projectId, checkpoint.jobId); await reopened.store.waitForProject(checkpoint.projectId);
      expect((await reopened.store.jobs(checkpoint.projectId)).find((job) => job.id === resumed.id)?.status).toBe("succeeded"); expect(request).toHaveBeenCalledTimes(2);
      expect(await readFile(journalFile, "utf8")).toBe(before);
    }
  });

  it("persists lossless PNG preparation through cancellation, reopening and GET-only recovery", async () => {
    const dataDirectory = await directory(), library = new AssetLibrary(dataDirectory); await library.load();
    const originalBytes = referencePng(), reference = await library.add("synthetic.png", originalBytes);
    const initial = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_optimized_png" })).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("cancelled test status")), { once: true });
    }));
    const original = await runner(dataDirectory, videoGenerator(initial), undefined, imageGenerator, library);
    const input: RunVideoToolRequest = { ...videoInput, aspectRatio: "adaptive", references: [{ type: "image", assetId: reference.id }] };
    const first = original.start("generate-video", input, { context: { projectId: "synthetic-project", nodeId: "synthetic-video" } });
    expect(original.start("generate-video", input, { context: { projectId: "synthetic-project", nodeId: "synthetic-video" } }).id).toBe(first.id);
    await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(2));
    expect(original.jobs()[0]?.videoReferencePreparation).toMatchObject({ version: 2, optimized: 1, originalBytes: originalBytes.length });
    original.cancelJob(first.id); await original.close();
    const persisted = await readFile(path.join(dataDirectory, "tools", "jobs.json"), "utf8");
    expect(persisted).not.toContain(fakeKey); expect(persisted).not.toContain("data:image");
    const resumed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/synthetic.mp4" } })).mockResolvedValueOnce(mp4());
    const reopened = await runner(dataDirectory, videoGenerator(resumed), undefined, imageGenerator, library);
    expect(reopened.jobs()[0]?.videoReferencePreparation?.optimized).toBe(1);
    await reopened.retryJob(first.id);
    await vi.waitFor(() => expect(reopened.jobs()[0]?.status).toBe("succeeded"));
    expect(resumed.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(initial.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(reopened.jobs()[0]?.run?.generation?.parameters).toMatchObject({ referencePngOptimized: 1, referencePngBytesOriginal: originalBytes.length });
    expect(await readFile((await library.content(reference.id)).absolutePath)).toEqual(originalBytes);
    expect(JSON.stringify(reopened.jobs())).not.toContain(fakeKey);
  });

  describe.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("adaptive media persistence: %s", (id) => {
    it.each(["reference", "frame"] as const)("submits a %s image and saves the video, metadata and reference across reload", async (mode) => {
      const dataDirectory = await directory(), library = new AssetLibrary(dataDirectory); await library.load();
      const reference = await library.add("reference.png", imageResult.bytes);
      const definition: VideoModel = { ...videoModel, id, durations: [6], resolutions: [id === "minimax-video-h3" ? "768p" : "480p"] };
      const native = id === "doubao-seedance-2-5-260628";
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_adaptive" }))
        .mockResolvedValueOnce(Response.json(native ? { status: "succeeded", content: { video_url: "http://127.0.0.1:43199/adaptive.mp4" } } : { status: "completed" })).mockResolvedValueOnce(mp4());
      const tools = await runner(dataDirectory, videoGenerator(request, definition), undefined, imageGenerator, library);
      const input: RunVideoToolRequest = { ...videoInput, model: { provider: definition.provider, id }, references: [{ type: "image", assetId: reference.id }], referenceMode: mode, aspectRatio: "adaptive", duration: 6, resolution: definition.resolutions[0] };
      const run = await tools.run("generate-video", input);
      const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      const imageUrl = `data:image/png;base64,${imageResult.bytes.toString("base64")}`;
      if (id === "tencent-vod-vs-2.5") {
        expect(body.aspect_ratio).toBe("adaptive");
        expect(mode === "frame" ? body.first_frame_url : body.images[0]).toBe(imageUrl);
      } else {
        expect(body.ratio).toBe("adaptive");
        expect(body.content[native ? 1 : 0]).toEqual({ type: "image_url", image_url: { url: imageUrl }, role: mode === "frame" ? "first_frame" : "reference_image" });
      }
      expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(run.generation).toMatchObject({ model: id, protocol: native ? "seedance" : "kunpo-videos", parameters: { aspectRatio: "adaptive", referenceMode: mode, referenceCount: 1, duration: 6 } });
      const stored = new AssetLibrary(dataDirectory); await stored.load();
      const outputId = run.files[0]!.assetId!;
      expect(stored.get(outputId)?.generation).toEqual(run.generation);
      expect(await readFile((await stored.content(outputId)).absolutePath)).toEqual(Buffer.from(await mp4().arrayBuffer()));
      expect(await readFile((await stored.content(reference.id)).absolutePath)).toEqual(imageResult.bytes);
      const metadata = await readFile(path.join(dataDirectory, "library", "assets.json"), "utf8");
      expect(metadata).not.toContain(fakeKey); expect(JSON.stringify(run.generation)).not.toContain("data:");
    });
  });

  it.each(["reference", "frame"] as const)("recovers an existing adaptive %s task after a legacy save rejection without another paid POST", async (mode) => {
    const dataDirectory = await directory(), library = new AssetLibrary(dataDirectory); await library.load();
    const reference = await library.add("reference.png", imageResult.bytes);
    const input: RunVideoToolRequest = { ...videoInput, aspectRatio: "adaptive", referenceMode: mode, references: [{ type: "image", assetId: reference.id }] };
    const initial = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_legacy_adaptive" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/adaptive.mp4" } })).mockResolvedValueOnce(mp4());
    // Reproduce the old validator failure after the adapter returned the binary.
    const rejectLegacy = vi.spyOn(library, "add").mockRejectedValueOnce(new AssetLibraryError("Invalid public generation parameter", 400));
    const original = await runner(dataDirectory, videoGenerator(initial), undefined, imageGenerator, library);
    const first = original.start("generate-video", input, { context: { projectId: "fixture", nodeId: "adaptive-video" } });
    await vi.waitFor(() => expect(original.jobs()[0]).toMatchObject({ status: "failed", error: "Invalid public generation parameter" }));
    rejectLegacy.mockRestore(); await original.close();
    expect(initial).toHaveBeenCalledTimes(3);
    const resumed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/adaptive.mp4" } })).mockResolvedValueOnce(mp4());
    const restoredLibrary = new AssetLibrary(dataDirectory); await restoredLibrary.load();
    const reopened = await runner(dataDirectory, videoGenerator(resumed), undefined, imageGenerator, restoredLibrary);
    const recovery = await reopened.retryJob(first.id);
    expect(recovery.videoRecoveryOnly).toBe(true);
    await expect(reopened.retryJob(first.id)).rejects.toMatchObject({ statusCode: 404 });
    await vi.waitFor(() => expect(reopened.jobs()[0]?.status).toBe("succeeded"));
    expect(initial.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(resumed.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    const outputId = reopened.jobs()[0]!.run!.files[0]!.assetId!;
    expect(restoredLibrary.get(outputId)?.generation?.parameters).toMatchObject({ aspectRatio: "adaptive", referenceMode: mode, referenceCount: 1 });
    expect(await readFile((await restoredLibrary.content(outputId)).absolutePath)).toEqual(Buffer.from(await mp4().arrayBuffer()));
    expect(JSON.stringify(reopened.jobs())).not.toContain(fakeKey);
  });

  it("does not retry paid audio when the binary arrived but local saving failed", async () => {
    const dataDirectory = await directory();
    const generate = vi.fn<AudioGenerator["generate"]>().mockResolvedValue({ bytes: Buffer.from("ID3"), mediaType: "audio/mpeg", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" } });
    const audio: AudioGenerator = { catalog: () => ({ models: [], providers: [] }), generate };
    const library = { add: vi.fn().mockRejectedValue(new Error("simulated local save failure")) } as unknown as AssetLibrary;
    const original = new ToolRunner(dataDirectory, imageGenerator, undefined, undefined, library, undefined, audio);
    runners.push(original); await original.load();
    const first = original.start("generate-sound-effect", { prompt: "A bell" });
    await vi.waitFor(() => expect(original.jobs()[0]).toMatchObject({ status: "failed", submissionOutcome: "unknown" }));
    await expect(original.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    await original.close();
    const reopened = await runner(dataDirectory, undefined, audio);
    await expect(reopened.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(generate).toHaveBeenCalledOnce();
  });
  it("coalesces a same-node double click and rejects an incompatible in-flight change", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>(async () => { await waiting; return imageResult; });
    const tools = await runner(await directory(), undefined, undefined, { generate });
    const input = { prompt: "One image", imageModel: { provider: "openai", id: "gpt-image-2.5-sunburst" } };
    const metadata = { context: { projectId: "test-project", boardId: "test-board", nodeId: "same-node" } };
    const first = tools.start("generate-image", input, metadata);
    const duplicate = tools.start("generate-image", input, metadata);
    expect(duplicate.id).toBe(first.id);
    expect(() => tools.start("generate-image", { ...input, prompt: "Changed while running" }, metadata)).toThrowError("This node already has a generation in progress");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    finish();
    await vi.waitFor(() => expect(tools.jobs()[0]?.status).toBe("succeeded"));
    expect(tools.jobs()).toHaveLength(1);
  });

  it("allows different nodes to generate concurrently without merging their choices", async () => {
    const pending: (() => void)[] = [];
    const generate = vi.fn<ImageGenerator["generate"]>(() => new Promise((resolve) => { pending.push(() => resolve(imageResult)); }));
    const tools = await runner(await directory(), undefined, undefined, { generate });
    const first = tools.start("generate-image", { prompt: "First", imageModel: { provider: "openai", id: "gpt-image-2.5-sunburst" } }, { context: { projectId: "project", nodeId: "first" } });
    const second = tools.start("generate-image", { prompt: "Second", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" } }, { context: { projectId: "project", nodeId: "second" } });
    expect(second.id).not.toBe(first.id);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending.forEach((complete) => complete());
    await vi.waitFor(() => expect(tools.jobs().every((job) => job.status === "succeeded")).toBe(true));
    expect(tools.jobs().map((job) => job.model?.id).sort()).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
  });

  it("persists the actual video protocol, model, parameters and task ID without the daemon key", async () => {
    const dataDirectory = await directory();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_provenance" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/movie.mp4" } })).mockResolvedValueOnce(mp4());
    const tools = await runner(dataDirectory, videoGenerator(request));
    const run = await tools.run("generate-video", videoInput);
    expect(run.model).toEqual(videoInput.model);
    expect(run.generation).toMatchObject({ model: videoModel.id, protocol: "seedance", taskId: "task_provenance", parameters: { duration: 5, resolution: "720p", aspectRatio: "16:9", referenceMode: "reference" } });
    const stored = JSON.parse(await readFile(path.join(dataDirectory, "tools", "runs", run.id, "run.json"), "utf8"));
    expect(stored.generation).toEqual(run.generation);
    expect(JSON.stringify(run)).not.toContain(fakeKey);
    expect(JSON.stringify(stored)).not.toContain(fakeKey);
    expect(JSON.stringify(stored.generation)).not.toContain(videoInput.prompt);
  });

  it("resumes a submitted video after close/reopen by GET with no second paid POST", async () => {
    const dataDirectory = await directory();
    let polling = false;
    const initial = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ id: "task_reopen" });
      polling = true;
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const original = await runner(dataDirectory, videoGenerator(initial));
    const first = original.start("generate-video", videoInput, { context: { projectId: "project", nodeId: "video-node" } });
    await vi.waitFor(() => expect(polling).toBe(true));
    await original.close();
    expect(original.jobs()[0]?.status).toBe("cancelled");
    const resumedRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/reopened.mp4" } })).mockResolvedValueOnce(mp4());
    const reopened = await runner(dataDirectory, videoGenerator(resumedRequest));
    expect(reopened.jobs()[0]?.id).toBe(first.id);
    const retried = await reopened.retryJob(first.id);
    await vi.waitFor(() => expect(reopened.jobs().find((job) => job.id === retried.id)?.status).toBe("succeeded"));
    expect(String(resumedRequest.mock.calls[0]?.[0]).endsWith("/tasks/task_reopen")).toBe(true);
    expect(resumedRequest.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(initial.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const journalFiles = await readdir(path.join(dataDirectory, "tools", "video-tasks"));
    expect(journalFiles).toHaveLength(1);
    expect(await readFile(path.join(dataDirectory, "tools", "video-tasks", journalFiles[0]!), "utf8")).not.toContain(fakeKey);
  });

  it.each([false, true])("preserves an uncertain synchronous audio outcome across restart and refuses retry with 409 (legacy standalone: %s)", async legacyStandalone => {
    const dataDirectory = await directory();
    const audioRequest = vi.fn<typeof fetch>().mockRejectedValue(new Error("simulated audio response loss"));
    const audio = new ProviderAudio([new VolcengineSeedAudioProvider(() => fakeKey, audioRequest, "http://127.0.0.1:43199/v1/audio/speech")]);
    const original = await runner(dataDirectory, undefined, audio);
    const warn = vi.fn(); original.setLogger({ info: vi.fn(), warn });
    const first = original.start("generate-sound-effect", { prompt: "A short bell", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" } }, { context: { projectId: "project", nodeId: "audio-node" } });
    await vi.waitFor(() => expect(original.jobs()[0]?.status).toBe("failed"));
    expect(original.jobs()[0]?.submissionOutcome).toBe("unknown");
    const diagnostic = original.jobs()[0]?.audioDiagnostic;
    expect(diagnostic).toMatchObject({ phase: "request", category: "unknown", requestBytes: expect.any(Number), elapsedMs: expect.any(Number) });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ audioDiagnostic: diagnostic }), "Generation failed");
    for (const privateValue of [fakeKey, "A short bell", "simulated audio response loss", "audio_data"]) expect(JSON.stringify(warn.mock.calls)).not.toContain(privateValue);
    await expect(original.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    await original.close();
    if (legacyStandalone) {
      const history = path.join(dataDirectory, "tools", "jobs.json");
      const jobs = JSON.parse(await readFile(history, "utf8"));
      delete jobs[0].context;
      delete jobs[0].metadata.context;
      delete jobs[0].submissionOutcome;
      await writeFile(history, JSON.stringify(jobs));
    }
    const reopened = await runner(dataDirectory, undefined, audio);
    expect(reopened.jobs()[0]?.submissionOutcome).toBe("unknown");
    expect(reopened.jobs()[0]?.audioDiagnostic).toEqual(diagnostic);
    await expect(reopened.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(audioRequest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reopened.jobs())).not.toContain(fakeKey);
  });

  it.each([200, 500, 502])("does not repeat synchronous audio after HTTP %s with no usable result", async (status) => {
    const dataDirectory = await directory();
    const audioRequest = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(status === 502 ? { error: { code: "bad_response_status_code", type: "invalid_parameter", message: "private upstream text" } } : { unexpected: "no usable audio" }, { status }));
    const audio = new ProviderAudio([new VolcengineSeedAudioProvider(() => fakeKey, audioRequest, "http://127.0.0.1:43199/v1/audio/speech")]);
    const original = await runner(dataDirectory, undefined, audio);
    const first = original.start("generate-sound-effect", { prompt: "A short bell", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" } });
    await vi.waitFor(() => expect(original.jobs()[0]?.status).toBe("failed"));
    expect(original.jobs()[0]?.submissionOutcome).toBe("unknown");
    if (status === 502) expect(original.jobs()[0]?.audioDiagnostic).toMatchObject({ httpStatus: 502, providerCode: "invalid-request" });
    await expect(original.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    await original.close();
    const reopened = await runner(dataDirectory, undefined, audio);
    expect(reopened.jobs()[0]?.submissionOutcome).toBe("unknown");
    await expect(reopened.retryJob(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(audioRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses to replay an uncertain synchronous image POST after restart", async () => {
    const dataDirectory = await directory();
    const lostRequest = vi.fn<typeof fetch>().mockRejectedValue(new Error("simulated response loss"));
    const original = await runner(dataDirectory, undefined, undefined, kunpoImages(lostRequest));
    const first = original.start("generate-image", { prompt: "Uncertain image", imageModel: { provider: "openai", id: "gpt-image-2.5-sunburst" } });
    await vi.waitFor(() => expect(original.jobs()[0]?.status).toBe("failed"));
    await original.close();
    const retryRequest = vi.fn<typeof fetch>();
    const reopened = await runner(dataDirectory, undefined, undefined, kunpoImages(retryRequest));
    const retry = await reopened.retryJob(first.id);
    await vi.waitFor(() => expect(reopened.jobs().find((job) => job.id === retry.id)?.status).toBe("failed"));
    expect(reopened.jobs().find((job) => job.id === retry.id)?.error).toContain("will not submit another paid request");
    expect(lostRequest).toHaveBeenCalledTimes(1);
    expect(retryRequest).not.toHaveBeenCalled();
  });

  it.each([2, 3] as const)("retains a partial %i-image batch across restart and downloads only known missing results", async (outputs) => {
    const dataDirectory = await directory();
    const url = "http://127.0.0.1:43199/cached.png";
    let posts = 0;
    const firstRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method !== "POST") throw new Error("Artifact temporarily unavailable");
      switch (++posts) {
        case 1: return Response.json({ data: [{ b64_json: imageResult.bytes.toString("base64") }] });
        case 2: return Response.json({ data: [{ url }] });
        default: throw new Error("Submission response lost");
      }
    });
    const original = await runner(dataDirectory, undefined, undefined, kunpoImages(firstRequest));
    const first = original.start("generate-image", { prompt: "Three forest assets", resolution: "1K", aspectRatio: "1:1", outputs, imageModel: { provider: "openai", id: "gpt-image-2.5-sunburst" } });
    await vi.waitFor(() => expect(original.jobs()[0]?.status).toBe("failed"));
    const partial = original.jobs()[0]!.run!;
    expect(posts).toBe(outputs);
    expect(partial.files).toHaveLength(1);
    expect((await original.file(partial.id, partial.files[0]!.name))?.bytes).toEqual(imageResult.bytes);
    await original.close();
    const retriever = vi.fn<typeof fetch>().mockImplementation(async () => new Response(imageResult.bytes, { headers: { "content-type": "image/png" } }));
    const reopened = await runner(dataDirectory, undefined, undefined, kunpoImages(retriever));
    const retry = await reopened.retryJob(first.id);
    await vi.waitFor(() => expect(reopened.jobs()[0]?.status).toBe(outputs === 2 ? "succeeded" : "failed"));
    const recovered = reopened.jobs()[0]!.run!;
    expect(recovered.id).toBe(partial.id);
    expect(recovered.files).toHaveLength(2);
    expect(recovered.files).toContainEqual(partial.files[0]);
    for (const file of recovered.files) expect((await reopened.file(recovered.id, file.name))?.bytes).toEqual(imageResult.bytes);
    expect(retriever.mock.calls.map(([input, init]) => [input, init?.method])).toEqual([[url, "GET"]]);
    if (outputs === 3) {
      await reopened.retryJob(retry.id);
      await vi.waitFor(() => expect(reopened.jobs()[0]?.status).toBe("failed"));
      expect(reopened.jobs()[0]?.run).toEqual(recovered);
      expect(retriever).toHaveBeenCalledOnce();
    }
  });

  it("recovers a known synchronous image URL by download without another generation POST", async () => {
    const dataDirectory = await directory();
    const firstRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ url: "http://127.0.0.1:43199/cached.png" }] }))
      .mockRejectedValueOnce(new Error("simulated artifact download loss"));
    const original = await runner(dataDirectory, undefined, undefined, kunpoImages(firstRequest));
    const first = original.start("generate-image", { prompt: "Download recovery", imageModel: { provider: "openai", id: "gpt-image-2.5-sunburst" } });
    await vi.waitFor(() => expect(original.jobs()[0]?.status).toBe("failed"));
    await original.close();
    const retryRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(imageResult.bytes, { headers: { "content-type": "image/png" } }));
    const reopened = await runner(dataDirectory, undefined, undefined, kunpoImages(retryRequest));
    const retry = await reopened.retryJob(first.id);
    await vi.waitFor(() => expect(reopened.jobs().find((job) => job.id === retry.id)?.status).toBe("succeeded"));
    expect(firstRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(retryRequest).toHaveBeenCalledTimes(1);
    expect(retryRequest.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43199/cached.png");
    expect(retryRequest.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(retryRequest.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
});
