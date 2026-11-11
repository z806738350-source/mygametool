import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { conversationItems } from "../src/daemon/agent.js";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.js";
import { gameDesignReference } from "../src/daemon/game-design-context.js";
import { writeCanvasDocument } from "../src/daemon/canvas-workspace.js";
import { createCanvasDocument, canvasDocumentPath } from "../src/shared/canvas-document.js";
import type { ProjectType } from "../src/shared/contracts.js";

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runtime(hold = false, type: ProjectType = "web-game") {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-design-context-"));
  directories.push(directory);
  let sessionManager: SessionManager;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const prompt = vi.fn(async (text: string) => {
    sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    if (hold) await completion;
  });
  const followUp = vi.fn(async (_text: string) => {});
  const app = createApp({
    dataDirectory: directory,
    createSession: async (project, conversation) => {
      sessionManager = SessionManager.open(conversation.sessionPath, path.dirname(conversation.sessionPath), project.workspacePath);
      return { messages: [], sessionManager, prompt, followUp, abort: async () => { finish(); }, dispose: () => {}, subscribe: () => () => {} };
    },
  });
  apps.push(app);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Sky garden", type } })).json();
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
  const url = `/projects/${project.id}/conversations/${conversation.id}/turns`;
  const idle = () => vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/projects/activity" })).json().activity).toEqual([]));
  return { app, project, prompt, followUp, finish, url, idle, items: () => conversationItems(sessionManager.getBranch(), false) };
}

describe("game design prompt context", () => {
  it("exposes agent board writes before the active turn finishes", async () => {
    const { app, project, prompt, finish, url, idle } = await runtime(true);
    const workspaceUrl = `/projects/${project.id}/canvas/workspace`;
    const workspace = (await app.inject({ method: "GET", url: workspaceUrl })).json();
    const boardId = workspace.boards[0].id;
    const boardUrl = `/projects/${project.id}/canvas/boards/${boardId}`;
    const write = createLocalAgentFileTools(project.workspacePath).find((tool) => tool.name === "write")!;
    try {
      await app.inject({ method: "POST", url, payload: { prompt: "Create the design" } });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const document = await writeCanvasDocument(project.workspacePath, { ...createCanvasDocument("Live design"), markdown: "Work in progress" });
      // Registering a document does not add its node to the board.
      expect((await app.inject({ method: "GET", url: workspaceUrl })).json().documents).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: boardUrl })).json().board.nodes).toEqual([]);
      const node = { id: "live-design", type: "document", title: "Live design", data: { documentId: document.document.id } };
      await write.execute("write-board", { path: `canvas/boards/${boardId}.json`, content: JSON.stringify({ version: 1, id: boardId, viewport: { width: 1280, height: 720 }, nodes: [node], edges: [] }) }, undefined, undefined, {} as never);
      const response = await app.inject({ method: "GET", url: boardUrl });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().board.nodes).toMatchObject([node]);
      expect((await app.inject({ method: "GET", url: "/projects/activity" })).json().activity).not.toEqual([]);
    } finally {
      finish();
      await idle();
    }
  });

  it("captures an explicitly referenced Asset Canvas document without a main game design", async () => {
    const { app, project, prompt, url, idle } = await runtime(false, "asset-canvas");
    const detail = await writeCanvasDocument(project.workspacePath, { ...createCanvasDocument("Art brief"), markdown: "A bright garden" }, false);
    const other = await writeCanvasDocument(project.workspacePath, { ...createCanvasDocument("Another brief"), markdown: "Unrelated brief" }, false);
    const response = await app.inject({ method: "POST", url, payload: {
      prompt: "Improve this brief",
      references: [{ type: "workspace-file", path: canvasDocumentPath(detail.document.id) }],
      contexts: [{ kind: "design-document", label: "Art brief", text: "Resolve this from the saved document" }],
    } });
    expect(response.statusCode).toBe(202);
    await idle();
    expect(prompt.mock.calls[0]![0]).toContain("A bright garden");
    expect(prompt.mock.calls[0]![0]).toContain(detail.revision);
    expect(prompt.mock.calls[0]![0]).not.toContain(other.document.markdown);
    expect(prompt.mock.calls[0]![0]).toContain("production references");
  });
  it("refreshes compact metadata on each turn and keeps it out of visible messages", async () => {
    const { app, project, prompt, url, idle, items } = await runtime();
    const document = createCanvasDocument("Sky garden");
    document.markdown = "A long design body";
    const first = await writeCanvasDocument(project.workspacePath, document);
    expect((await app.inject({ method: "POST", url, payload: { prompt: "Build movement" } })).statusCode).toBe(202);
    await idle();
    expect(prompt.mock.calls[0]![0]).toContain(first.revision);
    expect(prompt.mock.calls[0]![0]).not.toContain("A long design body");
    expect(items()).toMatchObject([{ type: "userMessage", text: "Build movement" }]);
    expect(items()[0]).not.toHaveProperty("contexts");

    const second = await writeCanvasDocument(project.workspacePath, { ...document, title: "Revised garden" });
    await app.inject({ method: "POST", url, payload: { prompt: "Adjust movement" } });
    await idle();
    expect(prompt.mock.calls[1]![0]).toContain(second.revision);
    expect(prompt.mock.calls[1]![0]).not.toContain(first.revision);
    await rm(path.join(project.workspacePath, "canvas", "index.json"));
    await app.inject({ method: "POST", url, payload: { prompt: "Discuss movement" } });
    await idle();
    expect(prompt.mock.calls[2]![0]).toContain("currently has no saved main game design");
  });

  it("captures the saved document on submission instead of trusting a stale client context", async () => {
    const { app, project, prompt, url, idle, items } = await runtime();
    const first = await writeCanvasDocument(project.workspacePath, createCanvasDocument("Old title"));
    const updated = { ...first.document, title: "Current title", markdown: "Only implement planting" };
    const latest = await writeCanvasDocument(project.workspacePath, updated);
    const response = await app.inject({ method: "POST", url, payload: {
      prompt: "Review this scope",
      contexts: [{ kind: "design-document", label: "Old title", text: `stale client snapshot ${first.revision}` }],
    } });
    expect(response.statusCode).toBe(202);
    await idle();
    const sent = prompt.mock.calls[0]![0];
    expect(sent).toContain("Only implement planting");
    expect(sent).toContain(latest.revision);
    expect(sent).not.toContain(first.revision);
    expect(sent).toContain(`<workspace-file-references>\n["${canvasDocumentPath(first.document.id)}"]`);
    expect(items()).toMatchObject([{ type: "userMessage", text: "Review this scope", contexts: [{ kind: "design-document", label: `Current title (${latest.revision.slice(0, 8)})` }] }]);
    await writeCanvasDocument(project.workspacePath, { ...updated, title: "Another revision" });
    expect(sent).toContain("Current title");
    expect(sent).not.toContain("Another revision");
  });

  it("leaves projects without a design usable and rejects an explicit missing document", async () => {
    const { app, prompt, url, idle } = await runtime();
    expect((await app.inject({ method: "POST", url, payload: { prompt: "Hello" } })).statusCode).toBe(202);
    await idle();
    expect(prompt).toHaveBeenCalledWith("Hello");
    const missing = await app.inject({ method: "POST", url, payload: {
      prompt: "Review design",
      contexts: [{ kind: "design-document", label: "Game design", text: "Reference it" }],
    } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toContain("does not have a game design document");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("captures the updated design for a queued follow-up while preserving the running turn", async () => {
    const { app, project, prompt, followUp, finish, url, idle } = await runtime(true);
    const first = await writeCanvasDocument(project.workspacePath, createCanvasDocument("First garden"));
    try {
      await app.inject({ method: "POST", url, payload: { prompt: "Build movement" } });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const next = await writeCanvasDocument(project.workspacePath, { ...first.document, title: "Updated garden" });
      const queued = await app.inject({ method: "POST", url, payload: {
        prompt: "Review the updated design next",
        contexts: [{ kind: "design-document", label: "Game design", text: "Reference it" }],
      } });
      expect(queued.statusCode).toBe(202);
      expect(queued.json().queued).toBe(true);
      expect(followUp.mock.calls[0]![0]).toContain(next.revision);
      expect(followUp.mock.calls[0]![0]).toContain("Document snapshot");
      expect(prompt.mock.calls[0]![0]).toContain(first.revision);
      expect(prompt.mock.calls[0]![0]).not.toContain(next.revision);
    } finally {
      finish();
      await idle();
    }
  });

  it("includes Markdown image references in the immutable snapshot", () => {
    const document = createCanvasDocument("Garden");
    document.markdown = "![Gardener](../../assets/generated/gardener.png)";
    const context = gameDesignReference({ document, revision: "abc12345" });
    expect(context.text).toContain("assets/generated/gardener.png");
    expect(context.text).not.toContain("rejected.png");
    expect(context.text).toContain("Image links do not include image pixels");
    expect(context.text).toContain("saved Markdown source");
  });
});
