import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { promptContextBlock } from "../src/daemon/prompt-context.js";
import { referenceWav } from "./audio-reference-fixture.js";
import { TEST_GLB } from "./model3d-fixture.js";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { AgentAttachmentStore } from "../src/daemon/agent-attachments.js";
import { CanvasStore, readCanvasDocument, canvasReferencesAsset, removeCanvasAssetReferences } from "../src/daemon/canvas-workspace.js";
import { exportProjectArchive, importProjectArchive } from "../src/daemon/project-archive.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { Model3DGenerationError } from "../src/daemon/model3d.js";
import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { checkCanvasWorkspace } from "../src/daemon/canvas-check.js";
import { canvasCandidatePaths, ensureCanvasAssets, readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { AutoContinueTools, type RecoverableTool } from "../src/daemon/agent-auto-continue.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { closeRuntimeMediaSnapshots, projectFiles, type RuntimeMedia } from "../src/daemon/isolated-project-files.js";
import { ImageGenerationError, type ImageGenerator } from "../src/daemon/openai-image.js";
import { validateGeneratedImage } from "../src/daemon/generated-image-format.js";
import { SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCanvasDocument, canvasDocumentPath, mergeCanvasDocumentContent } from "../src/shared/canvas-document.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { fitCanvasLayout, mergeCanvasDocument } from "../src/shared/canvas-workspace.js";
import { isCanvasDocument } from "../src/shared/canvas-document-schema.js";
import type { AssetCanvasNode, ProjectType, ToolRun, RunToolRequest } from "../src/shared/contracts.js";
import { ProviderAudio } from "../src/daemon/audio-generation.js";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";
import { model3DFixture } from "./model3d-fixture.js";
import { tripoActions } from "../src/shared/model3d-operations.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

const directories: string[] = [], stores: CanvasStore[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await closeRuntimeMediaSnapshots();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temp() { const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-design-")); directories.push(directory); return directory; }
const fixturePng = await sharp({ create: { width: 8, height: 8, channels: 3, background: "gold" } }).png().toBuffer();
const fakeGenerator: ImageGenerator = { generate: async () => ({ bytes: fixturePng, mediaType: "image/png" }) };
async function runtime(generator: ImageGenerator = fakeGenerator, projectType: ProjectType = "web-game", resolveInput?: ConstructorParameters<typeof ToolRunner>[5], audioGenerator?: ConstructorParameters<typeof ToolRunner>[6], modelGenerator?: ConstructorParameters<typeof ToolRunner>[2]) {
  const directory = await temp(), library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
  const tools = new ToolRunner(directory, generator, modelGenerator, undefined, library, resolveInput, audioGenerator);
  await Promise.all([library.load(), projects.load(), tools.load()]);
  const project = await projects.create("Sky garden", projectType), store = new CanvasStore(projects, library, tools);
  stores.push(store);
  const workspace = await store.workspace(project.id), boardId = workspace.boards[0]!.id;
  const detail = await store.board(project.id, boardId), node = createAssetGenerationNode("image", { x: 96, y: 96 });
  if (node.type === "image") node.data.prompt = "A gardener";
  detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
  await store.saveBoard(project.id, detail.board, detail.revision);
  return { directory, library, projects, tools, project, store, boardId, node };
}
async function waitForJob(store: CanvasStore, projectId: string) {
  await expect.poll(async () => (await store.jobs(projectId))[0]?.status, { timeout: 5000 }).not.toBe("running");
  return (await store.jobs(projectId))[0]!;
}
async function canvasCopyFixture(profile?: ConstructorParameters<typeof ProjectManager>[3]) {
  const directory = await temp(), projects = new ProjectManager(directory, undefined, [], profile);
  await projects.load();
  const project = await projects.create("Canvas copy");
  const source = path.join(project.workspacePath, "assets/canvas/clip.mp4");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, Buffer.from("000000186674797069736f6d", "hex"));
  await mkdir(path.join(project.workspacePath, "canvas"), { recursive: true });
  await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { clip: { canvasOnly: true, name: "clip.mp4", path: "assets/canvas/clip.mp4" } } }));
  return { directory, projects, project, source };
}
async function sparseMedia(filename: string, size: number) {
  await mkdir(path.dirname(filename), { recursive: true });
  const file = await open(filename, "w", 0o600);
  try { await file.write(Buffer.from("000000186674797069736f6d", "hex")); await file.truncate(size); }
  finally { await file.close(); }
}
describe("Canvas runtime copy admission", () => {
  it.each(["svg", "gif"] as const)("preserves a generated %s through Agent delivery, Canvas, game use and download after reopen", async format => {
    const mediaType = format === "svg" ? "image/svg+xml" : "image/gif";
    const bytes = format === "svg"
      ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><text x="1" y="16" font-size="12">Game</text></svg>')
      : await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [240, 240], loop: 0 }).toBuffer();
    const model = { id: "gpt-image-2.6-flare", provider: "kunpo" };
    const parameters: Record<string, string | number | boolean> = { output_format: format, complexity: "high", markedUp: false,
      ...(format === "svg" ? { svgModel: "gpt-6-sol", svgReasoningEffort: "low" } : { frame_count: 2, frame_duration_ms: 237 }) };
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({ bytes, mediaType, generation: { model: model.id, protocol: "openai-images", parameters } });
    const { directory, project, projects, tools, store, library } = await runtime({ generate });
    const input = { imageModel: model, prompt: "Game art", outputFormat: format, ...(format === "gif" ? { frameCount: 2, frameDurationMs: 237 } : {}) };
    await validateGeneratedImage(bytes, format, input);
    if (format === "gif") {
      await expect(validateGeneratedImage(bytes, format, { frameCount: 3 })).rejects.toThrow("frame count");
      await expect(validateGeneratedImage(bytes, format, { frameDurationMs: 120 })).rejects.toThrow("frame times");
    }
    const direct = createAgentTools(project, tools, projects).find(tool => tool.name === "generate_image")!;
    const delivered = await direct.execute("local", input, undefined, undefined, {} as never);
    const artifact = (delivered.details as { artifact: { path: string; mediaType: string } }).artifact;
    expect(artifact.path).toMatch(new RegExp(`\\.${format}$`));
    expect(artifact.mediaType).toBe(mediaType);
    expect(await readFile(path.join(project.workspacePath, artifact.path))).toEqual(bytes);
    const canvasTool = createAgentTools(project, tools, projects, undefined, undefined, store, "canvas").find(tool => tool.name === "generate_image")!;
    const result = await canvasTool.execute("canvas", input, undefined, undefined, {} as never);
    const job = (result.details as { canvasGeneration: { run: ToolRun } }).canvasGeneration;
    const file = job.run.files[0]!;
    expect(file).toMatchObject({ name: `output.${format}`, mediaType });
    const asset = (await readCanvasAssets(project.workspacePath)).assets[file.assetId!]!;
    expect(asset.canvasOnly).toBe(true);
    expect(await readFile(path.join(project.workspacePath, asset.path))).toEqual(bytes);
    const dest = `public/game-art.${format}`;
    await projects.useCanvasAsset(project.id, file.assetId!, dest);
    expect(await readFile(path.join(project.workspacePath, dest))).toEqual(bytes);
    const media: RuntimeMedia[] = [];
    const source = await projectFiles(project.workspacePath, media);
    const transferred = [...source, ...media].map(item => item.path);
    expect(transferred).not.toContain(asset.path); expect(transferred).toContain(dest);
    if (format === "svg") {
      await writeFile(path.join(project.workspacePath, asset.path), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><script/></svg>');
      await expect(projects.useCanvasAsset(project.id, file.assetId!, "public/changed.svg")).rejects.toThrow("verified self-contained static SVG");
      await expect(lstat(path.join(project.workspacePath, "public/changed.svg"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await store.close(); await tools.close(); await library.close();
    const app = createApp({ dataDirectory: directory, imageGenerator: { generate } }); apps.push(app);
    const download = await app.inject({ url: `/library/assets/${file.assetId}/content` });
    expect(download.statusCode).toBe(200); expect(download.headers["content-type"]).toContain(mediaType);
    if (format === "svg") expect(download.headers["content-security-policy"]).toContain("sandbox");
    expect(download.rawPayload).toEqual(bytes);
    const reopened = new AssetLibrary(directory); await reopened.load();
    try { expect(reopened.get(file.assetId!)).toMatchObject({ name: file.name, generation: { parameters }, ...(format === "svg" ? { width: 64, height: 32 } : { width: 1, height: 1 }) }); }
    finally { await reopened.close(); }
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects media above 32 MiB before allocating a copy or touching project metadata", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    await sparseMedia(source, 32 * 1024 * 1024 + 1);
    const before = project.updatedAt, touch = vi.spyOn(projects, "touch");
    const error = await projects.useCanvasAsset(project.id, "clip", "public/media/clip.mp4").catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(getToolPreflightFailure(error)).toEqual({ effect: "none", reason: "runtime_media_budget", disposition: "correctable" });
    expect(touch).not.toHaveBeenCalled(); expect(project.updatedAt).toBe(before);
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(source)).size).toBe(32 * 1024 * 1024 + 1);
  });
  it("accepts the exact per-file/legacy-total boundary and does not double-count or rewrite an identical target", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    await sparseMedia(source, 32 * 1024 * 1024);
    await sparseMedia(path.join(project.workspacePath, "public/previous.mp4"), 32 * 1024 * 1024);
    const target = "public/media/clip.mp4";
    await projects.useCanvasAsset(project.id, "clip", target);
    const before = await lstat(path.join(project.workspacePath, target)), touch = vi.spyOn(projects, "touch");
    await projects.useCanvasAsset(project.id, "clip", target);
    const after = await lstat(path.join(project.workspacePath, target));
    expect({ ino: after.ino, size: after.size, mtime: after.mtimeMs }).toEqual({ ino: before.ino, size: before.size, mtime: before.mtimeMs });
    expect(touch).not.toHaveBeenCalled();
    expect((await readFile(path.join(project.workspacePath, target))).equals(await readFile(source))).toBe(true);
  });
  it.each([false, true])("checks the entire eligible media set using a trusted medium profile only when available (%s)", async medium => {
    const { projects, project, source } = await canvasCopyFixture(medium ? async () => "capacity-128-v2" : undefined);
    await sparseMedia(path.join(project.workspacePath, "public/first.mp4"), 32 * 1024 * 1024);
    await sparseMedia(path.join(project.workspacePath, "public/second.mp4"), 32 * 1024 * 1024);
    const original = await readFile(source), target = "public/new/clip.mp4", touch = vi.spyOn(projects, "touch");
    if (medium) {
      expect(await projects.useCanvasAsset(project.id, "clip", target)).toBe(target);
      expect(await readFile(path.join(project.workspacePath, target))).toEqual(original);
      expect(touch).toHaveBeenCalledOnce();
    } else {
      const error = await projects.useCanvasAsset(project.id, "clip", target).catch(error => error);
      expect(error.message).toContain("legacy lower-bound"); expect(error.message).toContain("actual isolated profile is unverified");
      expect(error.message).toContain("storage/capacity diagnostic"); expect(error.message).not.toContain("128 MiB");
      expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
      expect(touch).not.toHaveBeenCalled();
      await expect(lstat(path.join(project.workspacePath, "public/new"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(source)).toEqual(original);
  });
  it.each(["per-file source", "aggregate source", "file count"] as const)("does not bypass the complete %s budget", async kind => {
    const { projects, project } = await canvasCopyFixture();
    if (kind === "per-file source") await writeFile(path.join(project.workspacePath, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
    else if (kind === "aggregate source") for (let index = 0; index < 5; index++) await writeFile(path.join(project.workspacePath, `${index}.txt`), Buffer.alloc(2 * 1024 * 1024));
    else for (let index = 0; index < 2000; index++) await writeFile(path.join(project.workspacePath, `${index}.txt`), "");
    const error = await projects.useCanvasAsset(project.id, "clip", "public/new.mp4").catch(error => error);
    expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("leaves an incomplete inventory unknown without branding it as a correctable budget refusal", async () => {
    const { projects, project } = await canvasCopyFixture();
    for (let index = 0; index < 4001; index++) await writeFile(path.join(project.workspacePath, `.ignored-${index}`), "");
    const error = await projects.useCanvasAsset(project.id, "clip", "public/new.mp4").catch(error => error);
    expect(error.message).toContain("inventory is incomplete"); expect(getToolPreflightFailure(error)).toBeUndefined();
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses the startup directory without overlooking media elsewhere in the eligible workspace", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    project.startupDirectory = "game";
    await sparseMedia(path.join(project.workspacePath, "public/first.mp4"), 32 * 1024 * 1024);
    await sparseMedia(path.join(project.workspacePath, "src/second.mp4"), 32 * 1024 * 1024);
    const error = await projects.useCanvasAsset(project.id, "clip", "game/public/clip.mp4").catch(error => error);
    expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
    await expect(lstat(path.join(project.workspacePath, "game"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path.join(project.workspacePath, "public/first.mp4"));
    expect(await projects.useCanvasAsset(project.id, "clip", "game/public/clip.mp4")).toBe("game/public/clip.mp4");
    expect(await readFile(path.join(project.workspacePath, "game/public/clip.mp4"))).toEqual(await readFile(source));
  });
  it("rejects a conflicting destination before creating a temporary file or touching metadata", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    const target = path.join(project.workspacePath, "public/clip.mp4"); await mkdir(path.dirname(target)); await writeFile(target, "user original");
    const write = vi.spyOn(filesystem, "writeFile"), touch = vi.spyOn(projects, "touch");
    try {
      const error = await projects.useCanvasAsset(project.id, "clip", "public/clip.mp4").catch(error => error);
      expect(error.message).toContain("already exists"); expect(getToolPreflightFailure(error)).toBeUndefined();
      expect(write).not.toHaveBeenCalled(); expect(touch).not.toHaveBeenCalled();
      expect(await readFile(target, "utf8")).toBe("user original"); expect((await lstat(source)).size).toBe(12);
    } finally { write.mockRestore(); }
  });
  it.each(["format", "link", "unknown profile"] as const)("does not turn a %s failure into a trusted no-effect budget receipt", async kind => {
    const { projects, project, source } = await canvasCopyFixture(kind === "unknown profile" ? async () => "capacity-256-v1" as never : undefined);
    if (kind === "format") await writeFile(source, "not a media header");
    if (kind === "link") { await rm(source); await symlink("../../canvas/assets.json", source); }
    const error = await projects.useCanvasAsset(project.id, "clip", "public/new.mp4").catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(getToolPreflightFailure(error)).toBeUndefined();
    expect(getToolPreflightFailure({ effect: "none", reason: "runtime_media_budget", disposition: "correctable" })).toBeUndefined();
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks cancellation after waiting for the project copy queue and after profile inspection", async () => {
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const { projects, project } = await canvasCopyFixture(async () => { if (++calls === 1) { reached(); await gate; } return undefined; });
    const first = projects.useCanvasAsset(project.id, "clip", "public/first.mp4"); await entered;
    const abort = new AbortController(), second = projects.useCanvasAsset(project.id, "clip", "public/second.mp4", false, abort.signal).catch(error => error);
    abort.abort(); release(); await first;
    expect((await second).name).toBe("AbortError"); expect(calls).toBe(1);
    await expect(lstat(path.join(project.workspacePath, "public/second.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    const cancelled = new AbortController();
    const extra = await canvasCopyFixture(async () => { cancelled.abort(); return undefined; });
    const error = await extra.projects.useCanvasAsset(extra.project.id, "clip", "public/new.mp4", false, cancelled.signal).catch(error => error);
    expect(error.name).toBe("AbortError"); expect(getToolPreflightFailure(error)).toBeUndefined();
    await expect(lstat(path.join(extra.project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["partial write", "cancel write", "destination race"] as const)("retains the source and never brands %s after writing starts as not executed", async kind => {
    const { projects, project, source } = await canvasCopyFixture(), original = await readFile(source);
    const abort = new AbortController(), target = path.join(project.workspacePath, "public/clip.mp4"), originalOpen = filesystem.open;
    const touch = vi.spyOn(projects, "touch");
    const write = vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes("/.adopt-") && path.basename(String(args[0])) === "payload") {
        const originalWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async data => {
          await originalWrite(kind === "partial write" ? original.subarray(0, 4) : data);
          if (kind === "partial write") throw Object.assign(new Error("Injected partial write"), { code: "ENOSPC" });
          if (kind === "cancel write") abort.abort();
          if (kind === "destination race") await writeFile(target, "concurrent user file", { flag: "wx" });
        });
      }
      return handle;
    });
    try {
      const error = await projects.useCanvasAsset(project.id, "clip", "public/clip.mp4", false, abort.signal).catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(getToolPreflightFailure(error)).toBeUndefined(); expect(touch).not.toHaveBeenCalled();
      expect(await readFile(source)).toEqual(original); expect((await readdir(path.dirname(target))).filter(file => file.startsWith(".adopt-"))).toEqual([]);
      if (kind === "destination race") expect(await readFile(target, "utf8")).toBe("concurrent user file");
      else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { write.mockRestore(); }
  });
  it("detects a same-inode staging mutation after writing and preserves the uncertain published target", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    const original = await readFile(source), changed = Buffer.from(original); changed[11] ^= 1;
    const originalLink = filesystem.link, touch = vi.spyOn(projects, "touch");
    const publish = vi.spyOn(filesystem, "link").mockImplementation(async (existing, target) => {
      if (String(existing).includes("/.adopt-") && path.basename(String(existing)) === "payload") await writeFile(existing, changed);
      return originalLink(existing, target);
    });
    try {
      const error = await projects.useCanvasAsset(project.id, "clip", "public/clip.mp4").catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(getToolPreflightFailure(error)).toBeUndefined(); expect(touch).not.toHaveBeenCalled();
      expect(await readFile(source)).toEqual(original);
      expect(await readFile(path.join(project.workspacePath, "public/clip.mp4"))).toEqual(changed);
      expect((await readdir(path.join(project.workspacePath, "public"))).filter(file => file.startsWith(".adopt-"))).toEqual([]);
    } finally { publish.mockRestore(); }
  });
  it.each(["capacity-128-v2", "capacity-128-media64-v3"] as const)("keeps the format limit bound to the trusted %s volume", async profile => {
    const { projects, project, source } = await canvasCopyFixture(async () => profile);
    await sparseMedia(source, 64 * 1024 * 1024);
    const touch = vi.spyOn(projects, "touch"), target = "public/large.mp4";
    if (profile === "capacity-128-v2") {
      const error = await projects.useCanvasAsset(project.id, "clip", target).catch(error => error);
      expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
      expect(touch).not.toHaveBeenCalled();
      await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await projects.useCanvasAsset(project.id, "clip", target)).toBe(target);
      const info = await lstat(path.join(project.workspacePath, target));
      expect(info.size).toBe(64 * 1024 * 1024); expect(touch).toHaveBeenCalledOnce();
      touch.mockClear();
      await projects.useCanvasAsset(project.id, "clip", target);
      expect(touch).not.toHaveBeenCalled();
      expect((await lstat(path.join(project.workspacePath, target))).ino).toBe(info.ino);
      await sparseMedia(source, 64 * 1024 * 1024 + 1);
      const error = await projects.useCanvasAsset(project.id, "clip", "public/above.mp4").catch(error => error);
      expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
      await expect(lstat(path.join(project.workspacePath, "public/above.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("does not grant raster64 admission from the new AV/GLB profile", async () => {
    const { projects, project, source } = await canvasCopyFixture(async () => "capacity-128-media64-v3");
    const raster = source.replace(/mp4$/, "png"); await sparseMedia(raster, 32 * 1024 * 1024 + 1);
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { clip: { canvasOnly: true, name: "large.png", path: "assets/canvas/clip.png" } } }));
    const error = await projects.useCanvasAsset(project.id, "clip", "public/large.png").catch(error => error);
    expect(getToolPreflightFailure(error)?.reason).toBe("runtime_media_budget");
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes concurrent copies so they cannot each spend the same remaining media budget", async () => {
    const { projects, project, source } = await canvasCopyFixture();
    await sparseMedia(source, 20 * 1024 * 1024);
    await sparseMedia(path.join(project.workspacePath, "public/previous.mp4"), 32 * 1024 * 1024);
    const results = await Promise.allSettled([projects.useCanvasAsset(project.id, "clip", "public/first.mp4"), projects.useCanvasAsset(project.id, "clip", "public/second.mp4")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(getToolPreflightFailure((results[1] as PromiseRejectedResult).reason)?.reason).toBe("runtime_media_budget");
    expect((await lstat(path.join(project.workspacePath, "public/first.mp4"))).size).toBe(20 * 1024 * 1024);
    await expect(lstat(path.join(project.workspacePath, "public/second.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the failed call receipt while allowing a corrected new call and reports copying without promising runtime readiness", async () => {
    const { projects, project, tools, store } = await runtime();
    const source = path.join(project.workspacePath, "assets/canvas/clip.mp4");
    await sparseMedia(source, 32 * 1024 * 1024 + 1);
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { clip: { canvasOnly: true, name: "clip.mp4", path: "assets/canvas/clip.mp4" } } }));
    const original = createAgentTools(project, tools, projects, undefined, undefined, store).find(tool => tool.name === "use_canvas_asset")!;
    const guard = new AutoContinueTools([original]), tool = guard.wrap()[0]!, copy = vi.spyOn(projects, "useCanvasAsset");
    const args = { assetId: "clip", destination: "public/clip.mp4" }, signal = new AbortController().signal;
    const failure = await tool.execute("over-limit", args, signal, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("runtime_media_budget");
    expect(copy).toHaveBeenLastCalledWith(project.id, "clip", args.destination, undefined, signal);
    await guard.prepare(signal, vi.fn());
    expect(guard.recoverySummary).toContain("not_executed (runtime_media_budget)");
    await writeFile(source, Buffer.from("000000186674797069736f6d", "hex"));
    const repeated = await tool.execute("over-limit", args, signal, undefined, {} as never).catch(error => error);
    expect(repeated).toBe(failure); expect(copy).toHaveBeenCalledOnce();
    const result = await tool.execute("corrected-new-call", args, signal, undefined, {} as never);
    expect(copy).toHaveBeenCalledTimes(2); expect(result.details).toEqual({ assetId: "clip", path: args.destination });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    expect(text).toContain("copied at public/clip.mp4"); expect(text).toContain("validate actual resources with build/preview");
    expect(text).not.toMatch(/Game asset ready|build ready|build-ready/i);
    expect(await readFile(path.join(project.workspacePath, args.destination))).toEqual(await readFile(source));
  });
  it("does not classify permission failures as a correctable budget rejection", async () => {
    const { projects, project, source } = await canvasCopyFixture(), originalStat = filesystem.lstat;
    const canonicalSource = await filesystem.realpath(source);
    const stat = vi.spyOn(filesystem, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === canonicalSource) throw Object.assign(new Error("Injected source permission refusal"), { code: "EACCES" });
      return originalStat(...args as Parameters<typeof originalStat>);
    });
    try {
      const error = await projects.useCanvasAsset(project.id, "clip", "public/clip.mp4").catch(error => error);
      expect(error.code).toBe("EACCES"); expect(getToolPreflightFailure(error)).toBeUndefined();
      await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { stat.mockRestore(); }
  });
});
// Store-only tests mock the generator. Give recovery an explicit saved-result
// capability; real fingerprint replay and the no-POST boundary are tested in app integration.
async function savedResultFixture(directory: string, workspace: string, jobId: string, video = false) {
  const jobs = JSON.parse(await readFile(path.join(workspace, "canvas/jobs.json"), "utf8"));
  const job = jobs.find((candidate: { id: string }) => candidate.id === jobId);
  const target = path.join(directory, "tools", video ? "video-tasks" : "image-requests");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entry = video ? { generate: { fingerprint: "a".repeat(64), task: { taskId: "task_store_fixture" } } }
    : { version: 1, fingerprint: "a".repeat(64), state: "ready", result: { url: "http://127.0.0.1:43199/saved.png", generation: { model: "saved-image", protocol: "openai-images", parameters: {} } } };
  await writeFile(path.join(target, `${job.recoveryId ?? job.id}${video ? "" : "-0"}.json`), JSON.stringify(entry), { mode: 0o600 });
}
describe("Markdown design workspace", () => {
  it("recovers only a receipt-bound Canvas job after interrupted delivery and refuses a missing original ID", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, tools, projects, project, boardId, node } = await runtime({ generate });
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store, "continue-test");
    const original = registered.find(tool => tool.name === "generate_canvas_media")! as RecoverableTool;
    const deliver = original.execute;
    const interrupted = { ...original, execute: vi.fn<typeof deliver>(async (...args) => { await deliver(...args); throw new Error("Interrupted after completed generation"); }) };
    const guard = new AutoContinueTools(registered.map(tool => tool === original ? interrupted : tool));
    const create = guard.wrap().find(tool => tool.name === original.name)!;
    const target = { boardId, nodeId: node.id };
    await expect(create.execute("original-canvas", target, undefined, undefined, {} as never)).rejects.toThrow("Interrupted");
    const saved = vi.fn(async () => {}); await guard.prepare(new AbortController().signal, saved);
    const result = await create.execute("repeated-model-call", target, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded" } });
    expect(generate).toHaveBeenCalledOnce(); expect(await store.jobs(project.id)).toHaveLength(1); expect(saved).toHaveBeenCalledOnce();
    await expect(original.recoverAfterHttp500!("unknown-original", target, new AbortController().signal, undefined, {} as never)).rejects.toThrow("original Canvas job ID is unknown");
    expect(generate).toHaveBeenCalledOnce();
  });
  it.each(["generate_image", "generate_reference_image"])("uses original chat attachments in %s and retains their Canvas source before dispatch", async name => {
    const generate = vi.fn<ImageGenerator["generate"]>(async input => {
      expect(input.images?.map(image => image.data)).toEqual([fixturePng.toString("base64"), local.toString("base64")]);
      const current = await store.board(project.id, boardId);
      const source = current.board.nodes.find(node => node.type === "asset" && node.description === `Chat attachment: ${reference}`)!;
      expect(source).toBeTruthy();
      expect(library.get((source.data as { assetId: string }).assetId)).toMatchObject({ origin: "uploaded", purpose: "reference" });
      return { bytes: fixturePng, mediaType: "image/png" };
    });
    const { store, tools, projects, project, boardId, library } = await runtime({ generate });
    const local = await sharp(fixturePng).jpeg().toBuffer();
    await writeFile(path.join(project.workspacePath, "local.jpg"), local);
    const attachment = await new AgentAttachmentStore().store(project, { batchId: "f2da1f75-4d77-462f-a75b-48dff99b7212", name: "reference.data", contents: fixturePng });
    const reference = `attachment:${attachment.batchId}/${attachment.id}`;
    const authorize = ({ batchId, id }: { batchId: string; id: string }) => batchId === attachment.batchId && id === attachment.id;
    const tool = createAgentTools(project, tools, projects, undefined, undefined, store, "chat", undefined, authorize).find(tool => tool.name === name)!;
    const input = { prompt: "Use these original references", imagePaths: [reference, "local.jpg"], resolution: "1K" as const, aspectRatio: "1:1" as const };
    await tool.execute("attachment-reference", input, undefined, undefined, {} as never);
    expect(generate).toHaveBeenCalledOnce();
    const manifest = await readCanvasAssets(project.workspacePath), source = Object.values(manifest.assets).find(asset => asset.name.startsWith("attachment-"))!;
    expect(await readFile(path.join(project.workspacePath, source.path))).toEqual(fixturePng);
    expect(source.canvasOnly).toBe(true);
    expect(await readFile(path.join(project.workspacePath, ".data/agent-attachments", attachment.batchId, "files", attachment.relativePath))).toEqual(fixturePng);
    const references = library.list().filter(asset => asset.purpose === "reference");
    await tool.execute("attachment-reference", input, undefined, undefined, {} as never);
    expect(generate).toHaveBeenCalledOnce();
    expect(library.list().filter(asset => asset.purpose === "reference")).toEqual(references);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
  });

  it.each([false, true])("corrects text-to-3D options before source or Canvas effects, without replay (Canvas=%s)", async canvas => {
    const generate = vi.fn(async (_input: import("../src/daemon/model3d.js").Model3DGenerationInput) => ({ bytes: TEST_GLB, mediaType: "model/gltf-binary" as const }));
    const model = { provider: "tripo", id: "v3.1-20260211" };
    const { store, tools, projects, project, boardId, library, directory } = await runtime(fakeGenerator, "web-game", async (_tool, input) => ({ ...input, model }), undefined, { generate });
    const before = (await store.board(project.id, boardId)).board;
    const guard = new AutoContinueTools(createAgentTools(project, tools, projects, undefined, undefined, canvas ? store : undefined, "3d-options"));
    const tool = guard.wrap().find(tool => tool.name === "generate_3d_asset")!;
    const input = { operation: "text", prompt: "A hero standing in a T-pose", targetPolycount: 30000, texture: true, pbr: false, options: { geometryQuality: "detailed", textureQuality: "detailed", pose: "t-pose" } };
    const failure = await tool.execute("invalid-options", input, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("invalid_media_options");
    expect(generate).not.toHaveBeenCalled(); expect(library.list()).toEqual([]); expect(await store.jobs(project.id)).toEqual([]);
    expect((await store.board(project.id, boardId)).board).toEqual(before);
    await expect(readdir(path.join(directory, "tools/model3d-tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    await tool.execute("corrected-options", { ...input, options: { geometryQuality: "detailed", textureQuality: "detailed" } }, undefined, undefined, {} as never);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ options: { geometryQuality: "detailed", textureQuality: "detailed" } });
    await expect(tool.execute("invalid-options", input, undefined, undefined, {} as never)).rejects.toThrow("Unsupported keys: pose");
    expect(generate).toHaveBeenCalledOnce(); await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
    expect(guard.recoverySummary).toContain("not_executed (invalid_media_options)");
  });

  it("rejects incompatible options on an existing Canvas node without adding generation history", async () => {
    const generate = vi.fn(), { store, tools, projects, project, boardId } = await runtime(fakeGenerator, "web-game", undefined, undefined, { generate });
    const detail = await store.board(project.id, boardId), node = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (node.type !== "model-3d") throw new Error("Expected 3D fixture");
    Object.assign(node.data, { operation: "text", prompt: "A hero in T-pose", model: { provider: "tripo", id: "v3.1-20260211" }, options: { pose: "t-pose" } });
    detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    await store.saveBoard(project.id, detail.board, detail.revision);
    const before = (await store.board(project.id, boardId)).board;
    const guard = new AutoContinueTools(createAgentTools(project, tools, projects, undefined, undefined, store, "canvas-options"));
    const tool = guard.wrap().find(tool => tool.name === "generate_canvas_media")!;
    const failure = await tool.execute("invalid-saved-options", { boardId, nodeId: node.id }, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("invalid_media_options");
    expect(generate).not.toHaveBeenCalled(); expect(await store.jobs(project.id)).toEqual([]);
    expect((await store.board(project.id, boardId)).board).toEqual(before);
    await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("retains a submitted 3D request when a provider error looks like local option validation", async () => {
    const submit = vi.fn(async () => ({ taskId: "existing-provider-task" }));
    const generate = vi.fn(async (input: import("../src/daemon/model3d.js").Model3DGenerationInput) => {
      await input.execution!.submitted("generate", "fixture", {}, submit);
      throw new Model3DGenerationError("These options are not supported by the selected 3D operation", 400);
    });
    const { store, tools, projects, project } = await runtime(fakeGenerator, "web-game", async (_tool, input) => ({ ...input, model: { provider: "tripo", id: "v3.1-20260211" } }), undefined, { generate });
    const guard = new AutoContinueTools(createAgentTools(project, tools, projects, undefined, undefined, store, "submitted-3d-options"));
    const tool = guard.wrap().find(tool => tool.name === "generate_3d_asset")!;
    const failure = await tool.execute("submitted-request", { operation: "text", prompt: "A hero", options: { geometryQuality: "detailed" } }, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)).toBeUndefined(); expect(generate).toHaveBeenCalledOnce();
    expect((await store.jobs(project.id))[0]).toMatchObject({ status: "failed", submissionOutcome: "unknown" });
    await expect(guard.prepare(new AbortController().signal)).rejects.toThrow(/unconfirmed/);
    expect(submit).toHaveBeenCalledOnce();
    expect(generate.mock.calls[1]?.[0].execution?.recoveryOnly).toBe(true);
  });

  it.each([false, true])("corrects unknown animation names before effects, then retains one successful workflow (Canvas=%s)", async canvas => {
    const animate = vi.fn(async () => ({ bytes: await model3DFixture({ rigged: true, clips: ["Walk"] }), mediaType: "model/gltf-binary" as const }));
    const animations = vi.fn(async (_signal, _model, options) => tripoActions(options?.rigModel, options?.rigType));
    const { store, tools, projects, project, boardId, library } = await runtime(fakeGenerator, "web-game", undefined, undefined, { generate: vi.fn(), animations, animate });
    await writeFile(path.join(project.workspacePath, "boss-stag.glb"), TEST_GLB);
    const before = (await store.board(project.id, boardId)).board, registered = createAgentTools(project, tools, projects, undefined, undefined, canvas ? store : undefined, "animation-input-fixture");
    const guard = new AutoContinueTools(registered), tool = guard.wrap().find(tool => tool.name === "animate_3d_asset")!;
    const input = { modelPath: "boss-stag.glb", model: { provider: "tripo", id: "v3.1-20260211" }, rigModel: "v2.5-20260210", rigType: "quadruped", actions: ["idle", "walk", "run", "attack"], heightMeters: 2.8, animateInPlace: true };
    const failure = await tool.execute("bad-animation", input, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("invalid_animation_action");
    expect(library.list()).toEqual([]); expect(await store.jobs(project.id)).toEqual([]);
    expect((await store.board(project.id, boardId)).board).toEqual(before); expect(animate).not.toHaveBeenCalled();
    await tool.execute("corrected-animation", { ...input, actions: ["Walk"] }, undefined, undefined, {} as never);
    expect(animate).toHaveBeenCalledOnce();
    await expect(tool.execute("bad-animation", input, undefined, undefined, {} as never)).rejects.toThrow("Unknown animation");
    expect(animate).toHaveBeenCalledOnce();
    expect(guard.recoverySummary).toContain("not_executed (invalid_animation_action)");
    await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("keeps provider-stage rig-check errors unconfirmed despite matching local error wording", async () => {
    const animate = vi.fn(async () => { throw new Model3DGenerationError('Unknown animation "idle" after a rig-check task', 400); });
    const { store, tools, projects, project } = await runtime(fakeGenerator, "web-game", undefined, undefined, { generate: vi.fn(), animations: async () => tripoActions(), animate });
    await writeFile(path.join(project.workspacePath, "source.glb"), TEST_GLB);
    const guard = new AutoContinueTools(createAgentTools(project, tools, projects, undefined, undefined, store, "submitted-animation")), tool = guard.wrap().find(tool => tool.name === "animate_3d_asset")!;
    const failure = await tool.execute("provider-error", { modelPath: "source.glb", actions: ["Walk"] }, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)).toBeUndefined(); expect(animate).toHaveBeenCalledOnce();
    await expect(guard.prepare(new AbortController().signal)).rejects.toThrow(/unconfirmed/);
  });

  it.each(["generate_music", "generate_sound_effect", "generate_speech"] as const)("corrects local %s input before Canvas jobs, paid receipts or output are created", async name => {
    const model = { provider: name === "generate_speech" ? "volcengine-tts" : "volcengine-seed-audio", id: "seed-audio-1.0" };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from("ID3fixture"), { headers: { "content-type": "audio/mpeg" } }));
    const { VolcengineTtsProvider } = await import("../src/daemon/volcengine-tts-provider.js");
    const audio = new ProviderAudio([name === "generate_speech" ? new VolcengineTtsProvider(() => "fixture-key", request) : new VolcengineSeedAudioProvider(() => "fixture-key", request)]);
    const { store, tools, projects, project, boardId, library, directory } = await runtime(fakeGenerator, "web-game", undefined, audio);
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store, "audio-input-fixture");
    const guard = new AutoContinueTools(registered), tool = guard.wrap().find(tool => tool.name === name)!;
    const before = await store.board(project.id, boardId);
    const bad = name === "generate_speech" ? { text: "Welcome", model, speed: 0.5 } : { prompt: "Quiet forest", model, loop: true, ...(name === "generate_music" ? { instrumental: true } : {}) };
    const failure = await tool.execute("bad-input", bad, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("audio_input_invalid");
    expect(guard.recoverySummary).toContain("not_executed (audio_input_invalid)");
    expect(request).not.toHaveBeenCalled(); expect(library.list()).toEqual([]);
    expect(await store.jobs(project.id)).toEqual([]);
    expect((await store.board(project.id, boardId)).board).toEqual(before.board);
    const corrected = name === "generate_speech" ? { ...bad, speed: 0 } : { ...bad, loop: false };
    await tool.execute("corrected-input", corrected, undefined, undefined, {} as never);
    expect(request).toHaveBeenCalledOnce(); expect((await store.jobs(project.id))[0]?.status).toBe("succeeded");
    await expect(tool.execute("bad-input", bad, undefined, undefined, {} as never)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(await readdir(path.join(directory, "tools", "audio-attempts"))).toHaveLength(1);
  });

  it("rejects an existing music node's unsupported loop before making a job and preserves its editable input", async () => {
    const model = { provider: "volcengine-seed-audio", id: "seed-audio-1.0" }, request = vi.fn<typeof fetch>();
    const { store, tools, projects, project, boardId } = await runtime(fakeGenerator, "web-game", undefined, new ProviderAudio([new VolcengineSeedAudioProvider(() => "fixture-key", request)]));
    const detail = await store.board(project.id, boardId), node: Extract<AssetCanvasNode, { type: "music" }> = {
      id: "music-input-fixture", type: "music", position: { x: 500, y: 96 },
      data: { model, prompt: "Quiet forest", instrumental: true, loop: true },
    };
    detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    await store.saveBoard(project.id, detail.board, detail.revision);
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store, "canvas-audio-input"), tool = new AutoContinueTools(registered).wrap().find(tool => tool.name === "generate_canvas_media")!;
    const failure = await tool.execute("bad-canvas-input", { boardId, nodeId: node.id }, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)?.reason).toBe("audio_input_invalid");
    expect(request).not.toHaveBeenCalled(); expect(await store.jobs(project.id)).toEqual([]);
    expect((await store.board(project.id, boardId)).board.nodes.find(entry => entry.id === node.id)).toEqual(node);
  });

  it.each([
    ["generate_image", "image", { prompt: "A visible gardener", background: "transparent", outputFormat: "png" }],
    ["generate_image", "image", { prompt: "Edit the gardener", imagePaths: ["front.png"], maskPath: "mask.png", resolution: "1K", aspectRatio: "1:1" }],
    ["generate_reference_image", "image", { prompt: "Left view", imagePaths: ["front.png"], resolution: "1K", aspectRatio: "1:1", quality: "max" }],
    ["generate_3d_from_views", "model-3d", { imagePaths: ["front.png", "left.png", "back.png"], texture: false }],
    ["generate_3d_asset", "model-3d", { operation: "text", prompt: "A garden gate", targetPolycount: 1000 }],
    ["generate_3d_asset", "model-3d", { operation: "retexture", sourcePath: "source.glb", prompt: "Wood", imagePath: "front.png" }],
    ["generate_3d_asset", "model-3d", { operation: "remesh", sourcePath: "source.glb", targetPolycount: 1000, options: { smartUv: true } }],
    ["animate_3d_asset", "animate-3d", { modelPath: "source.glb", actions: ["Walk"], rigType: "biped", animateInPlace: true }],
    ["generate_video", "video", { prompt: "Walk through the garden", imagePath: "front.png", duration: 8, resolution: "720p", aspectRatio: "16:9" }],
    ["generate_speech", "speech", { text: "Welcome", language: "en", style: "Warm", speed: 10, format: "wav", sampleRate: 24000 }],
    ["generate_speech", "voice", { text: "Welcome", voiceDesign: true, voiceDescription: "Warm storyteller", format: "mp3" }],
    ["generate_sound_effect", "sound-effect", { prompt: "Footstep", durationSeconds: 2, loop: true, negativePrompt: "Voices", format: "wav" }],
    ["generate_music", "music", { prompt: "Quiet garden", instrumental: true, durationSeconds: 10, loop: false, format: "wav" }],
  ] as const)("publishes %s as a %s node before dispatch, then keeps its output on that node", async (name, type, input) => {
    const { store, tools, projects, project, boardId, library } = await runtime();
    for (const file of ["front.png", "left.png", "back.png", "mask.png"]) await writeFile(path.join(project.workspacePath, file), fixturePng);
    await writeFile(path.join(project.workspacePath, "source.glb"), TEST_GLB);
    vi.spyOn(tools, "animationActions").mockResolvedValue([{ id: "walk", name: "Walk", category: "Basic", subCategory: "Movement" }]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = vi.spyOn(tools, "runPrepared").mockImplementation(async (toolId, request, _signal, options) => {
      const board = (await store.board(project.id, boardId)).board;
      const node = board.nodes.find(node => node.id === options?.canvasContext?.nodeId)!;
      expect(node).toMatchObject({ type });
      expect((await store.jobs(project.id))[0]).toMatchObject({ status: "running", context: { boardId, nodeId: node.id } });
      if ("imagePath" in input || "imagePaths" in input || "sourcePath" in input || "modelPath" in input) expect(board.nodes.some(node => node.type === "asset")).toBe(true);
      if (name === "generate_speech" && type === "speech") expect(request).toMatchObject({ language: "en", style: "Warm", speed: 10, output: { format: "wav", sampleRate: 24000 } });
      if (name === "generate_3d_from_views") expect(request).toMatchObject({ images: [{}, {}, {}], options: { referenceMode: "turnaround" }, texture: false });
      await gate;
      const model = type === "model-3d" || type === "animate-3d";
      const audio = ["speech", "voice", "sound-effect", "music"].includes(type);
      const asset = await library.add(model ? "result.glb" : audio ? "result.wav" : type === "video" ? "result.mp4" : "result.png", model ? TEST_GLB : audio ? referenceWav() : type === "video" ? Buffer.from("\0\0\0\x18ftypisom") : fixturePng);
      return { id: randomUUID(), toolId: toolId as ToolRun["toolId"], createdAt: new Date().toISOString(), files: [{ name: asset.name, mediaType: asset.contentType as ToolRun["files"][number]["mediaType"], assetId: asset.id }] };
    });
    const tool = createAgentTools(project, tools, projects, undefined, undefined, store).find(tool => tool.name === name)!;
    const pending = tool.execute("visible", input, undefined, undefined, {} as never);
    try {
      await expect.poll(() => run.mock.calls.length).toBe(1);
      const current = await store.board(project.id, boardId);
      const job = (await store.jobs(project.id))[0]!;
      const node = current.board.nodes.find(node => node.id === job.context?.nodeId)!;
      expect(node).toMatchObject({ type });
      node.title = "User's concurrent title";
      await store.saveBoard(project.id, current.board, current.revision);
      release();
      const result = await pending;
      expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded", context: { boardId, nodeId: node.id } }, artifact: { path: expect.any(String) } });
      expect(result.details).toMatchObject({ canvasAssets: [{ assetId: expect.any(String), path: expect.any(String), registered: true, canvasOnly: true }] });
      const message = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(message).toContain("registered in canvas/assets.json");
      expect(message).toContain("not in isolated_shell");
      expect(message).toContain("use_canvas_asset");
      expect((await store.board(project.id, boardId)).board.nodes.find(candidate => candidate.id === node.id)).toMatchObject({ title: "User's concurrent title", data: { assetId: expect.any(String) } });
      expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
      const completed = (await store.jobs(project.id)).find(candidate => candidate.id === job.id)!;
      const assetId = completed.run!.files[0]!.assetId!;
      const entry = (await readCanvasAssets(project.workspacePath)).assets[assetId]!;
      const destination = `public/media/${path.basename(entry.path)}`;
      const adopt = createAgentTools(project, tools, projects, undefined, undefined, store).find(candidate => candidate.name === "use_canvas_asset")!;
      expect((await adopt.execute("adopt", { assetId, destination }, undefined, undefined, {} as never)).details).toEqual({ assetId, path: destination });
      const media: RuntimeMedia[] = [];
      const source = await projectFiles(project.workspacePath, media);
      expect(source.some(file => file.path === entry.path)).toBe(false);
      expect(media.some(file => file.path === destination)).toBe(true);
      await tool.execute("visible", input, undefined, undefined, {} as never);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { release(); await pending.catch(() => {}); }
  });

  it("keeps the actual generation sources after their nodes change and the Canvas store reopens", async () => {
    const { store, tools, projects, project, boardId, library } = await runtime();
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store);
    const direct = registered.find(tool => tool.name === "generate_image")!;
    await direct.execute("source", { prompt: "Original concept" }, undefined, undefined, {} as never);
    const sourceJob = (await store.jobs(project.id))[0]!;
    const sourceId = sourceJob.run!.files[0]!.assetId!;
    const sourcePath = (await readCanvasAssets(project.workspacePath)).assets[sourceId]!.path;
    await registered.find(tool => tool.name === "generate_reference_image")!.execute("dependent", { prompt: "Left view", imagePaths: [sourcePath], resolution: "1K", aspectRatio: "1:1" }, undefined, undefined, {} as never);
    const dependent = (await store.jobs(project.id))[0]!;
    expect(dependent.sources).toEqual([{ assetId: sourceId, name: library.get(sourceId)!.name }]);
    expect(sourceJob.sources).toEqual([]);
    const replacement = await library.add("changed-concept.png", fixturePng);
    const board = await store.board(project.id, boardId);
    Object.assign(board.board.nodes.find(node => node.id === sourceJob.context?.nodeId)!.data, { assetId: replacement.id });
    await store.saveBoard(project.id, board.board, board.revision);
    await store.close();
    const next = new CanvasStore(projects, library, tools); stores.push(next);
    expect((await next.jobs(project.id))[0]!.sources).toEqual(dependent.sources);
    expect((await next.jobs(project.id))[0]!.sources![0]!.assetId).not.toBe(replacement.id);
  });

  it("shows a routed preflight failure on its saved node and generates only after correction", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, tools, projects, project, boardId } = await runtime({ generate });
    const prepare = vi.spyOn(tools, "prepare").mockRejectedValueOnce(new Error("Selected model unavailable"));
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store);
    await expect(registered.find(tool => tool.name === "generate_image")!.execute("preflight", { prompt: "A moth" }, undefined, undefined, {} as never)).rejects.toThrow("Selected model unavailable");
    const failed = (await store.jobs(project.id))[0]!;
    expect(failed).toMatchObject({ status: "failed", error: "Selected model unavailable" });
    expect(generate).not.toHaveBeenCalled();
    prepare.mockRestore();
    const result = await registered.find(tool => tool.name === "generate_canvas_media")!.execute("corrected", { boardId, nodeId: failed.context!.nodeId }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded", context: failed.context } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("recovers a routed direct call after a failed local save and daemon reopen without generating again", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const { directory, store, tools, projects, project, boardId, library } = await runtime({ generate });
    const failSave = vi.spyOn(projects, "materializeLibraryAsset").mockRejectedValueOnce(new Error("Local disk unavailable"));
    const direct = createAgentTools(project, tools, projects, undefined, undefined, store, "chat").find(tool => tool.name === "generate_image")!;
    await expect(direct.execute("original", { prompt: "A moth" }, undefined, undefined, {} as never)).rejects.toThrow("Local disk unavailable");
    const failed = (await store.jobs(project.id))[0]!;
    expect(failed).toMatchObject({ status: "failed", run: expect.anything() });
    failSave.mockRestore();
    await store.close();
    const reopened = new ToolRunner(directory, { generate }, undefined, undefined, library);
    await reopened.load();
    const next = new CanvasStore(projects, library, reopened); stores.push(next);
    const registered = createAgentTools(project, reopened, projects, undefined, undefined, next, "chat");
    const recover = registered.find(tool => tool.name === "recover_media")!;
    const result = await recover.execute("recover", { tool: "generate_image", recoverCallId: "original" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded", context: failed.context }, artifact: { type: "image" } });
    const board = (await next.board(project.id, boardId)).board;
    expect(board.nodes).toHaveLength(2);
    expect(board.nodes.find(node => node.id === failed.context?.nodeId)).toMatchObject({ data: { assetId: failed.run!.files[0]!.assetId } });
    await registered.find(tool => tool.name === "generate_image")!.execute("original", { prompt: "A moth" }, undefined, undefined, {} as never);
    expect((await next.board(project.id, boardId)).board.nodes).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("publishes concurrent calls independently, reuses sources and preserves cancellation payment protection", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>(async (_input, signal) => {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal?.addEventListener("abort", () => reject(new ImageGenerationError("Interrupted after submit", 502, true)), { once: true });
      });
      return { bytes: fixturePng, mediaType: "image/png" };
    });
    const { store, tools, projects, project, boardId } = await runtime({ generate });
    await writeFile(path.join(project.workspacePath, "source.png"), fixturePng);
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store);
    const direct = registered.find(tool => tool.name === "generate_reference_image")!;
    const a = new AbortController();
    const input = { prompt: "Front", imagePaths: ["source.png"], resolution: "1K", aspectRatio: "1:1" };
    const first = direct.execute("first", input, a.signal, undefined, {} as never);
    const failed = expect(first).rejects.toThrow();
    const second = direct.execute("second", { ...input, prompt: "Back" }, undefined, undefined, {} as never);
    try {
      await expect.poll(() => generate.mock.calls.length).toBe(2);
      const board = (await store.board(project.id, boardId)).board;
      expect(board.nodes.filter(node => node.type === "asset")).toHaveLength(1);
      expect((await store.jobs(project.id)).map(job => job.context?.nodeId)).toEqual(expect.arrayContaining(board.nodes.filter(node => node.id.startsWith("agent-")).map(node => node.id)));
      a.abort(); await failed;
      release(); await second;
      expect((await store.jobs(project.id)).map(job => job.status).sort()).toEqual(["cancelled", "succeeded"]);
      await expect(direct.execute("replacement", { ...input, prompt: "New front" }, undefined, undefined, {} as never)).rejects.toThrow("previous media request may already have been billed");
      expect(generate).toHaveBeenCalledTimes(2);
    } finally { a.abort(); release(); await Promise.allSettled([first, second]); }
  });

  it("uses the current board through Pi dispatch and connects the selected voice's pinned source", async () => {
    const { store, tools, projects, project, library, boardId } = await runtime();
    const workspace = await store.changeBoards(project.id, { type: "create", name: "Sound" });
    const active = workspace.boards.at(-1)!.id;
    const voice = await library.add("selected.wav", referenceWav());
    const existing = await store.board(project.id, active);
    existing.board.nodes.push({ id: "earlier-speech", type: "speech", position: { x: 0, y: 0 }, data: { text: "Previous sample", assetId: voice.id } });
    existing.board.editorLayout.nodes["earlier-speech"] = { x: 0, y: 0 };
    await store.saveBoard(project.id, existing.board, existing.revision);

    const run = vi.spyOn(tools, "runPrepared").mockImplementation(async (toolId, input) => {
      expect(input).toMatchObject({ referenceSha256: createHash("sha256").update(referenceWav()).digest("hex") });
      return { id: randomUUID(), toolId: toolId as ToolRun["toolId"], createdAt: "now", files: [{ name: voice.name, mediaType: "audio/wav", assetId: voice.id }] };
    });
    const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Speak" + promptContextBlock([{ kind: "canvas-board", label: "Sound", text: `Current canvas board: canvas/boards/${active}.json\nSelected nodes: none` }]) } }] } } as never;
    const tool = createAgentTools(project, tools, projects, undefined, undefined, store).find(tool => tool.name === "generate_speech")!;
    const response = await runToolCall({ type: "toolCall", id: "voice-pi", name: tool.name, arguments: { text: "Hello", referenceAssetId: voice.id } }, {
      tools: [{ ...tool, execute: (id, input) => tool.execute(id, input, undefined, undefined, ctx) }], assistantMessage: {} as never, context: { messages: [] },
    });
    expect(response.isError, JSON.stringify(response.result)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    const board = (await store.board(project.id, active)).board;
    expect(board.nodes).toHaveLength(3);
    const source = board.nodes.find(node => node.type === "asset")!;
    expect(board.nodes.find(node => node.type === "speech" && node.id !== "earlier-speech")).toMatchObject({ data: { voiceSourceNodeId: source.id, referenceAssetId: voice.id } });
    expect((await store.board(project.id, boardId)).board.nodes).toHaveLength(1);
  });

  it("keeps full-quality Canvas candidates portable and adopts only selected media without regenerating", async () => {
    const { project, projects, tools, store, library } = await runtime();
    const root = project.workspacePath;
    const video = Buffer.alloc(3_947_174);
    Buffer.from("000000186674797069736f6d", "hex").copy(video);
    const texture = await sharp({ create: { width: 1600, height: 128, channels: 4, background: { r: 120, g: 80, b: 32, alpha: 0.5 } } }).png().toBuffer();
    const inputs: [string, Buffer][] = [["night.mp4", video], ["cloak.png", texture], ["voice.wav", referenceWav()], ["hero.glb", TEST_GLB]];
    const items = await Promise.all(inputs.map(([name, bytes]) => library.add(name, bytes)));
    const manifest = await ensureCanvasAssets(project, projects, library, items.map(asset => asset.id));
    expect(await canvasCandidatePaths(root)).toEqual(new Set(items.map(asset => `assets/canvas/${asset.name}`)));
    for (const [i, asset] of items.entries()) {
      const candidate = manifest.assets[asset.id]!;
      expect(candidate.canvasOnly).toBe(true);
      expect((await readFile(path.join(root, candidate.path))).equals(inputs[i]![1])).toBe(true);
    }
    expect((await checkCanvasWorkspace(root)).ok).toBe(true);
    const unused: RuntimeMedia[] = [];
    expect((await projectFiles(root, unused)).map(file => file.path)).not.toContain(manifest.assets[items[0]!.id]!.path);
    expect(unused).toEqual([]);
    const activate = createAgentTools(project, tools, projects, undefined, undefined, store).find(tool => tool.name === "use_canvas_asset")!;
    const adopt = (assetId: string, destination: string) => activate.execute("adopt", { assetId, destination }, undefined, undefined, {} as never);
    await library.delete(items[0]!.id);
    const dest = "public/media/night.mp4";
    await adopt(items[0]!.id, dest);
    await adopt(items[0]!.id, dest);
    expect((await readFile(path.join(root, dest))).equals(video)).toBe(true);
    await adopt(items[1]!.id, "src/textures/cloak.png");
    expect(await readFile(path.join(root, "src/textures/cloak.png"))).toEqual(texture);
    const selected: RuntimeMedia[] = [];
    await projectFiles(root, selected);
    expect(selected.map(file => file.path).sort()).toEqual([dest, "src/textures/cloak.png"]);
    await expect(adopt(items[0]!.id, "src/clip.js")).rejects.toThrow("extension");
    await expect(adopt(items[0]!.id, "public/../outside.mp4")).rejects.toThrow("public/");
    await writeFile(path.join(root, dest), "other version");
    await expect(adopt(items[0]!.id, dest)).rejects.toThrow("already exists");
    expect(await readFile(path.join(root, dest), "utf8")).toBe("other version");
    const archive: Buffer[] = [];
    for await (const chunk of await exportProjectArchive(project, { library })) archive.push(Buffer.from(chunk));
    const target = await temp(), newLibrary = new AssetLibrary(target), newProjects = new ProjectManager(target, newLibrary);
    await Promise.all([newLibrary.load(), newProjects.load()]);
    const reopened = await importProjectArchive(newProjects, Buffer.concat(archive));
    expect(await canvasCandidatePaths(reopened.workspacePath)).toContain(manifest.assets[items[0]!.id]!.path);
    const restored = await newProjects.useCanvasAsset(reopened.id, items[0]!.id, "public/media/restored.mp4");
    expect((await readFile(path.join(reopened.workspacePath, restored))).equals(video)).toBe(true);
  });

  it("can explicitly adopt an older project's bound full-resolution original without replacing the working image", async () => {
    const { directory, project, projects, library } = await runtime();
    const bytes = await sharp({ create: { width: 2048, height: 256, channels: 4, background: "transparent" } }).png().toBuffer();
    const original = await library.add("old.png", bytes);
    const file = await projects.materializeLibraryAsset(project.id, original.id);
    // Model an older project's already-resized working copy, not today's identity preparation.
    await writeFile(path.join(project.workspacePath, file.path), await sharp(bytes).resize({ width: 1024 }).png().toBuffer());
    const working = await readFile(path.join(project.workspacePath, file.path));
    expect((await sharp(working).metadata()).width).toBeLessThan(2048);
    const entry = { name: original.name, path: file.path, libraryAssetId: original.id };
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { [original.id]: entry } }));
    const metadataFile = path.join(directory, "library/assets.json"), metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    delete metadata.assets.find((asset: { id: string }) => asset.id === original.id).contentSha256;
    await writeFile(metadataFile, JSON.stringify(metadata)); await library.load();
    const legacyMetadata = await readFile(metadataFile);
    expect(library.get(original.id)?.contentSha256).toBeUndefined();
    expect(await canvasCandidatePaths(project.workspacePath)).not.toContain(file.path);
    await projects.useCanvasAsset(project.id, original.id, "public/art/old.png", true);
    expect(await readFile(path.join(project.workspacePath, "public/art/old.png"))).toEqual(bytes);
    expect(await readFile(path.join(project.workspacePath, file.path))).toEqual(working);
    expect(await readFile(metadataFile)).toEqual(legacyMetadata);
  });

  it("rejects a changed Library original using its trusted digest without copying or touching the project", async () => {
    const { project, projects, library } = await runtime();
    const original = await library.add("integrity.png", fixturePng);
    const file = await projects.materializeLibraryAsset(project.id, original.id);
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { [original.id]: { name: original.name, path: file.path, libraryAssetId: original.id } } }));
    const content = await library.content(original.id), changed = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    await writeFile(content.absolutePath, changed);
    const before = project.updatedAt, touch = vi.spyOn(projects, "touch");
    const error = await projects.useCanvasAsset(project.id, original.id, "public/art/integrity.png", true).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.statusCode).toBe(409); expect(error.message).toContain("Library original integrity binding");
    expect(getToolPreflightFailure(error)).toBeUndefined(); expect(touch).not.toHaveBeenCalled(); expect(project.updatedAt).toBe(before);
    await expect(lstat(path.join(project.workspacePath, "public"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(project.workspacePath, file.path))).toEqual(fixturePng);
    expect(await readFile(content.absolutePath)).toEqual(changed);
    expect(library.get(original.id)?.contentSha256).toBe(createHash("sha256").update(fixturePng).digest("hex"));
  });

  it.each(["complete", "stop observing", "cancel original"] as const)("observes the existing Canvas job when asked to %s", async (action) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>(async () => {
      await pending;
      return { bytes: fixturePng, mediaType: "image/png" };
    });
    const { store, tools, projects, project, boardId, node } = await runtime({ generate });
    const job = await store.generateNode(project.id, boardId, node.id);
    const listJobs = store.jobs.bind(store);
    const jobs = vi.spyOn(store, "jobs");
    let resumePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => { resumePoll = resolve; });
    if (action === "complete") {
      jobs.mockImplementationOnce(listJobs).mockImplementationOnce(async (id) => {
        await pollGate;
        return listJobs(id);
      });
    }
    const recover = createAgentTools(project, tools, projects, undefined, undefined, store, "observer", () => [])
      .find(tool => tool.name === "recover_canvas_media")!;
    const observer = new AbortController();
    const result = recover.execute("observe", { boardId, nodeId: node.id, recoverJobId: job.id }, observer.signal, undefined, {} as never);
    const failure = action === "complete" ? undefined : expect(result).rejects.toThrow();
    try {
      // Wait for the observer's first status poll, so all state changes happen during recovery.
      await expect.poll(() => jobs.mock.calls.length).toBeGreaterThan(1);
      expect(generate).toHaveBeenCalledTimes(1);
      if (action === "complete") {
        release();
        await waitForJob(store, project.id);
        const next = await store.generateNode(project.id, boardId, node.id);
        expect(next.id).not.toBe(job.id);
      } else if (action === "stop observing") {
        observer.abort();
        await failure;
        expect((await store.jobs(project.id))[0]).toMatchObject({ id: job.id, status: "running" });
      } else if (action === "cancel original") {
        await store.cancel(project.id, job.id);
      }
    } finally { release(); resumePoll(); }
    if (action === "complete") {
      expect((await result).details).toMatchObject({ canvasGeneration: { id: job.id, status: "succeeded" } });
      expect(await store.jobs(project.id)).toHaveLength(2);
    } else {
      await failure;
      const terminal = await waitForJob(store, project.id);
      expect(terminal).toMatchObject({ id: job.id, status: action === "stop observing" ? "succeeded" : "cancelled" });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await store.jobs(project.id)).toHaveLength(1);
    }
  });

  it.each([null, "stale-job"])("keeps a failed Canvas recovery (%j) from becoming a new direct generation", async (recoverJobId) => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, tools, projects, project, boardId, node } = await runtime({ generate });
    const agentTools = createAgentTools(project, tools, projects, undefined, undefined, store, "conversation");
    const canvas = agentTools.find(tool => tool.name === "recover_canvas_media")!;
    const image = agentTools.find(tool => tool.name === "generate_image")!;
    const args = { boardId, nodeId: node.id, recoverJobId };
    await expect(canvas.execute("attempt-recovery", args, undefined, undefined, {} as never)).rejects.toThrow("recoverJobId");
    const ctx = { sessionManager: { getBranch: () => [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: canvas.name, id: "attempt-recovery", arguments: args }] } },
      { type: "message", message: { role: "toolResult", toolName: canvas.name, toolCallId: "attempt-recovery", isError: true } },
    ] } } as never;
    await expect(image.execute("new-call", { prompt: "A moth" }, undefined, undefined, ctx)).rejects.toThrow("No new generation");
    expect(generate).not.toHaveBeenCalled();
  });

  it("separates a fresh Canvas job, recovery, and a human-approved paid replacement", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockRejectedValueOnce(new ImageGenerationError("Response interrupted", 502, true))
      .mockResolvedValue({ bytes: fixturePng, mediaType: "image/png" });
    const { store, tools, projects, project, boardId, node } = await runtime({ generate });
    let approve = false;
    const ask = vi.fn(async () => ({ cancelled: false, answers: [{ questionId: "new-paid-media", value: approve ? "new" : "keep", label: "response", custom: false }] }));
    let enabled = true;
    const registered = createAgentTools(project, tools, projects, ask, undefined, store, "conversation", () => enabled ? ["generate-image"] : []);
    const create = registered.find(tool => tool.name === "generate_canvas_media")!;
    const recover = registered.find(tool => tool.name === "recover_canvas_media")!;
    const replace = registered.find(tool => tool.name === "replace_canvas_media")!;
    const target = { boardId, nodeId: node.id };
    for (const [tool, extra] of [[create, []], [recover, ["recoverJobId"]], [replace, ["confirmedAudioJobId"]]] as const) {
      const fields = [...Object.keys(target), ...extra].sort();
      const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties).sort()).toEqual(fields);
      expect([...schema.required].sort()).toEqual(fields);
    }
    const ctx = {} as never;
    const legacy = { ...target, recoverJobId: "new", confirmedAudioJobId: "new" };
    await expect(create.execute("legacy", legacy, undefined, undefined, ctx)).rejects.toThrow("No generation was submitted");
    await expect(recover.execute("missing-id", target, undefined, undefined, ctx)).rejects.toThrow("recoverJobId");
    await expect(replace.execute("missing-id", target, undefined, undefined, ctx)).rejects.toThrow("confirmedAudioJobId");
    expect(await store.jobs(project.id)).toEqual([]);
    expect(generate).not.toHaveBeenCalled();

    await expect(create.execute("original", target, undefined, undefined, ctx)).rejects.toThrow("Response interrupted");
    const [job] = await store.jobs(project.id);
    expect(job?.status).toBe("failed");
    enabled = false;
    await expect(recover.execute("restore", { ...target, recoverJobId: job!.id }, undefined, undefined, ctx)).rejects.toThrow("Recovery never submits a new generation");
    expect(ask).not.toHaveBeenCalled();
    const replacement = { ...target, confirmedAudioJobId: job!.id };
    await expect(replace.execute("unavailable", replacement, undefined, undefined, ctx)).rejects.toThrow("media operation is unavailable");
    expect(ask).not.toHaveBeenCalled();
    enabled = true;
    await expect(replace.execute("denied", replacement, undefined, undefined, ctx)).rejects.toThrow("No new generation");
    expect(generate).toHaveBeenCalledTimes(1);
    approve = true;
    await expect(replace.execute("approved", replacement, undefined, undefined, ctx)).resolves.toMatchObject({ details: { canvasGeneration: { status: "succeeded" } } });
    enabled = false;
    const [completed] = await store.jobs(project.id);
    const recovered = await recover.execute("retrieve-saved", { ...target, recoverJobId: completed!.id }, undefined, undefined, ctx);
    expect(recovered.details).toMatchObject({ canvasGeneration: { id: completed!.id, run: completed!.run } });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("requires a human choice when an Agent switches from direct to canvas generation after multiple lost responses, and never replays the completed Canvas call", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const loseResponse = async () => { await barrier; throw new ImageGenerationError("Response interrupted", 502, true); };
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockImplementationOnce(loseResponse).mockImplementationOnce(loseResponse)
      .mockResolvedValue({ bytes: fixturePng, mediaType: "image/png" });
    const { store, tools, projects, project, boardId, node } = await runtime({ generate });
    let approve = false;
    const ask = vi.fn(async () => ({ cancelled: false, answers: [{ questionId: "new-paid-media", value: approve ? "new" : "keep", label: "response", custom: false }] }));
    const agentTools = createAgentTools(project, tools, projects, ask, undefined, store, "conversation");
    const image = agentTools.find((tool) => tool.name === "generate_image")!;
    const canvas = agentTools.find((tool) => tool.name === "generate_canvas_media")!;
    const ctx = {} as never;
    const failed = Promise.allSettled(["lost-moth", "lost-fern"].map((id) => image.execute(id, { prompt: id }, undefined, undefined, ctx)));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    release();
    expect((await failed).every((result) => result.status === "rejected")).toBe(true);
    await expect(canvas.execute("other-call", { boardId, nodeId: node.id }, undefined, undefined, ctx)).rejects.toThrow("No new generation");
    expect(generate).toHaveBeenCalledTimes(2);
    approve = true;
    const result = await canvas.execute("approved-call", { boardId, nodeId: node.id }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded" } });
    expect(ask).toHaveBeenCalledTimes(2); // One decline and one approval, each covering both pending calls.
    expect(ask).toHaveBeenLastCalledWith("approved-call", expect.objectContaining({ previousPaidCount: 2 }), undefined, "generate-image");
    expect(generate).toHaveBeenCalledTimes(3);
    await expect(canvas.execute("approved-call", { boardId, nodeId: node.id }, undefined, undefined, ctx)).resolves.toMatchObject({ details: { previouslyDeliveredCallId: "approved-call" } });
    expect(generate).toHaveBeenCalledTimes(3);
    const next = await canvas.execute("next-independent-call", { boardId, nodeId: node.id }, undefined, undefined, ctx);
    expect(next.details).toMatchObject({ canvasGeneration: { status: "succeeded" } });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("logs Canvas preparation failures once and preserves the error when logging fails", async () => {
    const failure = new ImageGenerationError("Provider is disabled", 400);
    const resolve = vi.fn().mockRejectedValueOnce(failure).mockImplementation(async (_tool, input) => input);
    const { store, tools, project, boardId, node } = await runtime(fakeGenerator, "asset-canvas", resolve);
    const info = vi.fn(), warn = vi.fn(() => { throw new Error("Logger failed"); });
    tools.setLogger({ info, warn });
    await expect(store.generateNode(project.id, boardId, node.id)).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: project.id, toolId: "generate-image", error: failure.message }), "Generation failed");
    expect(info).not.toHaveBeenCalled();
    await store.generateNode(project.id, boardId, node.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: project.id, toolId: "generate-image" }), "Generation succeeded");
    expect(warn).toHaveBeenCalledOnce();
  });
  it("persists node sizes in layout files and merges resizing with content edits", async () => {
    const { store, project, boardId } = await runtime();
    const detail = await store.board(project.id, boardId);
    const node: AssetCanvasNode = { id: "notes", type: "text", position: { x: 10, y: 20 }, width: 700, height: 500, data: { text: "Rules", instruction: "" } };
    detail.board.nodes.push(node); detail.board.editorLayout.nodes.notes = { ...node.position, width: node.width, height: node.height };
    const saved = await store.saveBoard(project.id, detail.board, detail.revision);
    expect(saved.board.nodes.find((node) => node.id === "notes")).toMatchObject({ width: 700, height: 500 });
    const file = JSON.parse(await readFile(path.join(project.workspacePath, `canvas/boards/${boardId}.json`), "utf8"));
    expect(file.nodes.find((node: AssetCanvasNode) => node.id === "notes")).not.toHaveProperty("width");
    const local = structuredClone(saved.board), remote = structuredClone(saved.board);
    local.nodes.at(-1)!.width = 900;
    if (remote.nodes.at(-1)!.type === "text") (remote.nodes.at(-1)!.data as { text: string }).text = "Edited elsewhere";
    const merged = mergeCanvasDocument(saved.board, local, remote)!;
    expect(merged.nodes.at(-1)).toMatchObject({ width: 900, data: { text: "Edited elsewhere" } });
    expect(merged.editorLayout.nodes.notes).toMatchObject({ width: 900, height: 500 });
    delete local.nodes.at(-1)!.width; delete local.nodes.at(-1)!.height;
    local.editorLayout.nodes.notes = node.position;
    const reset = await store.saveBoard(project.id, local, saved.revision);
    expect(reset.board.nodes.at(-1)).not.toHaveProperty("width");
  });

  it("shares canonical table files across boards and reports damaged files without breaking the canvas", async () => {
    const { store, project, boardId } = await runtime();
    const created = await store.createTable(project.id, "Items");
    const next = await store.changeBoards(project.id, { type: "create", name: "Balance" });
    for (const id of [boardId, next.boards.at(-1)!.id]) {
      const detail = await store.board(project.id, id);
      detail.board.nodes.push({ id: "items", type: "table", position: { x: 0, y: 0 }, data: { tableId: created.table.id } });
      detail.board.editorLayout.nodes.items = { x: 0, y: 0 };
      await store.saveBoard(project.id, detail.board, detail.revision);
    }
    const updated = structuredClone(created.table);
    updated.columns[1]!.type = "number"; updated.rows[0]!.cells[updated.columns[1]!.id] = 15;
    await store.saveTable(project.id, updated, created.revision);
    await expect(store.saveTable(project.id, created.table, created.revision)).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.workspace(project.id)).tables?.[0]?.rows[0]?.cells).toEqual(updated.rows[0]!.cells);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    await store.changeBoards(project.id, { type: "delete", boardId: next.boards.at(-1)!.id });
    expect((await store.table(project.id, updated.id)).table).toEqual(updated);
    await writeFile(path.join(project.workspacePath, `canvas/tables/${updated.id}.json`), "broken");
    const workspace = await store.workspace(project.id);
    expect(workspace.tables).toEqual([]); expect(workspace.tableIssues?.[0]?.id).toBe(updated.id);
    expect((await store.board(project.id, boardId)).board.nodes.at(-1)?.type).toBe("table");
    expect((await checkCanvasWorkspace(project.workspacePath)).issues.some((issue) => issue.file.endsWith(`${updated.id}.json`))).toBe(true);
  });

  it("validates table routes, revisions, identities and unknown board references", async () => {
    const app = createApp({ dataDirectory: await temp() }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject(`${base}/workspace`)).json();
    const created = await app.inject({ method: "POST", url: `${base}/tables`, payload: { title: "Balance" } });
    expect(created.statusCode).toBe(201);
    const detail = created.json(), url = `${base}/tables/${detail.table.id}`;
    detail.table.columns[0].type = "number"; detail.table.rows[0].cells[detail.table.columns[0].id] = "wrong";
    expect((await app.inject({ method: "PUT", url, payload: detail })).statusCode).toBe(400);
    detail.table.rows[0].cells[detail.table.columns[0].id] = 42;
    expect((await app.inject({ method: "PUT", url, payload: detail })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url, payload: detail })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `${base}/tables/other`, payload: detail })).statusCode).toBe(400);
    const board = (await app.inject(`${base}/boards/${workspace.boards[0].id}`)).json();
    board.board.nodes.push({ id: "missing", type: "table", position: { x: 0, y: 0 }, data: { tableId: "unknown" } }); board.board.editorLayout.nodes.missing = { x: 0, y: 0 };
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${board.board.id}`, payload: board })).statusCode).toBe(404);
  });
  it("keeps imported files under assets/files and reports file nodes whose file is gone", async () => {
    const app = createApp({ dataDirectory: await temp() }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject(`${base}/workspace`)).json();
    const upload = (name: string, payload: Buffer) => app.inject({ method: "POST", url: `${base}/files?name=${encodeURIComponent(name)}`, headers: { "content-type": "application/octet-stream" }, payload });
    const first = await upload("Hero.psd", Buffer.from("8BPS"));
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ path: "assets/files/Hero.psd" });
    expect((await upload("Hero.psd", Buffer.from("8BPS v2"))).json()).toEqual({ path: "assets/files/Hero-2.psd" });
    expect((await upload("empty.json", Buffer.alloc(0))).json()).toEqual({ path: "assets/files/empty.json" });
    expect(await readFile(path.join(project.workspacePath, "assets/files/Hero-2.psd"), "utf8")).toBe("8BPS v2");
    expect((await upload("..", Buffer.from("x"))).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects/missing/canvas/files?name=a.txt", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") })).statusCode).toBe(404);

    const board = (await app.inject(`${base}/boards/${workspace.boards[0].id}`)).json();
    board.board.nodes.push({ id: "hero", type: "file", position: { x: 0, y: 0 }, data: { path: "assets/files/Hero.psd" } }); board.board.editorLayout.nodes.hero = { x: 0, y: 0 };
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${board.board.id}`, payload: board })).statusCode).toBe(200);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    const folder = (name: string) => app.inject({ method: "POST", url: `${base}/folders`, payload: { name } });
    expect((await folder("pack")).json()).toEqual({ path: "assets/files/pack" });
    expect((await folder("pack")).json()).toEqual({ path: "assets/files/pack-2" });
    const nested = (directory: string) => app.inject({ method: "POST", url: `${base}/files?name=skin.png&directory=${encodeURIComponent(directory)}`, headers: { "content-type": "application/octet-stream" }, payload: fixturePng });
    expect((await nested("assets/files/pack/textures/hero")).json()).toEqual({ path: "assets/files/pack/textures/hero/skin.png" });
    for (const directory of ["assets/imported", "src", "assets/files/../../src", "assets/files/pack/", "assets/files/./pack"]) expect((await nested(directory)).statusCode, directory).toBe(400);
    expect((await folder("..")).statusCode).toBe(400);
    await rm(path.join(project.workspacePath, "assets/files/Hero.psd"));
    expect((await checkCanvasWorkspace(project.workspacePath)).issues).toContainEqual({ file: `canvas/boards/${board.board.id}.json`, message: "Node hero: file assets/files/Hero.psd: File not found" });
  });

  it("retains nested folder media at full size and classifies supported formats independently of the import path", async () => {
    const app = createApp({ dataDirectory: await temp() }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const folder = "assets/files/Media pack/nested";
    const upload = (name: string, bytes: Buffer) => app.inject({ method: "POST", url: `/projects/${project.id}/canvas/files?name=${encodeURIComponent(name)}&directory=${encodeURIComponent(folder)}`,
      headers: { "content-type": "application/octet-stream" }, payload: bytes });
    const media: RuntimeMedia[] = [];
    for (const [extension, signature] of [["MP4", "\0\0\0\x18ftypisom"], ["mov", "\0\0\0\x18wide"], ["m4a", "\0\0\0\x18ftypM4A "],
      ["mp3", "ID3"], ["wav", "RIFF\0\0\0\0WAVE"], ["ogg", "OggS"], ["webm", "\x1a\x45\xdf\xa3"], ["gif", "GIF89a"],
      ["avif", "\0\0\0\x18ftypavif"], ["glb", "glTF"]]) {
      const bytes = Buffer.alloc(["MP4", "m4a", "wav", "glb"].includes(extension!) ? 2 * 1024 * 1024 + 24 : 1024);
      bytes.write(signature!, "latin1");
      if (extension === "glb") { bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); }
      const response = await upload(`original.${extension}`, bytes);
      expect(response.statusCode, response.body).toBe(201);
      const { path: imported } = response.json();
      expect(imported).toBe(`${folder}/original.${extension}`);
      expect(await readFile(path.join(project.workspacePath, imported))).toEqual(bytes);
      media.push({ path: imported, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const selected: RuntimeMedia[] = [];
    const ordinary = await projectFiles(project.workspacePath, selected);
    expect(selected.sort((a, b) => a.path.localeCompare(b.path))).toEqual(media.sort((a, b) => a.path.localeCompare(b.path)));
    expect(ordinary.some(file => file.path.startsWith(folder))).toBe(false);
    const invalid = Buffer.alloc(2 * 1024 * 1024 + 24, 65);
    const invalidImport = await upload("invalid.mp4", invalid);
    expect(invalidImport.statusCode, invalidImport.body).toBe(201);
    await expect(projectFiles(project.workspacePath, [])).rejects.toThrow("invalid.mp4");
    expect(await readFile(path.join(project.workspacePath, invalidImport.json().path))).toEqual(invalid);
  });

  it("records contextual defaults in canvas history and preserves them through retries and reloads", async () => {
    let defaultId = "project-image";
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockRejectedValueOnce(new ImageGenerationError("Temporary service failure", 502))
      .mockResolvedValue({ bytes: fixturePng, mediaType: "image/png" });
    const resolve = vi.fn(async (_tool: string, input: RunToolRequest, projectId?: string) => {
      if (!projectId) throw new Error("Project context missing");
      return { ...input, imageModel: "imageModel" in input && input.imageModel ? input.imageModel : { provider: projectId, id: defaultId } };
    });
    const { directory, store, project, projects, library, tools, boardId, node } = await runtime({ generate }, "asset-canvas", resolve);
    const first = await store.generateNode(project.id, boardId, node.id);
    expect(first.model).toEqual({ provider: project.id, id: "project-image" });
    expect(await waitForJob(store, project.id)).toMatchObject({ status: "failed", error: "Temporary service failure" });
    expect(resolve).toHaveBeenCalledOnce();
    defaultId = "changed-image";
    const restored = new CanvasStore(projects, library, tools); stores.push(restored);
    await savedResultFixture(directory, project.workspacePath, first.id);
    await restored.retry(project.id, first.id);
    expect((await waitForJob(restored, project.id)).status).toBe("succeeded");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([input]) => input.imageModel)).toEqual([{ provider: project.id, id: "project-image" }, { provider: project.id, id: "project-image" }]);
    const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
    expect(history[0].model).toEqual({ provider: project.id, id: "project-image" });
    const saved = (await restored.board(project.id, boardId)).board.nodes[0]!;
    expect("model" in saved.data ? saved.data.model : undefined).toBeUndefined();
  });

  it("starts with one freely named empty board", async () => {
    const { store, projects } = await runtime();
    const other = await projects.create("New game");
    const workspace = await store.workspace(other.id);
    expect(workspace.boards).toHaveLength(1); expect(workspace.documents).toEqual([]);
    expect(workspace.boards[0]!.name).toBe("Untitled");
    expect((await store.board(other.id, workspace.boards[0]!.id)).board.nodes).toEqual([]);
  });
  it.each(["managed", "external"])("initializes a %s agent canvas on demand and preserves subsequent edits", async (location) => {
    const { store, projects, tools } = await runtime();
    const project = await projects.create("New game", "web-game", location === "external" ? await temp() : undefined);
    await writeFile(path.join(project.workspacePath, "README.md"), "Existing project notes");
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    const initialize = createAgentTools(project, tools, projects, undefined, undefined, store)
      .find((tool) => tool.name === "canvas_initialize")!;
    await initialize.execute("initialize", {}, undefined, undefined, {} as never);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    expect(await readFile(path.join(project.workspacePath, "canvas/schemas/board.schema.json"), "utf8")).toContain("documentId");

    expect(await readFile(path.join(project.workspacePath, "canvas/AGENTS.md"), "utf8")).toContain("save its generation node on the board before calling generate_canvas_media");

    const document = await store.createDocument(project.id, "Rules");
    await store.save(project.id, { ...document.document, markdown: "# Keep these rules" }, document.revision, document.document.id);
    const index = await readFile(path.join(project.workspacePath, "canvas/index.json"), "utf8");
    await writeFile(path.join(project.workspacePath, "canvas/AGENTS.md"), "Custom canvas instructions");
    await initialize.execute("initialize-again", {}, undefined, undefined, {} as never);
    expect(await readFile(path.join(project.workspacePath, "canvas/index.json"), "utf8")).toBe(index);
    expect((await store.read(project.id))!.document.markdown).toBe("# Keep these rules");
    expect(await readFile(path.join(project.workspacePath, "canvas/AGENTS.md"), "utf8")).toBe("Custom canvas instructions");
    expect(await readFile(path.join(project.workspacePath, "README.md"), "utf8")).toBe("Existing project notes");
  });
  it.each(["design", "canvas.json"])("requires migration before opening the legacy %s format", async (legacy) => {
    const { store, projects } = await runtime();
    const project = await projects.create("Legacy project");
    const source = path.join(project.workspacePath, legacy);
    if (legacy === "design") await mkdir(source);
    else await writeFile(source, "Legacy canvas data");

    await expect(store.workspace(project.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("migrate-canvas-workspaces.ts") });
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    if (legacy === "canvas.json") expect(await readFile(source, "utf8")).toBe("Legacy canvas data");
  });
  it("preserves an incomplete canvas instead of reinitializing its assets", async () => {
    const { store, projects } = await runtime();
    const project = await projects.create("Incomplete canvas");
    const canvas = path.join(project.workspacePath, "canvas");
    await mkdir(canvas);
    const assets = JSON.stringify({ version: 1, assets: { reference: { name: "Reference", path: "assets/reference.png" } } });
    await writeFile(path.join(canvas, "assets.json"), assets);

    await expect(store.workspace(project.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("missing index.json") });
    expect(await readFile(path.join(canvas, "assets.json"), "utf8")).toBe(assets);
    await expect(lstat(path.join(canvas, "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("initializes a complete workspace when generation history is requested first", async () => {
    const { store, projects } = await runtime();
    const project = await projects.create("History before canvas");
    expect(await store.jobs(project.id)).toEqual([]);
    const workspace = await store.workspace(project.id);
    expect(workspace.boards).toHaveLength(1);
    expect((await store.board(project.id, workspace.boards[0]!.id)).board.nodes).toEqual([]);
  });
  it("shares documents and file edits with Asset Canvas while keeping a single board", async () => {
    const { store, project, boardId, library } = await runtime(fakeGenerator, "asset-canvas");
    const doc = await store.createDocument(project.id, "Production reference");
    const updated = await store.save(project.id, { ...doc.document, markdown: "# Brief\n\n一只像素风格的角色。" }, doc.revision, doc.document.id);
    const asset = await library.add("reference.png", fixturePng);
    const inserted = await store.insertAsset(project.id, doc.document.id, asset.id);
    expect(inserted.document.markdown).toContain(updated.document.markdown);
    expect(inserted.document.markdown).toContain("../../assets/");
    const workspace = await store.workspace(project.id);
    expect(workspace.boards).toHaveLength(1);
    expect(workspace.mainDocumentId).toBeUndefined();
    expect(workspace.documents[0]?.main).toBe(false);
    expect(await store.read(project.id)).toBeUndefined();
    const file = path.join(project.workspacePath, canvasDocumentPath(doc.document.id));
    await writeFile(file, "# Updated production brief");
    expect((await store.read(project.id, doc.document.id))!.document.markdown).toBe("# Updated production brief");
    await expect(store.save(project.id, inserted.document, inserted.revision, doc.document.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.changeBoards(project.id, { type: "create", name: "Second" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.changeBoards(project.id, { type: "delete", boardId })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.setMainDocument(project.id, doc.document.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
  });
  it("opens boards with a legacy size on a content-sized node and reports it", async () => {
    const { store, project, boardId } = await runtime(fakeGenerator, "asset-canvas");
    const canvas = path.join(project.workspacePath, "canvas");
    await writeFile(path.join(canvas, `boards/${boardId}.json`), JSON.stringify({ version: 1, id: boardId, viewport: { width: 1280, height: 720 }, edges: [],
      nodes: [{ id: "boat", type: "image", data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [] } }] }));
    await writeFile(path.join(canvas, `editor/${boardId}.json`), JSON.stringify({ version: 1, nodes: { boat: { x: 0, y: 0, width: 330, height: 320 } }, viewport: { x: 0, y: 0, zoom: 1 }, view: "canvas" }));
    const { board } = await store.board(project.id, boardId);
    expect(board.nodes[0]).not.toHaveProperty("width");
    expect(board.editorLayout.nodes.boat).toEqual({ x: 0, y: 0 });
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result.issues).toEqual([{ file: `canvas/editor/${boardId}.json`, message: expect.stringContaining("Node boat: image nodes size to their content") }]);
  });
  it("keeps Markdown canonical and rejects stale saves after disk edits", async () => {
    const { store, project } = await runtime();
    const detail = await store.createDocument(project.id, "Rules");
    const updated = await store.save(project.id, { ...detail.document, markdown: "# Rules\n\nPlant seeds." }, detail.revision, detail.document.id);
    const file = path.join(project.workspacePath, canvasDocumentPath(detail.document.id));
    expect(await readFile(file, "utf8")).toBe(updated.document.markdown);
    await writeFile(file, "# Rules\n\nGrow plants.");
    expect((await readCanvasDocument(project.workspacePath))!.revision).not.toBe(updated.revision);
    await expect(store.save(project.id, { ...updated.document, title: "Stale" }, updated.revision, detail.document.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("shares document references across boards and keeps documents when a board is deleted", async () => {
    const { store, project, boardId } = await runtime();
    const doc = await store.createDocument(project.id, "Rules");
    const index = await store.changeBoards(project.id, { type: "create", name: "Characters" });
    for (const entry of index.boards) {
      const detail = await store.board(project.id, entry.id);
      const node = { id: `doc-${entry.id}`, type: "document" as const, position: { x: 0, y: 0 }, data: { documentId: doc.document.id } };
      detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
      await store.saveBoard(project.id, detail.board, detail.revision);
    }
    await store.changeBoards(project.id, { type: "delete", boardId });
    expect((await store.workspace(project.id)).documents[0]!.id).toBe(doc.document.id);
    await expect(store.changeBoards(project.id, { type: "delete", boardId: index.boards[1]!.id })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("renames, reorders and selects the main document", async () => {
    const { store, project, boardId } = await runtime();
    const index = await store.changeBoards(project.id, { type: "create", name: "Art references" }), secondId = index.boards[1]!.id;
    await store.changeBoards(project.id, { type: "rename", boardId, name: "Mechanics" });
    expect((await store.changeBoards(project.id, { type: "move", boardId: secondId, direction: -1 })).boards.map((board) => board.name)).toEqual(["Art references", "Mechanics"]);
    await store.createDocument(project.id, "First");
    const second = await store.createDocument(project.id, "Second");
    await store.setMainDocument(project.id, second.document.id);
    expect((await store.read(project.id))!.document.id).toBe(second.document.id);
  });
  it("persists layout once and validates document references", async () => {
    const { store, project, boardId } = await runtime();
    const file = JSON.parse(await readFile(path.join(project.workspacePath, `canvas/boards/${boardId}.json`), "utf8"));
    expect(file.nodes[0]).not.toHaveProperty("position"); expect(file).not.toHaveProperty("editorLayout");
    const layout = JSON.parse(await readFile(path.join(project.workspacePath, `canvas/editor/${boardId}.json`), "utf8"));
    expect(layout.nodes[file.nodes[0].id]).toEqual({ x: 96, y: 96 });
    const detail = await store.board(project.id, boardId);
    detail.board.nodes.push({ id: "missing", type: "document", position: { x: 0, y: 0 }, data: { documentId: "missing" } }); detail.board.editorLayout.nodes.missing = { x: 0, y: 0 };
    await expect(store.saveBoard(project.id, detail.board, detail.revision)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("copies Library images into the project with Markdown-relative paths", async () => {
    const { store, project, library } = await runtime();
    const doc = await store.createDocument(project.id, "Art"), asset = await library.add("gardener.png", fixturePng);
    const inserted = await store.insertAsset(project.id, doc.document.id, asset.id);
    expect(inserted.document.markdown).toMatch(/!\[gardener\.png\]\(\.\.\/\.\.\/assets\//);
    const link = inserted.document.markdown.match(/\]\(([^)]+)\)/)![1]!;
    expect((await sharp(path.resolve(project.workspacePath, "canvas/documents", link)).metadata()).width).toBe(8);
  });
  it("removes a deleted image's embed when the file name has parentheses", async () => {
    const { store, project, library, projects } = await runtime();
    const doc = await store.createDocument(project.id, "Art"), asset = await library.add("hero (1).png", fixturePng);
    expect((await store.insertAsset(project.id, doc.document.id, asset.id)).document.markdown).toContain("/hero%20(1).png)");
    await projects.deleteWorkspaceEntry(project.id, (await store.workspace(project.id)).assets[0]!.path);
    expect((await store.read(project.id, doc.document.id))!.document.markdown).not.toContain("![");
  });
  it("reads direct semantic edits, fits new nodes and reports malformed fields without rewriting them", async () => {
    const { store, project, boardId, node } = await runtime();
    const filePath = path.join(project.workspacePath, `canvas/boards/${boardId}.json`);
    const content = JSON.parse(await readFile(filePath, "utf8"));
    content.nodes[0].title = "Main character";
    content.nodes[0].description = "Playable gardener sprite";
    content.nodes.push({ id: "rules", type: "text", title: "Rules", data: { text: "Plant seeds", instruction: "" } });
    const text = JSON.stringify(content); await writeFile(filePath, text);
    const detail = await store.board(project.id, boardId);
    expect(detail.board.nodes[0]).toMatchObject({ title: "Main character", description: "Playable gardener sprite", position: node.position });
    expect(detail.board.nodes[1]!.position.x).toBeGreaterThan(node.position.x);
    expect(await readFile(filePath, "utf8")).toBe(text);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    delete content.nodes[0].data.resolution;
    const invalid = JSON.stringify(content); await writeFile(filePath, invalid);
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result).toMatchObject({ ok: false, issues: [{ file: `canvas/boards/${boardId}.json`, message: expect.stringContaining("/nodes/0") }] });
    expect(await readFile(filePath, "utf8")).toBe(invalid);
    await expect(store.board(project.id, boardId)).rejects.toThrow("resolution");
  });
  it.each(["web-game", "asset-canvas"] as const)("lets the %s agent validate and generate a named node from local media and linked Markdown", async (projectType) => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, project, boardId, node, tools, projects } = await runtime({ generate }, projectType);
    const doc = await store.createDocument(project.id, "Visual direction");
    await store.save(project.id, { ...doc.document, markdown: "A bright garden" }, doc.revision, doc.document.id);
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/reference.png"), fixturePng);
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { gardener: { name: "Gardener reference", description: "Character direction", path: "assets/reference.png" } } }));
    const detail = await store.board(project.id, boardId), image = detail.board.nodes[0]!;
    if (image.type !== "image") throw new Error("Expected image node");
    image.title = "Gardener sprite"; image.data.prompt = "Pixel art";
    image.data.promptSource = { type: "node", nodeId: "direction" };
    image.data.images = [{ type: "library", assetId: "gardener" }];
    detail.board.nodes.push({ id: "direction", type: "document", position: { x: 0, y: 0 }, data: { documentId: doc.document.id } });
    detail.board.editorLayout.nodes.direction = { x: 0, y: 0 };
    await store.saveBoard(project.id, detail.board, detail.revision);
    expect(generate).not.toHaveBeenCalled();
    const registered = createAgentTools(project, tools, projects, undefined, undefined, store);
    const check = await registered.find((tool) => tool.name === "canvas_check")!.execute("check", {}, undefined, undefined, {} as never);
    expect(check.details).toMatchObject({ canvasCheck: { ok: true } });
    const result = await registered.find((tool) => tool.name === "generate_canvas_media")!.execute("generate", { boardId, nodeId: node.id }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded", context: { boardId, nodeId: node.id } } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringContaining("A bright garden"), images: [{ mediaType: "image/png", data: fixturePng.toString("base64") }] });
    expect(generate.mock.calls[0]![0].prompt).toContain("Pixel art");
    const job = (await store.jobs(project.id))[0]!, assetId = job.run!.files[0]!.assetId!;
    const manifest = await readCanvasAssets(project.workspacePath);
    expect((await sharp(path.join(project.workspacePath, manifest.assets[assetId]!.path)).metadata()).width).toBe(8);
    expect((await store.workspace(project.id)).assets.map((asset) => asset.id)).toContain("gardener");
    expect((await store.board(project.id, boardId)).board.nodes[0]).toMatchObject({ title: "Gardener sprite", data: { assetId } });
    await rm(path.join(project.workspacePath, "assets/reference.png"));
    const broken = await checkCanvasWorkspace(project.workspacePath);
    expect(broken.ok).toBe(false); expect(broken.issues[0]!.file).toContain("/assets/gardener");
  });
  it("exports current file contents and retries video inputs using project asset IDs", async () => {
    const { directory, store, project, boardId, tools, library } = await runtime();
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    const sourcePath = path.join(project.workspacePath, "assets/reference.png");
    await writeFile(sourcePath, "first");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { localImage: { name: "Local reference", path: "assets/reference.png" } } }));
    const first = await store.exportAsset(project.id, "localImage");
    expect(await store.exportAsset(project.id, "localImage")).toEqual(first);
    await writeFile(sourcePath, "updated");
    const updated = await store.exportAsset(project.id, "localImage");
    expect(updated.assetId).not.toBe(first.assetId);
    expect(await readFile((await library.content(updated.assetId)).absolutePath, "utf8")).toBe("updated");
    const detail = await store.board(project.id, boardId), video = createAssetGenerationNode("video", { x: 560, y: 0 });
    if (video.type !== "video") throw new Error("Expected video node");
    video.data.prompt = "Walk"; video.data.references = [{ type: "library", assetId: "localImage" }];
    detail.board.nodes.push(video); detail.board.editorLayout.nodes[video.id] = video.position;
    await store.saveBoard(project.id, detail.board, detail.revision);
    const output = await library.add("walk.mp4", Buffer.from("video"));
    const run = vi.spyOn(tools, "runPrepared").mockRejectedValueOnce(new Error("Temporary provider error")).mockResolvedValueOnce({ id: "retry-run", toolId: "generate-video", createdAt: "now", files: [{ name: output.name, mediaType: "video/mp4", assetId: output.id }] });
    const job = await store.generateNode(project.id, boardId, video.id);
    expect((await waitForJob(store, project.id)).status).toBe("failed");
    await savedResultFixture(directory, project.workspacePath, job.id, true);
    await store.retry(project.id, job.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(run.mock.calls.map((call) => call[1])).toEqual([expect.objectContaining({ references: [{ type: "image", assetId: updated.assetId }] }), expect.objectContaining({ references: [{ type: "image", assetId: updated.assetId }] })]);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
  });
  it("rejects media mismatches and missing documents with file diagnostics", async () => {
    const { store, project, boardId, library } = await runtime();
    const doc = await store.createDocument(project.id, "Rules"), model = await library.add("reference.glb", Buffer.from("model"));
    const detail = await store.board(project.id, boardId);
    if (detail.board.nodes[0]!.type === "image") detail.board.nodes[0]!.data.images = [{ type: "library", assetId: model.id }];
    await store.saveBoard(project.id, detail.board, detail.revision);
    await rm(path.join(project.workspacePath, canvasDocumentPath(doc.document.id)));
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      { file: canvasDocumentPath(doc.document.id), message: expect.any(String) },
      { file: `canvas/boards/${boardId}.json`, message: expect.stringContaining("unsupported media type") },
    ]));
  });
  it("keeps a missing asset registered without blocking workspace loading or unrelated board saves", async () => {
    const { store, project, boardId } = await runtime();
    const manifest = JSON.stringify({ version: 1, assets: { missing: { name: "Deleted image", path: "assets/deleted.png" } } });
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), manifest);
    const workspace = await store.workspace(project.id);
    expect(workspace.assets).toEqual([]);
    expect(workspace.unavailableAssets).toEqual([{ id: "missing", name: "Deleted image", path: "assets/deleted.png", status: "missing", message: "File not found" }]);
    const board = await store.board(project.id, boardId);
    board.board.nodes[0]!.title = "Still editable";
    await expect(store.saveBoard(project.id, board.board, board.revision)).resolves.toMatchObject({ board: { nodes: [expect.objectContaining({ title: "Still editable" })] } });
    expect(await readFile(path.join(project.workspacePath, "canvas/assets.json"), "utf8")).toBe(manifest);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(false);
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/deleted.png"), "restored");
    const restored = await store.workspace(project.id);
    expect(restored.unavailableAssets).toEqual([]);
    expect(restored.assets).toContainEqual(expect.objectContaining({ id: "missing" }));
  });

  it("allows deleting the last node after its file has been removed externally", async () => {
    const { store, project, boardId } = await runtime();
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    const file = path.join(project.workspacePath, "assets/reference.png");
    await writeFile(file, "reference");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { image: { name: "Reference", path: "assets/reference.png" } } }));
    let board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "reference", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "image", mediaType: "image" } });
    board.board.editorLayout.nodes.reference = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    await rm(file);
    board = await store.board(project.id, boardId);
    await store.saveBoard(project.id, board.board, board.revision);
    board = await store.board(project.id, boardId);
    board.board.nodes = []; board.board.editorLayout.nodes = {};
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await store.board(project.id, boardId)).board.nodes).toEqual([]);
    expect((await store.workspace(project.id)).unavailableAssets).toHaveLength(1);
  });

  it("preserves existing unregistered references but rejects introducing unknown assets", async () => {
    const { store, project, boardId } = await runtime();
    const file = path.join(project.workspacePath, `canvas/boards/${boardId}.json`);
    const content = JSON.parse(await readFile(file, "utf8"));
    content.nodes[0].data.assetId = "unregistered";
    await writeFile(file, JSON.stringify(content));
    let board = await store.board(project.id, boardId);
    board.board.nodes[0]!.title = "Keep missing output";
    await store.saveBoard(project.id, board.board, board.revision);
    board = await store.board(project.id, boardId);
    if (board.board.nodes[0]!.type === "image") board.board.nodes[0]!.data.images = [{ type: "library", assetId: "new-unknown" }];
    await expect(store.saveBoard(project.id, board.board, board.revision)).rejects.toThrow("new-unknown is not registered");
  });

  it("loads healthy documents and assets when one document file is missing", async () => {
    const { store, project, boardId } = await runtime();
    const missing = await store.createDocument(project.id, "Missing"), healthy = await store.createDocument(project.id, "Healthy");
    await rm(path.join(project.workspacePath, canvasDocumentPath(missing.document.id)));
    const workspace = await store.workspace(project.id);
    expect(workspace.documents.map((document) => document.id)).toEqual([healthy.document.id]);
    expect(workspace.documentIssues).toEqual([expect.objectContaining({ id: missing.document.id, title: "Missing", source: canvasDocumentPath(missing.document.id) })]);
    const board = await store.board(project.id, boardId);
    await store.saveBoard(project.id, board.board, board.revision);
    await writeFile(path.join(project.workspacePath, canvasDocumentPath(missing.document.id)), "Restored document");
    expect((await store.workspace(project.id)).documentIssues).toEqual([]);
  });

  it("inserts a healthy image without validating unrelated missing assets", async () => {
    const { store, project } = await runtime();
    const document = await store.createDocument(project.id, "References");
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/healthy.png"), "healthy");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: {
      healthy: { name: "Healthy", path: "assets/healthy.png" }, missing: { name: "Missing", path: "assets/missing.png" },
    } }));
    expect((await store.insertAsset(project.id, document.document.id, "healthy")).document.markdown).toContain("../../assets/healthy.png");
    await expect(store.insertAsset(project.id, document.document.id, "missing")).rejects.toThrow("File not found");
  });

  it("generates video without requiring unrelated missing assets", async () => {
    const { store, project, boardId, tools, library } = await runtime();
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { missing: { name: "Missing", path: "assets/missing.png" } } }));
    const board = await store.board(project.id, boardId), video = createAssetGenerationNode("video", { x: 560, y: 0 });
    if (video.type !== "video") throw new Error("Expected video node");
    video.data.prompt = "A garden";
    board.board.nodes.push(video); board.board.editorLayout.nodes[video.id] = video.position;
    await store.saveBoard(project.id, board.board, board.revision);
    const output = await library.add("garden.mp4", Buffer.from("video"));
    vi.spyOn(tools, "runPrepared").mockResolvedValue({ id: "video-run", toolId: "generate-video", createdAt: "now", files: [{ name: output.name, mediaType: "video/mp4", assetId: output.id }] });
    await store.generateNode(project.id, boardId, video.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
  });
  it("allows named IDs without inheriting object properties and rejects escaping asset paths", async () => {
    const { store, project, boardId } = await runtime();
    const layout = fitCanvasLayout([{ id: "constructor" }, { id: "__proto__" }], { version: 1, nodes: {}, viewport: { x: 0, y: 0, zoom: 1 }, view: "canvas" });
    expect(layout.nodes.constructor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(layout.nodes.__proto__).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const detail = await store.board(project.id, boardId);
    if (detail.board.nodes[0]!.type === "image") detail.board.nodes[0]!.data.images = [{ type: "library", assetId: "constructor" }];
    await expect(store.saveBoard(project.id, detail.board, detail.revision)).rejects.toThrow("asset constructor is not registered");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { invalid: { name: "Outside", path: "../outside.png" } } }));
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result.ok).toBe(false); expect(result.issues[0]!.message).toContain("/assets/invalid/path");
  });
  it("rejects malformed files and symlinks without overwriting them", async () => {
    const { store, project } = await runtime();
    const doc = await store.createDocument(project.id, "Rules"), file = path.join(project.workspacePath, canvasDocumentPath(doc.document.id));
    const outside = path.join(await temp(), "outside.md"); await writeFile(outside, "Keep me"); await rm(file); await symlink(outside, file);
    await expect(store.read(project.id)).rejects.toThrow("symbolic links"); expect(await readFile(outside, "utf8")).toBe("Keep me");
    await writeFile(path.join(project.workspacePath, "canvas/index.json"), "{}");
    await expect(store.workspace(project.id)).rejects.toThrow("canvas/index.json");
  });
  it("preserves prompt and position changes while finishing on an inactive board", async () => {
    let finish!: (value: Awaited<ReturnType<ImageGenerator["generate"]>>) => void;
    const { store, project, boardId, node, library } = await runtime({ generate: async () => new Promise((resolve) => { finish = resolve; }) });
    await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Original prompt" });
    await expect.poll(() => Boolean(finish)).toBe(true);
    await store.changeBoards(project.id, { type: "create", name: "Other board" });
    const edited = await store.board(project.id, boardId), image = edited.board.nodes.find((candidate) => candidate.type === "image")!;
    image.data.prompt = "New prompt"; image.position = { x: 480, y: 192 }; edited.board.editorLayout.nodes[image.id] = image.position;
    await store.saveBoard(project.id, edited.board, edited.revision);
    finish({ bytes: fixturePng, mediaType: "image/png" });
    const job = await waitForJob(store, project.id), saved = (await store.board(project.id, boardId)).board.nodes[0]!;
    expect(job.status).toBe("succeeded"); expect(saved).toMatchObject({ position: image.position, data: { prompt: "New prompt", assetId: job.run!.files[0]!.assetId } });
    expect(library.get(job.run!.files[0]!.assetId!)).toBeDefined();
  });
  it.each(["node", "board"] as const)("keeps output and history when its %s is removed", async (remove) => {
    let finish!: (value: Awaited<ReturnType<ImageGenerator["generate"]>>) => void;
    const { store, project, boardId, node, library } = await runtime({ generate: async () => new Promise((resolve) => { finish = resolve; }) });
    await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" }); await expect.poll(() => Boolean(finish)).toBe(true);
    if (remove === "board") { await store.changeBoards(project.id, { type: "create", name: "Other" }); await store.changeBoards(project.id, { type: "delete", boardId }); }
    else { const board = await store.board(project.id, boardId); board.board.nodes = []; board.board.editorLayout.nodes = {}; await store.saveBoard(project.id, board.board, board.revision); }
    finish({ bytes: fixturePng, mediaType: "image/png" });
    const job = await waitForJob(store, project.id); expect(job.status).toBe("succeeded"); expect(library.get(job.run!.files[0]!.assetId!)).toBeDefined();
  });
  it("rejects duplicate generation and supports cancellation and retry", async () => {
    let calls = 0;
    const { directory, store, project, boardId, node } = await runtime({ generate: async (_input, signal) => {
      if (calls++) return { bytes: fixturePng, mediaType: "image/png" };
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
    } });
    const job = await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" });
    await expect.poll(() => calls).toBe(1);
    await expect(store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.cancel(project.id, job.id)).status).toBe("cancelled");
    await vi.waitFor(() => expect(calls).toBe(1));
    await savedResultFixture(directory, project.workspacePath, job.id);
    await store.retry(project.id, job.id); expect((await waitForJob(store, project.id)).status).toBe("succeeded");
  });
  it.each(["generate-image", "generate-speech", "generate-sound-effect", "generate-music"] as const)("restores interrupted %s as cancelled without another paid call", async (toolId) => {
    const { store, project, boardId, node } = await runtime();
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), JSON.stringify([{ id: "interrupted", toolId, context: { projectId: project.id, boardId, nodeId: node.id }, status: "running", createdAt: "now", input: { prompt: "Garden" } }]));
    expect((await store.jobs(project.id))[0]).toMatchObject({ status: "cancelled", error: expect.stringContaining("interrupted") });
    if (toolId !== "generate-image") expect((await store.jobs(project.id))[0]?.submissionOutcome).toBe("unknown");
    await expect(store.retry(project.id, "interrupted")).rejects.toMatchObject({ statusCode: 409 });
  });
  it("keeps large legacy recovery inputs private, source budgets usable and duplication recoverable", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, projects, project, boardId, node, tools, library } = await runtime({ generate });
    const input = { prompt: "Original request", images: [{ mediaType: "image/png", data: "A".repeat(9 * 1024 * 1024) }] };
    const id = randomUUID(), recoveryId = randomUUID(), file = path.join(project.workspacePath, "canvas/jobs.json");
    await writeFile(file, JSON.stringify([{ id, recoveryId, toolId: "generate-image", status: "cancelled", createdAt: "now", context: { projectId: project.id, boardId, nodeId: node.id }, input }]));
    const reopened = new CanvasStore(projects, library, tools); stores.push(reopened);
    const legacy = await readFile(file, "utf8"), rename = filesystem.rename;
    const initialize = createAgentTools(project, tools, projects, undefined, undefined, reopened).find(tool => tool.name === "canvas_initialize")!;
    const failedWrite = vi.spyOn(filesystem, "rename").mockImplementation(async (source, target) => {
      if (target === file) throw new Error("History write failed");
      return rename(source, target);
    });
    try { await expect(initialize.execute("initialize-failed", {}, undefined, undefined, {} as never)).rejects.toThrow("History write failed"); }
    finally { failedWrite.mockRestore(); }
    expect(await readFile(file, "utf8")).toBe(legacy);
    await initialize.execute("initialize-metadata", {}, undefined, undefined, {} as never);
    expect((await reopened.jobs(project.id))[0]).toMatchObject({ id, status: "cancelled" });
    const publicText = await readFile(file, "utf8"), history = JSON.parse(publicText);
    expect(Buffer.byteLength(publicText)).toBeLessThan(4096);
    const privateFile = path.join(project.workspacePath, "canvas/.job-inputs", history[0].input.retainedInput + ".json");
    expect(JSON.parse(await readFile(privateFile, "utf8")).input).toEqual(input);
    expect((await lstat(privateFile)).mode & 0o777).toBe(0o600);
    expect((await projectFiles(project.workspacePath)).some(file => file.path.includes(".job-inputs"))).toBe(false);
    const copy = await projects.duplicate(project.id);
    expect((await reopened.jobs(copy.id))[0]).toMatchObject({ id, status: "cancelled", context: { projectId: copy.id } });
    await expect(reopened.retry(copy.id, id, true)).rejects.toThrow("No saved image result");
    expect(generate).not.toHaveBeenCalled();
    expect((await readFile(path.join(copy.workspacePath, "canvas/.job-inputs", history[0].input.retainedInput + ".json"))).equals(await readFile(privateFile))).toBe(true);
  });
  it.each(["missing", "mismatched"])("retains compact history when its private original input is %s", async kind => {
    const { projects, project, boardId, node, tools, library } = await runtime();
    const file = path.join(project.workspacePath, "canvas/jobs.json"), id = randomUUID();
    await writeFile(file, JSON.stringify([{ id, toolId: "generate-image", status: "cancelled", createdAt: "now", context: { projectId: project.id, boardId, nodeId: node.id }, input: { prompt: "Original request" } }]));
    const first = new CanvasStore(projects, library, tools); stores.push(first); await first.jobs(project.id);
    const before = await readFile(file, "utf8"), history = JSON.parse(before), privateFile = path.join(project.workspacePath, "canvas/.job-inputs", history[0].input.retainedInput + ".json");
    if (kind === "missing") await rm(privateFile);
    else { const saved = JSON.parse(await readFile(privateFile, "utf8")); saved.nodeId = "different-node"; await writeFile(privateFile, JSON.stringify(saved)); }
    const reopened = new CanvasStore(projects, library, tools); stores.push(reopened);
    await expect(reopened.jobs(project.id)).rejects.toThrow(/Original generation input is unavailable|does not match this job/);
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it("retains the exact job binding of an unsuccessful recovery observer without another submission", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const { projects, project, boardId, node, tools, library } = await runtime({ generate });
    const id = randomUUID(), file = path.join(project.workspacePath, "canvas/jobs.json");
    await writeFile(file, JSON.stringify([{ id, toolId: "generate-image", status: "cancelled", submissionOutcome: "unknown", createdAt: "now", context: { projectId: project.id, boardId, nodeId: node.id }, input: { prompt: "Original request" } }]));
    const reopened = new CanvasStore(projects, library, tools); stores.push(reopened);
    const registered = createAgentTools(project, tools, projects, undefined, undefined, reopened, "observer");
    const original = registered.find(tool => tool.name === "generate_canvas_media")! as RecoverableTool;
    const args = { boardId, nodeId: node.id }, signal = new AbortController().signal;
    const manager = SessionManager.inMemory(project.workspacePath);
    const user = manager.appendMessage({ role: "user", content: "Continue the game", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "recovery-observer", name: "generate_canvas_media", arguments: args }], stopReason: "toolUse", timestamp: 2 } as never);
    const guard = new AutoContinueTools(registered, { sessionManager: manager }); guard.reset(user);
    const watched = guard.wrap().find(tool => tool.name === "generate_canvas_media")!;
    const failure = await watched.execute("recovery-observer", args, signal, undefined, {} as never).catch(cause => cause);
    expect(failure.message).toContain("No saved image result");
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "media_recovery_unavailable", disposition: "correctable" });
    await expect(guard.prepare(signal)).resolves.toBeUndefined();
    expect(guard.recoverySummary).toContain("not_executed (media_recovery_unavailable)");
    manager.appendMessage({ role: "toolResult", toolCallId: "recovery-observer", toolName: "generate_canvas_media", content: [{ type: "text", text: failure.message }], isError: true, timestamp: 3 } as never);
    const restored = new AutoContinueTools(registered, { sessionManager: manager }); restored.reset(user);
    await expect(restored.prepare(signal)).resolves.toBeUndefined();
    await expect(restored.wrap().find(tool => tool.name === "canvas_initialize")!.execute("continue-local", {}, signal, undefined, {} as never)).resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Canvas ready") }] });
    await expect(original.recoverAfterHttp500!("recovery-observer", args, signal, undefined, {} as never)).rejects.toThrow(`Original Canvas job ${id}`);
    const identity = [project.id, "observer", "generate-image"];
    const scope = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const recoveryId = createHash("sha256").update(JSON.stringify([...identity, "recovery-observer"])).digest("hex");
    await expect(tools.agentMedia.observeCanvas({ scope, callId: "recovery-observer" }, recoveryId, randomUUID())).rejects.toThrow("cannot be rebound");
    expect(await tools.agentMedia.canvasJob({ scope, callId: "recovery-observer" }, recoveryId)).toBe(id);
    expect(await reopened.jobs(project.id)).toHaveLength(1);
    // An unsuccessful observer cannot clear the unresolved paid request or buy a sibling result.
    const detail = await reopened.board(project.id, boardId), sibling = createAssetGenerationNode("image", { x: 300, y: 96 });
    if (sibling.type === "image") sibling.data.prompt = "A sibling request";
    detail.board.nodes.push(sibling); detail.board.editorLayout.nodes[sibling.id] = sibling.position;
    await reopened.saveBoard(project.id, detail.board, detail.revision);
    await expect(original.execute("new-paid", { boardId, nodeId: sibling.id }, signal, undefined, {} as never)).rejects.toThrow("may already have been billed");
    expect(generate).not.toHaveBeenCalled();
  });
  it("keeps generation history usable in a duplicated project", async () => {
    const { store, projects, project, boardId, node } = await runtime();
    await store.generateNode(project.id, boardId, node.id);
    const original = await waitForJob(store, project.id); expect(original.status).toBe("succeeded");
    const copy = await projects.duplicate(project.id);
    expect(await store.jobs(copy.id)).toEqual([{ ...original, context: { ...original.context, projectId: copy.id } }]);
    await store.generateNode(copy.id, boardId, node.id);
    expect((await waitForJob(store, copy.id)).status).toBe("succeeded");
    expect(await store.jobs(copy.id)).toHaveLength(2); expect(await store.jobs(project.id)).toEqual([original]);
  });
  it("restores a generation that was running during duplication as cancelled in the copy", async () => {
    let calls = 0;
    const { directory, store, projects, project, boardId, node } = await runtime({ generate: async (_input, signal) => {
      if (calls++) return { bytes: fixturePng, mediaType: "image/png" };
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
    } });
    const job = await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" });
    await expect.poll(() => calls).toBe(1);
    const copy = await projects.duplicate(project.id);
    expect((await store.jobs(copy.id))[0]).toMatchObject({ id: job.id, status: "cancelled", error: expect.stringContaining("interrupted"), context: { projectId: copy.id } });
    // The copy shares the job ID; cancelling there must leave the original running.
    expect((await store.cancel(copy.id, job.id)).status).toBe("cancelled");
    expect((await store.jobs(project.id))[0]!.status).toBe("running"); expect(calls).toBe(1);
    await savedResultFixture(directory, copy.workspacePath, job.id);
    await store.retry(copy.id, job.id); expect((await waitForJob(store, copy.id)).status).toBe("succeeded");
    expect((await store.jobs(project.id))[0]!.status).toBe("running");
  });
  it.each(["meshy", "legacy-alias"])("retains disabled %s Canvas tasks and refuses recovery before replacing history", async (provider) => {
    const generate = vi.fn(), assertGenerationAllowed = vi.fn(async () => { throw new Model3DGenerationError(MESHY_DISABLED_MESSAGE, 410, true); });
    const { store, project, boardId, tools } = await runtime(fakeGenerator, "asset-canvas", undefined, undefined, { generate, assertGenerationAllowed });
    const board = await store.board(project.id, boardId), node = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    board.board.nodes.push(node); board.board.editorLayout.nodes[node.id] = node.position;
    await store.saveBoard(project.id, board.board, board.revision);
    const input = { model: { provider, id: provider === "meshy" ? "meshy-7.1" : "old-model" }, images: [] };
    const file = path.join(project.workspacePath, "canvas/jobs.json");
    await writeFile(file, JSON.stringify([{ id: "original-meshy-job", recoveryId: "original-task", toolId: "image-to-3d", context: { projectId: project.id, boardId, nodeId: node.id }, status: "failed", createdAt: "now", error: "Interrupted", input }]));
    vi.spyOn(tools, "hasSavedModel3DTask").mockResolvedValue(true);
    expect((await store.jobs(project.id))[0]?.canRecoverModel3D).toBe(false);
    const before = await readFile(file, "utf8");
    await expect(store.retry(project.id, "original-meshy-job", true)).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await store.jobs(project.id)).map(job => job.id)).toEqual(["original-meshy-job"]);
    expect(generate).not.toHaveBeenCalled();
    await expect(store.start(project.id, boardId, node.id, "image-to-3d", input)).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it.each(["generate-video", "image-to-3d", "animate-3d"] as const)("stores %s output in the matching node", async (toolId) => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const node: AssetCanvasNode = toolId === "animate-3d"
      ? { id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { heightMeters: 1.7, actionIds: [] } }
      : createAssetGenerationNode(toolId === "generate-video" ? "video" : "model-3d", { x: 0, y: 0 });
    board.board.nodes.push(node); board.board.editorLayout.nodes[node.id] = node.position; await store.saveBoard(project.id, board.board, board.revision);
    const output = await library.add(toolId === "generate-video" ? "output.mp4" : "output.glb", Buffer.from("output"));
    vi.spyOn(tools, "runPrepared").mockResolvedValue({ id: "run", toolId, createdAt: "now", files: [{ name: output.name, mediaType: toolId === "generate-video" ? "video/mp4" : "model/gltf-binary", assetId: output.id }] } satisfies ToolRun);
    await store.start(project.id, boardId, node.id, toolId, {} as RunToolRequest);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded"); expect((await store.board(project.id, boardId)).board.nodes.find((candidate) => candidate.id === node.id)!.data).toHaveProperty("assetId", output.id);
    expect((await readCanvasAssets(project.workspacePath)).assets[output.id]).toMatchObject({ path: `assets/canvas/${output.name}`, canvasOnly: true });
  });
  it("generates speech from the saved node and linked text, then stores its audio output", async () => {
    const model = { provider: "volcengine-tts", id: "seed-tts-2.0" } as const;
    const generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("audio"), mediaType: "audio/mpeg" as const, model });
    const { store, project, boardId, library } = await runtime(fakeGenerator, "asset-canvas", undefined, {
      catalog: () => ({ models: [], providers: [] }),
      generate,
    });
    const reference = await library.add("voice.wav", referenceWav(), { duration: 1, purpose: "reference" });
    const detail = await store.board(project.id, boardId);
    detail.board.nodes.push(
      { id: "script", type: "text", position: { x: 0, y: 0 }, data: { text: "欢迎来到雾港。", instruction: "" } },
      { id: "narration", type: "speech", position: { x: 320, y: 0 }, data: {
        text: "请留意潮汐。", promptSource: { type: "node", nodeId: "script" }, model,
        referenceAssetId: reference.id, speed: 25,
      } },
    );
    detail.board.editorLayout.nodes.script = { x: 0, y: 0 };
    detail.board.editorLayout.nodes.narration = { x: 320, y: 0 };
    await store.saveBoard(project.id, detail.board, detail.revision);

    await store.generateNode(project.id, boardId, "narration");
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(generate).toHaveBeenCalledWith({
      operation: "speech",
      text: "欢迎来到雾港。\n\n请留意潮汐。",
      model,
      referenceAssetId: reference.id,
      referenceAudio: { bytes: referenceWav(), mediaType: "audio/wav" },
      speed: 25,
    }, expect.any(AbortSignal));
    const saved = (await store.board(project.id, boardId)).board.nodes.find((node) => node.id === "narration");
    expect(saved?.type).toBe("speech");
    expect(saved?.data).toHaveProperty("assetId", expect.any(String));
  });
  it("keeps a speech reference in the project after Library removal and clears it only on explicit removal", async () => {
    const model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const generate = vi.fn().mockResolvedValue({ bytes: referenceWav(), mediaType: "audio/wav", model });
    const { store, project, boardId, library, projects } = await runtime(fakeGenerator, "asset-canvas", undefined, { catalog: () => ({ models: [], providers: [] }), generate });
    const reference = await library.add("voice.wav", referenceWav(), { purpose: "reference", duration: 1 });
    const digest = createHash("sha256").update(referenceWav()).digest("hex");
    const detail = await store.board(project.id, boardId);
    detail.board.nodes.push(
      { id: "voice-source", type: "voice", position: { x: 320, y: 0 }, data: { description: "Narrator", sampleText: "Hello", selectedAssetId: reference.id, selectedSha256: digest } },
      { id: "speech-ref", type: "speech", position: { x: 0, y: 0 }, data: { text: "Hello", model, referenceAssetId: reference.id, referenceSha256: digest, voiceSourceNodeId: "voice-source", voiceId: "legacy-kept-only" } },
    );
    detail.board.editorLayout.nodes["voice-source"] = { x: 320, y: 0 };
    detail.board.editorLayout.nodes["speech-ref"] = { x: 0, y: 0 };
    await store.saveBoard(project.id, detail.board, detail.revision);
    const manifest = await readCanvasAssets(project.workspacePath);
    expect(await readFile(path.join(project.workspacePath, manifest.assets[reference.id]!.path))).toEqual(referenceWav());
    expect(await canvasReferencesAsset(project.workspacePath, reference.id)).toBe(true);
    await library.delete(reference.id);
    await store.generateNode(project.id, boardId, "speech-ref");
    const finished = await waitForJob(store, project.id);
    expect(finished).toMatchObject({ status: "succeeded", run: { files: [{ assetId: expect.any(String) }] } });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ referenceAudio: { bytes: referenceWav(), mediaType: "audio/wav" } }), expect.any(AbortSignal));
    expect(generate.mock.calls[0]![0]).not.toHaveProperty("voiceId");
    await projects.deleteWorkspaceEntry(project.id, manifest.assets[reference.id]!.path);
    const { board } = await store.board(project.id, boardId);
    expect(board.nodes.find(node => node.id === "speech-ref")!.data).toEqual({
      text: "Hello", model, voiceId: "legacy-kept-only", assetId: finished.run!.files[0]!.assetId,
    });
    expect(board.nodes.find(node => node.id === "voice-source")!.data).toEqual({ description: "Narrator", sampleText: "Hello" });
  });
  it("disconnects a deleted source node while keeping a separately pinned speech recording", async () => {
    const { store, project, boardId, library, projects } = await runtime();
    const source = await library.add("source.wav", referenceWav());
    const pinnedBytes = referenceWav(2);
    const pinned = await library.add("pinned.wav", pinnedBytes);
    const binding = { text: "Hello", referenceAssetId: pinned.id, referenceSha256: createHash("sha256").update(pinnedBytes).digest("hex") };
    const detail = await store.board(project.id, boardId);
    const position = { x: 0, y: 0 };
    detail.board.nodes.push(
      { id: "source", type: "asset", position, data: { assetId: source.id, mediaType: "audio" } },
      { id: "line", type: "speech", position, data: { ...binding, voiceSourceNodeId: "source" } },
    );
    Object.assign(detail.board.editorLayout.nodes, { source: position, line: position });
    await store.saveBoard(project.id, detail.board, detail.revision);
    const manifest = await readCanvasAssets(project.workspacePath);
    await projects.deleteWorkspaceEntry(project.id, manifest.assets[source.id]!.path);
    const { board } = await store.board(project.id, boardId);
    expect(board.nodes.find(node => node.id === "source")).toBeUndefined();
    expect(board.nodes.find(node => node.id === "line")!.data).toEqual(binding);
  });
  it("generates sound effects and music from their saved node settings", async () => {
    const generate = vi.fn().mockImplementation(async (input) => ({
      bytes: Buffer.from("audio"), mediaType: "audio/mpeg" as const, model: input.model ?? { provider: "audio-lab", id: input.operation },
    }));
    const { store, project, boardId } = await runtime(fakeGenerator, "asset-canvas", undefined, {
      catalog: () => ({ models: [], providers: [] }),
      generate,
    });
    const detail = await store.board(project.id, boardId);
    detail.board.nodes.push(
      { id: "brief", type: "text", position: { x: 0, y: 0 }, data: { text: "Rainy harbor", instruction: "" } },
      { id: "rain", type: "sound-effect", position: { x: 320, y: 0 }, data: {
        prompt: "close perspective", promptSource: { type: "node", nodeId: "brief" }, durationSeconds: 10, loop: true, negativePrompt: "thunder",
      } },
      { id: "theme", type: "music", position: { x: 320, y: 240 }, data: {
        prompt: "warm strings", instrumental: false, lyrics: "Follow the tide", durationSeconds: 60,
      } },
    );
    detail.board.editorLayout.nodes.brief = { x: 0, y: 0 };
    detail.board.editorLayout.nodes.rain = { x: 320, y: 0 };
    detail.board.editorLayout.nodes.theme = { x: 320, y: 240 };
    await store.saveBoard(project.id, detail.board, detail.revision);

    await store.generateNode(project.id, boardId, "rain");
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    await store.generateNode(project.id, boardId, "theme");
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(generate).toHaveBeenNthCalledWith(1, {
      operation: "sound-effect", prompt: "Rainy harbor\n\nclose perspective", durationSeconds: 10, loop: true, negativePrompt: "thunder",
    }, expect.any(AbortSignal));
    expect(generate).toHaveBeenNthCalledWith(2, {
      operation: "music", prompt: "warm strings", instrumental: false, lyrics: "Follow the tide", durationSeconds: 60,
    }, expect.any(AbortSignal));
    const saved = (await store.board(project.id, boardId)).board.nodes;
    expect(saved.find((node) => node.id === "rain")?.data).toHaveProperty("assetId", expect.any(String));
    expect(saved.find((node) => node.id === "theme")?.data).toHaveProperty("assetId", expect.any(String));
  });
  it("generates animation from a connected 3D node and validates its actual media type", async () => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    const source = await library.add("character.glb", Buffer.from("model"));
    model.data.assetId = source.id;
    const animation: AssetCanvasNode = { id: "animation", type: "animate-3d", position: { x: 400, y: 0 }, data: { source: { type: "node", nodeId: model.id }, heightMeters: 1.7, actionIds: [0] } };
    board.board.nodes.push(model, animation);
    for (const node of [model, animation]) board.board.editorLayout.nodes[node.id] = node.position;
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    const output = await library.add("animated.glb", Buffer.from("animated"));
    const run = vi.spyOn(tools, "runPrepared").mockResolvedValue({ id: "animation-run", toolId: "animate-3d", createdAt: "now", files: [{ name: output.name, mediaType: "model/gltf-binary", assetId: output.id }] });
    await store.generateNode(project.id, boardId, animation.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(run).toHaveBeenCalledWith("animate-3d", expect.objectContaining({ assetId: source.id, actionIds: [0], heightMeters: 1.7 }), expect.any(AbortSignal), { recoveryId: expect.any(String), projectId: project.id, canvasContext: { projectId: project.id, boardId, nodeId: animation.id } }, expect.any(Function), expect.any(Function));
    const manifest = await readCanvasAssets(project.workspacePath);
    await writeFile(path.join(project.workspacePath, "assets/wrong.png"), "image");
    manifest.assets[source.id]!.path = "assets/wrong.png";
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify(manifest));
    const issues = (await checkCanvasWorkspace(project.workspacePath)).issues;
    expect(issues.some((issue) => issue.message.includes(`Node animation: reference ${source.id}`))).toBe(true);
  });
  it("blocks an Agent's single concept image and uses its corrected three-view Canvas node once", async () => {
    const generate = vi.fn().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" });
    const { project, store, projects, tools, library, boardId } = await runtime(fakeGenerator, "web-game", undefined, undefined, { generate });
    const tool = createAgentTools(project, tools, projects, undefined, undefined, store).find(tool => tool.name === "generate_canvas_media")!;
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    const views = await Promise.all(["red", "green", "blue"].map(async background => {
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
      return library.add(background + ".png", bytes);
    }));
    const references = views.map(asset => ({ type: "library" as const, assetId: asset.id }));
    model.data.model = { provider: "tripo", id: "v3.1-20260211" };
    model.data.prompt = "Use the original design for this watchtower";
    model.data.images = references.slice(0, 1);
    const initial = await store.board(project.id, boardId);
    initial.board.nodes.push(model);
    initial.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, initial.board, initial.revision);
    const args = { boardId, nodeId: model.id };
    await expect(tool.execute("incomplete", args, undefined, undefined, {} as never)).rejects.toThrow("front, left, and back");
    expect(generate).not.toHaveBeenCalled();
    const corrected = await store.board(project.id, boardId);
    const savedNode = corrected.board.nodes.find(node => node.id === model.id);
    if (savedNode?.type !== "model-3d") throw new Error("Expected saved model node");
    savedNode.data.images = references;
    await store.saveBoard(project.id, corrected.board, corrected.revision);
    const jobCount = (await store.jobs(project.id)).length;
    await expect(tool.execute("text-only", args, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow("vision-capable main Agent");
    expect(await store.jobs(project.id)).toHaveLength(jobCount);
    expect(generate).not.toHaveBeenCalled();
    const result = await tool.execute("corrected", args, undefined, undefined, { model: { input: ["text", "image"] } } as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0].images).toHaveLength(3);
    expect(generate.mock.calls[0]![0].prompt).toBeUndefined();
  });
  it("converts saved WebP references to PNG for 3D generation without modifying the asset", async () => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const bytes = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
    const reference = await library.add("reference.webp", bytes), model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    model.data.prompt = "Draft description from a previously saved board";
    model.data.images = [{ type: "library", assetId: reference.id }];
    board.board.nodes.push(model); board.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    const manifest = await readCanvasAssets(project.workspacePath);
    const workingFile = path.join(project.workspacePath, manifest.assets[reference.id]!.path);
    const savedBytes = await readFile(workingFile);
    const output = await library.add("character.glb", Buffer.from("model"));
    const run = vi.spyOn(tools, "runPrepared").mockResolvedValue({ id: "3d-run", toolId: "image-to-3d", createdAt: "now", files: [{ name: output.name, mediaType: "model/gltf-binary", assetId: output.id }] });
    await store.generateNode(project.id, boardId, model.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    const input = run.mock.calls[0]![1];
    if (!("images" in input)) throw new Error("Expected image references");
    expect(run.mock.calls[0]![0]).toBe("image-to-3d");
    expect(input).not.toHaveProperty("prompt");
    expect((await store.board(project.id, boardId)).board.nodes.find(candidate => candidate.id === model.id)?.data).toMatchObject({ prompt: model.data.prompt });
    expect(input.images![0]!.mediaType).toBe("image/png");
    expect(Buffer.from(input.images![0]!.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await readFile(workingFile)).toEqual(savedBytes);
    expect(await readFile((await library.content(reference.id)).absolutePath)).toEqual(bytes);
  });
  it("rejects an undecodable WebP before starting a provider job", async () => {
    const { store, project, boardId, tools, library } = await runtime(fakeGenerator, "asset-canvas"), board = await store.board(project.id, boardId);
    const reference = await library.add("broken.webp", Buffer.from("broken")), model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    model.data.images = [{ type: "library", assetId: reference.id }];
    board.board.nodes.push(model); board.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, board.board, board.revision);
    const run = vi.spyOn(tools, "runPrepared");
    await expect(store.generateNode(project.id, boardId, model.id)).rejects.toThrow("Could not convert the WebP");
    expect(run).not.toHaveBeenCalled();
    expect(await store.jobs(project.id)).toEqual([]);
  });
  it("keeps the linked and local prompt for a saved text-to-3D node", async () => {
    const { store, project, boardId } = await runtime(), detail = await store.board(project.id, boardId);
    const model = createAssetGenerationNode("model-3d", { x: 320, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    model.data.operation = "text";
    model.data.prompt = "Worn metal";
    model.data.promptSource = { type: "node", nodeId: "brief" };
    detail.board.nodes.push({ id: "brief", type: "text", position: { x: 0, y: 0 }, data: { text: "A lantern", instruction: "" } }, model);
    detail.board.editorLayout.nodes.brief = { x: 0, y: 0 };
    detail.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, detail.board, detail.revision);
    const stop = new Error("Captured local request");
    const start = vi.spyOn(store, "start").mockRejectedValue(stop);
    await expect(store.generateNode(project.id, boardId, model.id)).rejects.toBe(stop);
    expect(start.mock.calls[0]![4]).toMatchObject({ operation: "text", prompt: "A lantern\n\nWorn metal", images: [] });
  });
  it("clears board references when a Library asset is forcibly removed", async () => {
    const { store, project, boardId, node, library } = await runtime(), asset = await library.add("garden.png", fixturePng), board = await store.board(project.id, boardId);
    const image = board.board.nodes[0]!; if (image.type === "image") { image.data.assetId = asset.id; image.data.images = [{ type: "library", assetId: asset.id }]; }
    await store.saveBoard(project.id, board.board, board.revision); expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeCanvasAssetReferences(project.workspacePath, asset.id); expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes[0]!.id).toBe(node.id);
  });
  it("protects ordered 3D views across file and multi-project Library deletion, while allowing the trailing view to be removed", async () => {
    const { store, project, projects, boardId, library } = await runtime(fakeGenerator, "asset-canvas");
    const addView = async (color: string) => library.add(color + ".png", await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer());
    const [front, left, back, right] = await Promise.all([addView("red"), addView("blue"), addView("green"), addView("yellow")]);
    const first = await store.board(project.id, boardId);
    const image = first.board.nodes[0]!;
    if (image.type !== "image") throw new Error("Expected image draft");
    image.data.images = [{ type: "library", assetId: left.id }];
    const savedFirst = await store.saveBoard(project.id, first.board, first.revision);
    const second = await projects.create("Turnaround project", "asset-canvas");
    const secondBoardId = (await store.workspace(second.id)).boards[0]!.id;
    const board = await store.board(second.id, secondBoardId);
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected model draft");
    model.data.options = { referenceMode: "turnaround" };
    model.data.images = [{ type: "library", assetId: front.id }, { type: "node", nodeId: "left-view" }, { type: "library", assetId: back.id }, { type: "library", assetId: right.id }];
    board.board.nodes.push(model, { type: "asset", id: "left-view", data: { assetId: left.id, mediaType: "image" }, position: { x: 320, y: 0 } });
    board.board.editorLayout.nodes = Object.fromEntries(board.board.nodes.map(node => [node.id, node.position]));
    const savedSecond = await store.saveBoard(second.id, board.board, board.revision);
    const { assets } = await readCanvasAssets(second.workspacePath);
    await expect(projects.deleteWorkspaceEntry(second.id, assets[back.id]!.path)).rejects.toThrow("Replace the Back image");
    await expect(projects.removeLibraryAssetReferences(left.id)).rejects.toThrow("Replace the Left image");
    expect((await store.board(project.id, boardId)).revision).toBe(savedFirst.revision);
    expect((await store.board(second.id, secondBoardId)).revision).toBe(savedSecond.revision);
    await expect(readFile(path.join(second.workspacePath, assets[back.id]!.path))).resolves.toEqual(await readFile((await library.content(back.id)).absolutePath));
    await projects.deleteWorkspaceEntry(second.id, assets[right.id]!.path);
    expect((await store.board(second.id, secondBoardId)).board.nodes.find(node => node.id === model.id)?.data).toMatchObject({ images: model.data.images.slice(0, 3) });
  });
  it("protects and clears an animation's Library model reference", async () => {
    const { store, project, boardId, library } = await runtime(), asset = await library.add("character.glb", Buffer.from("model")), board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "library", assetId: asset.id }, heightMeters: 1.7, actionIds: [] } });
    board.board.editorLayout.nodes.animation = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeCanvasAssetReferences(project.workspacePath, asset.id);
    expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes.find((node) => node.id === "animation")!.data).not.toHaveProperty("source");
  });
  it("validates API documents and generates from saved node settings and linked Markdown", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const app = createApp({ dataDirectory: await temp(), imageGenerator: { generate } }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.inject({ method: "POST", url: base, payload: { template: "game" } })).statusCode).toBe(404);
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    expect((await app.inject(`${base}/boards/${boardId}`)).json().board.nodes).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: 42 } })).statusCode).toBe(400);
    const doc = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    expect(doc.document).toMatchObject({ title: "Rules", markdown: "" });
    expect((await app.inject({ method: "PUT", url: `${base}?documentId=${doc.document.id}`, payload: { ...doc, document: { ...doc.document, markdown: "Changed" } } })).statusCode).toBe(200);
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json(), node = createAssetGenerationNode("image", { x: 0, y: 0 }); detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "Garden"; node.data.resolution = "2K"; node.data.aspectRatio = "16:9";
    node.data.promptSource = { type: "node", nodeId: "brief" };
    detail.board.nodes.push({ id: "brief", type: "document", position: { x: 600, y: 0 }, data: { documentId: doc.document.id } });
    detail.board.editorLayout.nodes.brief = { x: 600, y: 0 };
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail })).statusCode).toBe(200);
    const job = await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate` }); expect(job.statusCode).toBe(202);
    await expect.poll(async () => (await app.inject(`${base}/jobs`)).json()[0]?.status).toBe("succeeded");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ prompt: "Changed\n\nGarden", resolution: "2K", aspectRatio: "16:9" });
  });
  it("serves generation history and generates in a duplicated project", async () => {
    const app = createApp({ dataDirectory: await temp(), imageGenerator: fakeGenerator }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json(), base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json(), node = createAssetGenerationNode("image", { x: 0, y: 0 });
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "Garden";
    detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate` })).statusCode).toBe(202);
    await expect.poll(async () => (await app.inject(`${base}/jobs`)).json()[0]?.status).toBe("succeeded");

    const copy = (await app.inject({ method: "POST", url: `/projects/${project.id}/duplicate` })).json(), copyBase = `/projects/${copy.id}/canvas`;
    const history = await app.inject(`${copyBase}/jobs`);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([{ status: "succeeded", context: { projectId: copy.id, boardId, nodeId: node.id } }]);
    expect((await app.inject({ method: "POST", url: `${copyBase}/boards/${boardId}/nodes/${node.id}/generate` })).statusCode).toBe(202);
    await expect.poll(async () => (await app.inject(`${copyBase}/jobs`)).json()[0]?.status).toBe("succeeded");
  });
  it("cancels and finishes canvas generation when the application closes", async () => {
    let started!: () => void;
    const generating = new Promise<void>((resolve) => { started = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>((_input, signal) => new Promise((_resolve, reject) => {
      started();
      signal!.addEventListener("abort", () => reject(new Error("Generation stopped")), { once: true });
    }));
    const app = createApp({ dataDirectory: await temp(), imageGenerator: { generate } });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json();
    const node = createAssetGenerationNode("image", { x: 0, y: 0 });
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "Garden";
    detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail });
    await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate` });
    await generating;

    await app.close();
    const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
    expect(history[0]).toMatchObject({ status: "cancelled" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(["web-game", "asset-canvas"] as const)("generates from a saved %s document snapshot and rejects stale revisions before calling the model", async (type) => {
    const model = { provider: "test-provider", id: "test-model" };
    const runtimeModel = { ...model, api: "openai-completions" as const, baseUrl: "https://llm.ziy.cc/v1" };
    const response = vi.fn(() => ({ content: [{ type: "text", text: "## Rules\n\nImproved rules" }], stopReason: "stop" }));
    const streamSimple = vi.fn((_model, _context, _options) => ({ async *[Symbol.asyncIterator]() {
      const message = response();
      yield message.stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message };
    } }));
    const modelRuntime = { getModel: () => runtimeModel, getAvailable: async () => [runtimeModel], hasConfiguredAuth: () => true, getAuth: async () => undefined, streamSimple } as unknown as ModelRuntime;
    const app = createApp({ dataDirectory: await temp(), createModelRuntime: async () => modelRuntime }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json(), base = `/projects/${project.id}/canvas`;
    const original = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    const saved = (await app.inject({ method: "PUT", url: `${base}?documentId=${original.document.id}`, payload: { ...original, document: { ...original.document, markdown: "## Rules\n\nCurrent rules" } } })).json();
    const url = `${base}/documents/${saved.document.id}/generate`;
    const payload = { instruction: "Improve the rules", model, revision: saved.revision };
    expect((await app.inject({ method: "POST", url, payload: { ...payload, revision: original.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/documents/missing/generate`, payload })).statusCode).toBe(404);
    expect(streamSimple).not.toHaveBeenCalled();
    const generated = await app.inject({ method: "POST", url, payload });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toEqual({ status: "complete", markdown: "## Rules\n\nImproved rules", model, revision: saved.revision });
    expect(JSON.parse(streamSimple.mock.calls[0]![1].messages[0].content).document).toEqual({ title: "Rules", markdown: saved.document.markdown });
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json()).toEqual(saved);
    response.mockReturnValueOnce({ content: [], stopReason: "error" });
    const empty = await app.inject({ method: "POST", url, payload });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ status: "empty", markdown: "", error: expect.stringContaining("could not generate"), revision: saved.revision });
    response.mockReturnValueOnce({ content: [{ type: "text", text: "Partial rules" }], stopReason: "length" });
    const incomplete = await app.inject({ method: "POST", url, payload });
    expect(incomplete.statusCode).toBe(200);
    expect(incomplete.json()).toMatchObject({ status: "incomplete", markdown: "Partial rules", error: expect.stringContaining("output limit"), revision: saved.revision });
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json()).toEqual(saved);
  });
  it("generates tables from a saved snapshot and never saves invalid or truncated AI output", async () => {
    const model = { provider: "test-provider", id: "test-model" };
    const runtimeModel = { ...model, api: "openai-completions" as const, baseUrl: "https://llm.ziy.cc/v1" };
    const response = vi.fn(() => ({ content: [{ type: "text", text: "" }], stopReason: "stop" }));
    const streamSimple = vi.fn((_model, _context, _options) => ({ async *[Symbol.asyncIterator]() {
      const message = response();
      yield { type: "done", reason: message.stopReason, message };
    } }));
    const modelRuntime = { getModel: () => runtimeModel, getAvailable: async () => [runtimeModel], hasConfiguredAuth: () => true, getAuth: async () => undefined, streamSimple } as unknown as ModelRuntime;
    const app = createApp({ dataDirectory: await temp(), createModelRuntime: async () => modelRuntime }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json(), base = `/projects/${project.id}/canvas`;
    const original = (await app.inject({ method: "POST", url: `${base}/tables`, payload: { title: "Equipment" } })).json();
    const saved = (await app.inject({ method: "PUT", url: `${base}/tables/${original.table.id}`, payload: { ...original, table: { ...original.table, title: "Current equipment" } } })).json();
    const url = `${base}/tables/${saved.table.id}/generate`, payload = { instruction: "Add a weapon", model, revision: saved.revision };
    expect((await app.inject({ method: "POST", url, payload: { ...payload, revision: original.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/tables/missing/generate`, payload })).statusCode).toBe(404);
    expect(streamSimple).not.toHaveBeenCalled();
    const candidate = { ...saved.table, title: "Generated equipment" };
    response.mockReturnValue({ content: [{ type: "text", text: JSON.stringify(candidate) }], stopReason: "stop" });
    const generated = await app.inject({ method: "POST", url, payload });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toEqual({ status: "complete", table: candidate, model, revision: saved.revision });
    expect(JSON.parse(streamSimple.mock.calls[0]![1].messages[0].content).table).toEqual(saved.table);
    response.mockReturnValueOnce({ content: [{ type: "text", text: "invalid table" }], stopReason: "stop" });
    expect((await app.inject({ method: "POST", url, payload })).json()).toMatchObject({ status: "invalid", revision: saved.revision });
    response.mockReturnValueOnce({ content: [{ type: "text", text: JSON.stringify(candidate) }], stopReason: "length" });
    expect((await app.inject({ method: "POST", url, payload })).json()).toMatchObject({ status: "incomplete", error: expect.stringContaining("output limit") });
    expect((await app.inject(`${base}/tables/${saved.table.id}`)).json()).toEqual(saved);
  });
});
describe("design merge and validation", () => {
  it("merges independent node metadata and content edits and detects conflicting names", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "Gardener"; remote.nodes[0]!.description = "Player character";
    expect(mergeCanvasDocument(base, local, remote)!.nodes[0]).toMatchObject({ title: "Gardener", description: "Player character" });
    remote.nodes[0]!.title = "Enemy";
    expect(mergeCanvasDocument(base, local, remote)).toBeUndefined();
  });
  it("merges independent title/prose edits and reports competing prose edits", () => {
    const base = createCanvasDocument("Rules");
    expect(mergeCanvasDocumentContent(base, { ...base, title: "Garden" }, { ...base, markdown: "Plant seeds" })).toMatchObject({ title: "Garden", markdown: "Plant seeds" });
    expect(mergeCanvasDocumentContent(base, { ...base, markdown: "Left" }, { ...base, markdown: "Right" })).toBeUndefined();
    expect(isCanvasDocument({ ...base, content: {} })).toBe(false);
  });
  it("merges prompt/layout edits with generated output and preserves node deletions", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.position = { x: 288, y: 192 }; if (local.nodes[0]!.type === "image") local.nodes[0]!.data.prompt = "New prompt";
    if (remote.nodes[0]!.type === "image") remote.nodes[0]!.data.assetId = "output";
    expect(mergeCanvasDocument(base, local, remote)!.nodes[0]).toMatchObject({ position: { x: 288, y: 192 }, data: { prompt: "New prompt", assetId: "output" } });
    local.nodes = []; local.editorLayout.nodes = {}; expect(mergeCanvasDocument(base, local, remote)!.nodes).toEqual([]);
  });
  it("removes dangling model references and edges while merging independent animation edits", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    base.nodes = [model, { id: "animation", type: "animate-3d", position: { x: 400, y: 0 }, data: { source: { type: "node", nodeId: model.id }, heightMeters: 1.7, actionIds: [] } }];
    base.editorLayout.nodes = Object.fromEntries(base.nodes.map((node) => [node.id, node.position]));
    base.edges = [{ id: "model-link", source: model.id, target: "animation" }];
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes = local.nodes.filter((node) => node.id !== model.id);
    if (remote.nodes[1]!.type === "animate-3d") remote.nodes[1]!.data.actionIds = [1];
    const merged = mergeCanvasDocument(base, local, remote)!;
    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0]!.data).toMatchObject({ actionIds: [1] });
    expect(merged.nodes[0]!.data).not.toHaveProperty("source");
    expect(merged.edges).toEqual([]);
  });

  it.each(["generate_image", "generate_canvas_media"])("allows a corrected new request after %s rejected only placeholder IDs in preflight", async (name) => {
    const generate = vi.fn(fakeGenerator.generate);
    const { directory, store, tools, projects, project, boardId, node } = await runtime({ generate });
    const open = (runner: ToolRunner) => createAgentTools(project, runner, projects, undefined, undefined, store, "conversation")
      .find(tool => tool.name === "generate_image")!;
    const args = name === "generate_image" ? { prompt: "Moth", recoverCallId: "null" } : { boardId, nodeId: node.id, recoverJobId: "new", confirmedAudioJobId: "new" };
    const result = { role: "toolResult", toolName: name, toolCallId: "bad-template", isError: true, content: [] as Array<{ type: string; text: string }> };
    const ctx = { sessionManager: { getBranch: () => [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, id: "bad-template", arguments: args }] } },
      { type: "message", message: result },
    ] } } as never;
    // Recreate the inferred receipt an older version wrote before the app was reopened.
    await expect(open(tools).execute("first-correction", { prompt: "A moth" }, undefined, undefined, ctx)).rejects.toThrow("Find the original request");
    expect(generate).not.toHaveBeenCalled();
    result.content.push({ type: "text", text: `${name}: ${name === "generate_image" ? "recoverCallId requires the actual original ID." : "For canvas recovery supply recoverJobId alone with boardId and nodeId."} No generation was submitted.` });
    const reopened = new ToolRunner(directory, { generate });
    await reopened.load();
    await expect(open(reopened).execute("clean", { prompt: "A moth" }, undefined, undefined, ctx)).resolves.toMatchObject({ details: { canvasGeneration: { status: "succeeded" }, artifact: expect.anything() } });
    expect(generate).toHaveBeenCalledOnce();
  });
});
