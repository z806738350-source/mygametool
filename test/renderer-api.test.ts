import { observeWorkspaceVersion, workspaceVersion } from "../src/renderer/workspace-version.js";
import { request } from "../src/renderer/api.js";
import { executeStorageCleanup, getStorageCleanupResult, planStorageCleanup, scanStorageCleanup, storageCleanupAvailable } from "../src/renderer/api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvePlan, cancelPlan, compactConversation, createConversation, createLibraryImage, createProject, deleteWorkspaceEntry, deleteLibraryAsset, deleteProject, duplicateProject, forceDeleteLibraryAsset, getConversation, getConversationCapabilities, getConversationContextUsage, getExploreGameCover, getHomeComposerCapabilities, getLibraryAsset, getOpenAIEndpointSettings, getNodeCodebase, getProjectCover, getWorkspaceAsset, getWorkspaceFile, inspectPluginSource, installPlugin, listLibraryAssetReferences, listLibraryAssets, listModels, listPlugins, listProjects, listWorkspaceFiles, publishProject, readPlugin, readPluginSkill, refinePlan, removePendingPrompt, renameWorkspaceEntry, renameConversation, renameLibraryAsset, renameProject, reviseLastPrompt, sendPrompt, setConversationModel, setConversationReasoning, setProjectCover, steerPendingPrompt, subscribeToProject, uninstallPlugin, updateAgentDefaults, updateOpenAIEndpointSettings, updateNodeCodebase, updatePluginSettings, updateProjectRunSettings, updateProjectStartupDirectory, uploadLibraryAsset, getCheckpointChanges, getCheckpointFile, getUnfinishedChanges, getUnfinishedRestore, restoreCheckpoint, restoreUnfinished, undoCheckpoint, reapplyCheckpoint } from "../src/renderer/api.js";
import { readPluginIconImage, updatePluginDraftIcon, cancelToolJob, getCanvasModelPreview, getProjectCoverState, listToolJobs, setProjectCoverMode, retryToolJob, startToolJob } from "../src/renderer/api.js";
import { exportProject } from "../src/renderer/api.js";
import { answerApproval, getExecutionStorageOverview, getProjectExecutionStorage, recoverProjectExecutionStorage } from "../src/renderer/api.js";
import { volumeMigrationReview, volumeMigrationConfirmation } from "./volume-migration-fixture.js";
import { clearProjectBrowserData, confirmProjectDeletion, projectDeletionConfirmation } from "../src/renderer/project-deletion.js";
import i18next from "i18next";
import { t } from "../src/renderer/i18n.js";
import { getNativeMediaUrl } from "../src/renderer/api.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { RuntimeEvent } from "../src/shared/contracts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer event stream", () => {
  it("forwards a dedicated exact volume confirmation and blocks unsaved Canvas drafts before approving", async () => {
    installWindow();
    const storage = emptyDraftStorage(), projectId = "migration-api", confirmation = volumeMigrationConfirmation(volumeMigrationReview(projectId));
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    await answerApproval(projectId, "conversation-1", "migration/request", "allow", undefined, confirmation);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/projects/migration-api/conversations/conversation-1/approvals/migration%2Frequest", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "allow", volumeMigrationConfirmation: confirmation }) }));
    storage.values.set(`canvas-board:${projectId}:board`, dirtyCanvasDraft());
    await expect(answerApproval(projectId, "conversation-1", "migration/request", "allow", undefined, confirmation)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(storage.removeItem).not.toHaveBeenCalled();
    await answerApproval(projectId, "conversation-1", "migration/request", "deny");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ decision: "deny" }) }));
  });
  it("uses the desktop storage bridge with opaque IDs and no HTTP or filesystem paths", async () => {
    installWindow();
    expect(storageCleanupAvailable()).toBe(false);
    expect(() => scanStorageCleanup()).toThrow("unsupported");
    const cleanup = { scan: vi.fn().mockResolvedValue({ scanId: "scan-1" }), plan: vi.fn().mockResolvedValue({ planId: "plan-1" }), execute: vi.fn().mockResolvedValue({ planId: "plan-1", entries: [] }), result: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("window", { ohMyGameDesktop: { storageCleanup: cleanup } });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(storageCleanupAvailable()).toBe(true);
    await expect(scanStorageCleanup()).resolves.toEqual({ scanId: "scan-1" });
    await planStorageCleanup({ scanId: "scan-1", itemIds: ["opaque-item"] });
    await executeStorageCleanup({ planId: "plan-1", confirmationToken: "token", confirmation: "PERMANENT_DELETE" });
    await getStorageCleanupResult("plan-1");
    expect(cleanup.plan).toHaveBeenCalledWith({ scanId: "scan-1", itemIds: ["opaque-item"] });
    expect(cleanup.execute).toHaveBeenCalledWith({ planId: "plan-1", confirmationToken: "token", confirmation: "PERMANENT_DELETE" });
    expect(cleanup.result).toHaveBeenCalledWith("plan-1"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("exports a restored project's current workspace version", async () => {
    installWindow();
    const id = "archive-restored-project";
    observeWorkspaceVersion(id, "restored-version");
    const fetchMock = vi.fn(async () => new Response("archive"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await (await exportProject(id)).text()).toBe("archive");
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${id}/export`, {
      method: "POST",
      headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "restored-version" },
    });
    await expect(exportProject(id, "old-editor-version")).rejects.toMatchObject({ code: "workspace_stale" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("saves the configured project startup directory", async () => {
    installWindow();
    const project = { id: "project-1", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1", startupDirectory: "apps/game", preview: { status: "stopped" } };
    const fetchMock = vi.fn(async () => Response.json(project));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateProjectStartupDirectory(project.id, project.startupDirectory)).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/settings/startup-directory",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ startupDirectory: "apps/game" }) }),
    );
  });

  it("saves a project's run and playtest settings together", async () => {
    installWindow();
    const project = { id: "project-1", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1", startupDirectory: "apps/game", startupScript: "start", packageManager: "pnpm", previewPath: "/play", previewViewport: "mobile", preview: { status: "stopped" } };
    const input = { startupDirectory: "apps/game", startupScript: "start", packageManager: "pnpm" as const, previewPath: "/play", previewViewport: "mobile" as const };
    const fetchMock = vi.fn(async () => Response.json(project));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateProjectRunSettings(project.id, input)).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/settings/run",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
    );
  });

  it("shows the specific API error message", async () => {
    installWindow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "Bad Request",
      message: "querystring/page must be valid",
    }, { status: 400 })));

    await expect(listProjects()).rejects.toThrow(
      "querystring/page must be valid",
    );
  });

  it("sends an example only when one is chosen", async () => {
    installWindow();
    const project = { id: "project", name: "Story", type: "interactive-story", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project", preview: { status: "waiting" } };
    const fetchMock = vi.fn(async () => Response.json(project, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createProject({ type: "interactive-story" });
    await createProject({ type: "interactive-story", exampleId: "story-example" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "interactive-story" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "interactive-story", exampleId: "story-example" }) }));
  });

  it("loads and updates the Playable codebase contract", async () => {
    installWindow();
    const codebase = {
      graph: { version: 1, title: "Story" },
      editorLayout: { version: 1, nodes: {} },
      revision: "revision-1",
    } as Awaited<ReturnType<typeof getNodeCodebase>>;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(codebase))
      .mockResolvedValueOnce(Response.json({ revision: "revision-2" }))
      .mockResolvedValueOnce(Response.json({ error: "The project changed. Reload the latest version before saving." }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getNodeCodebase("project-1")).resolves.toEqual(codebase);
    const update = { ...codebase, sources: { "nodes/start/node.js": "export function mount() {}\n" } };
    await expect(updateNodeCodebase("project-1", update)).resolves.toEqual({ revision: "revision-2" });
    await expect(updateNodeCodebase("project-1", update)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects/project-1/playable/codebase",
      expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project-1/playable/codebase",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(update) }),
    );
  });

  it("uploads a Library asset as binary data", async () => {
    installWindow();
    const file = new File(["video"], "opening.mp4", { type: "video/mp4" });
    const asset = { id: "asset-1", name: file.name, mediaType: "video" };
    const fetchMock = vi.fn(async () => Response.json(asset, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLibraryAsset(file, "video/mp4", 6.5)).resolves.toEqual(asset);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/library/assets/upload?name=opening.mp4&mediaType=video%2Fmp4&duration=6.5",
      expect.objectContaining({ method: "POST", body: file, headers: expect.objectContaining({ "content-type": "application/octet-stream" }) }),
    );
  });

  it("routes project uploads and image references through project admission", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ id: "asset-1" }, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    await uploadLibraryAsset(file, "video/mp4", undefined, "reference", undefined, "project-1");
    await createLibraryImage({ name: "reference.png", image: { mediaType: "image/png", data: "aW1hZ2U=" } }, "project-1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/project-1/library-assets/upload?name=clip.mp4&mediaType=video%2Fmp4&purpose=reference");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/projects/project-1/library-assets");
  });

  it("sends the Library video a trimmed upload was cut from", async () => {
    installWindow();
    const file = new File(["video"], "opening (trimmed).mp4", { type: "video/mp4" });
    const fetchMock = vi.fn(async () => Response.json({ id: "asset-2" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadLibraryAsset(file, "video/mp4", 3.2, undefined, { assetId: "asset-1", trim: { start: 2.2, end: 5.4 } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/library/assets/upload?name=opening+%28trimmed%29.mp4&mediaType=video%2Fmp4&duration=3.2&trimSource=asset-1&trimStart=2.2&trimEnd=5.4",
      expect.objectContaining({ method: "POST", body: file }),
    );
  });

  it("handles chunked UTF-8 and ignores malformed events", async () => {
    installWindow();
    const content = [
      sse(1, "agent.started", { prompt: "Build" }),
      "event: item.agentMessage.delta\ndata: {bad json}\n\n",
      sse(2, "item.agentMessage.delta", { itemId: "assistant-1", delta: "你好" }),
    ].join("");
    const encoded = new TextEncoder().encode(content);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(chunkedStream(encoded, [17, 83, 121]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const received: RuntimeEvent[] = [];
    let unsubscribe = () => {};
    await new Promise<void>((resolve) => {
      unsubscribe = subscribeToProject("project", 0, {
        onEvent: (event) => {
          received.push(event);
          if (event.id === 2) {
            unsubscribe();
            resolve();
          }
        },
        onOpen: () => {},
        onError: () => {},
      });
    });

    expect(received.map((event) => event.id)).toEqual([1, 2]);
    expect(received[1]?.data).toEqual({ itemId: "assistant-1", delta: "你好" });
  });

  it("reconnects from the latest event cursor", async () => {
    installWindow();
    const urls: string[] = [];
    let unsubscribe = () => {};
    let resolveReconnect = () => {};
    const reconnected = new Promise<void>((resolve) => { resolveReconnect = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(streamFrom(sse(7, "preview.updated", { preview: { status: "starting" } })), { status: 200 });
      }
      queueMicrotask(() => {
        unsubscribe();
        resolveReconnect();
      });
      return new Response(streamFrom(""), { status: 200 });
    }));

    unsubscribe = subscribeToProject("project", 5, {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
    });
    await reconnected;

    expect(urls[0]).toContain("cursor=5");
    expect(urls[1]).toContain("cursor=7");
  });

  it("keeps the latest delivered cursor when the stream rejects", async () => {
    installWindow();
    const urls: string[] = [];
    let unsubscribe = () => {};
    let failStream!: ReadableStreamDefaultController<Uint8Array>;
    let finish!: () => void;
    const reconnected = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        failStream = controller;
        controller.enqueue(new TextEncoder().encode(sse(7, "preview.updated", { preview: { status: "starting" } })));
      } }));
      queueMicrotask(() => { unsubscribe(); finish(); });
      return new Response(streamFrom(""));
    }));
    unsubscribe = subscribeToProject("project", 5, {
      onEvent: () => failStream.error(new Error("Disconnected")), onOpen: () => {}, onError: () => {},
    });
    await reconnected;
    expect(urls[1]).toContain("cursor=7");
  });

  it("reloads a snapshot after the event cursor expires", async () => {
    installWindow();
    const urls: string[] = [];
    let unsubscribe = () => {};
    let resolveReset = () => {};
    const reset = new Promise<void>((resolve) => { resolveReset = resolve; });
    const onReset = vi.fn(async () => 40);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return Response.json({ error: "Event cursor expired" }, { status: 409 });
      queueMicrotask(() => {
        unsubscribe();
        resolveReset();
      });
      return new Response(streamFrom(""), { status: 200 });
    }));

    unsubscribe = subscribeToProject("project", 3, {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
      onReset,
    });
    await reset;

    expect(onReset).toHaveBeenCalledOnce();
    expect(urls[0]).toContain("cursor=3");
    expect(urls[1]).toContain("cursor=40");
  });
});

describe("renderer project API", () => {
  it("lists and reads plugins through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ plugins: [], errors: [] }))
      .mockResolvedValueOnce(Response.json({ id: "ohmygame:godot" }))
      .mockResolvedValueOnce(Response.json({ id: "skills/godot/SKILL.md", content: "# Godot" }));
    vi.stubGlobal("fetch", fetchMock);

    await listPlugins();
    await readPlugin("ohmygame:godot");
    await readPluginSkill("ohmygame:godot", "skills/godot/SKILL.md");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/plugins", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/plugins/ohmygame%3Agodot", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/plugins/ohmygame%3Agodot/skill-content?id=skills%2Fgodot%2FSKILL.md", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
  });

  it("loads Composer capabilities before a project exists", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ plugins: [], skills: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getHomeComposerCapabilities();

    expect(fetchMock).toHaveBeenCalledWith("/api/composer/capabilities", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
  });

  it("updates settings and removes personal plugins through the unified API", async () => {
    installWindow();
    const plugin = { id: "personal:character-writer" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(plugin))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await updatePluginSettings(plugin.id, { enabled: false, components: {} });
    await uninstallPlugin(plugin.id);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/plugins/personal%3Acharacter-writer/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: false, components: {} }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/plugins/personal%3Acharacter-writer", expect.objectContaining({ method: "DELETE" }));
  });

  it("installs plugins through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "personal:test" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await installPlugin({ type: "git", url: "https://example.com/test.git" });

    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/install", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "git", url: "https://example.com/test.git" }),
    }));
  });

  it("inspects plugin sources through the unified API", async () => {
    installWindow();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await inspectPluginSource({ type: "directory", path: "/plugins/test" });

    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/inspect", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "directory", path: "/plugins/test" }),
    }));
  });

  it("reports that author publishing is unavailable in the local edition", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ error: "Publishing is disabled in the local secure edition" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishProject("project", "user-access-token", { title: "Game", description: "Description" })).rejects.toMatchObject({ status: 403, message: "Publishing is disabled in the local secure edition" });

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project/publish", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ accessToken: "user-access-token", title: "Game", description: "Description" }),
    }));
  });

  it("lists projects", async () => {
    installWindow();
    const projects = [{ id: "project-1", name: "First" }];
    const fetchMock = vi.fn(async () => Response.json(projects));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjects()).resolves.toEqual(projects);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
  });

  it("renames, duplicates, and deletes projects", async () => {
    installWindow();
    emptyDraftStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "project-1", name: "Renamed" }))
      .mockResolvedValueOnce(Response.json({ id: "project-2", name: "Renamed copy" }, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await renameProject("project-1", "Renamed");
    await duplicateProject("project-1");
    await deleteProject("project-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/duplicate", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1", expect.objectContaining({ method: "DELETE" }));
  });

  it("clears all browser data of a confirmed deleted project without touching another project or global preferences", () => {
    installWindow();
    const storage = emptyDraftStorage();
    const removed = ["canvas-board:removed:board:version", "canvas-documents:removed", "canvas-tables:removed", "canvas-document-generations:removed", "canvas-table-generations:removed", "canvas-active:removed", "ohmygame:composer-draft:v1:removed:chat", "ohmygame:playable:project:removed", "ohmygame:playable:project:removed:seen", "ohmygame:playtest:request:removed", "ohmygame:playtest:ask:removed"];
    for (const key of removed) storage.values.set(key, "old project data");
    storage.values.set("canvas-board:kept:board", "keep");
    storage.values.set("ohmygame:appearance", "dark");
    clearProjectBrowserData("removed");
    expect(removed.some(key => storage.values.has(key))).toBe(false);
    expect([...storage.values.keys()].sort()).toEqual(["canvas-board:kept:board", "ohmygame:appearance"]);
  });

  it.each([200, 503])("preserves recovery drafts of projects missing from a listing (status=%s)", async status => {
    installWindow();
    const storage = emptyDraftStorage();
    storage.values.set("canvas-active:kept", "board");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status === 200 ? [] : { error: "Unavailable" }, { status })));
    if (status === 200) expect(await listProjects()).toEqual([]);
    else await expect(listProjects()).rejects.toThrow();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each(["en", "zh-CN"] as const)("localizes execution retirement preflight failures in %s without retrying deletion or requesting VM actions", async (language) => {
    installWindow();
    const storage = emptyDraftStorage();
    const draftKey = "ohmygame:composer-draft:v1:other-project:chat";
    const draft = JSON.stringify({ version: 1, prompt: "keep this draft", mentions: [], planning: false });
    storage.values.set(draftKey, draft);
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      code: "execution_retirement_unavailable", message: "VMStopped: limactl start /fixture/runtime", blocked: true,
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const previousLanguage = i18next.language;
    try {
      await i18next.changeLanguage(language);
      await expect(deleteProject("pending-delete")).rejects.toMatchObject({
        code: "execution_retirement_unavailable", status: 409, blocked: true,
        message: t("api.executionRetirementUnavailable"),
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/projects/pending-delete", expect.objectContaining({ method: "DELETE" }));
      expect(storage.values.get(draftKey)).toBe(draft);
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("keeps a dispatched retirement's pending result distinct from a preflight failure", async () => {
    installWindow();
    emptyDraftStorage();
    const confirm = vi.fn();
    Object.assign(window, { confirm });
    const message = "The project deletion result is pending verification.";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deletionProjectVersionResponse())
      .mockResolvedValueOnce(Response.json({ code: "project_lifecycle_pending", message }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteProject({ id: "pending-delete", name: "Game", draftStatus: "clear" })).rejects.toMatchObject({ code: "project_lifecycle_pending", status: 409, message });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/pending-delete", expect.objectContaining({ method: "DELETE" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["cancel", "confirm", "cancel late draft", "confirm late draft", "changed generation", "restored again"] as const)("handles explicit execution discard: %s", async choice => {
    installWindow();
    const storage = emptyDraftStorage();
    const selected = "canvas-active:retained-project", other = "canvas-active:another-project";
    storage.values.set(selected, "board");
    storage.values.set(other, "board");
    const lateDraft = choice === "cancel late draft" || choice === "confirm late draft";
    const confirm = vi.fn().mockReturnValue(choice === "confirm late draft").mockImplementationOnce(() => {
      if (lateDraft) storage.values.set("canvas-board:retained-project:board", dirtyCanvasDraft());
      return choice !== "cancel";
    });
    Object.assign(window, { confirm });
    const projectId = "retained-project";
    const headers = expect.objectContaining({ "x-workspace-version": "current-workspace" });
    const retry = choice === "changed generation" ? Response.json({ code: "execution_discard_state_changed" }, { status: 409 })
      : choice === "restored again" ? Response.json({ code: "workspace_stale" }, { status: 409, headers: { "x-workspace-version": "newer-workspace" } })
      : new Response(null, { status: 204 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deletionProjectVersionResponse())
      .mockResolvedValueOnce(Response.json({ code: "execution_discard_required", generation: "37" }, { status: 409 }))
      .mockResolvedValueOnce(retry);
    vi.stubGlobal("fetch", fetchMock);
    observeWorkspaceVersion(projectId, "old-editor-version");
    const deletion = deleteProject({ id: projectId, name: "Game", draftStatus: "clear" });
    if (choice === "changed generation") await expect(deletion).rejects.toThrow(t("api.executionDiscardStateChanged"));
    else if (choice === "restored again") await expect(deletion).rejects.toMatchObject({ code: "workspace_stale", message: t("projects.deleteWorkspaceChanged") });
    else await deletion;
    expect(workspaceVersion(projectId)).toBe("old-editor-version");
    expect(confirm).toHaveBeenNthCalledWith(1, t("projects.confirmDiscardExecution", { name: "Game" }));
    expect(confirm).toHaveBeenCalledTimes(lateDraft ? 2 : 1);
    if (lateDraft) expect(confirm).toHaveBeenNthCalledWith(2, t("projects.confirmDiscardDrafts", { name: "Game", warning: t("projects.discardDraftWarning.pending") }));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/retained-project", expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/retained-project", expect.objectContaining({ method: "DELETE", headers }));
    const deleted = choice === "confirm" || choice === "confirm late draft";
    if (deleted || choice === "changed generation" || choice === "restored again") {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/retained-project?discardExecutionGeneration=37", expect.objectContaining({ method: "DELETE", headers }));
    } else expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.values.has(selected)).toBe(!deleted);
    if (lateDraft) expect(storage.values.has("canvas-board:retained-project:board")).toBe(!deleted);
    expect(storage.values.has(other)).toBe(true);
  });

  it("keeps project drafts when the current workspace version could not be read", async () => {
    installWindow();
    const storage = emptyDraftStorage();
    const key = "canvas-active:workspace-version-missing";
    storage.values.set(key, "board");
    const fetchMock = vi.fn(async () => Response.json({ id: "workspace-version-missing" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProject({ id: "workspace-version-missing", name: "Game", draftStatus: "clear" }))
      .rejects.toThrow(t("projects.deleteVersionUnavailable"));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/projects/workspace-version-missing", expect.objectContaining({ cache: "no-store" }));
    expect(storage.values.has(key)).toBe(true);
  });

  it("explains possible isolated environment startup in both confirmations and keeps cancellation request-free", async () => {
    installWindow();
    emptyDraftStorage();
    const confirm = vi.fn(() => false);
    Object.assign(window, { confirm, alert: vi.fn() });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const project = { id: "cancel-delete", name: "Game", type: "web-game" as const, updatedAt: "", workspacePath: "/fixture/Game", preview: { status: "stopped" as const } };
    const previousLanguage = i18next.language;
    try {
      for (const language of ["en", "zh-CN"] as const) {
        await i18next.changeLanguage(language);
        const managed = projectDeletionConfirmation(project);
        for (const promise of language === "en"
          ? ["browser drafts", "This cannot be undone.", "Before deletion, the local isolated environment may start to verify execution volumes."]
          : ["浏览器草稿", "此操作无法撤销", "删除前可能启动本地隔离环境，以核对执行卷。"])
          expect(managed).toContain(promise);
        expect(confirmProjectDeletion(project)).toBeUndefined();
        expect(confirm).toHaveBeenLastCalledWith(managed);
        const external = { ...project, workspaceLocation: "external" as const };
        const removal = projectDeletionConfirmation(external);
        expect(removal).toContain(project.workspacePath);
        for (const promise of language === "en"
          ? ["will be permanently removed.", "browser drafts", "Before deletion, the local isolated environment may start to verify execution volumes."]
          : ["将被永久移除", "中的文件会保留", "删除前可能启动本地隔离环境，以核对执行卷。"])
          expect(removal).toContain(promise);
        expect(confirmProjectDeletion(external)).toBeUndefined();
        expect(confirm).toHaveBeenLastCalledWith(removal);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it("rechecks drafts before deletion and clears late drafts only after confirmed deletion", async () => {
    installWindow();
    const storage = emptyDraftStorage();
    storage.values.set("canvas-board:another-project:board", "unreadable");
    const project = { id: "safe-delete", name: "Game", type: "web-game" as const, updatedAt: "", workspacePath: "/fixture", preview: { status: "stopped" as const } };
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.assign(window, { confirm });
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "DELETE") return deletionProjectVersionResponse();
      storage.values.set("ohmygame:composer-draft:v1:safe-delete:late", JSON.stringify({ version: 1, prompt: "late draft", mentions: [], planning: false }));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmation = confirmProjectDeletion(project);
    expect(confirmation).toEqual({ id: project.id, name: project.name, draftStatus: "clear" });
    storage.values.set("canvas-board:safe-delete:board", dirtyCanvasDraft());
    await expect(deleteProject(project.id)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await deleteProject(confirmation!);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/projects/safe-delete", expect.objectContaining({ cache: "no-store" }));
    expect(storage.values.has("canvas-board:safe-delete:board")).toBe(true);
    await deleteProject(confirmation!);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(storage.values.has("canvas-board:safe-delete:board")).toBe(false);
    expect(storage.values.has("ohmygame:composer-draft:v1:safe-delete:late")).toBe(false);
    expect(storage.values.has("canvas-board:another-project:board")).toBe(true);
  });

  it.each(["pending", "unknown"] as const)("can cancel or explicitly delete a project with %s drafts", async draftStatus => {
    installWindow();
    const storage = emptyDraftStorage();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.assign(window, { confirm });
    const project = { id: "draft-delete", name: "Game", type: "web-game" as const, updatedAt: "", workspacePath: "/fixture", preview: { status: "stopped" as const } };
    const key = draftStatus === "pending" ? "ohmygame:composer-draft:v1:draft-delete:chat" : "canvas-documents:draft-delete";
    storage.values.set(key, draftStatus === "pending" ? JSON.stringify({ version: 1, prompt: "keep me", mentions: [], planning: false }) : "corrupt");
    const remove = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: "project_lifecycle_pending" }, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => init?.method === "DELETE" ? remove() : deletionProjectVersionResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(confirmProjectDeletion(project)).toBeUndefined();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining(t(`projects.discardDraftWarning.${draftStatus}`)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.values.has(key)).toBe(true);

    const confirmation = confirmProjectDeletion(project);
    expect(confirmation?.draftStatus).toBe(draftStatus);
    await expect(deleteProject(confirmation!)).rejects.toMatchObject({ status: 409 });
    expect(storage.values.has(key)).toBe(true);
    await deleteProject(confirmation!);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(storage.values.has(key)).toBe(false);
  });

  it("treats confirmed host deletion as successful if browser storage access fails", async () => {
    installWindow();
    vi.stubGlobal("localStorage", { get length() { throw new DOMException("Storage denied"); } });
    Object.assign(window, { confirm: vi.fn(() => true) });
    const project = { id: "inaccessible-drafts", name: "Game", type: "web-game" as const, updatedAt: "", workspacePath: "/fixture", preview: { status: "stopped" as const } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deletionProjectVersionResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const confirmation = confirmProjectDeletion(project);
    expect(confirmation?.draftStatus).toBe("unknown");
    await deleteProject(confirmation!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/inaccessible-drafts", expect.objectContaining({ method: "DELETE" }));
  });

  it("reads the global execution volume overview without writes and forwards cancellation", async () => {
    installWindow();
    const signal = new AbortController().signal;
    const overview = { supported: true, vmState: "stopped", dataStatus: "unavailable", snapshot: null, unallocatedProjects: null };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(overview));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getExecutionStorageOverview(signal)).resolves.toEqual(overview);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/execution-storage", expect.objectContaining({ cache: "no-store", signal }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("loads storage without caching and restores only the confirmed generation while retaining composer drafts", async () => {
    installWindow();
    const storage = emptyDraftStorage(), projectId = "recover-api";
    storage.values.set(`ohmygame:composer-draft:v1:${projectId}:chat`, JSON.stringify({ version: 1, prompt: "keep composer", mentions: [], planning: false }));
    observeWorkspaceVersion(projectId, "host-version");
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ projectId, state: "recovery-pending" }))
      .mockResolvedValueOnce(Response.json({ changed: ["src/game.ts"] }))
      .mockResolvedValueOnce(Response.json({ error: "The isolated execution component needs a separate update.", code: "execution_component_update_required" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await getProjectExecutionStorage(projectId);
    await expect(recoverProjectExecutionStorage(projectId, "generation-1")).resolves.toEqual({ changed: ["src/game.ts"] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/projects/${projectId}/execution-storage`, expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/projects/${projectId}/execution-storage/recover`, expect.objectContaining({ method: "POST", body: JSON.stringify({ generation: "generation-1" }), headers: expect.objectContaining({ "x-workspace-version": "host-version" }) }));
    await expect(getProjectExecutionStorage(projectId)).rejects.toThrow("The isolated execution component needs a separate update.");
    storage.values.set(`canvas-board:${projectId}:board`, dirtyCanvasDraft());
    await expect(recoverProjectExecutionStorage(projectId, "generation-1")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("loads a project's persisted conversation", async () => {
    installWindow();
    const detail = {
      conversation: { id: "conversation-1", projectId: "project-1", title: "Conversation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 1 },
      agent: { status: "idle" },
      settings: {},
      plan: { mode: "normal" },
      items: [{ id: "one", turnId: "turn-1", type: "userMessage", text: "Hi" }],
      pendingPrompts: [],
      cursor: 4,
    };
    const fetchMock = vi.fn(async () => Response.json(detail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversation("project-1", "conversation-1")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1",
      expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } }),
    );

    await getConversation("project-1", "conversation-1", true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects/project-1/conversations/conversation-1?reset=1",
      expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } }),
    );
  });

  it("lists models and selects one for a conversation", async () => {
    installWindow();
    const model = { provider: "openai-codex", providerName: "OpenAI Codex", id: "gpt-5.5", name: "GPT-5.5", reasoningLevels: ["low", "medium", "high"] as const };
    const settings = { model, reasoningLevel: "medium" };
    const conversation = { id: "conversation-1", projectId: "project-1", title: "New conversation", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 0 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: [model], defaultModel: model, defaultReasoningLevel: "medium" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(conversation, { status: 201 }))
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json({ level: "high" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listModels()).resolves.toEqual({ models: [model], defaultModel: model, defaultReasoningLevel: "medium" });
    await expect(updateAgentDefaults({ model, reasoningLevel: "high" })).resolves.toBeUndefined();
    await createConversation("project-1", model, "medium");
    await setConversationModel("project-1", "conversation-1", model);
    await setConversationReasoning("project-1", "conversation-1", "high");

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/models/default", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ model: { provider: model.provider, id: model.id }, reasoningLevel: "high" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1/conversations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: { provider: model.provider, id: model.id }, reasoningLevel: "medium" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/projects/project-1/conversations/conversation-1/model", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ provider: model.provider, id: model.id }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/projects/project-1/conversations/conversation-1/reasoning", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ level: "high" }),
    }));
  });

  it("loads and updates the OpenAI endpoint", async () => {
    installWindow();
    const settings = { baseUrl: "https://api.openai.com/v1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json({ ...settings, baseUrl: "https://relay.example/v1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOpenAIEndpointSettings()).resolves.toEqual(settings);
    await expect(updateOpenAIEndpointSettings("https://relay.example/v1")).resolves.toEqual({ ...settings, baseUrl: "https://relay.example/v1" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/models/providers/openai/endpoint", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://relay.example/v1" }),
    }));
  });

  it("sends a prompt to a project", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ accepted: true, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendPrompt("project-1", "conversation-1", "Build a game")).resolves.toMatchObject({ turnId: "turn-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: "Build a game" }),
      headers: { "x-ohmygame-dev-client": "1", "content-type": "application/json", "x-workspace-version": "0" },
    }));
  });

  it("sends structured Plugin mentions with the visible prompt", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "ohmygame" };

    await sendPrompt("project-1", "conversation-1", "Use @Godot", [], [], "normal", [mention]);

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Use @Godot", mentions: [mention] }),
    }));
  });

  it("compacts a conversation and reads Pi context usage", async () => {
    installWindow();
    const usage = { tokens: 74_000, contextWindow: 100_000, percent: 74 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ contextUsage: usage }));
    vi.stubGlobal("fetch", fetchMock);

    await compactConversation("project-1", "conversation-1", "Keep API decisions");
    await expect(getConversationContextUsage("project-1", "conversation-1")).resolves.toEqual(usage);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/compact", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ instructions: "Keep API decisions" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/context-usage", expect.any(Object));
  });

  it("sends planning prompts and plan decisions", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ queued: false, turnId: "turn-plan" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "conversation-1", "Plan this", [], [], "planning");
    await approvePlan("project-1", "conversation-1");
    await refinePlan("project-1", "conversation-1");
    await cancelPlan("project-1", "conversation-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Plan this", mode: "planning" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/plan/approve", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project-1/conversations/conversation-1/plan/refine", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/projects/project-1/conversations/conversation-1/plan", expect.objectContaining({ method: "DELETE" }));
  });

  it("revises the latest user message", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-2" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await reviseLastPrompt("project-1", "conversation-1", "Build a platformer");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1/revise-last",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "Build a platformer" }) }),
    );
  });

  it("restores a checkpoint and reports a refusal", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await restoreCheckpoint("project-1", "conversation-1", "checkpoint 1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1/checkpoints/checkpoint%201/restore",
      expect.objectContaining({ method: "POST" }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Wait for the agent to finish before restoring" }, { status: 409 })));
    await expect(restoreCheckpoint("project-1", "conversation-1", "checkpoint-1")).rejects.toMatchObject({ status: 409, message: "Wait for the agent to finish before restoring" });
  });

  it("reads the changes of a turn and one of its files", async () => {
    installWindow();
    const changes = [{ path: "src/a b.js", kind: "modified", state: "applied" }];
    const file = { path: "src/a b.js", before: { binary: false, content: "old\n" }, after: { binary: false, content: "new\n" } };
    const fetchMock = vi.fn(async (url: string) => Response.json(url.includes("/file?") ? file : { changes }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCheckpointChanges("project-1", "conversation-1", "checkpoint 1")).resolves.toEqual(changes);
    await expect(getCheckpointFile("project-1", "conversation-1", "checkpoint 1", "src/a b.js")).resolves.toEqual(file);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/checkpoints/checkpoint%201/changes", { headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/checkpoints/checkpoint%201/file?path=src%2Fa%20b.js", { headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } });
  });

  it("undoes a turn with a JSON body whether or not conflicts are decided", async () => {
    installWindow();
    const result = { changed: ["src/a.js"], conflicts: ["src/b.js"] };
    const fetchMock = vi.fn(async () => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(undoCheckpoint("project-1", "conversation-1", "checkpoint 1")).resolves.toEqual(result);
    await undoCheckpoint("project-1", "conversation-1", "checkpoint 1", "keep");
    // To overwrite, the files the user was shown go along.
    await undoCheckpoint("project-1", "conversation-1", "checkpoint 1", "overwrite", ["src/b.js"]);

    const url = "/api/projects/project-1/conversations/conversation-1/checkpoints/checkpoint%201/undo";
    expect(fetchMock).toHaveBeenNthCalledWith(1, url, expect.objectContaining({ method: "POST", body: "{}", headers: { "x-ohmygame-dev-client": "1", "content-type": "application/json", "x-workspace-version": "0" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, url, expect.objectContaining({ method: "POST", body: JSON.stringify({ conflicts: "keep" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, url, expect.objectContaining({ method: "POST", body: JSON.stringify({ conflicts: "overwrite", expected: ["src/b.js"] }) }));
  });

  it("sends Reapply with explicit conflict consent and returns the remaining Undo state", async () => {
    installWindow();
    const result = {
      changed: ["src/a.js"],
      conflicts: [],
      undone: false,
      kept: 0,
    };
    const fetchMock = vi.fn(async () => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reapplyCheckpoint(
        "project-1",
        "conversation-1",
        "checkpoint 1",
        "overwrite",
        ["src/a.js"],
      ),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1/checkpoints/checkpoint%201/reapply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          conflicts: "overwrite",
          expected: ["src/a.js"],
        }),
      }),
    );
  });

  it("keeps the conflicts of a refused undo on the error", async () => {
    installWindow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Files were changed after this turn", conflicts: ["src/a.js", "src/b.js"] }, { status: 409 })));
    const refused = await undoCheckpoint("project-1", "conversation-1", "checkpoint-1").catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, message: "Files were changed after this turn", conflicts: ["src/a.js", "src/b.js"] });
    expect(refused).not.toHaveProperty("blocked", true);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Some files cannot be put back", conflicts: ["src/a.js"], blocked: true }, { status: 409 })));
    await expect(undoCheckpoint("project-1", "conversation-1", "checkpoint-1", "overwrite")).rejects.toMatchObject({ status: 409, conflicts: ["src/a.js"], blocked: true });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "The workspace was left partly changed", code: "CHECKPOINT_INCOMPLETE" }, { status: 409 })));
    const incomplete = await undoCheckpoint("project-1", "conversation-1", "checkpoint-1").catch((error: unknown) => error);
    expect(incomplete).toMatchObject({ status: 409, code: "CHECKPOINT_INCOMPLETE" });
    expect(incomplete).toHaveProperty("conflicts", undefined);

    // Anything but a list of paths and a plain true is left out.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Refused", conflicts: ["src/a.js", 2], blocked: "yes" }, { status: 409 })));
    const malformed = await undoCheckpoint("project-1", "conversation-1", "checkpoint-1").catch((error: unknown) => error);
    expect(malformed).toMatchObject({ status: 409, message: "Refused" });
    expect(malformed).toHaveProperty("conflicts", undefined);
    expect(malformed).toHaveProperty("blocked", undefined);
  });

  it("asks for an unfinished restore and puts the files back", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ unfinished: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUnfinishedRestore("project-1")).resolves.toBe(true);
    await expect(restoreUnfinished("project-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/checkpoints/unfinished", { headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/checkpoints/unfinished/restore", expect.objectContaining({ method: "POST" }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Wait for the agent to finish" }, { status: 409 })));
    await expect(restoreUnfinished("project-1")).rejects.toMatchObject({ status: 409, message: "Wait for the agent to finish" });
  });

  it("reads what putting the files back would do", async () => {
    installWindow();
    const changes = [{ path: "src/a.js", kind: "added" }, { path: "src/b.js", kind: "removed" }];
    const fetchMock = vi.fn(async () => Response.json({ changes }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUnfinishedChanges("project-1")).resolves.toEqual(changes);

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/checkpoints/unfinished/changes", { headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "No restore or undo was left unfinished" }, { status: 404 })));
    await expect(getUnfinishedChanges("project-1")).rejects.toMatchObject({ status: 404 });
  });

  it("sends image attachments with a prompt", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: false, turnId: "turn-1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

    await sendPrompt("project-1", "conversation-1", "Describe this", [], [image]);

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Describe this", images: [image] }),
    }));
  });

  it("sends file references and removes a pending follow-up", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ queued: true, turnId: "turn-2" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPrompt("project-1", "conversation-1", "Review this", [{ type: "workspace-file", path: "src/app.ts" }]);
    await removePendingPrompt("project-1", "conversation-1", "turn-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/conversations/conversation-1/turns", expect.objectContaining({
      body: JSON.stringify({ prompt: "Review this", references: [{ type: "workspace-file", path: "src/app.ts" }] }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/conversations/conversation-1/queue/turn-2", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("loads Composer capabilities for a conversation", async () => {
    installWindow();
    const fetchMock = vi.fn(async () => Response.json({ plugins: [], skills: [{ name: "review", description: "Review changes" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConversationCapabilities("project-1", "conversation-1")).resolves.toEqual({
      plugins: [],
      skills: [{ name: "review", description: "Review changes" }],
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects/project-1/conversations/conversation-1/capabilities",
      expect.any(Object),
    );
  });

  it("steers queued messages", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await steerPendingPrompt("project-1", "conversation-1", "turn-2");

    expect(fetchMock.mock.calls.map(([url, options]) => [url, (options as RequestInit).method, (options as RequestInit).body])).toEqual([
      ["/api/projects/project-1/conversations/conversation-1/queue/turn-2/steer", "POST", undefined],
    ]);
  });

  it("renames a conversation", async () => {
    installWindow();
    const renamed = { id: "conversation-1", title: "New title" };
    const fetchMock = vi.fn(async () => Response.json(renamed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameConversation("project-1", "conversation-1", "New title")).resolves.toEqual(renamed);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "New title" }),
        headers: { "x-ohmygame-dev-client": "1", "content-type": "application/json", "x-workspace-version": "0" },
      }),
    );
  });

  it("loads workspace files and encodes file paths", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await listWorkspaceFiles("project-1");
    await getWorkspaceFile("project-1", "src/my file.ts");
    await getWorkspaceAsset("project-1", "public/cover image.png");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/project-1/files",
      "/api/projects/project-1/files/content?path=src%2Fmy%20file.ts",
      "/api/projects/project-1/files/raw?path=public%2Fcover%20image.png",
    ]);
  });

  it("renames and deletes workspace files", async () => {
    installWindow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ path: "assets/new name.glb" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await renameWorkspaceEntry("project-1", "assets/old name.glb", "new name.glb");
    await deleteWorkspaceEntry("project-1", "assets/new name.glb");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/files?path=assets%2Fold%20name.glb", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "new name.glb" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/files?path=assets%2Fnew%20name.glb", expect.objectContaining({ method: "DELETE" }));
  });

  it("uses global Library asset endpoints", async () => {
    installWindow();
    const asset = { id: "video", name: "opening.mp4" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([asset]))
      .mockResolvedValueOnce(Response.json(asset, { status: 201 }))
      .mockResolvedValueOnce(new Response(new Blob(["video"])))
      .mockResolvedValueOnce(Response.json(asset))
      .mockResolvedValueOnce(Response.json([{ id: "project", name: "Story", type: "interactive-story" }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLibraryAssets()).resolves.toEqual([asset]);
    await expect(createLibraryImage({ name: "reference.png", image: { mediaType: "image/png", data: "aW1hZ2U=" } })).resolves.toEqual(asset);
    await expect(getLibraryAsset("video")).resolves.toBeInstanceOf(Blob);
    await expect(renameLibraryAsset("video", "Opening")).resolves.toEqual(asset);
    const signal = new AbortController().signal;
    await expect(listLibraryAssetReferences("video", signal)).resolves.toEqual([{ id: "project", name: "Story", type: "interactive-story" }]);
    await expect(deleteLibraryAsset("video")).resolves.toBeUndefined();
    await expect(forceDeleteLibraryAsset("video")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/library/assets",
      "/api/library/assets",
      "/api/library/assets/video/content",
      "/api/library/assets/video",
      "/api/library/assets/video/references",
      "/api/library/assets/video",
      "/api/library/assets/video?force=true",
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/library/assets", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "reference.png", image: { mediaType: "image/png", data: "aW1hZ2U=" } }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/library/assets/video/references", expect.objectContaining({ signal, cache: "no-store" }));
  });

  it("downloads workspace assets with desktop authorization", async () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const fetchMock = vi.fn(async () => new Response(new Blob(["image"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWorkspaceAsset("project-1", "cover.png")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/projects/project-1/files/raw?path=cover.png",
      { headers: { authorization: "Bearer secret" }, signal: undefined },
    );
  });

  it("uses native media only in the capable editor and pins the inspected content without putting credentials in URLs", async () => {
    installWindow();
    const digest = "a".repeat(64), signal = new AbortController().signal;
    const fetchMock = vi.fn(async () => new Response(null, { headers: { etag: `"${digest}"`, "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getNativeMediaUrl({ libraryAssetId: "video" }, signal)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("window", { ohMyGameDesktop: { nativeMedia: true, runtime: { daemonUrl: "http://127.0.0.1:43210", token: "synthetic-native-token" } } });
    const url = await getNativeMediaUrl({ projectId: "project-1", filePath: "public/long video.mp4" }, signal);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:43210/projects/project-1/files/raw?path=public%2Flong+video.mp4", { method: "HEAD", headers: { authorization: "Bearer synthetic-native-token" }, signal });
    expect(new URL(url!).searchParams.get("sha256")).toBe(digest);
    expect(url).not.toContain("token"); expect(url).not.toContain("synthetic-native-token");
    const library = await getNativeMediaUrl({ libraryAssetId: "video" }, signal);
    expect(library).toBe(`http://127.0.0.1:43210/library/assets/video/content?preview=true&sha256=${digest}`);
  });

  it("rejects missing or weak media bindings and a runtime rotation without downloading a body", async () => {
    const runtime = { daemonUrl: "http://127.0.0.1:43210", token: "synthetic-old-token" };
    vi.stubGlobal("window", { ohMyGameDesktop: { nativeMedia: true, runtime } });
    const fetchMock = vi.fn(async () => new Response(null, { headers: { etag: `W/"${"a".repeat(64)}"`, "content-type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getNativeMediaUrl({ libraryAssetId: "sound" })).rejects.toThrow();
    fetchMock.mockImplementationOnce(async () => { runtime.token = "synthetic-rotated-token"; return new Response(null, { headers: { etag: `"${"a".repeat(64)}"`, "content-type": "audio/wav" } }); });
    await expect(getNativeMediaUrl({ libraryAssetId: "sound" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([`.data/model-assets/${"a".repeat(64)}/${"b".repeat(64)}.glb`, `public/${"a".repeat(1001)}.glb`])("keeps the Blob fallback for a workspace path outside native eligibility", async filePath => {
    vi.stubGlobal("window", { ohMyGameDesktop: { nativeMedia: true, runtime: { daemonUrl: "http://127.0.0.1:43210", token: "synthetic-native-token" } } });
    const fetchMock = vi.fn(async () => new Response(null, { headers: { etag: `"${"a".repeat(64)}"`, "content-type": "model/gltf-binary" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getNativeMediaUrl({ projectId: "project-1", filePath })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["library", "workspace"])("keeps an explicit %s editing download bound to the preview bytes", async kind => {
    installWindow();
    const digest = "b".repeat(64), signal = new AbortController().signal;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Blob(["synthetic source"]))); vi.stubGlobal("fetch", fetchMock);
    if (kind === "library") await getLibraryAsset("video", false, signal, digest);
    else await getWorkspaceAsset("project-1", "public/video.mp4", signal, digest);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`sha256=${digest}`);
    await expect(kind === "library" ? getLibraryAsset("video", false, signal, "invalid") : getWorkspaceAsset("project-1", "public/video.mp4", signal, "invalid")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["library", "workspace", "model-preview"])("forwards cancellation for %s Blob downloads without changing authenticated URLs", async kind => {
    vi.stubGlobal("window", { ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "synthetic-local-token" } } });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Blob(["synthetic asset"])));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const load = (signal: AbortSignal) => kind === "library" ? getLibraryAsset("asset/id", true, signal) : kind === "workspace" ? getWorkspaceAsset("project-1", "public/model file.glb", signal) : getCanvasModelPreview("project-1", "asset/id", signal);
    const endpoint = kind === "library" ? "/library/assets/asset%2Fid/content?preview=true" : kind === "workspace" ? "/projects/project-1/files/raw?path=public%2Fmodel%20file.glb" : "/projects/project-1/canvas/assets/asset%2Fid/model-preview";
    await expect(load(controller.signal)).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:43210" + endpoint, { headers: { authorization: "Bearer synthetic-local-token" }, signal: controller.signal });
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Synthetic cancellation", "AbortError")), { once: true })));
    const pending = load(controller.signal), rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads plugin icons through authenticated desktop requests and saves draft revisions", async () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
    });
    const fetchMock = vi.fn(async () => new Response("icon", { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readPluginIconImage("personal:review")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:43210/plugins/personal%3Areview/icon", expect.objectContaining({ headers: { authorization: "Bearer secret" } }));
    await readPluginIconImage("personal:review", "workspace", undefined, "./assets/logo.png");
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:43210/plugins/setup-sessions/workspace/icon?path=.%2Fassets%2Flogo.png", expect.objectContaining({ headers: { authorization: "Bearer secret" } }));
    fetchMock.mockImplementation(async () => Response.json({ errors: [], revision: "next" }));
    await updatePluginDraftIcon("workspace", { revision: "reviewed", icon: { type: "preset", id: "image" } });
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:43210/plugins/setup-sessions/workspace/icon", expect.objectContaining({ method: "PUT", body: JSON.stringify({ revision: "reviewed", icon: { type: "preset", id: "image" } }), headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
  });

  it("loads and stores project covers with desktop authorization", async () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const cover = new Blob(["cover"], { type: "image/webp" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(cover))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectCover("project-1")).resolves.toBeInstanceOf(Blob);
    await expect(setProjectCover("project-1", cover)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:43210/projects/project-1/cover", {
      headers: { authorization: "Bearer secret" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43210/projects/project-1/cover", {
      method: "PUT",
      headers: { "content-type": "image/webp", authorization: "Bearer secret", "x-workspace-version": "0" },
      body: cover,
    });
  });

  it("marks automatic cover writes and switches cover mode without publishing", async () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
    });
    const cover = new Blob(["cover"], { type: "image/webp" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: "custom" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getProjectCoverState("project-1")).resolves.toEqual({ mode: "custom" });
    await setProjectCover("project-1", cover, "auto");
    await setProjectCoverMode("project-1", "custom");
    await setProjectCoverMode("project-1", "auto");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43210/projects/project-1/cover?source=auto", {
      method: "PUT", headers: { "content-type": "image/webp", authorization: "Bearer secret", "x-workspace-version": "0" }, body: cover,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "http://127.0.0.1:43210/projects/project-1/cover/state", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer secret", "x-workspace-version": "0" }, body: JSON.stringify({ mode: "custom" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "http://127.0.0.1:43210/projects/project-1/cover/state", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer secret", "x-workspace-version": "0" }, body: JSON.stringify({ mode: "auto" }),
    });
  });

  it("loads Community game covers through the local runtime", async () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: { runtime: { daemonUrl: "http://127.0.0.1:43210", token: "secret" } },
      setTimeout,
      clearTimeout,
    });
    const fetchMock = vi.fn(async () => new Response(new Blob(["cover"], { type: "image/webp" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getExploreGameCover("game 1", "deployment 1")).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/community/games/game%201/deployments/deployment%201/cover",
      { headers: { authorization: "Bearer secret" } },
    );
  });
});

describe("renderer tools API", () => {
  it("creates, lists, cancels, and retries background tool jobs", async () => {
    installWindow();
    const job = { id: "job-1", toolId: "generate-image", status: "running" };
    const retry = { ...job, id: "job-2" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(job, { status: 202 }))
      .mockResolvedValueOnce(Response.json([job]))
      .mockResolvedValueOnce(Response.json({ ...job, status: "cancelled" }))
      .mockResolvedValueOnce(Response.json(retry, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startToolJob("generate-image", { prompt: "A forest", size: "1024x1024" }, undefined, { projectId: "project-1", nodeId: "node-1" })).resolves.toEqual(job);
    await expect(listToolJobs()).resolves.toEqual([job]);
    await expect(cancelToolJob("job-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(retryToolJob("job-1")).resolves.toEqual(retry);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tools/generate-image/jobs", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ projectId: "project-1", nodeId: "node-1" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/tool-jobs", expect.objectContaining({ headers: { "x-ohmygame-dev-client": "1" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/tool-jobs/job-1/cancel", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/tool-jobs/job-1/retry", expect.objectContaining({ method: "POST" }));
  });

});

function installWindow(): void {
  vi.stubGlobal("window", {
    ohMyGameDesktop: undefined,
    setTimeout,
    clearTimeout,
  });
}

function emptyDraftStorage() {
  const values = new Map<string, string>();
  const storage = { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, removeItem: vi.fn((key: string) => values.delete(key)), setItem: vi.fn((key: string, value: string) => values.set(key, value)) };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

function deletionProjectVersionResponse(): Response {
  return new Response(null, { headers: { "x-workspace-version": "current-workspace" } });
}

function dirtyCanvasDraft() {
  const base = createAssetCanvasDocument(), local = structuredClone(base);
  local.viewport.width++;
  return JSON.stringify({ base, local });
}

function sse(id: number, type: RuntimeEvent["type"], data: object): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({
    id,
    projectId: "project",
    type,
    timestamp: new Date(0).toISOString(),
    data,
  })}\n\n`;
}

function streamFrom(content: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(content);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function chunkedStream(bytes: Uint8Array, boundaries: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const boundary of boundaries) {
        controller.enqueue(bytes.slice(offset, boundary));
        offset = boundary;
      }
      controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
}


it("renames project metadata once without adopting its response version or refreshing an old editor draft", async () => {
  installWindow();
  const projectId = "rename-metadata-version-fixture";
  observeWorkspaceVersion(projectId, "0");
  const draftVersion = workspaceVersion(projectId);
  const renamed = { id: projectId, name: "Renamed from the project list" };
  const fetchMock = vi.fn(async () => Response.json(renamed, { headers: { "x-workspace-version": "restored-version" } }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(renameProject(projectId, renamed.name)).resolves.toEqual(renamed);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}`, {
    method: "PATCH", body: JSON.stringify({ name: renamed.name }),
    headers: { "content-type": "application/json", "x-ohmygame-dev-client": "1", "x-workspace-version": draftVersion },
  });
  expect(workspaceVersion(projectId)).toBe(draftVersion);

  // A real restore event still invalidates the version captured by the editor.
  observeWorkspaceVersion(projectId, "restored-version");
  await expect(request(`/projects/${projectId}/files`, { method: "POST", workspaceVersion: draftVersion, body: "{}" }))
    .rejects.toMatchObject({ code: "workspace_stale" });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("keeps a restore event's version when an older read settles and refuses the old editor's delayed write", async () => {
  installWindow();
  observeWorkspaceVersion("versioned-project", "0");
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const pending = request("/projects/versioned-project/files");
  observeWorkspaceVersion("versioned-project", "restored");
  finish(Response.json([], { headers: { "x-ohmygame-dev-client": "1", "x-workspace-version": "0" } }));
  await pending;
  expect(workspaceVersion("versioned-project")).toBe("restored");
  await expect(request("/projects/versioned-project/files", { method: "POST", workspaceVersion: "0", body: "{}" })).rejects.toMatchObject({ code: "workspace_stale" });
  expect(fetchMock).toHaveBeenCalledOnce();
});
