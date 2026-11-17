import { open, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { MEDIA_FILE_TYPES } from "../src/shared/media-files.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { readCanvasBoard } from "../src/daemon/canvas-workspace.js";
import { createAgentAttachmentReadTool, createLocalAgentFileTools, createProjectFileReadTool, localAgentPath } from "../src/daemon/agent-local-files.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { AgentAttachmentStore, getAttachmentReferences, resolveAgentAttachment, type AttachmentReference } from "../src/daemon/agent-attachments.js";
import { INLINE_IMAGE_HIGH_BYTES } from "../src/daemon/session-images.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import { assertLocalExecutionAllowed } from "../src/daemon/local-execution-policy.js";
import { ensureProjectDependencies } from "../src/daemon/project-dependencies.js";
import { projectProcessEnvironment } from "../src/daemon/project-process.js";
import { createPiSession, loadPiSkillCatalog, type RuntimeModel } from "../src/daemon/agent.js";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { AgentProcess, setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import { ExternalMcpService } from "../src/daemon/external-mcp.js";
import { PluginMcpHost } from "../src/daemon/plugin-mcp-host.js";
import { PluginIntegrationHost } from "../src/daemon/plugin-integration.js";
import { installPlugin } from "../src/daemon/plugin-installer.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { fileChangeMetadata, MAX_CHANGE_BYTES } from "../src/daemon/file-line-changes.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";

const fileFault = vi.hoisted(() => ({ point: "", target: "" }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      if (fileFault.point === "mkdir" && String(args[0]) === fileFault.target) throw new Error("Simulated failure after mkdir");
      return result;
    }) as typeof actual.mkdir,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== fileFault.target || typeof args[1] !== "number" || !(args[1] & 2)) return handle;
      if (fileFault.point === "create") {
        await handle.close();
        throw new Error("Simulated failure after opening a new file");
      }
      if (fileFault.point === "truncate") {
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (length) => { await truncate(length); throw new Error("Simulated failure after truncation"); };
      }
      if (fileFault.point === "write") {
        handle.writeFile = async () => {
          await handle.write("partial", 0, "utf8");
          throw Object.assign(new Error("Simulated partial write failure"), { code: "EACCES", notExecuted: true });
        };
      }
      if (fileFault.point === "close") {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw new Error("Simulated failure after closing the written file"); };
      }
      return handle;
    },
  };
});

const directories: string[] = [];
afterEach(async () => { fileFault.point = ""; fileFault.target = ""; await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-safe-agent-"));
  directories.push(directory);
  return directory;
}
async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (cause) { return cause; }
  throw new Error("Expected the operation to be rejected");
}

it.each(["ls", "find", "grep"])("uses the project root for an omitted or empty %s directory without relaxing protected paths", async name => {
  const directory = await workspace(), outside = await workspace();
  await writeFile(path.join(directory, "game.js"), "const needle = true;\n");
  await writeFile(path.join(directory, ".env"), "private-directory-fixture");
  await symlink(outside, path.join(directory, "linked"));
  const registered = createLocalAgentFileTools(directory), guard = new AutoContinueTools(registered);
  const tools = guard.wrap(), listing = tools.find(tool => tool.name === name)!;
  const args = name === "ls" ? {} : { pattern: name === "grep" ? "needle" : "" };
  const invoke = (id: string, input: object) => listing.execute(id, input, undefined, undefined, {} as never);
  const root = await invoke("dot", { ...args, path: "." });
  expect(await invoke("omitted", args)).toEqual(root);
  expect(await invoke("empty", { ...args, path: "" })).toEqual(root);
  expect(JSON.stringify(root)).toContain("game.js");
  expect(JSON.stringify(root)).not.toContain("private-directory-fixture");
  await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
  await tools.find(tool => tool.name === "write")!.execute("continue-local", { path: "continued.txt", content: "continued" }, undefined, undefined, {} as never);
  expect(await readFile(path.join(directory, "continued.txt"), "utf8")).toBe("continued");
  const original = registered.find(tool => tool.name === name)!;
  for (const requested of ["../outside", outside, ".env", "linked"]) {
    const failure = await rejected(original.execute("unsafe-" + requested, { ...args, path: requested }, undefined, undefined, {} as never));
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "unsafe_path", disposition: "blocked" });
  }
  await expect(localAgentPath(directory, "")).rejects.toThrow("relative project path");
});

it("provides a native agent only a controlled current-project reread, without attachment or host-file fallbacks", async () => {
  const directory = await workspace(), outside = await workspace();
  await writeFile(path.join(directory, "game.js"), "export const current = true;");
  await writeFile(path.join(directory, ".env"), "offline-private-fixture");
  await writeFile(path.join(outside, "outside.js"), "outside fixture");
  await symlink(path.join(outside, "outside.js"), path.join(directory, "linked.js"));
  const read = createProjectFileReadTool(directory);
  const bridge = new ToolBridge([read, ...createLocalAgentFileTools(directory)]);
  const names = bridge.list().map(tool => tool.name);
  expect(names).toContain("read_project_file");
  for (const name of ["read", "write", "edit", "bash"]) expect(names).not.toContain(name);
  expect(projectPiToolNames("normal", [], names)).toContain("read_project_file");
  expect(projectPiToolNames("planning", [], names)).toContain("read_project_file");
  const current = await bridge.call("read_project_file", { path: "game.js" }, "current");
  expect(current.isError).toBe(false);
  expect(current.result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("current = true") }));
  for (const file of ["attachment:00000000-0000-4000-8000-000000000000", "https://example.invalid/image.png", "../outside.js", path.join(outside, "outside.js"), "linked.js", ".env"]) {
    const result = await bridge.call("read_project_file", { path: file }, "refused-" + file);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result.content)).not.toContain("offline-private-fixture");
  }
});
const REFERENCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMIbrGaCcMMyBwAgE4J/ZR8Jv0AAAAASUVORK5CYII=", "base64");
async function storedAttachment(name: string, contents: Buffer) {
  const directory = await workspace();
  const project = { workspacePath: directory } as ProjectState;
  const store = new AgentAttachmentStore();
  const attachment = await store.store(project, { batchId: "f2da1f75-4d77-462f-a75b-48dff99b7212", name, contents });
  const resolved = await resolveAgentAttachment(directory, attachment);
  const reference = `attachment:${attachment.batchId}/${attachment.id}`;
  const authorize = ({ batchId, id }: AttachmentReference) => batchId === attachment.batchId && id === attachment.id;
  return { directory, store, attachment, resolved, reference, authorize };
}

describe("local secure execution boundaries", () => {
  it.each(["missing", "ambiguous"])("retains a %s edit rejection without replaying it across continuation", async (kind) => {
    const directory = await workspace(), file = path.join(directory, "game.js");
    await writeFile(file, "alpha alpha\n");
    const guard = new AutoContinueTools(createLocalAgentFileTools(directory));
    const tools = guard.wrap(), edit = tools.find(tool => tool.name === "edit")!;
    const args = { path: "game.js", oldText: kind === "missing" ? "absent" : "alpha", newText: "wrong" };
    const failure = await rejected(edit.execute("rejected-edit", args, undefined, undefined, undefined as never));
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", disposition: "correctable", reason: "edit_text_not_unique" });
    expect(await readFile(file, "utf8")).toBe("alpha alpha\n");
    await guard.prepare(new AbortController().signal);
    await expect(edit.execute("rejected-edit", args, undefined, undefined, undefined as never)).rejects.toBe(failure);
    await tools.find(tool => tool.name === "read")!.execute("fresh-read", { path: "game.js" }, undefined, undefined, undefined as never);
    await edit.execute("corrected-edit", { path: "game.js", oldText: "alpha alpha", newText: "beta" }, undefined, undefined, undefined as never);
    expect(await readFile(file, "utf8")).toBe("beta\n");
  });

  it.each(["oversized", "json", "schema"])("classifies a pure %s write preflight without creating its parent", async (kind) => {
    const directory = await workspace(), write = createLocalAgentFileTools(directory).find(tool => tool.name === "write")!;
    const relative = kind === "oversized" ? "new/file.txt" : "canvas/boards/board.json";
    const content = kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : kind === "json" ? "{" : "{}";
    const failure = await rejected(write.execute("invalid-write", { path: relative, content }, undefined, undefined, undefined as never));
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", disposition: "correctable", reason: kind === "oversized" ? "text_too_large" : "invalid_canvas_document" });
    await expect(lstat(path.join(directory, relative.split("/")[0]!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks protected read and media targets while ordinary missing-file reads stay retryable", async () => {
    const directory = await workspace(), guard = new AutoContinueTools(createLocalAgentFileTools(directory));
    const read = guard.wrap().find(tool => tool.name === "read")!;
    const missing = await rejected(read.execute("missing", { path: "missing.txt" }, undefined, undefined, undefined as never));
    expect(getToolPreflightFailure(missing)).toBeUndefined();
    await guard.prepare(new AbortController().signal);
    const denied = await rejected(read.execute("private", { path: "../outside" }, undefined, undefined, undefined as never));
    expect(getToolPreflightFailure(denied)).toEqual({ effect: "none", disposition: "blocked", reason: "unsafe_path" });
    await expect(guard.prepare(new AbortController().signal)).rejects.toThrow();
    const write = createLocalAgentFileTools(directory).find(tool => tool.name === "write")!;
    const media = await rejected(write.execute("media", { path: "original.png", content: "text" }, undefined, undefined, undefined as never));
    expect(getToolPreflightFailure(media)?.disposition).toBe("blocked");
    await expect(lstat(path.join(directory, "original.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["mkdir", "create", "truncate", "write", "close"])("keeps failure after %s unknown even if content writing was not completed", async (point) => {
    const directory = await realpath(await workspace()), file = path.join(directory, "nested", "game.js");
    if (!["mkdir", "create"].includes(point)) {
      await mkdir(path.dirname(file));
      await writeFile(file, "before");
    }
    const guard = new AutoContinueTools(createLocalAgentFileTools(directory));
    const write = guard.wrap().find(tool => tool.name === "write")!;
    fileFault.point = point; fileFault.target = point === "mkdir" ? path.dirname(file) : file;
    const failure = await rejected(write.execute("uncertain-write", { path: "nested/game.js", content: "after" }, undefined, undefined, undefined as never));
    fileFault.point = ""; fileFault.target = "";
    expect(getToolPreflightFailure(failure)).toBeUndefined();
    await expect(guard.prepare(new AbortController().signal)).rejects.toThrow("unconfirmed");
    if (point === "mkdir") {
      expect((await lstat(path.dirname(file))).isDirectory()).toBe(true);
      await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } else expect(await readFile(file, "utf8")).toBe(point === "write" ? "partial" : point === "close" ? "after" : "");
  });
  it.each(["image", "video", "audio", "model"] as const)("persists valid %s asset boards through Agent write/edit and the canvas reader", async (mediaType) => {
    const directory = await workspace();
    const { editorLayout: _layout, ...board } = { ...createCanvasBoard(), id: "board" };
    const content = JSON.stringify({ ...board, nodes: [{ id: "asset", type: "asset", data: { assetId: "media", mediaType } }] });
    const tools = createLocalAgentFileTools(directory);
    await tools.find((tool) => tool.name === "write")!.execute("write", { path: "canvas/boards/board.json", content }, undefined, undefined, {} as never);
    await tools.find((tool) => tool.name === "edit")!.execute("edit", { path: "canvas/boards/board.json", oldText: '"assetId":"media"', newText: '"assetId":"updated"' }, undefined, undefined, {} as never);
    expect((await readCanvasBoard(directory, "board"))!.board.nodes[0]!.data).toEqual({ assetId: "updated", mediaType });
  });

  it("rejects incomplete asset board writes and edits without changing the saved board", async () => {
    const directory = await workspace();
    const { editorLayout: _layout, ...board } = { ...createCanvasBoard(), id: "board" };
    const content = JSON.stringify({ ...board, nodes: [{ id: "asset", type: "asset", data: { assetId: "media", mediaType: "image" } }] });
    const tools = createLocalAgentFileTools(directory);
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    await write.execute("valid", { path: "canvas/boards/board.json", content }, undefined, undefined, {} as never);
    for (const requested of ["canvas/boards/board.json", "./canvas//boards/board.json", "canvas\\boards\\board.json"]) {
      await expect(write.execute("invalid", { path: requested, content: content.replace(',"mediaType":"image"', "") }, undefined, undefined, {} as never)).rejects.toThrow("mediaType");
    }
    await expect(edit.execute("invalid", { path: "canvas/boards/board.json", oldText: ',"mediaType":"image"', newText: "" }, undefined, undefined, {} as never)).rejects.toThrow("mediaType");
    expect(await readFile(path.join(directory, "canvas/boards/board.json"), "utf8")).toBe(content);
    expect((await readCanvasBoard(directory, "board"))!.board.nodes[0]!.data).toEqual({ assetId: "media", mediaType: "image" });
  });

  it.each([
    ["{", "invalid JSON"],
    [JSON.stringify({ version: 1, id: "board", viewport: { width: 1280, height: 720 }, nodes: [{ id: "asset", type: "asset", data: { assetId: "media", mediaType: "unknown" } }], edges: [] }), "mediaType"],
    [JSON.stringify({ version: 1, id: "different", viewport: { width: 1280, height: 720 }, nodes: [], edges: [] }), "file name"],
  ])("does not create a board for invalid content %s", async (content, error) => {
    const directory = await workspace();
    const write = createLocalAgentFileTools(directory).find((tool) => tool.name === "write")!;
    await expect(write.execute("invalid", { path: "canvas/boards/board.json", content }, undefined, undefined, {} as never)).rejects.toThrow(error);
    await expect(readFile(path.join(directory, "canvas/boards/board.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes mutation tools and retains bounded live diff metadata without private original content", async () => {
    const directory = await workspace();
    const tools = createLocalAgentFileTools(directory);
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    expect(write.executionMode).toBe("sequential");
    expect(edit.executionMode).toBe("sequential");
    const result = await write.execute("write", { path: "notes.txt", content: "first\nsecond\n" }, undefined, undefined, {} as never);
    expect(fileChangeMetadata(result.details as Record<string, unknown>)).toMatchObject({ lineChanges: { added: 2, removed: 0 }, fileDiff: { hunks: [[{ kind: "added", text: "first", after: 1 }, { kind: "added", text: "second", after: 2 }]] } });
    const edited = await edit.execute("edit", { path: "notes.txt", oldText: "first", newText: "changed" }, undefined, undefined, {} as never);
    expect(fileChangeMetadata(edited.details as Record<string, unknown>).lineChanges).toEqual({ added: 1, removed: 1 });
    await writeFile(path.join(directory, "large.txt"), "x".repeat(MAX_CHANGE_BYTES + 1));
    expect((await write.execute("large", { path: "large.txt", content: "small" }, undefined, undefined, {} as never)).details).toBeUndefined();
    const secret = "local-tool-before-diff-secret-canary-20261028";
    registerSensitiveValue(secret);
    await writeFile(path.join(directory, "original.txt"), secret);
    const replaced = await write.execute("private-before", { path: "original.txt", content: "public replacement" }, undefined, undefined, {} as never);
    expect(replaced.details).toBeUndefined();
    expect(JSON.stringify(replaced)).not.toContain(secret);
  });

  it("does not publish successful diff metadata for a cancelled or failed mutation", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, "notes.txt"), "original");
    const tools = createLocalAgentFileTools(directory);
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(write.execute("cancelled", { path: "notes.txt", content: "changed" }, cancellation.signal, undefined, {} as never)).rejects.toThrow();
    await expect(edit.execute("failed", { path: "notes.txt", oldText: "missing", newText: "changed" }, undefined, undefined, {} as never)).rejects.toThrow("exactly once");
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe("original");
  });

  it("rejects text-only Agent images and screenshot history without registering visual tools", async () => {
    const directory = await workspace();
    const agentDir = path.join(directory, "agent-config");
    await mkdir(agentDir);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model: RuntimeModel = { ...runtime.getModels("openai")[0]!, provider: "custom-provider", id: "text-only", api: "openai-responses", input: ["text"] };
    const gameTool = { ...createLocalAgentFileTools(directory)[0]!, name: "game_use" };
    const session = await createPiSession({ workspacePath: directory, type: "general" }, SessionManager.inMemory(directory), [gameTool], runtime, model, agentDir);
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
    try {
      expect(session.getAllTools?.().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["game_use"]));
      expect(session.getAllTools?.().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["recall_image"]));
      await expect((session as AgentSession).prompt("Inspect this screenshot", { images: [image] })).rejects.toThrow("image input enabled");
      expect((session as AgentSession).messages).toEqual([]);
      await expect(async () => (session as AgentSession).agent.streamFunction(model, normalizeContext({
        messages: [{ role: "toolResult", toolCallId: "legacy-image", toolName: "game_use", isError: false, timestamp: 1, content: [image] }],
      }))).rejects.toThrow("image input enabled");
      expect(request).not.toHaveBeenCalled();
    } finally { session.dispose(); vi.unstubAllGlobals(); }
  });

  it("keeps Kunpo Fable's tool registry empty and refuses incompatible saved history", async () => {
    const directory = await workspace(), agentDir = path.join(directory, "agent-config");
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "write"] }));
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model: RuntimeModel = { ...runtime.getModels("anthropic")[0]!, provider: "kunpo", id: "claude-fable-5-2", input: ["text"] };
    const history = SessionManager.inMemory(directory);
    history.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
    const guide = { ...createLocalAgentFileTools(directory)[0]!, name: "read_workflow_guide" };
    const openSession = () => createPiSession({ workspacePath: directory, type: "general" }, history, [guide], runtime, model, agentDir);
    const session = await openSession();
    try {
      expect(session.getAllTools?.()).toEqual([]);
      expect((session as AgentSession).systemPrompt).toContain("This connection has no tools or image input.");
      session.setActiveToolsByName?.(["read", "write", "bash", guide.name]);
      expect((session as AgentSession).getActiveToolNames()).toEqual([]);
    } finally { session.dispose(); }
    history.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "retained" }], isError: false, timestamp: 2 });
    const before = history.getBranch();
    await expect(openSession()).rejects.toThrow("Start a new text conversation");
    expect(history.getBranch()).toEqual(before);
  });

  it("excludes executable tools from Pi's registry even with saved default tool and package settings", async () => {
    const directory = await workspace();
    const agentDir = path.join(directory, "agent-config");
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["bash"], packages: ["npm:never-download-this"],
      retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 2 } }, cacheWarming: "idle" }));
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const optimize = { ...createLocalAgentFileTools(directory)[0]!, name: "optimize_image_asset" };
    const three = { ...optimize, name: "prepare_three_runtime" };
    const catalog = { ...optimize, name: "list_media_capabilities" };
    const guide = { ...optimize, name: "read_workflow_guide" };
    const referenceImage = { ...optimize, name: "generate_reference_image" };
    const session = await createPiSession({ workspacePath: directory, type: "web-game" }, SessionManager.inMemory(directory), [optimize, three, catalog, guide, referenceImage], runtime, undefined, agentDir);
    try {
      expect(session.getAllTools?.().map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write", "edit", "recall_image"]));
      expect(session.getAllTools?.().map((tool) => tool.name)).toContain("optimize_image_asset");
      expect((session.getAllTools?.() as Array<{ name: string; description?: string }> | undefined)?.find((tool) => tool.name === "read")?.description).toContain("Image input is unavailable for this model");
      expect(session.getAllTools?.().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["bash"]));
      session.setActiveToolsByName?.(["bash", "powershell", "read"]);
      expect((session as AgentSession).getActiveToolNames()).toEqual(["read"]);
      session.setActiveToolsByName?.(["optimize_image_asset", "prepare_three_runtime", "bash"]);
      expect((session as AgentSession).getActiveToolNames()).toEqual(["optimize_image_asset", "prepare_three_runtime"]);
      for (const mode of ["planning", "normal"] as const) {
        session.setActiveToolsByName?.(projectPiToolNames(mode, ["generate-image"], session.getAllTools!().map(tool => tool.name)));
        const active = (session as AgentSession).getActiveToolNames();
        expect(active).toEqual(expect.arrayContaining(["list_media_capabilities", "read_workflow_guide"]));
        expect(active.includes("generate_reference_image")).toBe(mode === "normal");
      }
      const settings = (session as AgentSession).settingsManager;
      expect(settings.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 0 });
      expect(settings.getProviderRetrySettings()).toMatchObject({ maxRetries: 0 });
      expect(settings.getCacheWarmingMode()).toBe("off");
      expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"))).toMatchObject({ retry: { enabled: true }, cacheWarming: "idle" });
    } finally { session.dispose(); }
  });

  it("keeps other native runtimes unavailable even with saved enabled settings", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, "agent-runtimes.json"), JSON.stringify({ version: 1, runtimes: { "claude-code-cli": { enabled: true, permissionMode: "full" } } }));
    const service = new AgentRuntimeService(directory, () => "http://127.0.0.1:43110");
    await service.load();
    expect((await service.status("claude-code-cli", true)).enabled).toBe(false);
    expect(await service.models()).toEqual({ models: [], loading: [] });
    expect(await service.codexImageConnection(true)).toBeUndefined();
    await expect(service.login("claude-code-cli")).rejects.toThrow("temporarily unavailable");
    expect(() => assertLocalExecutionAllowed("shell")).toThrow("temporarily unavailable");
  });

  it("rejects process, plugin and MCP entry points before any connection or process starts", async () => {
    const spawn = vi.fn();
    setAgentProcessSpawner(spawn as never);
    try {
      expect(() => new AgentProcess({ binaryPath: "/never-run", args: [], cwd: "/", env: {} })).toThrow("temporarily unavailable");
      expect(spawn).not.toHaveBeenCalled();
    } finally { setAgentProcessSpawner(undefined); }
    const mcp = new PluginMcpHost();
    await expect(mcp.extension({ mcpServers: {} })).rejects.toThrow("temporarily unavailable");
    await expect(mcp.probe("test", "test", { command: "/never-run" }, "/", "test")).rejects.toThrow("temporarily unavailable");
    const host = new PluginIntegrationHost({} as never);
    expect(() => host.start({} as never, "prepare")).toThrow("temporarily unavailable");
    const git = vi.fn();
    await expect(installPlugin({} as never, { type: "git", url: "https://example.com/plugin.git" }, git)).rejects.toThrow("temporarily unavailable");
    expect(git).not.toHaveBeenCalled();
  });

  it("does not resolve or load ambient skills from a saved agent folder", async () => {
    const directory = await workspace();
    const resolve = vi.fn();
    expect(await loadPiSkillCatalog(directory, directory, resolve)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects external MCP enable even if a caller bypasses the settings UI", async () => {
    const directory = await workspace();
    const service = new ExternalMcpService({ dataDirectory: directory, projects: () => [], tools: () => [], catalog: () => [] });
    await service.load();
    await expect(service.setEnabled(true)).rejects.toThrow("temporarily unavailable");
    expect(service.enabled).toBe(false);
    expect((await service.handle({ body: {}, authorization: "Bearer old-token", sessionId: undefined, roots: undefined })).status).toBe(403);
    await service.close();
  });

  it("refuses dependency installation before invoking a runner or changing workspace files", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, "package.json"), "{}");
    const run = vi.fn();
    await expect(async () => ensureProjectDependencies(directory, "npm", run)).rejects.toThrow("temporarily unavailable");
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, "package.json"), "utf8")).toBe("{}");
  });

  it("passes only a minimal environment, never keys, home, proxy credentials or daemon settings", () => {
    const secret = "fake-key-canary-local-only";
    const environment = projectProcessEnvironment({ PATH: "/runtime/bin", TMPDIR: "/tmp", HOME: "/private/home", API_KEY: secret, HTTPS_PROXY: `http://user:${secret}@proxy`, OHMYGAME_DAEMON_TOKEN: secret });
    expect(environment).toEqual({ PATH: "/runtime/bin", TMPDIR: "/tmp" });
    expect(JSON.stringify(environment)).not.toContain(secret);
  });
});

describe("project-local agent file tools", () => {
  it("inspects all original bytes despite short reads before allowing text replacement", async () => {
    const directory = await workspace();
    const filename = path.join(directory, "short.bin");
    const original = Buffer.from([65, 66, 67, 68, 0, 69]);
    await writeFile(filename, original);
    const handle = await open(filename, "r");
    const prototype = Object.getPrototypeOf(handle);
    const read = prototype.read;
    await handle.close();
    const spy = vi.spyOn(prototype, "read").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (Buffer.isBuffer(args[0]) && typeof args[2] === "number") args[2] = Math.min(args[2], 2);
      return read.apply(this, args);
    });
    try {
      const write = createLocalAgentFileTools(directory).find((tool) => tool.name === "write")!;
      await expect(write.execute("short", { path: "short.bin", content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow("binary");
      expect(spy.mock.calls.length).toBeGreaterThan(1);
    } finally { spy.mockRestore(); }
    expect(await readFile(filename)).toEqual(original);
  });

  it("searches a single safe project file without treating it as a directory", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, "board.schema.json"), '{"nodes": []}');
    const grep = createLocalAgentFileTools(directory).find((tool) => tool.name === "grep")!;
    const result = await grep.execute("grep-file", { pattern: "nodes", path: "board.schema.json" }, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: "text", text: 'board.schema.json:1:{"nodes": []}' }]);
  });

  it("reads generated raster bytes above the text limit only for image-capable models", async () => {
    const directory = await workspace();
    const bytes = Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), Buffer.alloc(1024 * 1024 + 10)]);
    await writeFile(path.join(directory, "mockup.png"), bytes);
    const read = createLocalAgentFileTools(directory, undefined, true).find((tool) => tool.name === "read")!;
    const result = await read.execute("image", { path: "mockup.png" }, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);
    const textRead = createLocalAgentFileTools(directory).find((tool) => tool.name === "read")!;
    await expect(textRead.execute("text-only", { path: "mockup.png" }, undefined, undefined, {} as never)).rejects.toThrow("image input enabled");
    const secret = "image-read-protected-canary-20261106";
    registerSensitiveValue(secret);
    await writeFile(path.join(directory, "secret.png"), Buffer.concat([bytes, Buffer.from(secret)]));
    await expect(read.execute("secret", { path: "secret.png" }, undefined, undefined, {} as never)).rejects.toThrow("Protected credential");
    await writeFile(path.join(directory, "placeholder.png"), "placeholder");
    await expect(read.execute("invalid", { path: "placeholder.png" }, undefined, undefined, {} as never)).rejects.toThrow("does not contain a supported");
    await link(path.join(directory, "mockup.png"), path.join(directory, "linked.png"));
    await expect(read.execute("linked", { path: "linked.png" }, undefined, undefined, {} as never)).rejects.toThrow("non-linked");
  });

  it.each(["png", "jpeg", "webp"] as const)("reads an authorized %s attachment receipt as original image bytes without a filename extension", async (format) => {
    const bytes = format === "png" ? REFERENCE_PNG : await sharp(REFERENCE_PNG).toFormat(format).toBuffer();
    const fixture = await storedAttachment("reference.data", bytes);
    const authorize = vi.fn(fixture.authorize);
    const read = createLocalAgentFileTools(fixture.directory, undefined, true, authorize).find((tool) => tool.name === "read")!;
    expect((await read.execute("image", { path: fixture.reference }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "image", mimeType: `image/${format}`, data: bytes.toString("base64") }]);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenNthCalledWith(1, { batchId: fixture.attachment.batchId, id: fixture.attachment.id }, undefined);
    expect(await readFile(fixture.resolved.absolutePath)).toEqual(bytes);
    const scoped = createAgentAttachmentReadTool(fixture.directory, true, fixture.authorize);
    expect(scoped.name).toBe("read_attachment");
    expect((await scoped.execute("scoped", { path: fixture.reference }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "text", text: expect.stringContaining("OhMyGame did not generate a text caption") }, { type: "image", mimeType: `image/${format}`, data: bytes.toString("base64") }]);
  });

  it("denies attachment reads without current-branch authorization, including text receipts", async () => {
    for (const [name, bytes] of [["reference.png", REFERENCE_PNG], ["notes.txt", Buffer.from("private branch notes")]] as const) {
      const fixture = await storedAttachment(name, bytes);
      for (const authorize of [undefined, () => false, ({ id }: AttachmentReference) => id !== fixture.attachment.id]) {
        const read = createLocalAgentFileTools(fixture.directory, undefined, true, authorize).find((tool) => tool.name === "read")!;
        await expect(read.execute("denied", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("current conversation branch");
        await expect(createAgentAttachmentReadTool(fixture.directory, true, authorize).execute("denied", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("current conversation branch");
      }
    }
    const read = createAgentAttachmentReadTool(await workspace(), true, () => false);
    await expect(read.execute("not-on-disk", { path: "attachment:f2da1f75-4d77-462f-a75b-48dff99b7212/ff9912c2-49ec-471a-9574-aa5560430e80" }, undefined, undefined, {} as never)).rejects.toThrow("current conversation branch");
  });

  it("rechecks attachment authorization and cancellation before releasing text or image content", async () => {
    for (const [name, bytes] of [["reference.png", REFERENCE_PNG], ["notes.txt", Buffer.from("first\nsecond\nthird")]] as const) {
      const fixture = await storedAttachment(name, bytes);
      const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const read = createAgentAttachmentReadTool(fixture.directory, true, authorize);
      await expect(read.execute("revoked", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("current conversation branch");
      expect(authorize).toHaveBeenCalledTimes(2);
      const controller = new AbortController();
      const cancel = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => { controller.abort(); return true; });
      await expect(createAgentAttachmentReadTool(fixture.directory, true, cancel).execute("cancelled", { path: fixture.reference }, controller.signal, undefined, {} as never)).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(await readFile(fixture.resolved.absolutePath)).toEqual(bytes);
    }
  });

  it("retains text pagination but rejects image receipt pagination and text-only image input", async () => {
    const textFixture = await storedAttachment("notes.txt", Buffer.from("first\nsecond\nthird"));
    const textRead = createLocalAgentFileTools(textFixture.directory, undefined, false, textFixture.authorize)[0]!;
    expect((await textRead.execute("text", { path: textFixture.reference, offset: 2, limit: 1 }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "text", text: "second" }]);
    const fixture = await storedAttachment("reference.png", REFERENCE_PNG);
    const read = createLocalAgentFileTools(fixture.directory, undefined, true, fixture.authorize)[0]!;
    for (const pagination of [{ offset: 1 }, { limit: 1 }]) {
      await expect(read.execute("partial", { path: fixture.reference, ...pagination }, undefined, undefined, {} as never)).rejects.toThrow("offset or limit");
    }
    await expect(createAgentAttachmentReadTool(fixture.directory, false, fixture.authorize).execute("text-only", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("image input enabled");
    expect(await readFile(fixture.resolved.absolutePath)).toEqual(REFERENCE_PNG);
  });

  it("bounds attachment image bytes and validates actual format and complete raster decoding", async () => {
    const oversized = await storedAttachment("large.png", Buffer.concat([REFERENCE_PNG, Buffer.alloc(INLINE_IMAGE_HIGH_BYTES)]));
    await expect(createAgentAttachmentReadTool(oversized.directory, true, oversized.authorize).execute("oversized", { path: oversized.reference }, undefined, undefined, {} as never)).rejects.toThrow("20 MiB");
    const invalid = await storedAttachment("invalid.png", REFERENCE_PNG.subarray(0, 24));
    await expect(createAgentAttachmentReadTool(invalid.directory, true, invalid.authorize).execute("invalid", { path: invalid.reference }, undefined, undefined, {} as never)).rejects.toThrow("not a valid");
    const mismatch = await storedAttachment("reference.png", REFERENCE_PNG);
    const metadataPath = path.join(mismatch.directory, ".data/agent-attachments", mismatch.attachment.batchId, "metadata", `${mismatch.attachment.id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, mediaType: "image/jpeg" }));
    await expect(createAgentAttachmentReadTool(mismatch.directory, true, mismatch.authorize).execute("mismatch", { path: mismatch.reference }, undefined, undefined, {} as never)).rejects.toThrow("Invalid stored attachment");
    const gif = await storedAttachment("reference.gif", Buffer.from("GIF89a synthetic unsupported image"));
    await expect(createAgentAttachmentReadTool(gif.directory, true, gif.authorize).execute("gif", { path: gif.reference }, undefined, undefined, {} as never)).rejects.toThrow("PNG/JPEG/WebP attachments");
    const secret = "attachment-image-protected-canary-20261109";
    registerSensitiveValue(secret);
    const protectedImage = await storedAttachment("protected.png", Buffer.concat([REFERENCE_PNG, Buffer.from(secret)]));
    await expect(createAgentAttachmentReadTool(protectedImage.directory, true, protectedImage.authorize).execute("secret", { path: protectedImage.reference }, undefined, undefined, {} as never)).rejects.toThrow("Protected credential");
    expect(await readFile(invalid.resolved.absolutePath)).toEqual(REFERENCE_PNG.subarray(0, 24));
    expect(await readFile(mismatch.resolved.absolutePath)).toEqual(REFERENCE_PNG);
  });

  it("keeps receipt access separate from private project paths, links, URLs and mutations", async () => {
    const fixture = await storedAttachment("reference.png", REFERENCE_PNG);
    const scoped = createAgentAttachmentReadTool(fixture.directory, true, fixture.authorize);
    const tools = createLocalAgentFileTools(fixture.directory, undefined, true, fixture.authorize);
    const privatePath = path.relative(fixture.directory, fixture.resolved.absolutePath);
    for (const requested of ["reference.png", privatePath, fixture.resolved.absolutePath, `https://example.invalid/${fixture.reference}`, `${fixture.reference}/../other`, `${fixture.reference}\n`, `${fixture.reference}\r\n`, fixture.reference.replace(/-/g, "a")]) {
      await expect(scoped.execute("invalid", { path: requested }, undefined, undefined, {} as never)).rejects.toThrow("exact attachment");
    }
    for (const requested of [privatePath, fixture.resolved.absolutePath, `https://example.invalid/${fixture.reference}`]) {
      await expect(tools[0]!.execute("invalid", { path: requested }, undefined, undefined, {} as never)).rejects.toThrow();
    }
    await expect(tools.find((tool) => tool.name === "write")!.execute("write", { path: fixture.reference, content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(tools.find((tool) => tool.name === "edit")!.execute("edit", { path: fixture.reference, oldText: "x", newText: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow();
    await link(fixture.resolved.absolutePath, path.join(fixture.directory, "linked.png"));
    await expect(scoped.execute("hardlink", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("Invalid stored attachment");
    await rm(path.join(fixture.directory, "linked.png"));
    await rm(fixture.resolved.absolutePath);
    const outside = path.join(await workspace(), "outside.png");
    await writeFile(outside, REFERENCE_PNG);
    await symlink(outside, fixture.resolved.absolutePath);
    await expect(scoped.execute("symlink", { path: fixture.reference }, undefined, undefined, {} as never)).rejects.toThrow("Invalid stored attachment");
    expect(await readFile(outside)).toEqual(REFERENCE_PNG);
  });

  it("publishes canonical readable image receipts and parses only exact manifest references", async () => {
    const fixture = await storedAttachment("reference.png", REFERENCE_PNG);
    const context = fixture.store.promptContext([fixture.resolved]);
    expect(context).toContain(fixture.reference);
    expect(context).not.toContain(fixture.directory);
    expect(context).toContain("untrusted reference material");
    expect(getAttachmentReferences(context)).toEqual([{ batchId: fixture.attachment.batchId, id: fixture.attachment.id }]);
    const manifest = (files: unknown) => `<local-attachments>${JSON.stringify({ files })}</local-attachments>`;
    expect(getAttachmentReferences(context + manifest([{ path: fixture.reference }, { path: fixture.reference.toUpperCase() }]))).toEqual([{ batchId: fixture.attachment.batchId, id: fixture.attachment.id }]);
    expect(getAttachmentReferences(fixture.reference + "<local-attachments>{invalid}</local-attachments>" + manifest([{ path: "/host/path.png" }, { path: `https://example.invalid/${fixture.reference}` }, { path: `${fixture.reference}/other` }, { path: `${fixture.reference}\n` }, { path: fixture.reference.replace(/-/g, "a") }, null, {}]) + manifest({ path: fixture.reference }))).toEqual([]);
    for (const metadataOnly of [{ ...fixture.resolved, size: INLINE_IMAGE_HIGH_BYTES + 1 }, { ...fixture.resolved, mediaType: "image/gif" }, { ...fixture.resolved, kind: "binary" as const }]) {
      expect(getAttachmentReferences(fixture.store.promptContext([metadataOnly]))).toEqual([]);
    }
  });

  it("preserves originals when text writes target media, binary, or oversized files", async () => {
    const directory = await workspace();
    const write = createLocalAgentFileTools(directory).find((tool) => tool.name === "write")!;
    for (const [name, bytes] of [
      ["original.png", Buffer.from("iVBORw0KGgo=", "base64")],
      ["unknown.bin", Buffer.from([0, 1, 2])],
      ["invalid.txt", Buffer.from([255, 254])],
      ["large.txt", Buffer.alloc(1024 * 1024 + 1, 65)],
    ] as const) {
      await writeFile(path.join(directory, name), bytes);
      await expect(write.execute("overwrite", { path: name, content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow();
      expect(await readFile(path.join(directory, name))).toEqual(bytes);
    }
    await expect(write.execute("new-media", { path: "new.jpg", content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow("text-only");
    await expect(readFile(path.join(directory, "new.jpg"))).rejects.toThrow();
  });

  it("protects every recognized binary media extension while keeping SVG authoring available", async () => {
    const directory = await workspace();
    const tools = createLocalAgentFileTools(directory);
    const write = tools.find(tool => tool.name === "write")!, edit = tools.find(tool => tool.name === "edit")!;
    for (const [extension, media] of Object.entries(MEDIA_FILE_TYPES)) {
      if (media.contentType === "image/svg+xml") continue;
      const name = `asset${extension.toUpperCase()}`;
      await expect(write.execute("create-placeholder", { path: name, content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow("text-only");
      await expect(readFile(path.join(directory, name))).rejects.toThrow();
      await writeFile(path.join(directory, name), "retained legacy placeholder");
      await expect(edit.execute("edit-placeholder", { path: name, oldText: "legacy", newText: "new" }, undefined, undefined, {} as never)).rejects.toThrow("text-only");
      expect(await readFile(path.join(directory, name), "utf8")).toBe("retained legacy placeholder");
    }
    for (const extension of ["bmp", "ico", "tiff", "zip", "pdf", "woff2", "ttf"]) {
      await expect(write.execute("binary", { path: `asset.${extension}`, content: "placeholder" }, undefined, undefined, {} as never)).rejects.toThrow("text-only");
    }
    await write.execute("svg", { path: "shape.svg", content: '<svg><rect width="1"/></svg>' }, undefined, undefined, {} as never);
    await edit.execute("svg-edit", { path: "shape.svg", oldText: 'width="1"', newText: 'width="2"' }, undefined, undefined, {} as never);
    expect(await readFile(path.join(directory, "shape.svg"), "utf8")).toBe('<svg><rect width="2"/></svg>');
  });

  it("keeps registered credentials in ordinary files out of read and grep results and refuses credential writes", async () => {
    const directory = await workspace();
    const canary = "sk-agent-file-canary-known-only-20261028";
    registerSensitiveValue(canary);
    await writeFile(path.join(directory, "game.js"), `const marker = "${canary}";`);
    await writeFile(path.join(directory, `${canary}.js`), "const marker = 'private filename';");
    await writeFile(path.join(directory, "safe.js"), "const marker = 'safe';");
    const tools = createLocalAgentFileTools(directory);
    const read = tools.find((tool) => tool.name === "read")!;
    const grep = tools.find((tool) => tool.name === "grep")!;
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    await expect(read.execute("read", { path: "game.js" }, undefined, undefined, {} as never)).rejects.toThrow("protected credential");
    const matches = await grep.execute("grep", { pattern: "marker" }, undefined, undefined, {} as never);
    expect(JSON.stringify(matches)).toContain("safe.js");
    expect(JSON.stringify(matches)).not.toContain(canary);
    expect(JSON.stringify(matches)).not.toContain("game.js");
    for (const name of ["ls", "find"]) {
      const tool = tools.find((tool) => tool.name === name)!;
      const result = await tool.execute(name, name === "find" ? { pattern: "" } : {}, undefined, undefined, {} as never);
      expect(JSON.stringify(result)).not.toContain(canary);
    }
    await expect(edit.execute("edit", { path: "game.js", oldText: "marker", newText: "other" }, undefined, undefined, {} as never)).rejects.toThrow("protected credential");
    await expect(write.execute("write", { path: "safe.js", content: canary }, undefined, undefined, {} as never)).rejects.toThrow("protected credential");
    await expect(edit.execute("edit", { path: "safe.js", oldText: "safe", newText: canary }, undefined, undefined, {} as never)).rejects.toThrow("protected credential");
    expect(await readFile(path.join(directory, "safe.js"), "utf8")).toBe("const marker = 'safe';");
    expect(await readFile(path.join(directory, "game.js"), "utf8")).toBe(`const marker = "${canary}";`);
  });

  it("supports local editing without registering shell or executable tools", async () => {
    const directory = await workspace();
    const tools = createLocalAgentFileTools(directory);
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "ls", "find", "grep"]);
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    await write.execute("write", { path: "src/game.js", content: "const title = 'hello';" }, undefined, undefined, {} as never);
    await edit.execute("edit", { path: "src/game.js", oldText: "hello", newText: "world" }, undefined, undefined, {} as never);
    expect(await readFile(path.join(directory, "src/game.js"), "utf8")).toBe("const title = 'world';");
  });

  it("rejects hidden/private files, traversal, absolute paths and symlinks before reading a canary", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, ".env"), "API_KEY=fake-key-canary-local-only");
    await mkdir(path.join(directory, "src"));
    for (const name of [".env", "src/../.env", "auth.json", "../outside", "public.txt:secret", "src/NUL", path.join(directory, ".env")]) {
      await expect(localAgentPath(directory, name)).rejects.toThrow();
    }
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe("API_KEY=fake-key-canary-local-only");
  });

  it.skipIf(process.platform === "win32")("rejects a symlink whose private target stays inside the project", async () => {
    const directory = await workspace();
    await writeFile(path.join(directory, ".env"), "fake-key-canary-local-only");
    await symlink(path.join(directory, ".env"), path.join(directory, "public.txt"));
    await expect(localAgentPath(directory, "public.txt")).rejects.toThrow("Symbolic links");
    await expect(localAgentPath(directory, "public.txt", true)).rejects.toThrow("Symbolic links");
  });

  it.skipIf(process.platform === "win32")("rejects a workspace root replaced by a symbolic link", async () => {
    const directory = await workspace();
    await mkdir(path.join(directory, "target"));
    await symlink(path.join(directory, "target"), path.join(directory, "workspace"));
    await expect(localAgentPath(path.join(directory, "workspace"), ".")).rejects.toThrow("ordinary directory");
  });

  it("rejects a hard link without reading or truncating the private target", async () => {
    const directory = await workspace();
    const secret = "fake-key-canary-local-only";
    await writeFile(path.join(directory, ".env"), secret);
    await link(path.join(directory, ".env"), path.join(directory, "public.txt"));
    const tools = createLocalAgentFileTools(directory);
    const read = tools.find((tool) => tool.name === "read")!;
    const write = tools.find((tool) => tool.name === "write")!;
    await expect(read.execute("read", { path: "public.txt" }, undefined, undefined, {} as never)).rejects.toThrow("Hard-linked");
    await expect(write.execute("write", { path: "public.txt", content: "changed" }, undefined, undefined, {} as never)).rejects.toThrow("non-linked");
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe(secret);
  });
});
