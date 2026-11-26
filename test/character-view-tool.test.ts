import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { CharacterViewToolInput } from "../src/shared/character-views.js";
import type { ConversationDetail, ProjectState } from "../src/shared/contracts.js";
import { LOCAL_IMAGE_BUDGET_MESSAGE } from "../src/shared/agent-errors.js";
import { AgentAttachmentStore } from "../src/daemon/agent-attachments.js";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { getToolConfirmedFailure, getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { CheckpointStore } from "../src/daemon/checkpoints.js";
import { CharacterViewPublicationJournal } from "../src/daemon/character-view-publication.js";
import { createCharacterViewTool } from "../src/daemon/character-view-tool.js";
import { characterViewProgressReminder } from "../src/daemon/character-view-progress.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";

it("keeps the requested playtest open until a successful player input follows publication", () => {
  type Messages = Parameters<typeof characterViewProgressReminder>[0];
  const receipt = (toolName: string, toolCallId: string, details: object) => ({
    role: "toolResult", toolName, toolCallId, details, content: [], timestamp: 0, isError: false,
  } as const);
  const start = [
    { role: "user", content: "Build the eight views and playtest movement", timestamp: 0 },
    receipt("prepare_character_views", "plan", { characterViews: { state: "committed",
      result: { setId: "courier", authoringPath: "authoring.json", delivery: "complete-set-and-playtest" } } }),
    receipt("prepare_character_views", "publish", { characterViews: { state: "committed", result: { manifest: { setId: "courier", complete: true } } } }),
  ];
  const play = (actions: object[], evidence: object) => [
    ...start, { role: "assistant", content: [{ type: "toolCall", id: "game", name: "game_use", arguments: { operation: "open", actions } }] },
    receipt("game_use", "game", evidence),
  ] as Messages;
  const snapshot = { playtest: { sessionId: "preview" } };
  expect(characterViewProgressReminder(play([], snapshot))?.text).toContain("Exercise the requested controls");
  const controls = [{ type: "press", key: "ArrowUp" }];
  expect(characterViewProgressReminder(play(controls, { ...snapshot, playtestReplay: { historical: true } }))).toBeDefined();
  expect(characterViewProgressReminder(play(controls, snapshot))).toBeUndefined();
});

const model = { provider: "kunpo", id: "gpt-image-2.6-flare" };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function toolReply(model: Parameters<ModelRuntime["streamSimple"]>[0], content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: stopReason, message: {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } }));
  return stream;
}

describe("prepare_character_views", () => {
  it("manually resumes a saved local image error after restarting Pi, retaining its user, earlier effects and failed request", async () => {
    const directory = await temporaryTestDirectory("character-manual-retry-");
    const agentDirectory = path.join(directory, "agent");
    await mkdir(agentDirectory);
    await writeFile(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    await runtime.setRuntimeApiKey("anthropic", "local-retry-fixture-key");
    const model = runtime.getModels("anthropic").find(candidate => candidate.input.includes("image"))!;
    model.baseUrl = "http://127.0.0.1:43199";
    const failed = `Fixture API error (413): ${JSON.stringify({ code: "request_size_exceeded", message: LOCAL_IMAGE_BUDGET_MESSAGE })}`;
    const originalWrite = { path: "original.txt", content: "once" };
    const source = { kind: "workspace", reference: "front.png" };
    const plan = { action: "plan", setId: "courier", expectedAuthoringSha256: null, plan: {
      designRevision: "d1", delivery: "complete-set-and-playtest", original: source, baseline: source, identity: "Courier", camera: "Fixed",
      stance: "Standing", asymmetry: "Left bag", displayHeadToGround: 128, views: [{ direction: "S", viewRevision: "one", source }],
    } };
    const received = new Map<string, string>();
    let attempt = 0, failedOnce = false, partialStop = false;
    let reminder: string | undefined;
    const generate = vi.fn<ImageGenerator["generate"]>();
    runtime.streamSimple = (running, context) => {
      for (const message of context.messages) if (message.role === "toolResult")
        received.set(message.toolCallId, message.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" "));
      if (++attempt > 12) throw new Error("Unexpected retry loop");
      if (received.has("plan") && !failedOnce) {
        failedOnce = true;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: "error", reason: "error", error: {
          role: "assistant", api: running.api, provider: running.provider, model: running.id, timestamp: Date.now(), content: [], stopReason: "error",
          errorMessage: failed, diagnostics: [{ type: "provider_failure", timestamp: Date.now(), details: { status: 413, errorCode: "request_size_exceeded" } }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } }));
        return stream;
      }
      if (received.has("same-write") && !partialStop) {
        partialStop = true;
        return toolReply(running, [{ type: "text", text: "The adopted front is ready." }], "stop");
      }
      if (partialStop && !received.has("new-edit")) {
        const last = context.messages.at(-1);
        if (last?.role === "system") reminder = String(last.content);
      }
      const calls: Omit<ToolCall, "type">[] = [
        { id: "canvas", name: "canvas_initialize", arguments: {} },
        { id: "first-write", name: "write", arguments: originalWrite },
        { id: "discover", name: "tool_search", arguments: { query: "prepare_character_views" } },
        { id: "plan", name: "prepare_character_views", arguments: plan },
        { id: "same-write", name: "write", arguments: originalWrite },
        { id: "new-edit", name: "write", arguments: { path: "game-recovery.txt", content: "completed" } },
      ];
      const next = calls.find(call => !received.has(call.id));
      return next ? toolReply(running, [{ type: "toolCall", ...next }], "toolUse")
        : toolReply(running, [{ type: "text", text: "The original task is complete." }], "stop");
    };
    const start = () => createApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => runtime, imageGenerator: { generate } });
    const prune = vi.spyOn(CheckpointStore.prototype, "prune");
    let app = start();
    try {
      const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Manual retry", type: "web-game" } })).json<ProjectState>();
      await sharp({ create: { width: 4, height: 4, channels: 4, background: "#7733aa88" } }).png().toFile(path.join(project.workspacePath, "front.png"));
      const route = `/projects/${project.id}/conversations`;
      const created = await app.inject({ method: "POST", url: route, payload: { model: { provider: model.provider, id: model.id } } });
      expect(created.statusCode, created.body).toBe(201);
      const chat = `${route}/${created.json().id}`;
      const detail = async () => (await app.inject({ method: "GET", url: chat })).json<ConversationDetail>();
      expect((await app.inject({ method: "POST", url: `${chat}/turns`, payload: { prompt: "Finish the game locally." } })).statusCode).toBe(202);
      await vi.waitFor(async () => {
        const saved = await detail();
        expect(saved.agent.status).toBe("error");
        expect(saved.turns.flatMap(turn => turn.items).some(item => item.type === "userMessage" && item.changes)).toBe(true);
      });
      await app.close();
      app = start();
      const original = (await detail()).turns.find(turn => turn.items.some(item => item.type === "userMessage"))!;
      const retry = (id: string) => app.inject({ method: "POST", url: `${chat}/turns/${id}/retry-local-image-request` });
      expect((await retry("wrong-user")).statusCode).toBe(409);
      const canvas = path.join(project.workspacePath, "canvas");
      const board = JSON.parse(await readFile(path.join(canvas, "index.json"), "utf8")).boards[0].id;
      const editor = path.join(canvas, "editor", `${board}.json`);
      const layout = JSON.parse(await readFile(editor, "utf8"));
      const panned = { ...layout, viewport: { x: 24, y: -114, zoom: 0.85 } };
      await writeFile(editor, JSON.stringify({ ...panned, nodes: { ...panned.nodes, moved: { x: 31, y: 42 } } }));
      expect((await retry(original.id)).statusCode).toBe(409);
      await writeFile(editor, JSON.stringify({ ...panned, viewport: { ...panned.viewport, zoom: -1 } }));
      expect((await retry(original.id)).statusCode).toBe(409);
      await writeFile(editor, JSON.stringify(panned));
      await writeFile(path.join(project.workspacePath, "original.txt"), "user edit");
      expect((await retry(original.id)).statusCode).toBe(409);
      await writeFile(path.join(project.workspacePath, "original.txt"), "once");
      const accepted = await retry(original.id);
      expect(accepted.statusCode, accepted.body).toBe(202);
      expect(accepted.json()).toEqual({ turnId: original.id, queued: false });
      await vi.waitFor(async () => {
        const saved = await detail();
        expect(saved.agent, JSON.stringify(saved.turns.map(turn => turn.items.map(item => [item.type, "error" in item && item.error?.message])))).toMatchObject({ status: "idle" });
        expect(saved.turns).toHaveLength(1);
        expect(saved.turns[0]).toMatchObject({ id: original.id, status: "completed" });
        const items = saved.turns[0]!.items;
        expect(items.filter(item => item.type === "userMessage")).toHaveLength(1);
        expect(items).toContainEqual(expect.objectContaining({ type: "agentMessage", status: "failed", error: expect.objectContaining({ message: failed }) }));
        expect(items).toContainEqual(expect.objectContaining({ type: "retry", source: "manual-local-image", attempt: 1, maxAttempts: 1, status: "completed" }));
        expect(items).toContainEqual(expect.objectContaining({ type: "userMessage", changes: expect.objectContaining({ items: expect.arrayContaining([
          expect.objectContaining({ path: "original.txt" }), expect.objectContaining({ path: "game-recovery.txt" }),
        ]) }) }));
      });
      expect(received.get("same-write")).toContain("reused without executing it again");
      expect(reminder).toContain("no complete published manifest");
      expect(JSON.parse(await readFile(editor, "utf8"))).toEqual(panned);
      expect(await readFile(path.join(project.workspacePath, "game-recovery.txt"), "utf8")).toBe("completed");
      expect((await retry(original.id)).statusCode).toBe(409);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await app.close();
      const pruning = prune.mock.results.map(result => result.value);
      prune.mockRestore();
      await Promise.all(pruning);
    }
  });

  it.each(["preparing", "sealed-unpublished"] as const)("settles a verified %s plan and completes the same plan with stable nodes", async expectedState => {
    const data = await temporaryTestDirectory("character-view-plan-interrupt-");
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#8844cc88" } }).png().toBuffer();
    const library = new AssetLibrary(data);
    const projects = new ProjectManager(data, library);
    const generate = vi.fn<ImageGenerator["generate"]>();
    const tools = new ToolRunner(data, { generate }, undefined, undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("Interrupted directions", "web-game");
    const canvas = new CanvasStore(projects, library, tools);
    const anchor = await projects.getLocalImageRecoveryAnchor(project.id);
    const tool = createCharacterViewTool({ project, conversationId: "plan-interrupt-fixture", projects, canvas, tools,
      authorizeAttachment: () => false, gate: () => {}, journal: async () => new CharacterViewPublicationJournal(anchor),
      sourceProfile: async () => undefined, mutateWorkspace: operation => operation() });
    const context = {} as Parameters<typeof tool.execute>[4];
    const source = { kind: "workspace", reference: "source.png", expectedSha256: hash(png) } as const;
    await writeFile(path.join(project.workspacePath, source.reference), png);
    const input: CharacterViewToolInput = { action: "plan", setId: "courier", expectedAuthoringSha256: null, plan: {
      designRevision: "d1", original: source, baseline: source, identity: "Courier", camera: "Fixed overhead camera",
      stance: "Standing", asymmetry: "Satchel on left hip", displayHeadToGround: 144,
      views: (["N", "NE"] as const).map(direction => ({ direction, viewRevision: "r1", model, prompt: `Face ${direction}`, resolution: "1K", aspectRatio: "1:1", references: [source] })),
    } };
    const controller = new AbortController();
    if (expectedState === "preparing") {
      const createNode = canvas.createAgentMediaNode.bind(canvas);
      vi.spyOn(canvas, "createAgentMediaNode").mockImplementationOnce(async (...args) => {
        const result = await createNode(...args);
        controller.abort();
        return result;
      });
    } else {
      const sealNodes = canvas.sealCharacterViewNodes.bind(canvas);
      vi.spyOn(canvas, "sealCharacterViewNodes").mockImplementationOnce(async (...args) => {
        await sealNodes(...args);
        controller.abort();
      });
    }
    try {
      const response = await tool.execute("interrupted-plan", input, controller.signal, undefined, context);
      expect(getToolConfirmedFailure(response)).toMatchObject({ reason: "character_view_publication_failed" });
      const receipt = response.details!.characterViews;
      expect(receipt).toMatchObject({ state: "failed", effects: {
        ready: false, authoringSha256: null,
        retainedSources: [{ sha256: hash(png), assetId: expect.any(String), path: expect.any(String) }],
        retainedNodes: Array.from({ length: expectedState === "preparing" ? 1 : 2 }, () => expect.objectContaining({ state: expectedState })),
      } });
      if (receipt.state !== "failed") throw new Error("Expected settled partial plan");
      const retained = receipt.effects as { authoringPath: string; retainedNodes: { direction: "N" | "NE"; boardId: string; nodeId: string }[] };
      const authoring = path.join(project.workspacePath, retained.authoringPath);
      await expect(readFile(authoring)).rejects.toMatchObject({ code: "ENOENT" });
      await new CharacterViewPublicationJournal(anchor).assertSettled();
      const { boardId, nodeId } = retained.retainedNodes[0]!;
      await expect(canvas.generateNode(project.id, boardId, nodeId)).rejects.toThrow(/still preparing|has not been committed/);
      const original = await tool.recoverAfterHttp500("interrupted-plan", input, undefined, undefined, context);
      expect(original.details?.characterViews).toEqual(receipt);
      expect(getToolConfirmedFailure(original)).toEqual(getToolConfirmedFailure(response));

      const finished = await tool.execute("finish-same-plan", input, undefined, undefined, context);
      expect(finished.details?.characterViews).toMatchObject({ state: "committed" });
      const ready = JSON.parse(await readFile(authoring, "utf8"));
      for (const node of retained.retainedNodes) expect(ready.views[node.direction]).toMatchObject({ boardId: node.boardId, nodeId: node.nodeId });
      const board = (await canvas.board(project.id, boardId)).board;
      expect(board.nodes.filter(node => node.type === "image").map(node => node.id)).toEqual([ready.views.N.nodeId, ready.views.NE.nodeId]);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await canvas.close();
    }
  });

  it("plans without submitting, reads the managed result, and enforces the visible scale in publish", async () => {
    const data = await temporaryTestDirectory("character-view-tool-");
    const rgba = Buffer.alloc(6 * 7 * 4);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 5; x++) rgba.set([210, 100, 40, 255], (y * 6 + x) * 4);
    const png = await sharp(rgba, { raw: { width: 6, height: 7, channels: 4 } }).png().toBuffer();
    const outputPng = await sharp(png).modulate({ brightness: 0.8 }).png().toBuffer();
    const library = new AssetLibrary(data);
    const projects = new ProjectManager(data, library);
    const generate = vi.fn<ImageGenerator["generate"]>(async () => ({ bytes: outputPng, mediaType: "image/png" }));
    const tools = new ToolRunner(data, { generate }, undefined, undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("Character view test", "web-game");
    const attachment = await new AgentAttachmentStore().store(project, { batchId: randomUUID(), name: "source.png", contents: png });
    const canvas = new CanvasStore(projects, library, tools);
    const journal = new CharacterViewPublicationJournal(await projects.getLocalImageRecoveryAnchor(project.id));
    let enabled = true;
    let attachmentAuthorized = false;
    const tool = createCharacterViewTool({ project, conversationId: "character-fixture", projects, canvas, tools,
      authorizeAttachment: ref => attachmentAuthorized && ref.id === attachment.id && ref.batchId === attachment.batchId,
      gate: () => { if (!enabled) throw new Error("Guide disabled"); },
      journal: async () => journal, sourceProfile: async () => undefined, mutateWorkspace: operation => operation() });
    const context = {} as Parameters<typeof tool.execute>[4];
    const source = { kind: "attachment", reference: `attachment:${attachment.batchId}/${attachment.id}`, expectedSha256: hash(png) } as const;
    const plan: CharacterViewToolInput = { action: "plan", setId: "courier", expectedAuthoringSha256: null, plan: {
      designRevision: "d1", original: source, baseline: source, identity: "Courier", camera: "Fixed overhead camera",
      stance: "Standing", asymmetry: "Satchel on left hip", displayHeadToGround: 144,
      views: [{ direction: "N", viewRevision: "r1", model, prompt: "Face north", resolution: "1K", aspectRatio: "3:4", references: [source] }],
    } };

    try {
      const begin = vi.spyOn(journal, "begin");
      await expect(tool.execute("unauthorized", plan, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "authorization_denied" && /conversation branch/.test(String(error)));
      attachmentAuthorized = true;
      const stale = structuredClone(plan);
      stale.plan!.original = { ...source, expectedSha256: "0".repeat(64) };
      await expect(tool.execute("stale-source", stale, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && /pixels changed/.test(String(error)));
      const local = structuredClone(plan);
      local.plan!.original = { kind: "workspace", reference: "draft.png" };
      await expect(tool.execute("missing-source", local, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && /source is missing/.test(String(error)));
      await writeFile(path.join(project.workspacePath, "draft.png"), png.subarray(0, 32));
      await expect(tool.execute("damaged-source", local, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input");
      expect(begin).not.toHaveBeenCalled();
      begin.mockRestore();
      const first = await tool.execute("plan-first", plan, undefined, undefined, context);
      expect(first.details?.characterViews).toMatchObject({ state: "committed", result: {
        original: { sha256: hash(png), raster: { width: 6, height: 7, bounds: { left: 1, top: 1, right: 5, bottom: 6 }, alpha: { clear: 22, opaque: 20, soft: 0 } } },
      } });
      expect(generate).not.toHaveBeenCalled();
      const authoringPath = path.join(project.workspacePath, "assets/generated/character-sets/courier/authoring.json");
      const authoring = await readFile(authoringPath);
      const ready = JSON.parse(authoring.toString());
      expect(ready.design.original).toMatchObject({ sha256: hash(png) });
      const { boardId, nodeId } = ready.views.N;
      const missingDesign: CharacterViewToolInput = { ...plan, expectedAuthoringSha256: hash(authoring), plan: { designRevision: "d2", views: plan.plan!.views } };
      await expect(tool.execute("missing-design", missingDesign, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && /original, baseline/.test(String(error)));
      await expect(tool.execute("stale-cas", plan, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && String(error).includes(hash(authoring)));

      const retry = { ...structuredClone(plan), expectedAuthoringSha256: hash(authoring) };
      const repeated = retry.plan!.views[0]!;
      if (!("model" in repeated)) throw new Error("Expected the planned generation node");
      repeated.model = { id: model.id, provider: model.provider };
      const prepare = tools.prepare.bind(tools);
      const drift = vi.spyOn(tools, "prepare").mockImplementation(async (...args) => {
        const resolved = await prepare(...args);
        return "images" in resolved && resolved.images?.some(image => image.libraryAssetId)
          ? { ...resolved, prompt: `${resolved.prompt} changed by the host` }
          : resolved;
      });
      try {
        const failure = await tool.execute("recheck-frozen-input", retry, undefined, undefined, context);
        expect(getToolConfirmedFailure(failure)).toMatchObject({ reason: "character_view_publication_failed" });
        expect(failure.details?.characterViews).toMatchObject({ state: "failed", effects: { ready: false } });
        await journal.assertSettled();
        expect(await readFile(authoringPath)).toEqual(authoring);
        expect(generate).not.toHaveBeenCalled();
      } finally {
        drift.mockRestore();
      }
      const job = await canvas.generateNode(project.id, boardId, nodeId);
      await canvas.waitForProject(project.id);
      const retained = await canvas.managedCharacterViewJob(project.id, { jobId: job.id });
      expect(retained?.characterView?.displayHeadToGround).toBe(144);
      const assetId = retained?.run?.files[0]?.assetId;
      expect(assetId).toBeTruthy();
      expect(generate).toHaveBeenCalledOnce();

      const bad: CharacterViewToolInput = { action: "publish", setId: "courier", expectedAuthoringSha256: hash(authoring), publish: {
        designRevision: "d1", purpose: "sample", expectedActiveSha256: null,
        canvas: { width: 16, height: 20 }, pivot: { x: 8, y: 14 }, headToGround: 5,
        views: [{ direction: "N", viewRevision: "r1", source: { kind: "canvas", reference: assetId!, expectedSha256: hash(outputPng) },
          sourceHeadY: 1, sourceGroundPoint: { x: 3, y: 6 }, scale: 0.9, sampling: "nearest", visualReview: "Source checked on both backgrounds" }],
      } };
      await expect(tool.execute("bad-scale", bad, undefined, undefined, context)).rejects.toSatisfy(error =>
        getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && /head-to-ground/.test(String(error)));
      const good = structuredClone(bad);
      good.publish!.views[0]!.scale = 1;
      const wrongDigest = structuredClone(good);
      wrongDigest.publish!.views[0]!.source.expectedSha256 = "b".repeat(64);
      await expect(tool.execute("altered-result", wrongDigest, undefined, undefined, context)).rejects.toThrow("original digest");
      const published = await tool.execute("checked-scale", good, undefined, undefined, context);
      const receipt = published.details?.characterViews;
      expect(receipt?.state).toBe("committed");
      expect(receipt?.state === "committed" && receipt.result).toMatchObject({ manifest: { headToGround: 5, complete: false } });
      expect(generate).toHaveBeenCalledOnce();

      const generated = { kind: "canvas", reference: assetId!, expectedSha256: hash(outputPng) } as const;
      const original = { kind: "canvas", reference: ready.design.original.assetId, expectedSha256: ready.design.original.sha256 } as const;
      attachmentAuthorized = false;
      const adoption: CharacterViewToolInput = { action: "plan", setId: "courier", expectedAuthoringSha256: hash(authoring), plan: { designRevision: "d1", views: [
        { direction: "S", viewRevision: "r1", source: generated },
        { direction: "NE", viewRevision: "r1", model, prompt: "Face northeast", resolution: "1K", aspectRatio: "3:4", references: [generated, original] },
      ] } };

      const seal = canvas.sealCharacterViewNodes.bind(canvas);
      vi.spyOn(canvas, "sealCharacterViewNodes").mockImplementationOnce(async (id, seals) => {
        const { boardId, nodeId: nextId } = seals[0]!;
        const board = await canvas.board(id, boardId);
        const next = board.board.nodes.find(node => node.id === nextId);
        if (next?.type !== "image") throw new Error("Expected a dependent direction node");
        next.data.images[0] = { type: "node", nodeId };
        await canvas.saveBoard(id, board.board, board.revision);
        return seal(id, seals);
      });
      const pinFailure = await tool.execute("reject-mutable-reference", adoption, undefined, undefined, context);
      expect(getToolConfirmedFailure(pinFailure)).toMatchObject({ reason: "character_view_publication_failed" });
      expect(pinFailure.details?.characterViews).toMatchObject({ state: "failed", reason: /Pin a saved image asset/ });
      await journal.assertSettled();
      expect(await readFile(authoringPath)).toEqual(authoring);

      adoption.plan!.views[1]!.viewRevision = "r2";
      await expect(tool.execute("adopt-existing", adoption, undefined, undefined, context)).resolves.toMatchObject({
        details: { characterViews: { state: "committed", result: { views: { S: { accepted: { sha256: hash(outputPng) } } } } } },
      });
      const adopted = JSON.parse(await readFile(authoringPath, "utf8"));
      expect(adopted.design).toEqual(ready.design);
      expect(adopted.views.N).toEqual(ready.views.N);
      const adoptedBoard = (await canvas.board(project.id, adopted.views.NE.boardId)).board;
      const next = adoptedBoard.nodes.find(node => node.id === adopted.views.NE.nodeId);
      if (next?.type !== "image") throw new Error("Expected a dependent direction node");
      const pinned = next.data.images[0];
      expect(pinned?.type === "node" && adoptedBoard.nodes.find(node => node.id === pinned.nodeId)).toMatchObject({
        type: "asset", data: { assetId },
      });

      const promotion: CharacterViewToolInput = { ...adoption, expectedAuthoringSha256: hash(await readFile(authoringPath)), plan: {
        designRevision: "d2", baseline: generated, views: [{ direction: "S", viewRevision: "r1", source: original }],
      } };
      await expect(tool.execute("different-front", promotion, undefined, undefined, context)).rejects.toThrow("same source as baseline");
      promotion.plan!.views = [{ direction: "S", viewRevision: "r1", source: generated },
        { direction: "N", viewRevision: "r1", model, prompt: "Face north using approved front", resolution: "1K", aspectRatio: "3:4", references: [generated] }];
      await expect(tool.execute("promote-front", promotion, undefined, undefined, context)).resolves.toMatchObject({ details: { characterViews: { state: "committed" } } });
      const promoted = JSON.parse(await readFile(authoringPath, "utf8"));
      expect(promoted.design).toEqual({ ...ready.design, baseline: adopted.views.S.accepted });
      expect(promoted.displayHeadToGround).toBe(ready.displayHeadToGround);
      expect(Object.keys(promoted.views)).toEqual(["S", "N"]);
      expect(promoted.views.N.nodeId).not.toBe(ready.views.N.nodeId);
      await journal.assertSettled();
      expect(generate).toHaveBeenCalledOnce();

      enabled = false;
      const replay = await tool.recoverAfterHttp500("checked-scale", good, undefined, undefined, context);
      expect(replay.details?.characterViews).toMatchObject({ state: "committed" });
      await expect(tool.execute("new-plan", plan, undefined, undefined, context)).rejects.toThrow("Guide disabled");

      enabled = true;
      // This intentionally leaves an unresolved journal in a disposable project. It never stages a file.
      const start = journal.begin.bind(journal);
      vi.spyOn(journal, "begin").mockImplementationOnce(identity => start(identity));
      const register = canvas.registerCharacterViewSource.bind(canvas);
      vi.spyOn(canvas, "registerCharacterViewSource").mockImplementationOnce(async (...args) => {
        const registered = await register(...args);
        return { ...registered, assetId: randomUUID() };
      });
      const recheck = { ...promotion, expectedAuthoringSha256: hash(await readFile(authoringPath)) };
      await expect(tool.execute("unverified-registration", recheck, undefined, undefined, context)).rejects.toSatisfy(error =>
        !getToolPreflightFailure(error) && /Cannot verify the original character preparation/.test(String(error)));
      await expect(tool.recoverAfterHttp500("unverified-registration", recheck, undefined, undefined, context)).rejects.toThrow();
    } finally {
      await canvas.close();
    }
  });

  it.each([undefined, "complete-set-and-playtest"] as const)("respects the character delivery scope %s after a normal Pi stop", async delivery => {
    const directory = await temporaryTestDirectory("character-pi-route-");
    const agentDirectory = path.join(directory, "agent");
    await mkdir(agentDirectory);
    await writeFile(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey("anthropic", "local-character-route-fixture-key");
    const model = modelRuntime.getModels("anthropic").find(candidate => candidate.input.includes("image"))!;
    expect(model).toBeDefined();
    model.baseUrl = "http://127.0.0.1:43199";
    const generate = vi.fn<ImageGenerator["generate"]>(async () => { throw new Error("A local adopted view must not generate an image"); });
    const prune = vi.spyOn(CheckpointStore.prototype, "prune");
    const app = createApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => modelRuntime, imageGenerator: { generate } });
    try {
      const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "Character route fixture", type: "web-game" } });
      expect(response.statusCode, response.body).toBe(201);
      const project = response.json<ProjectState>();
      const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#8844cc88" } }).png().toBuffer();
      await writeFile(path.join(project.workspacePath, "source.png"), png);
      const source = { kind: "workspace", reference: "source.png", expectedSha256: hash(png) } as const;
      const plan: CharacterViewToolInput = { action: "plan", setId: "courier", expectedAuthoringSha256: null, plan: {
        designRevision: "d1", ...(delivery ? { delivery } : {}), original: source, baseline: source, identity: "Courier", camera: "Fixed overhead view",
        stance: "Standing", asymmetry: "Own left hip satchel", displayHeadToGround: 144,
        views: [{ direction: "S", viewRevision: "r1", source }],
      } };
      type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
      const define = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
      const calls = [
        define("character-guide", "read_workflow_guide", { guide: "eight-direction-character", reference: "alignment.md" }),
        define("character-tool-search", "tool_search", { query: "prepare_character_views" }),
        define("character-plan", "prepare_character_views", plan),
      ];
      const observed = new Map<string, { text: string; error: boolean }>();
      let normalStops = 0;
      let reminderRole: string | undefined;
      modelRuntime.streamSimple = (runningModel, context) => {
        for (const message of context.messages) if (message.role === "toolResult") {
          observed.set(message.toolCallId, { text: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"), error: message.isError });
        }
        const next = calls.find(call => !observed.has(call.id));
        if (next) return toolReply(runningModel, [next], "toolUse");
        if (normalStops === 1 && !observed.has("read-saved-plan")) {
          reminderRole = context.messages.at(-1)?.role;
          return toolReply(runningModel, [define("read-saved-plan", "read", { path: "assets/generated/character-sets/courier/authoring.json" })], "toolUse");
        }
        if (++normalStops > 2) throw new Error("Pi kept requesting another decision without new character progress");
        return toolReply(runningModel, [{ type: "text", text: "Only S is prepared." }], "stop");
      };
      const route = `/projects/${project.id}/conversations`;
      const conversation = await app.inject({ method: "POST", url: route, payload: { model: { provider: model.provider, id: model.id } } });
      expect(conversation.statusCode, conversation.body).toBe(201);
      const chat = `${route}/${conversation.json().id}`;
      const request = delivery ? "Finish all eight character views and their playable preview." : "Prepare only the front S and pause.";
      const prompt = await app.inject({ method: "POST", url: `${chat}/turns`, payload: { prompt: request } });
      expect(prompt.statusCode, prompt.body).toBe(202);
      await vi.waitFor(async () => {
        const detail = (await app.inject({ method: "GET", url: chat })).json<ConversationDetail>();
        expect(detail.agent.status, JSON.stringify(detail.agent)).toBe("idle");
        expect(observed.has("character-plan")).toBe(true);
        expect(detail.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage")).toHaveLength(1);
      });
      expect(observed.get("character-guide")).toMatchObject({ error: false, text: expect.stringContaining("sourceGroundPoint") });
      expect(observed.get("character-tool-search")).toMatchObject({ error: false, text: expect.stringContaining("expectedAuthoringSha256") });
      expect(observed.get("character-plan")?.error, observed.get("character-plan")?.text).toBe(false);
      expect(JSON.parse(observed.get("character-plan")!.text)).toMatchObject({ state: "committed", result: { views: { S: { accepted: { sha256: hash(png) } } } } });
      expect(normalStops).toBe(delivery ? 2 : 1);
      expect(reminderRole).toBe(delivery ? "system" : undefined);
      if (delivery) expect(observed.get("read-saved-plan")).toMatchObject({ error: false, text: expect.stringContaining('"setId": "courier"') });
      else expect(observed.has("read-saved-plan")).toBe(false);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      try {
        await app.close();
      } finally {
        // A completed turn can still be pruning its checkpoint files after the app closes.
        const pruning = prune.mock.results.map(result => result.value);
        prune.mockRestore();
        await Promise.all(pruning);
      }
    }
  });
});
