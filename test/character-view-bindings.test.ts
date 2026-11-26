import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { createProjectFileReadTool } from "../src/daemon/agent-local-files.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { CharacterViewBindings } from "../src/daemon/character-view-bindings.js";
import { ProjectManager } from "../src/daemon/projects.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunError, ToolRunner } from "../src/daemon/tools.js";

const stores: CanvasStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
const original = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#8844cc88" } }).png().toBuffer();
const model = { provider: "kunpo", id: "gpt-image-2.6-flare" };
const planFingerprint = createHash("sha256").update("original-N-plan").digest("hex");
const direction = {
  nodeId: "hero-n-r1", setId: "hero", designRevision: "v1",
  direction: "N" as const, viewRevision: "r1", displayHeadToGround: 96, planFingerprint,
};

async function fixture(generate: ImageGenerator["generate"]) {
  const directory = await mkdtemp(path.join(inject("testTempDirectory"), "managed-character-"));
  const library = new AssetLibrary(directory);
  const projects = new ProjectManager(directory, library);
  const tools = new ToolRunner(directory, { generate }, undefined, undefined, library);
  await Promise.all([library.load(), projects.load(), tools.load()]);
  const project = await projects.create("Turnaround test", "web-game");
  const id = project.id;
  const canvas = new CanvasStore(projects, library, tools);
  stores.push(canvas);
  const { boardId, nodeId } = await canvas.reserveCharacterViewNode(id, direction);
  const source = await library.add("original.png", original);
  await canvas.createAgentMediaNode(id, nodeId, async reference => {
    const node = createAssetGenerationNode("image", { x: 0, y: 0 });
    if (node.type !== "image") throw new Error("Missing image fixture node");
    Object.assign(node.data, {
      prompt: "Show the same character facing north", model,
      outputFormat: "png", background: "transparent",
      images: [await reference({ assetId: source.id })],
    });
    return node;
  }, boardId);
  const authoring = path.join(project.workspacePath, "assets/generated/character-sets/hero/authoring.json");
  const seal = () => canvas.sealCharacterViewNodes(id, [{ boardId, nodeId, planFingerprint }]);
  const commit = async () => {
    await mkdir(path.dirname(authoring), { recursive: true });
    await writeFile(authoring, JSON.stringify({
      schemaVersion: 1, setId: direction.setId, designRevision: direction.designRevision,
      views: { N: { boardId, nodeId, planFingerprint, viewRevision: direction.viewRevision } },
    }));
  };
  return { directory, id, project, projects, tools, library, canvas, boardId, nodeId, source, authoring, seal, commit };
}

function result() {
  return { bytes: original, mediaType: "image/png" as const };
}

describe("managed character direction submissions", () => {
  it.each(["agent", "Canvas button"] as const)("handles a second direction submitted by the %s while the first is running", async origin => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>(resolve => { finish = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>(() => pending);
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, project, projects, tools } = sample;
    const east = { ...direction, nodeId: "hero-e-r1", direction: "E" as const };
    await canvas.reserveCharacterViewNode(id, { ...east, boardId });
    const north = (await canvas.board(id, boardId)).board.nodes.find(node => node.id === nodeId)!;
    await canvas.createAgentMediaNode(id, east.nodeId, async () => structuredClone(north), boardId);
    await canvas.sealCharacterViewNodes(id, [{ boardId, nodeId, planFingerprint }, { boardId, nodeId: east.nodeId, planFingerprint }]);
    await sample.commit();
    const manifest = JSON.parse(await readFile(sample.authoring, "utf8"));
    manifest.views.E = { ...manifest.views.N, nodeId: east.nodeId };
    await writeFile(sample.authoring, JSON.stringify(manifest));
    const tool = createAgentTools(project, tools, projects, undefined, undefined, canvas, "sequence-check").find(tool => tool.name === "generate_canvas_media")!;
    const run = (callId: string, nodeId: string) => tool.execute(callId, { boardId, nodeId }, undefined, undefined, {} as never);
    const first = run("start-north", nodeId);
    try {
      await expect.poll(() => generate.mock.calls.length).toBe(1);
      if (origin === "agent") {
        await expect(run("overlapping-east", east.nodeId)).rejects.toSatisfy(cause =>
          getToolPreflightFailure(cause)?.disposition === "correctable" && /E was not submitted.*N is still generating/.test(String(cause)));
        expect(await canvas.managedCharacterViewJob(id, { boardId, nodeId: east.nodeId })).toBeUndefined();
        expect(generate).toHaveBeenCalledOnce();
      } else {
        await expect(canvas.generateNode(id, boardId, east.nodeId)).resolves.toMatchObject({ status: "running" });
        await expect.poll(() => generate.mock.calls.length).toBe(2);
      }
    } finally {
      finish(result());
      await first;
    }
    await canvas.waitForProject(id);
    await expect(run("finish-east", east.nodeId)).resolves.toMatchObject({ details: { characterView: { direction: "E" } } });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("requires the committed plan, freezes effective settings, and observes concurrent Canvas generations", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>(resolve => { finish = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>(() => pending);
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId } = sample;
    const state = async () => (await canvas.boardJobs(id, boardId)).characterViews[0]?.state;
    expect(await state()).toBe("preparing");
    await expect(canvas.generateNode(id, boardId, nodeId)).rejects.toThrow(/still preparing/);
    await sample.seal();
    expect(await state()).toBe("preparing");
    await expect(canvas.generateNode(id, boardId, nodeId)).rejects.toThrow(/has not been committed/);
    expect(generate).not.toHaveBeenCalled();
    await sample.commit();
    expect(await state()).toBe("ready");
    const detail = await canvas.board(id, boardId);
    const node = detail.board.nodes.find(node => node.id === nodeId);
    if (node?.type !== "image") throw new Error("No saved direction");
    const prompt = node.data.prompt;
    node.data.prompt = "Changed after sealing";
    const changed = await canvas.saveBoard(id, detail.board, detail.revision);
    expect(await state()).toBe("changed");
    await expect(canvas.generateNode(id, boardId, nodeId)).rejects.toThrow(/settings changed|input has changed/);
    expect(generate).not.toHaveBeenCalled();
    node.data.prompt = prompt;
    node.data = Object.fromEntries(Object.entries(node.data).reverse()) as typeof node.data;
    node.data.model = { id: model.id, provider: model.provider };
    await canvas.saveBoard(id, detail.board, changed.revision);
    expect(await state()).toBe("ready");
    const reference = (await readCanvasAssets(sample.project.workspacePath)).assets[sample.source.id]!;
    const referenceFile = path.join(sample.project.workspacePath, reference.path);
    const different = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#66338866" } }).png().toBuffer();
    await writeFile(referenceFile, different);
    await expect(canvas.generateNode(id, boardId, nodeId)).rejects.toThrow(/input has changed/);
    expect(generate).not.toHaveBeenCalled();
    await writeFile(referenceFile, original);
    try {
      const [first, observer] = await Promise.all([
        canvas.generateNode(id, boardId, nodeId),
        canvas.generateNode(id, boardId, nodeId),
      ]);
      expect(first.id).toBe(observer.id);
      expect(observer.status).toBe("running");
      expect(await state()).toBe("running");
      await expect.poll(() => generate.mock.calls.length).toBe(1);
      expect(generate.mock.calls[0]?.[0]).toMatchObject({
        imageModel: model, prompt, outputFormat: "png",
        images: [{ data: original.toString("base64") }],
      });
    } finally {
      finish(result());
    }
    await canvas.waitForProject(id);
    const finished = await canvas.generateNode(id, boardId, nodeId);
    expect(finished.status).toBe("succeeded");
    expect(finished.run?.files[0]?.assetId).toBeTruthy();
    expect(await state()).toBe("available");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("presents a retained original on the board after its job was pruned without revealing the private recovery identity", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>(async () => result());
    const { canvas, id, boardId, nodeId, seal, commit, project, projects, library, tools } = await fixture(generate);
    await seal(); await commit();
    const job = await canvas.generateNode(id, boardId, nodeId);
    await canvas.waitForProject(id);
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), "[]");
    const reopened = new CanvasStore(projects, library, tools);
    stores.push(reopened);
    expect(await reopened.boardJobs(id, boardId)).toEqual({
      jobs: [], characterViews: [{ nodeId, setId: "hero", designRevision: "v1", direction: "N", viewRevision: "r1", state: "available", jobId: job.id }],
    });
    const retained = await reopened.retry(id, job.id);
    expect(retained).toMatchObject({ status: "succeeded", id: job.id });
    const { absolutePath } = await library.content(retained.run!.files[0]!.assetId!);
    await rm(absolutePath);
    expect((await reopened.boardJobs(id, boardId)).characterViews[0]?.state).toBe("unavailable");
    await expect(reopened.retry(id, job.id)).rejects.toThrow();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("uses the original result for reopen, explicit Agent recovery and HTTP 500 recovery after history and node loss", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>(async () => result());
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, tools, projects, library, project } = sample;
    await sample.seal(); await sample.commit();
    const agent = createAgentTools(project, tools, projects, undefined, undefined, canvas, "test-conversation");
    const request = agent.find(tool => tool.name === "generate_canvas_media")!;
    const generated = await request.execute("direction-original", { boardId, nodeId }, undefined, undefined, {} as never);
    const lookup = await canvas.managedCharacterViewJob(id, { boardId, nodeId });
    expect(lookup?.status).toBe("succeeded");
    const jobId = lookup!.id;
    const assetId = lookup!.run!.files[0]!.assetId;
    const board = await canvas.board(id, boardId);
    board.board.nodes = board.board.nodes.filter(node => node.id !== nodeId);
    delete board.board.editorLayout.nodes[nodeId];
    await canvas.saveBoard(id, board.board, board.revision);
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), "[]");
    await rm(sample.authoring);
    const reopened = new CanvasStore(projects, library, tools);
    stores.push(reopened);
    expect(await reopened.jobs(id)).toEqual([]);
    await expect(reopened.generateNode(id, boardId, nodeId)).resolves.toMatchObject({
      id: jobId, run: { files: [{ assetId }] }, status: "succeeded",
    });
    await expect(reopened.retry(id, jobId, true)).resolves.toMatchObject({ id: jobId, status: "succeeded" });
    const restored = createAgentTools(project, tools, projects, undefined, undefined, reopened, "test-conversation");
    const explicit = restored.find(tool => tool.name === "recover_canvas_media")!;
    const recovered = await explicit.execute("direction-recovery", { boardId, nodeId, recoverJobId: jobId }, undefined, undefined, {} as never);
    expect(recovered.details).toMatchObject({ canvasGeneration: { id: jobId, status: "succeeded" } });
    const automatic = restored.find(tool => tool.name === "generate_canvas_media")! as typeof request & {
      recoverAfterHttp500: typeof request.execute;
    };
    const fromHook = await automatic.recoverAfterHttp500("direction-original", { boardId, nodeId }, undefined, undefined, {} as never);
    expect(fromHook.details).toMatchObject({ canvasGeneration: { id: jobId, status: "succeeded" } });
    for (const receipt of [generated, recovered, fromHook]) {
      const source = { kind: "canvas", reference: assetId, expectedSha256: createHash("sha256").update(original).digest("hex") };
      expect(receipt.details).toMatchObject({ characterView: { source, direction: "N", viewRevision: "r1", nodeId, jobId, boardId,
        reviewRead: { path: expect.any(String), characterPreviewHeight: 96 } } });
      expect(receipt.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(JSON.stringify(source)) });
    }
    expect((await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8")).trim()).toBe("[]");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("opens a rear diagonal alongside the current straight rear and opposite turn in its generation and recovery receipts", async () => {
    const sample = await fixture(async () => result());
    const { project, tools, projects, canvas, id, boardId } = sample;
    const ne = { ...direction, direction: "NE" as const, boardId, nodeId: "hero-ne-r1" };
    await canvas.reserveCharacterViewNode(id, ne);
    const originalNode = (await canvas.board(id, boardId)).board.nodes.find(node => node.id === sample.nodeId)!;
    await canvas.createAgentMediaNode(id, ne.nodeId, async () => ({ ...originalNode, id: ne.nodeId } as typeof originalNode), boardId);
    await canvas.sealCharacterViewNodes(id, [{ boardId, nodeId: sample.nodeId, planFingerprint }, ne]);
    await sample.commit();
    const authoring = JSON.parse(await readFile(sample.authoring, "utf8"));
    const northwest = await canvas.registerCharacterViewSource(id, { assetId: sample.source.id });
    authoring.views.NW = { viewRevision: "r1", accepted: { assetId: northwest.assetId } };
    authoring.views.NE = ne;
    await writeFile(sample.authoring, JSON.stringify(authoring));
    const agent = createAgentTools(project, tools, projects, undefined, undefined, canvas, "compare-turns");
    const generate = agent.find(tool => tool.name === "generate_canvas_media")!;
    const north = await generate.execute("north", { boardId, nodeId: sample.nodeId }, undefined, undefined, {} as never);
    const northeast = await generate.execute("northeast", { boardId, nodeId: ne.nodeId }, undefined, undefined, {} as never);
    const current = northeast.details as { characterView: { jobId: string } };
    const recover = agent.find(tool => tool.name === "recover_canvas_media")!;
    const recovered = await recover.execute("recover-northeast", { boardId, nodeId: ne.nodeId, recoverJobId: current.characterView.jobId }, undefined, undefined, {} as never);
    const northPath = (north.details as { characterView: { path: string } }).characterView.path;
    for (const receipt of [northeast, recovered]) {
      expect(receipt.details).toMatchObject({ characterView: { reviewColumns: ["NE", "N", "NW"],
        reviewRead: { characterComparePaths: [northPath, northwest.path] } } });
    }
  });

  it("retains the generated original when a candidate has no visible pixels to preview", async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#00000000" } }).png().toBuffer();
    const generate = vi.fn<ImageGenerator["generate"]>(async () => ({ bytes, mediaType: "image/png" }));
    const sample = await fixture(generate);
    await sample.seal(); await sample.commit();
    const { project, projects, canvas, tools, boardId, nodeId } = sample;
    const agent = createAgentTools(project, tools, projects, undefined, undefined, canvas, "unreadable-preview");
    const receipt = await agent.find(tool => tool.name === "generate_canvas_media")!.execute("generate", { boardId, nodeId }, undefined, undefined, {} as never);
    const { characterView } = receipt.details as { characterView: { jobId: string; path: string; reviewRead: object } };
    const read = createProjectFileReadTool(project.workspacePath, true);
    await expect(read.execute("preview", characterView.reviewRead, undefined, undefined, {} as never)).rejects.toThrow("no visible pixels");
    const recovered = await agent.find(tool => tool.name === "recover_canvas_media")!.execute("recover", { boardId, nodeId, recoverJobId: characterView.jobId }, undefined, undefined, {} as never);
    expect(recovered.details).toMatchObject({ canvasGeneration: { status: "succeeded" }, characterView });
    expect((await read.execute("original", { path: characterView.path }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not turn an unresolved submitted operation into a replacement after history loss", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>();
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, tools, projects, library, project } = sample;
    await sample.seal(); await sample.commit();
    const transport = vi.spyOn(tools, "runPrepared")
      .mockRejectedValueOnce(new ToolRunError("Fixture response lost after submission", 502, "unknown"));
    const job = await canvas.generateNode(id, boardId, nodeId);
    await canvas.waitForProject(id);
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), "[]");
    const reopened = new CanvasStore(projects, library, tools);
    stores.push(reopened);
    expect((await reopened.boardJobs(id, boardId)).characterViews[0]).toMatchObject({ state: "unknown", jobId: job.id });
    await expect(reopened.generateNode(id, boardId, nodeId)).resolves.toMatchObject({
      id: job.id, status: "failed", submissionOutcome: "unknown",
    });
    await expect(reopened.retry(id, job.id, true)).rejects.toThrow(/original may have been submitted/);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("recovers a retained run with its original identity and does not write into a changed node", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>(async () => result());
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, tools, projects, library, project } = sample;
    await sample.seal(); await sample.commit();
    vi.spyOn(projects, "materializeLibraryAsset").mockRejectedValueOnce(new Error("Fixture write failed after result"));
    const first = await canvas.generateNode(id, boardId, nodeId);
    await canvas.waitForProject(id);
    const prior = await canvas.managedCharacterViewJob(id, { jobId: first.id });
    expect(prior).toMatchObject({ id: first.id, status: "failed", run: { files: [{ assetId: expect.any(String) }] } });
    const board = await canvas.board(id, boardId);
    const changed = board.board.nodes.find(node => node.id === nodeId);
    if (changed?.type !== "image") throw new Error("No managed image fixture");
    changed.data.prompt = "Different camera request awaiting a new revision";
    await canvas.saveBoard(id, board.board, board.revision);
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), "[]");
    await rm(sample.authoring);
    const reopened = new CanvasStore(projects, library, tools);
    stores.push(reopened);
    expect((await reopened.boardJobs(id, boardId)).characterViews[0]).toMatchObject({ state: "recoverable", jobId: first.id });
    const restored = await reopened.retry(id, first.id, true);
    expect(restored.id).not.toBe(first.id);
    await reopened.waitForProject(id);
    await expect(reopened.managedCharacterViewJob(id, { jobId: first.id })).resolves.toMatchObject({
      id: restored.id, status: "succeeded", run: { files: [{ assetId: prior!.run!.files[0]!.assetId }] },
    });
    const saved = (await reopened.board(id, boardId)).board.nodes.find(node => node.id === nodeId);
    expect(saved?.data).toMatchObject({ prompt: changed.data.prompt });
    expect(saved?.data).not.toHaveProperty("assetId");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("allows one corrected request on the original identity after a trusted not-submitted result", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>(async () => result());
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, tools } = sample;
    await sample.seal(); await sample.commit();
    const transport = vi.spyOn(tools, "runPrepared")
      .mockRejectedValueOnce(new ToolRunError("Fixture refused before submission", 409, undefined, undefined, undefined, true));
    const skipped = await canvas.generateNode(id, boardId, nodeId);
    await canvas.waitForProject(id);
    const known = await canvas.managedCharacterViewJob(id, { jobId: skipped.id });
    expect(known).toMatchObject({ id: skipped.id, status: "failed" });
    expect(known?.submissionOutcome).toBeUndefined();
    const next = await canvas.generateNode(id, boardId, nodeId);
    expect(next.id).not.toBe(skipped.id);
    await canvas.waitForProject(id);
    expect(transport.mock.calls.length).toBe(2);
    expect(transport.mock.calls[0]![3]?.recoveryId).toBe(transport.mock.calls[1]![3]?.recoveryId);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("reuses the first reserved identity after interruption before the private input and job are saved", async () => {
    const generate = vi.fn<ImageGenerator["generate"]>(async () => result());
    const sample = await fixture(generate);
    const { canvas, id, boardId, nodeId, tools, projects, library } = sample;
    await sample.seal(); await sample.commit();
    const recorder = vi.spyOn(CharacterViewBindings.prototype, "retainInput")
      .mockRejectedValueOnce(new Error("Fixture stopped before writing the original input"));
    await expect(canvas.generateNode(id, boardId, nodeId, undefined, undefined, true, "generate-image", "original-binding"))
      .rejects.toThrow(/Fixture stopped/);
    expect(generate).not.toHaveBeenCalled();
    const state = new CharacterViewBindings(await projects.getLocalImageRecoveryAnchor(id));
    const prepared = (await state.load())[0]?.attempt;
    expect(prepared).toMatchObject({ phase: "prepared", recoveryId: "original-binding" });
    const reopened = new CanvasStore(projects, library, tools);
    stores.push(reopened);
    const resumed = await reopened.generateNode(id, boardId, nodeId, undefined, undefined, true, "generate-image", "new-observer");
    expect(resumed.id).toBe(prepared?.job.id);
    await reopened.waitForProject(id);
    expect((await state.load())[0]?.attempt).toMatchObject({ phase: "succeeded", recoveryId: "original-binding" });
    expect(generate).toHaveBeenCalledTimes(1);
    recorder.mockRestore();
  });
});
