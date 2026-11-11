import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AgentAttachmentStore, resolveAgentAttachment } from "../src/daemon/agent-attachments.js";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.js";
import type { CodingSession } from "../src/daemon/agent.js";
import { CHECKPOINT_ENTRY, TURN_END_ENTRY } from "../src/daemon/checkpoint-extension.js";
import { ConversationManager } from "../src/daemon/conversations.js";
import { writePlayableFixtureWorkspace } from "./playable-fixture.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { isolatedPreviewFixture } from "./isolated-preview-fixture.js";

const apps: ReturnType<typeof createApp>[] = [];
const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;
const REFERENCE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMIbrGaCcMMyBwAgE4J/ZR8Jv0AAAAASUVORK5CYII=";
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function saveProjectAsset(app: Awaited<ReturnType<typeof createApp>>, projectId: string, filePath: string) {
  const saved = await app.inject({ method: "POST", url: `/projects/${projectId}/assets/library?path=${encodeURIComponent(filePath)}` });
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json();
}

describe("daemon", () => {
  it("lists retained project models only for the asset catalog and serves their original and preview separately", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-project-assets-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Assets" } })).json();
    const other = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Other" } })).json();
    const folder = `.data/model-assets/${"a".repeat(64)}`, original = `${folder}/original.fbx`, preview = `${folder}/${"b".repeat(64)}.glb`;
    await mkdir(path.join(project.workspacePath, folder), { recursive: true });
    await writeFile(path.join(project.workspacePath, original), "original quad model");
    await writeFile(path.join(project.workspacePath, preview), "triangulated model");
    await writeFile(path.join(project.workspacePath, ".data/assets.json"), JSON.stringify({ version: 1, prompts: {}, previews: { [original]: preview }, libraryAssets: { [original]: "quad" }, origins: { [original]: "generated" }, purposes: { [original]: "asset" } }));
    for (const file of ["picture.png", "sound.mp3", "movie.mp4", "small.glb"]) await writeFile(path.join(project.workspacePath, file), file);
    const normal = (await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json();
    expect(normal.some((file: { path: string }) => file.path.startsWith(".data/"))).toBe(false);
    const catalog = await app.inject({ method: "GET", url: `/projects/${project.id}/files?assets=true` });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().filter((file: { mediaType?: string }) => file.mediaType)).toHaveLength(5);
    expect(catalog.json()).toContainEqual(expect.objectContaining({ path: original, libraryAssetId: "quad", previewPath: preview, mediaType: "model", origin: "generated" }));
    expect((await app.inject({ method: "GET", url: `/projects/${other.id}/files?assets=true` })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/projects/missing/files?assets=true` })).statusCode).toBe(404);
    for (const [file, expected, type] of [[original, "original quad model", "application/vnd.autodesk.fbx"], [preview, "triangulated model", "model/gltf-binary"]]) {
      const response = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=${encodeURIComponent(file!)}` });
      expect(response.statusCode).toBe(200); expect(response.body).toBe(expected); expect(response.headers["content-type"]).toBe(type);
      expect((await app.inject({ method: "GET", url: `/projects/${other.id}/files/raw?path=${encodeURIComponent(file!)}` })).statusCode).toBe(400);
    }
  });

  it("exposes project activity without requiring a conversation event subscription", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const prompt = vi.fn(async () => completion);
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-project-activity-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const activity = async () => (await app.inject({ method: "GET", url: "/projects/activity" })).json().activity;
    expect(await activity()).toEqual([]);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
        payload: { prompt: "Build" },
      });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
      expect(await activity()).toEqual([{ projectId: project.id, status: "running" }]);
      expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([expect.objectContaining({ id: project.id })]);
      await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns/${response.json().turnId}/cancel` });
      expect(await activity()).toEqual([{ projectId: project.id, status: "cancelling" }]);
    } finally {
      finish();
    }
    await vi.waitFor(async () => expect(await activity()).toEqual([]));
  });

  it("creates an empty isolated Web Game project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project.name).toBe("First");
    expect(project.type).toBe("web-game");
    expect(await readdir(project.workspacePath)).toEqual([]);
    expect(project.preview).toEqual({ status: "waiting" });
  });

  it("creates a typed project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Story", type: "interactive-story" });
    const codebase = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable/codebase` })).json();
    expect(codebase.graph).toMatchObject({ entryNodeId: "start", edges: [] });
  });

  it("serves the Node Runtime only for projects with graph.json", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nodes", type: "interactive-story" },
    })).json();

    await rm(path.join(project.workspacePath, "graph.json"));
    const story = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(story.statusCode).toBe(200);
    expect(story.json()).toEqual({ available: false });

    await writePlayableFixtureWorkspace(project.workspacePath);
    const playable = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(playable.statusCode).toBe(200);
    expect(playable.json()).toMatchObject({ available: true, definition: { version: 1, graph: { title: "Ash Club" } } });

    await writeFile(path.join(project.workspacePath, "graph.json"), "{");
    const invalid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("graph.json is not valid JSON");
  });

  it("accepts a custom viewport only for blank Interactive Story projects", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-viewport-")),
    });
    apps.push(app);

    const valid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-story",
        viewport: { width: 720, height: 1280 },
      },
    });
    const webProject = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "web-game",
        viewport: { width: 1280, height: 720 },
      },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        type: "interactive-story",
        viewport: { width: 100, height: 720 },
      },
    });

    expect(valid.statusCode).toBe(201);
    const codebase = (await app.inject({ method: "GET", url: `/projects/${valid.json().id}/playable/codebase` })).json();
    expect(codebase.graph.viewport).toEqual({ width: 720, height: 1280 });
    expect(webProject.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
  });

  it("uses a selected non-empty folder as an external workspace without deleting it", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-project-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-user-workspace-"));
    await writeFile(path.join(workspacePath, "README.md"), "Existing project files\n");
    const app = createApp({ dataDirectory });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Existing files", workspacePath },
    });

    expect(response.statusCode).toBe(201);
    const project = response.json();
    expect(project).toMatchObject({
      name: "Existing files",
      workspaceLocation: "external",
      workspaceAvailable: true,
    });
    expect(project.workspacePath).toBe(await realpath(workspacePath));
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("Existing project files\n");

    const conversation = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` });
    expect(conversation.statusCode).toBe(201);
    expect((await stat(path.join(dataDirectory, "projects", project.id, "session"))).isDirectory()).toBe(true);

    const sameWorkspace = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Same workspace", type: "interactive-story", workspacePath },
    });
    expect(sameWorkspace.statusCode).toBe(200);
    expect(sameWorkspace.json()).toMatchObject({ id: project.id, name: "Existing files", type: "web-game" });
    await expect(stat(path.join(workspacePath, "graph.json"))).rejects.toThrow();

    const nestedWorkspace = path.join(workspacePath, "nested");
    await mkdir(nestedWorkspace);
    const nested = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nested workspace", workspacePath: nestedWorkspace },
    });
    expect(nested.statusCode).toBe(201);
    expect(nested.json().workspacePath).toBe(await realpath(nestedWorkspace));
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "DELETE", url: `/projects/${nested.json().id}` })).statusCode).toBe(204);

    expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("Existing project files\n");
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("does not run a non-server dev script from an imported workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-preview-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-format-workspace-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({
      scripts: { dev: "bun format" },
    }));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Formatting workspace", workspacePath },
    })).json();

    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });

    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "This folder's dev script runs a non-server task: bun format" });
    expect(project.preview).toEqual({ status: "waiting" });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("recognizes a runnable imported workspace when it is created", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-runnable-workspace-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-vite-workspace-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const app = createApp({ dataDirectory });
    apps.push(app);

    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Runnable workspace", workspacePath },
    })).json();

    expect(project.preview).toEqual({ status: "stopped" });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it.each(["web-game", "general"] as const)("sets a %s startup directory when its dev server is nested", async (type) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-nested-preview-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-nested-workspace-"));
    const startupDirectory = path.join(workspacePath, "apps", "game");
    await mkdir(startupDirectory, { recursive: true });
    await writeFile(path.join(startupDirectory, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const app = createApp({ dataDirectory });
    apps.push(app);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Nested workspace", type, workspacePath } })).json();
    expect(project.preview).toEqual({ status: "waiting" });

    const configured = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/startup-directory`,
      payload: { startupDirectory: "apps/game" },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ startupDirectory: "apps/game", preview: { status: "stopped" } });

    const runSettings = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/run`,
      payload: {
        startupDirectory: "apps/game",
        startupScript: "dev",
        packageManager: "pnpm",
        previewPath: "/play",
        previewViewport: "mobile",
        ...(type === "general" ? { webPreviewEnabled: true } : {}),
      },
    });
    expect(runSettings.statusCode).toBe(200);
    expect(runSettings.json()).toMatchObject({
      startupDirectory: "apps/game",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });

    const invalid = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/startup-directory`,
      payload: { startupDirectory: "../outside" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Startup directory must be a relative path inside the project workspace" });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it.each([false, true])("respects General Web preview policy when browser output is generated: %s", async (webPreviewEnabled) => {
    const guest = await isolatedPreviewFixture("General ready");
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-general-auto-preview-")),
      projectExecution: guest.execution,
      createSession: async (project) => ({
        messages: [], abort: async () => {}, dispose: () => {}, subscribe: () => () => {},
        prompt: async () => {
          await mkdir(path.join(project.workspacePath, "node_modules"), { recursive: true });
          await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
          await writeFile(path.join(project.workspacePath, "server.mjs"), `
            import { createServer } from "node:http";
            const port = Number(process.env.PORT || process.argv[process.argv.indexOf("--port") + 1]);
            createServer((_req, res) => res.end("General ready")).listen(port, "127.0.0.1");
          `);
        },
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "general" } })).json();
    expect(project.webPreviewEnabled).toBe(true);
    const settingsUrl = `/projects/${project.id}/settings/run`;
    const settings = { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled };
    if (!webPreviewEnabled) {
      const configured = await app.inject({ method: "PUT", url: settingsUrl, payload: settings });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(configured.json()).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
    }
    await app.inject({ method: "PUT", url: `/projects/${project.id}/preview/leases/test-editor`, payload: { automatic: true } });
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const turn = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Build browser output" } });
    expect(turn.statusCode).toBe(202);
    const readProject = async () => (await app.inject({ method: "GET", url: `/projects/${project.id}` })).json();
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/projects/activity" })).json().activity).toEqual([]));
    if (webPreviewEnabled) {
      await vi.waitFor(async () => expect((await readProject()).preview.status).toBe("ready"), { timeout: 3_000 });
      const url = (await readProject()).preview.url;
      expect(await (await fetch(url)).text()).toBe("General ready");
      const disabled = await app.inject({ method: "PUT", url: settingsUrl, payload: { ...settings, webPreviewEnabled: false } });
      expect(disabled.json()).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
      await expect(fetch(url, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
      for (const reuse of ["", "?reuse=1"]) {
        expect((await app.inject({ method: "POST", url: `/projects/${project.id}/preview${reuse}` })).statusCode).toBe(409);
      }
    } else {
      expect(await readProject()).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
      const enabled = await app.inject({ method: "PUT", url: settingsUrl, payload: { ...settings, webPreviewEnabled: true } });
      // The root directory/dev/Auto defaults do not change on first activation.
      expect(enabled.json()).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    }
    expect((await app.inject({ method: "PUT", url: settingsUrl, payload: { ...settings, webPreviewEnabled: "true" } })).statusCode).toBe(400);
  });

  it("rejects a Web preview switch on a Web Game project", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-web-switch-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const response = await app.inject({ method: "PUT", url: `/projects/${project.id}/settings/run`, payload: { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: false } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Only General Game");
  });

  it("creates General Game and Godot projects and rejects unknown types", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);

    const godot = await app.inject({ method: "POST", url: "/projects", payload: { name: "Platformer", type: "godot-game" } });
    const general = await app.inject({ method: "POST", url: "/projects", payload: { type: "general" } });
    const unknown = await app.inject({ method: "POST", url: "/projects", payload: { type: "unknown" } });

    expect(godot.statusCode).toBe(201);
    expect(godot.json()).toMatchObject({ name: "Platformer", type: "godot-game" });
    expect(general.statusCode).toBe(201);
    expect(general.json()).toMatchObject({ type: "general", webPreviewEnabled: true, preview: { status: "waiting" } });
    expect(await readdir(general.json().workspacePath)).toEqual([]);
    expect(unknown.statusCode).toBe(400);
    const preview = await app.inject({ method: "POST", url: `/projects/${general.json().id}/preview?reuse=1` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error).toContain("dev script");
  });

  it("lists projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Second" } })).json();

    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([second, first]);
  });

  it("renames, duplicates, and deletes projects", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-project-actions-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "First" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>First</h1>");

    const renamed = await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Renamed" } });
    const duplicated = await app.inject({ method: "POST", url: `/projects/${project.id}/duplicate` });
    const deleted = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Renamed" });
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json()).toMatchObject({ name: "Renamed copy" });
    expect(await readdir(duplicated.json().workspacePath)).toEqual(["index.html"]);
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(404);
  });

  it("exposes workspace code and media with project provenance", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "hello world.txt"), "Hello\n");
    await writeFile(path.join(project.workspacePath, "cover.png"), Buffer.from([1, 2, 3]));
    await mkdir(path.join(project.workspacePath, "empty-folder"));

    const files = await app.inject({ method: "GET", url: `/projects/${project.id}/files` });
    const content = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("hello world.txt")}`,
    });
    const media = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=cover.png` });
    const location = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=${encodeURIComponent("hello world.txt")}`,
    });
    const folderLocation = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=empty-folder`,
    });

    expect(files.json()).toEqual([
      { path: "cover.png", size: 3, mediaType: "image", origin: "workspace", purpose: "asset" },
      { path: "empty-folder", size: 0, directory: true },
      { path: "hello world.txt", size: 6 },
    ]);
    expect(content.json()).toMatchObject({ path: "hello world.txt", content: "Hello\n", binary: false });
    expect(media.headers["content-type"]).toBe("image/png");
    expect(media.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(location.json()).toEqual({ path: path.join(await realpath(project.workspacePath), "hello world.txt") });
    expect(folderLocation.json()).toEqual({ path: path.join(await realpath(project.workspacePath), "empty-folder") });
  });

  it("renames and deletes workspace assets", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "old name.png"), Buffer.from([1, 2, 3]));

    const renamed = await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}/assets?path=${encodeURIComponent("old name.png")}`,
      payload: { name: "new name" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/assets?path=${encodeURIComponent("new name.png")}`,
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ path: "new name.png" });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).not.toContainEqual(expect.objectContaining({ path: "opening.mp4" }));
  });

  it("saves project media once in the global Library and protects references", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-api-")) });
    apps.push(app);
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await writeFile(path.join(project.workspacePath, "opening.mp4"), "video bytes");
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
    await saveProjectAsset(app, project.id, "opening.mp4");

    const first = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    const second = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ name: "opening.mp4", mediaType: "video", contentType: "video/mp4", size: 11 });
    const content = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/content` });
    expect(content.rawPayload.toString()).toBe("video bytes");

    await useLibraryAssetInGraph(app, project.id, "opening", "video", first[0].id);
    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Asset is used by 1 project" });

    const references = await app.inject({ method: "GET", url: `/library/assets/${first[0].id}/references` });
    expect(references.json()).toEqual([{ id: project.id, name: "Story", type: "interactive-story" }]);
    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${first[0].id}?force=true` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).not.toContainEqual(expect.objectContaining({ path: "opening.mp4" }));
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.opening).toBeUndefined();
  });

  it("materializes a Library asset once", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-materialize-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    const target = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Target" } })).json();
    await writeFile(path.join(source.workspacePath, "sprite.png"), Buffer.from(REFERENCE_PNG, "base64"));
    await saveProjectAsset(app, source.id, "sprite.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/${asset.id}` }),
      app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/${asset.id}` }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(await readdir(path.join(target.workspacePath, "assets", "imported"))).toEqual(["sprite.png"]);
    const missing = await app.inject({ method: "POST", url: `/projects/${target.id}/library-assets/missing` });
    expect(missing.statusCode).toBe(404);
    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
  });

  it("blocks Library deletion when an Interactive Story document cannot be verified", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-broken-graph-")) });
    apps.push(app);
    const storyProject = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await writeFile(path.join(storyProject.workspacePath, "graph.json"), JSON.stringify({ version: 1, nodes: "broken" }));
    const source = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(source.workspacePath, "image.png"), "image bytes");
    await saveProjectAsset(app, source.id, "image.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=image.png` });

    const response = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Cannot verify Library references");
  });

  it("renames and deletes an unreferenced Library asset", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-actions-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "sprite.png"), "image bytes");
    await saveProjectAsset(app, project.id, "sprite.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${project.id}/assets?path=sprite.png` });

    const renamed = await app.inject({ method: "PATCH", url: `/library/assets/${asset.id}`, payload: { name: "hero" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("hero.png");
    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/library/assets/${asset.id}/content` })).statusCode).toBe(404);
  });

  it("imports a local image into the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await app.inject({
      method: "POST",
      url: "/library/assets",
      payload: {
        name: "reference.webp",
        image: { mediaType: "image/png", data: png.toString("base64") },
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "reference.png", mediaType: "image", contentType: "image/png" });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.rawPayload).toEqual(png);

    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await useLibraryAssetInGraph(app, project.id, "reference", "image", response.json().id);
    expect((await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/references` })).json()).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.reference).toBeUndefined();
  });

  it("rejects Library image data that does not match its media type", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets",
      payload: {
        name: "reference.png",
        image: { mediaType: "image/png", data: Buffer.from("not a png").toString("base64") },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Image data does not match its media type" });
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
  });

  it("uploads a video into the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=opening.mp4&mediaType=video%2Fmp4&duration=6.5",
      headers: { "content-type": "application/octet-stream" },
      payload: mp4,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "opening.mp4", mediaType: "video", contentType: "video/mp4", duration: 6.5 });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.rawPayload).toEqual(mp4);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await useLibraryAssetInGraph(app, project.id, "clip", "video", response.json().id);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${response.json().id}?force=true` })).statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.clip).toBeUndefined();
    expect(updated.graph.nodes[0].assets).not.toContain("clip");
  });

  it("records the Library video a trimmed upload was cut from, and rejects an unknown or partial source", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-trim-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const upload = (query: string) => app.inject({
      method: "POST",
      url: `/library/assets/upload?${query}`,
      headers: { "content-type": "application/octet-stream" },
      payload: mp4,
    });
    const original = (await upload("name=opening.mp4&mediaType=video%2Fmp4&duration=10")).json();

    const trimmed = await upload(`name=opening%20(trimmed).mp4&mediaType=video%2Fmp4&duration=3.2&trimSource=${original.id}&trimStart=2.2&trimEnd=5.4`);
    expect(trimmed.statusCode, trimmed.body).toBe(201);
    expect(trimmed.json()).toMatchObject({ name: "opening (trimmed).mp4", duration: 3.2, derivedFrom: { assetId: original.id, trim: { start: 2.2, end: 5.4 } } });
    expect((await upload("name=plain.mp4&mediaType=video%2Fmp4")).json().derivedFrom).toBeUndefined();

    for (const query of [
      "name=a.mp4&mediaType=video%2Fmp4&trimSource=missing&trimStart=1&trimEnd=2",
      `name=a.mp4&mediaType=video%2Fmp4&trimSource=${original.id}&trimStart=1`,
      `name=a.mp4&mediaType=video%2Fmp4&trimSource=${original.id}&trimStart=3&trimEnd=2`,
    ]) {
      const response = await upload(query);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toEqual({ error: "Invalid trim source" });
    }

    // The record survives a restart.
    const reopened = createApp({ dataDirectory });
    apps.push(reopened);
    const listed = (await reopened.inject({ method: "GET", url: "/library/assets" })).json() as { id: string; derivedFrom?: unknown }[];
    expect(listed.find((asset) => asset.id === trimmed.json().id)?.derivedFrom).toEqual({ assetId: original.id, trim: { start: 2.2, end: 5.4 } });
  });

  it("uploads and serves an SVG image from the global Library", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>');

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=logo.svg&mediaType=image%2Fsvg%2Bxml",
      headers: { "content-type": "application/octet-stream" },
      payload: svg,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ name: "logo.svg", mediaType: "image", contentType: "image/svg+xml" });
    const content = await app.inject({ method: "GET", url: `/library/assets/${response.json().id}/content` });
    expect(content.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(content.rawPayload).toEqual(svg);
  });

  it("uploads GIF, AVIF, Ogg, M4A and GLB files whose data matches their type", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from(`ftyp${brand}\0\0\0\0mif1`, "latin1")]);
    const glb = Buffer.alloc(12);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(12, 8);
    const upload = (name: string, mediaType: string, payload: Buffer) => app.inject({
      method: "POST",
      url: `/library/assets/upload?name=${name}&mediaType=${encodeURIComponent(mediaType)}`,
      headers: { "content-type": "application/octet-stream" },
      payload,
    });
    for (const [name, mediaType, kind, payload] of [
      ["walk.gif", "image/gif", "image", Buffer.from("GIF89a\x01\0\x01\0", "latin1")],
      ["sky.avif", "image/avif", "image", ftyp("avif")],
      ["theme.ogg", "audio/ogg", "audio", Buffer.from("OggS\0\x02", "latin1")],
      ["voice.m4a", "audio/mp4", "audio", ftyp("M4A ")],
      ["hero.glb", "model/gltf-binary", "model", glb],
    ] as const) {
      const response = await upload(name, mediaType, payload);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ name, mediaType: kind, contentType: mediaType });
    }
    for (const [name, mediaType, payload] of [
      ["sky.avif", "image/avif", ftyp("isom")],
      ["clip.mp4", "video/mp4", ftyp("avif")],
      ["hero.glb", "model/gltf-binary", Buffer.from("not a model")],
    ] as const) {
      const response = await upload(name, mediaType, payload);
      expect(response.statusCode, name).toBe(400);
      expect(response.json()).toEqual({ error: "File data does not match its media type" });
    }
  });

  it("rejects non-SVG data uploaded as SVG", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-library-upload-")) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=logo.svg&mediaType=image%2Fsvg%2Bxml",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("not an svg"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "File data does not match its media type" });
  });

  it("rejects unsafe workspace file paths", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/content?path=${encodeURIComponent("../project.json")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid workspace path" });
    const location = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/location?path=${encodeURIComponent("../project.json")}`,
    });
    expect(location.statusCode).toBe(400);
  });

  it("validates workspace references before prompting", async () => {
    const prompts: string[] = [];
    const session: CodingSession = {
      messages: [],
      prompt: async (prompt) => { prompts.push(prompt); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-reference-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "Hello");
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "index.html" }] },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Review", references: [{ type: "workspace-file", path: "missing.html" }] },
    });

    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompts[0]).toContain('["index.html"]'));
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "File not found" });
  });

  it("validates Plugin mentions and sends Codex references to Pi", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mention-api-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "godot-game" } })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const mention = { name: "godot", displayName: "Godot", marketplaceId: "ohmygame" };

    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Godot", mentions: [mention] },
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("Use [@Godot](plugin://godot@ohmygame)"));
    const incompatible = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game" } })).json();
    const otherConversation = (await app.inject({ method: "POST", url: `/projects/${incompatible.id}/conversations` })).json();
    const mismatch = await app.inject({ method: "POST", url: `/projects/${incompatible.id}/conversations/${otherConversation.id}/turns`, payload: { prompt: "Use @Godot", mentions: [mention] } });
    expect(mismatch.statusCode).toBe(409);
    expect(prompt).toHaveBeenCalledTimes(1);
    const rejected = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Use @Missing", mentions: [{ name: "missing", displayName: "Missing", marketplaceId: "ohmygame" }] },
    });

    expect(accepted.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "Plugin Missing is not installed" });
  });

  it("returns the skills loaded by the current conversation session", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-capabilities-api-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [{ name: "review", description: "Review changes" }],
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${conversation.id}/capabilities`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([{ name: "review", description: "Review changes" }]);
  });

  it("exposes the shared Plugins and Skills to Interactive Story conversations", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-story-capabilities-api-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [{ name: "godot", description: "Control Godot" }],
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${conversation.id}/capabilities`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([{ name: "godot", description: "Control Godot" }]);
  });

  it("offers only configured OhMyGame media generation tools without a Plugin", async () => {
    const setActiveToolsByName = vi.fn();
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-default-media-tools-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        setActiveToolsByName,
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Create a character image" },
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "update_plan",
      "generate_image",
      "generate_3d_asset",
      "generate_video",
      "animate_3d_asset",
    ]);
  });

  it("offers only the audio operations supported by configured providers", async () => {
    const setActiveToolsByName = vi.fn();
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-audio-tools-"));
    await new LocalApiKeyStore(path.join(dataDirectory, "local-api-keys.json")).modify("kunpo", async () => ({ type: "api_key", key: "sk-audio-tools-kunpo-fixture" }));
    const registered = ["read", "write", "edit", "ls", "find", "grep", "update_plan", "generate_image", "generate_3d_asset", "generate_video", "animate_3d_asset", "generate_speech", "generate_sound_effect", "generate_music"];
    const app = createApp({
      dataDirectory,
      piAgentDirectory: dataDirectory,
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        setActiveToolsByName,
        getAllTools: () => registered.map((name) => ({ name })),
      }),
    });
    apps.push(app);
    const catalog = (await app.inject({ method: "GET", url: "/audio-models/catalog" })).json();
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "volcengine-tts", id: "seed-audio-1.0", capabilities: expect.objectContaining({ operationStatus: { speech: "unverified" } }) }),
      expect.objectContaining({ provider: "volcengine-seed-audio", id: "seed-audio-1.0", capabilities: expect.objectContaining({ operationStatus: { "sound-effect": "documented", music: "unverified" } }) }),
    ]));
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Create a voice line" },
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(setActiveToolsByName).toHaveBeenCalledWith(registered);
    expect(setActiveToolsByName.mock.calls.at(-1)?.[0]).not.toEqual(expect.arrayContaining(["bash", "web_search", "install_plugin"]));
  });

  it.each([
    ["png", REFERENCE_PNG],
    ["gif", "R0lGODlhAwACAIAAAExpcVOEOiH5BAUAAAAALAAAAAADAAIAAAICjF8AOw=="],
  ])("accepts a %s reference without text and keeps it in the conversation only", async (extension, data) => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-image-prompt-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { name: `狗大王.${extension.toUpperCase()}`, mediaType: `image/${extension}`, data };

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", images: [image] },
    });

    expect(response.statusCode, response.body).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("", {
      images: [expect.objectContaining({ type: "image", mimeType: image.mediaType, data })],
    }));
    await vi.waitFor(async () => {
      const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
      expect(detail.json().agent.status).toBe("idle");
    });
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Again", images: [image] } })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).toEqual([]);
  });

  it("rejects malformed or credential-bearing conversation images before starting the agent", async () => {
    const createSession = vi.fn(async (): Promise<CodingSession> => { throw new Error("Unexpected agent request"); });
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-rejected-reference-")), createSession });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const png = Buffer.from(REFERENCE_PNG, "base64");
    const marker = "CANARY_CHAT_IMAGE_PROTECTED_CONTENT";
    registerSensitiveValue(marker);
    for (const [mediaType, bytes, status] of [
      ["image/jpeg", png, 400],
      ["image/png", png.subarray(0, 8), 400],
      ["image/png", Buffer.concat([png, Buffer.from(marker)]), 403],
    ] as const) {
      const response = await app.inject({
        method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
        payload: { prompt: "Inspect", images: [{ mediaType, data: bytes.toString("base64") }] },
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.body).not.toContain(marker);
    }
    expect(createSession).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual([]);
  });

  it("stores dropped files outside the game workspace and gives the agent an attachment manifest", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachments-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const batchId = "dbd8b240-d5e1-4d0e-a741-5e9bd23f7571";

    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=dialogue.json&relativePath=${encodeURIComponent("references/dialogue.json")}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from('{"opening":"Hello"}'),
    });

    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json()).toMatchObject({ batchId, relativePath: "references/dialogue.json", kind: "text" });
    expect(await readFile(path.join(project.workspacePath, ".data", "agent-attachments", batchId, "files", "references", "dialogue.json"), "utf8")).toContain("Hello");
    const metadata = JSON.parse(await readFile(path.join(project.workspacePath, ".data", "agent-attachments", batchId, "metadata", `${uploaded.json().id}.json`), "utf8"));
    expect(metadata).not.toHaveProperty("absolutePath");

    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", attachments: [{ id: uploaded.json().id, batchId }, { id: uploaded.json().id, batchId }] },
    });

    expect(sent.statusCode, sent.body).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.stringContaining("references/dialogue.json")));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("untrusted reference material"));
    const reference = `attachment:${batchId}/${uploaded.json().id}`;
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining(reference));
    const [read, write] = createLocalAgentFileTools(project.workspacePath, undefined, false, (receipt) => receipt.batchId === batchId && receipt.id === uploaded.json().id);
    expect((await read!.execute("inspect", { path: reference }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "text", text: '{"opening":"Hello"}' }]);
    await expect(write!.execute("replace", { path: reference, content: "changed" }, undefined, undefined, {} as never)).rejects.toThrow();
    const file = path.join(project.workspacePath, ".data", "agent-attachments", batchId, "files", "references", "dialogue.json");
    await link(file, path.join(project.workspacePath, "other.json"));
    await expect(read!.execute("linked", { path: reference }, undefined, undefined, {} as never)).rejects.toThrow("Invalid stored attachment");
  });

  it("passes an uploaded reference to a vision-capable agent when the game exceeds its source limit", async () => {
    const prompt = vi.fn<CodingSession["prompt"]>(async () => {});
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-image-")),
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const batchId = "ae4a9775-641e-4595-bbc8-1f1de5fb889b";
    const image = Buffer.from(REFERENCE_PNG, "base64");
    await writeFile(path.join(project.workspacePath, "existing.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const saved = await app.inject({ method: "POST", url: "/library/assets", payload: {
      name: "Library original.png", purpose: "asset", image: { mediaType: "image/png", data: REFERENCE_PNG },
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    const before = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    expect(before).toMatchObject([{ id: saved.json().id, purpose: "asset", referenceOnly: false, projects: [] }]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=hero.png`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: image,
    });

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ kind: "image", mediaType: "image/png" });
    const stored = await resolveAgentAttachment(project.workspacePath, uploaded.json());
    await expect(new AgentAttachmentStore().promptImage(project, stored, REFERENCE_PNG.length - 1))
      .rejects.toMatchObject({ statusCode: 413 });

    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "", attachments: [{ id: uploaded.json().id, batchId }] },
    });

    expect(sent.statusCode, sent.body).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.stringContaining("hero.png"), {
      images: [expect.objectContaining({ type: "image", mimeType: "image/png", data: REFERENCE_PNG })],
    }));
    const reference = `attachment:${batchId}/${uploaded.json().id}`;
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining(reference), expect.anything());
    const read = createLocalAgentFileTools(project.workspacePath, undefined, true, (receipt) => receipt.batchId === batchId && receipt.id === uploaded.json().id)[0]!;
    expect((await read.execute("reference", { path: reference }, undefined, undefined, {} as never)).content)
      .toEqual([{ type: "image", mimeType: "image/png", data: REFERENCE_PNG }]);
    expect(await readFile(stored.absolutePath)).toEqual(image);
    expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toEqual(before);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json()).toMatchObject([{ path: "existing.png" }]);
    const imported = await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${saved.json().id}` });
    expect(imported.statusCode, imported.body).toBe(400);
    expect(imported.json().error).toContain("isolated source limits");
    await expect(stat(path.join(project.workspacePath, "assets/imported/Library original.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe folder paths in agent attachments", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-path-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const batchId = "f8b3c92d-5017-4d83-bf05-946208ee2b1a";

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=.env&relativePath=${encodeURIComponent("secrets/.env")}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from("SECRET=value"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid attachment path" });
  });

  it("rejects linked attachment storage before writing uploads or pruning expired batches", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-attachment-links-"));
    const app = createApp({ dataDirectory: data });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const outside = path.join(data, "outside");
    const batchId = "f8b3c92d-5017-4d83-bf05-946208ee2b1a";
    const expired = path.join(outside, "agent-attachments", "17d3e762-a161-4ab3-bc3c-9e28673f17e4");
    await mkdir(expired, { recursive: true });
    await writeFile(path.join(expired, "keep.txt"), "keep");
    await utimes(expired, new Date(0), new Date(0));
    await rm(path.join(project.workspacePath, ".data"), { recursive: true, force: true });
    await symlink(outside, path.join(project.workspacePath, ".data"), "junction");
    const result = await app.inject({ method: "POST", url: `/projects/${project.id}/attachments?batchId=${batchId}&name=notes.txt`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" }, payload: "sample" });
    expect(result.statusCode).toBe(409);
    expect(await readdir(path.join(outside, "agent-attachments"))).toEqual([path.basename(expired)]);
    expect(await readFile(path.join(expired, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects attachment metadata that no longer matches its file", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-metadata-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const batchId = "d8ea3d7b-4665-4e7a-9d58-f1e246ac812d";
    const uploaded = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=notes.txt`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from("hello"),
    });
    const metadataPath = path.join(project.workspacePath, ".data", "agent-attachments", batchId, "metadata", `${uploaded.json().id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

    await writeFile(metadataPath, JSON.stringify({ ...metadata, size: 1 }));
    const wrongSize = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: uploaded.json().id, batchId }] },
    });
    expect(wrongSize.statusCode).toBe(500);

    await writeFile(metadataPath, JSON.stringify({ ...metadata, kind: "image", mediaType: "image/png" }));
    const fakeImage = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: uploaded.json().id, batchId }] },
    });
    expect(fakeImage.statusCode).toBe(500);
  });

  it("cleans expired draft batches but retains batches used by a conversation", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-agent-attachment-cleanup-")),
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const expiredBatch = "1e447592-12ac-4f8f-9da0-6027daf6a902";
    const claimedBatch = "c14bbf1a-1534-4e2a-b850-cd9e076af289";
    const upload = async (batchId: string, name: string) => app.inject({
      method: "POST",
      url: `/projects/${project.id}/attachments?batchId=${batchId}&name=${name}`,
      headers: { "content-type": "application/vnd.ohmygame.attachment" },
      payload: Buffer.from(name),
    });

    const expired = await upload(expiredBatch, "expired.txt");
    const claimed = await upload(claimedBatch, "claimed.txt");
    const sent = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Read it", attachments: [{ id: claimed.json().id, batchId: claimedBatch }] },
    });
    expect(sent.statusCode).toBe(202);

    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const attachmentRoot = path.join(project.workspacePath, ".data", "agent-attachments");
    await utimes(path.join(attachmentRoot, expiredBatch), old, old);
    await utimes(path.join(attachmentRoot, claimedBatch), old, old);
    expect((await upload("fd2de1f6-0acf-4d68-84cb-d8066f33ffeb", "fresh.txt")).statusCode).toBe(201);

    await expect(readFile(path.join(attachmentRoot, expiredBatch, "files", "expired.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(attachmentRoot, claimedBatch, "files", "claimed.txt"), "utf8")).toBe("claimed.txt");
    expect(expired.statusCode).toBe(201);
  });

  it("restores an active image prompt without replaying its base64 event", async () => {
    let finishPrompt!: () => void;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-active-image-")),
      createSession: async () => ({
        messages: [],
        prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
        abort: async () => { finishPrompt(); },
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const image = { mediaType: "image/png", data: REFERENCE_PNG };
    const turn = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Describe", images: [image] },
    });

    const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });

    expect(detail.json()).toMatchObject({
      turns: [{
        id: turn.json().turnId,
        conversationId: conversation.id,
        status: "inProgress",
        items: [
          { type: "userMessage", text: "Describe", images: [{ mediaType: image.mediaType, data: "", url: expect.any(String) }], turnId: turn.json().turnId },
          { type: "imageRead", count: 1, status: "completed", turnId: turn.json().turnId },
        ],
      }],
      cursor: 2,
    });
    expect(detail.body).not.toContain(image.data);
    const imageUrl = detail.json().turns[0].items[0].images[0].url;
    const content = await app.inject({ method: "GET", url: imageUrl });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("image/png");
    expect(content.rawPayload).toEqual(Buffer.from(image.data, "base64"));
    await expect.poll(() => typeof finishPrompt).toBe("function");
    finishPrompt();
  });

  it("removes only the expected pending follow-up", async () => {
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp: async () => {},
      steer: async () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-pending-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "First" },
    });
    const pending = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Second" },
    });

    const stale = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/stale-turn`,
    });
    const current = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
    const removed = await app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/conversations/${conversation.id}/queue/${pending.json().turnId}`,
    });

    expect(stale.statusCode).toBe(409);
    expect(current.json().pendingPrompts).toEqual([
      expect.objectContaining({ turnId: pending.json().turnId, prompt: "Second" }),
    ]);
    expect(removed.statusCode).toBe(204);
    finishPrompt();
  });

  it("removes and steers queued messages", async () => {
    let finishPrompt!: () => void;
    const followUp = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      followUp,
      steer,
      clearQueue,
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-queue-api-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "First" } });
    const second = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Second" } })).json();
    const third = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Third" } })).json();

    const steered = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/queue/${third.turnId}/steer` });
    const detail = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` })).json();

    expect(steered.statusCode).toBe(204);
    expect(detail.pendingPrompts).toEqual([
      expect.objectContaining({ turnId: third.turnId, prompt: "Third", steering: true }),
      expect.objectContaining({ turnId: second.turnId, prompt: "Second" }),
    ]);
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenLastCalledWith("Third", undefined);
    finishPrompt();
  });

  it("serves the Playable sandbox without a token", async () => {
    const playerDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-"));
    await mkdir(path.join(playerDirectory, "assets"));
    await writeFile(path.join(playerDirectory, "playable-sandbox.html"), "<script src=\"./assets/playable-sandbox.js\"></script>");
    await writeFile(path.join(playerDirectory, "assets", "playable-sandbox.js"), "console.log(1);");
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")),
      interactiveStoryPlayerDirectory: playerDirectory,
      accessToken: "secret",
    });
    apps.push(app);
    const page = await app.inject({ method: "GET", url: "/playable-sandbox/playable-sandbox.html" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.body).toContain("./assets/playable-sandbox.js");
    const script = await app.inject({ method: "GET", url: "/playable-sandbox/assets/playable-sandbox.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toMatch(/^text\/javascript/);
    // Everything else still needs the token.
    expect((await app.inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/playable-sandbox/playable-sandbox.html?x" })).statusCode).toBe(401);
  });

  it("exposes health and rejects empty prompts", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: " " },
    });
    expect(response.statusCode).toBe(400);
    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "This folder has no package.json dev script that starts a preview server." });
  });

  it("stores and serves a WebP project cover", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-cover-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const cover = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

    const missing = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });
    const invalid = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: Buffer.from("not-webp"),
    });
    const stored = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/cover`,
      headers: { "content-type": "image/webp" },
      payload: cover,
    });
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/cover` });

    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(stored.statusCode).toBe(204);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.headers["content-type"]).toBe("image/webp");
    expect(loaded.rawPayload).toEqual(cover);
  });

  it("stores Node thumbnails as editor cache outside the file list", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnail-api-")) });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Nodes", type: "interactive-story" } })).json();
    await writePlayableFixtureWorkspace(project.workspacePath);
    const image = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    const put = (nodeId: string, payload: Buffer, hash = "0123abcd0123ab") => app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/thumbnails/${nodeId}?hash=${hash}`,
      headers: { "content-type": "image/webp" },
      payload,
    });

    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails/menu` })).statusCode).toBe(404);
    expect((await put("menu", Buffer.from("not-webp"))).statusCode).toBe(400);
    expect((await put("nowhere", image)).statusCode).toBe(400);
    expect((await put("menu", image, "nope")).statusCode).toBe(400);
    const stored = await put("menu", image);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ hash: "0123abcd0123ab" });

    const listed = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails` });
    expect(listed.json()).toEqual({ thumbnails: { menu: stored.json() } });
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/thumbnails/menu` });
    expect(loaded.headers["content-type"]).toBe("image/webp");
    expect(loaded.rawPayload).toEqual(image);

    const files = (await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json() as { path: string }[];
    expect(files.some((file) => file.path.startsWith(".ohmygame"))).toBe(false);
  });

  it("opens an idle event stream immediately", async () => {
    const headers = { authorization: "Bearer local-stream-test" };
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-sse-")), accessToken: "local-stream-test" });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {}, headers })).json();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${address}/projects/${project.id}/events`, { signal: controller.signal, headers });
      const chunk = await response.body?.getReader().read();
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(chunk?.value)).toBe(": connected\n\n");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it("uses the first prompt as the conversation title without renaming the project", async () => {
    const session: CodingSession = {
      messages: [],
      prompt: async () => { throw new Error("No API key"); },
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-title-")),
      createSession: async () => session,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
    })).json();

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "Build a small game" },
    });
    const conversations = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations`,
    });
    const unchangedProject = await app.inject({ method: "GET", url: `/projects/${project.id}` });

    expect(conversations.json()).toEqual([
      expect.objectContaining({ id: conversation.id, title: "Build a small game" }),
    ]);
    expect(unchangedProject.json().name).toBe(project.name);
  });

  it("stores explicit conversation choices and retains project defaults independently of configured models", async () => {
    const first = { provider: "provider-one", id: "model-one", name: "Model One", reasoning: true };
    const second = { provider: "provider-one", id: "model-two", name: "Model Two", reasoning: true };
    const runtime = fakeModelRuntime([first, second]);
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-models-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();

    const models = await app.inject({ method: "GET", url: "/models" });
    const defaults = await app.inject({
      method: "PUT",
      url: "/models/default",
      payload: { model: { provider: second.provider, id: second.id }, reasoningLevel: "high" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: { model: { provider: first.provider, id: first.id }, reasoningLevel: "medium" },
    });
    const createdWithDefaults = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: {},
    });
    expect(createdWithDefaults.statusCode, createdWithDefaults.body).toBe(201);
    const projectDefault = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${createdWithDefaults.json().id}` });
    expect(projectDefault.json().settings).toEqual({ model: project.modelSelections.agent, reasoningLevel: "off" });
    const createdWithExplicitModel = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations`,
      payload: { model: { provider: second.provider, id: second.id } },
    });
    expect(createdWithExplicitModel.statusCode).toBe(201);
    const changed = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/model`,
      payload: { provider: second.provider, id: second.id },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${created.json().id}`,
    });
    const defaultDetail = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/conversations/${createdWithExplicitModel.json().id}`,
    });
    const reasoning = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/conversations/${created.json().id}/reasoning`,
      payload: { level: "high" },
    });

    expect(models.json()).toEqual({
      models: [
        { provider: first.provider, providerName: first.provider, id: first.id, name: first.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"], supportsImages: false },
        { provider: second.provider, providerName: second.provider, id: second.id, name: second.name, reasoningLevels: ["off", "minimal", "low", "medium", "high"], supportsImages: false },
      ],
      defaultReasoningLevel: "medium",
    });
    expect(defaults.statusCode).toBe(204);
    expect(created.json()).toMatchObject({ id: expect.any(String), projectId: project.id, title: "New conversation" });
    expect(changed.json()).toEqual({
      model: { provider: second.provider, id: second.id },
      reasoningLevel: "medium",
    });
    expect(reasoning.json()).toEqual({ level: "high" });
    expect(detail.json().settings.model).toEqual({ provider: second.provider, id: second.id });
    expect(detail.json().cursor).toBe(0);
    expect(defaultDetail.json().settings).toEqual({
      model: { provider: second.provider, id: second.id },
      reasoningLevel: "high",
    });
  });

  it("applies an OpenAI-compatible endpoint through Pi", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const runtime = {
      ...fakeModelRuntime([]),
      listCredentials: async () => [],
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" });
    const custom = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://relay.example/v1" },
    });
    const official = await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(initial.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(custom.json()).toEqual({ baseUrl: "https://relay.example/v1" });
    expect(official.json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(registerProvider).toHaveBeenCalledWith("openai", { baseUrl: "https://relay.example/v1" });
    expect(unregisterProvider).toHaveBeenCalledWith("openai");
  });

  it("never sends a ChatGPT sign-in through the custom OpenAI endpoint", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const runtime = {
      ...fakeModelRuntime([]),
      listCredentials: async () => [{ providerId: "openai", type: "oauth" }],
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-oauth-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    await app.inject({
      method: "PUT",
      url: "/settings/models/providers/openai/endpoint",
      payload: { baseUrl: "https://relay.example/v1" },
    });

    expect(registerProvider).not.toHaveBeenCalled();
    expect(unregisterProvider).not.toHaveBeenCalled();
  });

  it("refuses retired ChatGPT sign-in without invoking the SDK or changing stored endpoint metadata", async () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    const loginProvider = vi.fn(async () => ({ type: "oauth" }));
    const runtime = {
      ...fakeModelRuntime([]),
      getProvider: (provider: string) => ({ name: provider, auth: { oauth: {}, apiKey: { login: true } } }),
      listCredentials: async () => [],
      login: loginProvider,
      registerProvider,
      unregisterProvider,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-signin-")),
      createModelRuntime: async () => runtime,
    });
    apps.push(app);

    await app.inject({ method: "PUT", url: "/settings/models/providers/openai/endpoint", payload: { baseUrl: "https://relay.example/v1" } });
    expect(registerProvider).toHaveBeenCalledWith("openai", { baseUrl: "https://relay.example/v1" });

    const login = await app.inject({ method: "POST", url: "/settings/models/providers/openai/login", payload: { method: "oauth" } });
    expect(login.statusCode).toBe(403);
    expect(loginProvider).not.toHaveBeenCalled();
    expect(unregisterProvider).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" })).json()).toEqual({ baseUrl: "https://relay.example/v1" });
  });

  it("does not expose the removed Cloud model connection", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-cloud-removed-")) });
    apps.push(app);
    const connected = await app.inject({ method: "PUT", url: "/account/connection", payload: { accessToken: "user-token" } });
    expect(connected.statusCode).toBe(404);
  });

  it("rejects new legacy media credentials, lists only stored key names, and clears a key without changing model defaults", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-retired-media-"));
    const ids = ["meshy", "tripo", "hyper3d", "volcengine-ark", "byteplus-modelark", "minimax-video-cn", "minimax-video-global"];
    const preferences = { version: 1, hidden: {}, defaultModel3D: { provider: "meshy", id: "my-model" } };
    await Promise.all(Object.entries({
      "meshy.json": { version: 1, apiKey: "legacy-shared-test" },
      "minimax.json": { version: 1, cnApiKey: "legacy-cn-test", globalApiKey: "legacy-global-test" },
      "model-visibility.json": preferences,
    }).map(([file, contents]) => writeFile(path.join(directory, file), JSON.stringify(contents))));
    const request = vi.fn<typeof fetch>();
    const app = createApp({ dataDirectory: directory, videoFetch: request, model3DFetch: request });
    apps.push(app);
    const url = "/settings/models/legacy-media-keys";
    for (const id of ids) {
      const suffix = id.startsWith("minimax") ? "/minimax-key" : ["volcengine-ark", "byteplus-modelark"].includes(id) ? "/seedance-key" : "";
      const denied = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}${suffix}`, payload: { apiKey: "rejected-test-key" } });
      expect(denied.statusCode, denied.body).toBe(410);
      expect(denied.body).not.toContain("rejected-test-key");
    }
    expect((await app.inject("/settings/models/providers/meshy")).json()).toEqual({ configured: false, hasSavedKey: true });
    const listed = (await app.inject(url)).json();
    expect(listed).toEqual([{ id: "meshy", name: "Meshy" }, { id: "minimax-video-cn", name: "MiniMax China" }, { id: "minimax-video-global", name: "MiniMax Global" }]);
    expect((await app.inject("/model3d-models/catalog")).json()).toMatchObject({ models: [], providers: [] });
    const videos = await app.inject("/video-models/catalog");
    expect(videos.statusCode).toBe(200);
    expect(videos.json().providers).not.toContainEqual(expect.objectContaining({ provider: "minimax-video-cn" }));
    expect((await app.inject({ method: "DELETE", url: `${url}/minimax-video-cn` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `${url}/meshy` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `${url}/kunpo` })).statusCode).toBe(404);
    expect((await app.inject(url)).json()).toEqual([listed[2]]);
    expect(JSON.parse(await readFile(path.join(directory, "minimax.json"), "utf8"))).toEqual({ version: 1, globalApiKey: "legacy-global-test" });
    expect(JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"))).toEqual(preferences);
    expect((await app.inject("/settings/models/providers/meshy")).json()).toEqual({ configured: false, hasSavedKey: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose legacy Seedance connections or use their keys to configure Kunpo", async () => {
    const request = vi.fn<typeof fetch>();
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-settings-"));
    await writeFile(path.join(dataDirectory, "seedance.json"), JSON.stringify({ version: 1, volcengineApiKey: "volc-key", byteplusApiKey: "byteplus-key" }));
    const app = createApp({ dataDirectory, videoFetch: request });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/settings/providers" });
    expect(initial.json()).toContainEqual(expect.objectContaining({ id: "kunpo", configured: false }));
    expect(initial.json().some((provider: { id: string }) => ["volcengine-ark", "byteplus-modelark"].includes(provider.id))).toBe(false);
    expect(initial.body).not.toContain("volc-key");

    const configured = await app.inject({ method: "GET", url: "/settings/providers" });
    expect(configured.json()).toContainEqual(expect.objectContaining({ id: "kunpo", configured: false }));
    expect(configured.json().some((provider: { id: string }) => ["volcengine-ark", "byteplus-modelark"].includes(provider.id))).toBe(false);
    expect(configured.body).not.toContain("volc-key");
    expect(configured.body).not.toContain("byteplus-key");

    const submitted = await app.inject({ method: "POST", url: "/tools/generate-video/jobs", payload: {
      prompt: "No native key migration", model: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" },
    } });
    expect(submitted.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ url: "/tool-jobs" })).json();
      expect(jobs.find((job: { id: string }) => job.id === submitted.json().id)?.status).toBe("failed");
    });
    expect(request).not.toHaveBeenCalled();

    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/volcengine-ark/seedance-key" })).statusCode).toBe(204);
    const afterDomesticClear = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(afterDomesticClear).toContainEqual(expect.objectContaining({ id: "kunpo", configured: false }));
    expect(afterDomesticClear.some((provider: { id: string }) => ["volcengine-ark", "byteplus-modelark"].includes(provider.id))).toBe(false);
    expect((await app.inject({ method: "PUT", url: "/settings/models/providers/openrouter/seedance-key", payload: { apiKey: "sk-rejected-native-seedance-unique-canary-only" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/openrouter/seedance-key" })).statusCode).toBe(404);
  });

  it.each([false, true])("retires global Speaker settings and preview without sending audio (connected=%s)", async (connected) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-retired-speech-"));
    const credential = "sk-retired-speech-route-canary";
    const legacyFile = path.join(directory, "volcengine-tts.json");
    const legacy = { version: 1, defaultVoiceId: "old-speaker" };
    await writeFile(legacyFile, JSON.stringify(legacy), { mode: 0o600 });
    if (connected) await new LocalApiKeyStore(path.join(directory, "local-api-keys.json")).modify("kunpo", async () => ({ type: "api_key", key: credential }));
    const audioFetch = vi.fn<typeof fetch>();
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, audioFetch });
    const url = "/settings/models/providers/volcengine-tts";
    try {
      expect((await app.inject({ url })).json()).toEqual({ configured: connected });
      const retired = [
        await app.inject({ method: "PUT", url, payload: { defaultVoiceId: "new-speaker" } }),
        await app.inject({ method: "PUT", url, payload: { apiKey: credential } }),
        await app.inject({ method: "POST", url: url + "/preview", payload: { text: "hello" } }),
      ];
      for (const response of retired) {
        expect(response.statusCode).toBe(410);
        expect(response.json().error).toContain("speech node");
        expect(response.body).not.toContain(credential);
      }
      expect(audioFetch).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(legacyFile, "utf8"))).toEqual(legacy);
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
      await expect(stat(legacyFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await app.inject({ url })).json()).toEqual({ configured: connected });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not activate Kunpo audio with a retired native audio credential", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-audio-settings-")) });
    apps.push(app);
    const settingsUrl = "/settings/models/providers/volcengine-seed-audio";
    expect((await app.inject({ method: "GET", url: settingsUrl })).json()).toEqual({ configured: false });
    const retired = await app.inject({ method: "PUT", url: settingsUrl, payload: { apiKey: "sk-retired-audio-canary" } });
    expect(retired.statusCode).toBe(410);
    expect(retired.json().error).toContain("KunpoAPI");
    expect(retired.body).not.toContain("sk-retired-audio-canary");
    expect((await app.inject({ method: "GET", url: "/audio-models/catalog" })).json().models).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toEqual([
      expect.objectContaining({ id: "kunpo", configured: false, capabilities: ["language", "image", "video", "audio", "3d"] }),
    ]);
    expect((await app.inject({ method: "DELETE", url: settingsUrl })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: settingsUrl })).json()).toEqual({ configured: false });
  });

  it("validates request bodies before they reach a manager", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-test-")) });
    apps.push(app);
    const invalidProject = await app.inject({ method: "POST", url: "/projects", payload: { name: 42 } });
    expect(invalidProject.statusCode).toBe(400);
    const invalidProjectType = await app.inject({ method: "POST", url: "/projects", payload: { type: "unknown" } });
    expect(invalidProjectType.statusCode).toBe(400);

    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
    const invalidPrompt = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: 42 },
    });
    expect(invalidPrompt.statusCode).toBe(400);
    const longName = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "x".repeat(201) },
    });
    expect(longName.statusCode).toBe(400);
  });

  it("restores a project after an app restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-restart-"));
    const first = createApp({ dataDirectory });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "Persistent" } })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory });
    apps.push(second);
    await second.ready();
    const restored = await second.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: project.id, name: "Persistent" });
    expect(restored.json()).not.toHaveProperty("canUndo");
  });

  it("restores an external workspace after an app restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-restart-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-external-workspace-"));
    await writeFile(path.join(workspacePath, "existing.txt"), "Keep me");
    const first = createApp({ dataDirectory });
    apps.push(first);
    await first.ready();
    const project = (await first.inject({ method: "POST", url: "/projects", payload: { name: "External", workspacePath } })).json();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({ dataDirectory });
    apps.push(second);
    await second.ready();
    const restored = await second.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      id: project.id,
      workspacePath: await realpath(workspacePath),
      workspaceLocation: "external",
      workspaceAvailable: true,
    });
    await second.close();
    apps.splice(apps.indexOf(second), 1);
    await rm(workspacePath, { recursive: true, force: true });

    const third = createApp({ dataDirectory });
    apps.push(third);
    await third.ready();
    const missingWorkspace = await third.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(missingWorkspace.statusCode).toBe(200);
    expect(missingWorkspace.json()).toMatchObject({
      id: project.id,
      workspaceLocation: "external",
      workspaceAvailable: false,
    });
    expect((await third.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  });

  it("restores conversation history from the project's Pi session", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-conversation-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 0 },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(0).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: 1 },
      }),
      JSON.stringify({
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp: new Date(2).toISOString(),
        summary: "Earlier context",
        firstKeptEntryId: "user-1",
        tokensBefore: 42_000,
      }),
    ].join("\n") + "\n");

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conversation: expect.objectContaining({
        id: "session-1",
        projectId: project.id,
        title: "Hello",
        messageCount: 2,
      }),
      agent: { status: "idle" },
      settings: {},
      plan: { mode: "normal" },
      turns: [{
        id: "user-1",
        conversationId: "session-1",
        status: "completed",
        items: [
          { id: "user-1", turnId: "user-1", type: "userMessage", text: "Hello", timestamp: 0 },
          { id: "assistant-1:assistant:0", turnId: "user-1", type: "agentMessage", branchEntryId: "assistant-1", text: "Hi", status: "completed", phase: "final_answer", timestamp: 1 },
          { id: "compaction-1", turnId: "user-1", type: "contextCompaction", status: "completed", summary: "Earlier context", tokensBefore: 42_000, timestamp: 2 },
        ],
      }],
      cursor: 0,
      pendingPrompts: [],
    });
  });

  it("snapshots the active turn at the latest cursor when conversation is loaded mid-run", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-active-conversation-"));
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({ dataDirectory, createSession: async () => session });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    const oldTimestamp = new Date(Date.now() - 10_000).toISOString();
    const currentTimestamp = new Date(Date.now() + 10_000).toISOString();
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      sessionEntry("old-user", null, oldTimestamp, { role: "user", content: "Current", timestamp: 0 }),
      sessionEntry("old-assistant", "old-user", oldTimestamp, { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: 1 }),
      sessionEntry("current-user", "old-assistant", currentTimestamp, { role: "user", content: "Current", timestamp: 2 }),
    ].join("\n") + "\n");
    const turn = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/session-1/turns`,
      payload: { prompt: "Current" },
    });

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.json()).toMatchObject({
      conversation: { id: "session-1" },
      agent: { status: "running" },
      turns: [{
        id: "old-user",
        status: "completed",
        items: [
          { id: "old-user", turnId: "old-user", type: "userMessage", text: "Current" },
          { id: "old-assistant:assistant:0", turnId: "old-user", type: "agentMessage", text: "Answer", status: "completed" },
        ],
      }, {
        id: turn.json().turnId,
        status: "inProgress",
        items: [
          { turnId: turn.json().turnId, type: "userMessage", text: "Current" },
        ],
      }],
      cursor: 1,
    });
    finishPrompt();
  });

  it("keeps what an earlier turn changed when the conversation is loaded while the next turn runs", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-turn-end-conversation-"));
    let finishPrompt!: () => void;
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: () => () => {},
    };
    const app = createApp({ dataDirectory, createSession: async () => session });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const sessionDirectory = path.join(dataDirectory, "projects", project.id, "session");
    await mkdir(sessionDirectory);
    const oldTimestamp = new Date(Date.now() - 10_000).toISOString();
    // The end of a turn is written as its run is closed, which is when a message that waited for that starts the
    // next run: its time is not before the start of that run.
    const endTimestamp = new Date(Date.now() + 10_000).toISOString();
    const custom = (id: string, parentId: string | null, timestamp: string, customType: string, data: object) => JSON.stringify({ type: "custom", id, parentId, timestamp, customType, data });
    await writeFile(path.join(sessionDirectory, "session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: project.workspacePath }),
      custom("checkpoint-1", null, oldTimestamp, CHECKPOINT_ENTRY, { version: 1, commit: "a".repeat(40) }),
      sessionEntry("user-1", "checkpoint-1", oldTimestamp, { role: "user", content: "Build", timestamp: 0 }),
      sessionEntry("assistant-1", "user-1", oldTimestamp, { role: "assistant", content: [{ type: "text", text: "Built" }], stopReason: "stop", timestamp: 1 }),
      custom("end-1", "assistant-1", endTimestamp, TURN_END_ENTRY, { version: 1, checkpoint: "checkpoint-1", commit: "b".repeat(40), files: 2 }),
    ].join("\n") + "\n");
    const turn = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/session-1/turns`, payload: { prompt: "Polish" } });

    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/session-1` });

    expect(response.json()).toMatchObject({
      agent: { status: "running" },
      turns: [{
        id: "user-1",
        status: "completed",
        items: [
          { id: "user-1", type: "userMessage", text: "Build", checkpointId: "checkpoint-1", changes: { files: 2 } },
          { id: "assistant-1:assistant:0", type: "agentMessage", text: "Built" },
        ],
      }, {
        id: turn.json().turnId,
        status: "inProgress",
        items: [{ type: "userMessage", text: "Polish" }],
      }],
    });
    finishPrompt();
  });

  it("includes agent output produced during the final asynchronous history read", async () => {
    let finishPrompt!: () => void;
    let emit!: Parameters<CodingSession["subscribe"]>[0];
    const session: CodingSession = {
      messages: [],
      prompt: () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
      abort: async () => { finishPrompt(); },
      dispose: () => {},
      subscribe: (listener) => { emit = listener; return () => {}; },
    };
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-snapshot-race-")), createSession: async () => session });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).json();
    await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Inspect" } });
    await expect.poll(() => typeof emit).toBe("function");
    const originalView = ConversationManager.prototype.view;
    let reads = 0;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(ConversationManager.prototype, "view").mockImplementation(async function (this: ConversationManager, project, stored) {
      const view = await originalView.call(this, project, stored);
      if (++reads === 3) await paused;
      return view;
    });
    try {
      const loading = app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}` });
      await expect.poll(() => reads).toBe(3);
      emit({ type: "message_update", message: {} as never,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} as never } });
      emit({ type: "message_update", message: {} as never,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "During read", partial: {} as never } });
      release();
      const detail = (await loading).json();
      expect(detail.turns.flatMap((turn: { items: unknown[] }) => turn.items)).toContainEqual(expect.objectContaining({
        type: "agentMessage", text: "During read",
      }));
      expect(detail.cursor).toBeGreaterThan(1);
    } finally {
      release();
      spy.mockRestore();
      finishPrompt();
    }
  });
});

/** Declares a Library asset in the project's graph and uses it on the Start node. */
/** A new project has no Scenes; adds a Blank one, `start`, through the editor's endpoint. */
async function addStartScene(app: Pick<ReturnType<typeof createApp>, "inject">, projectId: string): Promise<void> {
  const added = await app.inject({ method: "POST", url: `/projects/${projectId}/playable/nodes`, payload: { preset: "blank", id: "start" } });
  expect(added.statusCode, added.body).toBe(200);
}

/** Declares a Library asset on the project's first Scene, adding one when there is none. */
async function useLibraryAssetInGraph(
  app: ReturnType<typeof createApp>,
  projectId: string,
  id: string,
  type: "image" | "video",
  assetId: string,
): Promise<void> {
  let codebase = (await app.inject({ method: "GET", url: `/projects/${projectId}/playable/codebase` })).json();
  if (!codebase.graph.nodes.length) {
    await addStartScene(app, projectId);
    codebase = (await app.inject({ method: "GET", url: `/projects/${projectId}/playable/codebase` })).json();
  }
  codebase.graph.assets[id] = { type, source: { kind: "library", assetId } };
  codebase.graph.nodes[0].assets.push(id);
  const saved = await app.inject({ method: "PUT", url: `/projects/${projectId}/playable/codebase`, payload: codebase });
  expect(saved.statusCode, saved.body).toBe(200);
}

function sessionEntry(id: string, parentId: string | null, timestamp: string, message: object): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp, message });
}

function fakeModelRuntime(models: Array<{ provider: string; id: string; name: string }>): ModelRuntime {
  return {
    getModels: (provider?: string) => models.filter((model) => !provider || model.provider === provider),
    getAvailable: async (provider?: string) => models.filter((model) => !provider || model.provider === provider),
    getProvider: (provider: string) => ({ name: provider }),
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
    getAuth: async () => undefined,
  } as unknown as ModelRuntime;
}

describe("Playable Nodes projects", () => {
  async function createPlayableApp(prefix: string, options: Parameters<typeof createApp>[0] = {}) {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), prefix)), ...options });
    apps.push(app);
    return app;
  }

  it("creates Interactive Story projects as Playable Nodes with no Scenes yet", async () => {
    const app = await createPlayableApp("ohmygame-playable-create-");
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Nodes", type: "interactive-story", viewport: { width: 720, height: 1280 } },
    });

    expect(response.statusCode).toBe(201);
    const codebase = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable/codebase` })).json();
    expect(codebase.graph).toMatchObject({
      title: "Nodes",
      viewport: { width: 720, height: 1280 },
      nodes: [],
      edges: [],
    });
    const runtime = (await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable` })).json();
    expect(runtime).toMatchObject({ available: true, definition: { graph: { nodes: [] } } });
  });

  it("upgrades a sandboxed story to a web story and takes the upgrade back", async () => {
    const app = await createPlayableApp("ohmygame-story-upgrade-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Old", type: "interactive-story" } })).json();
    // A story from before web stories has no page and no runtime of its own.
    await rm(path.join(project.workspacePath, "index.html"));
    await rm(path.join(project.workspacePath, "story"), { recursive: true });
    await app.inject({ method: "POST", url: `/projects/${project.id}/playable/nodes`, payload: { preset: "visual-novel", id: "chapter" } });
    const status = () => app.inject({ method: "GET", url: `/projects/${project.id}/interactive-story/upgrade` }).then((response) => response.json());
    expect(await status()).toEqual({ web: false });
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/playable` })).json().web).toBeUndefined();

    const upgraded = await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade` });
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json()).toMatchObject({ copiedAssets: [], missingAssets: [] });
    expect(upgraded.json().changed).toEqual(expect.arrayContaining(["index.html", "story/story-web/runtime.js"]));
    expect(await status()).toMatchObject({ web: true, upgradedAt: expect.any(String) });
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/playable` })).json().web).toBe(true);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade` })).statusCode).toBe(409);

    // Media still in the Library show, and can be copied in once the Library has them.
    const read = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` });
    const codebase = read.json();
    const uploaded = (await app.inject({
      method: "POST",
      url: "/library/assets/upload?name=clip.mp4&mediaType=video%2Fmp4&duration=1",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    })).json();
    // The upgrade changed the workspace version, so a write carries the version it read.
    const put = await app.inject({ method: "PUT", url: `/projects/${project.id}/playable/codebase`, headers: { "x-workspace-version": String(read.headers["x-workspace-version"]) }, payload: {
      ...codebase,
      graph: { ...codebase.graph, assets: { opening: { type: "video", source: { kind: "library", assetId: uploaded.id } } } },
    } });
    expect(put.statusCode, put.body).toBe(200);
    expect(await status()).toMatchObject({ web: true, libraryAssets: ["opening"] });
    const copied = await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/library-media` });
    expect(copied.json()).toMatchObject({ copiedAssets: ["opening"], changed: ["graph.json", "assets/library/opening.mp4"] });
    expect((await status()).libraryAssets).toBeUndefined();

    const undone = await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade/undo` });
    expect(undone.statusCode).toBe(200);
    expect(await status()).toEqual({ web: false });
    await expect(readFile(path.join(project.workspacePath, "index.html"))).rejects.toThrow();
    expect(await readFile(path.join(project.workspacePath, "nodes/chapter/node.js"), "utf8")).toContain('import script from "./script.txt";');

    // Keeping an upgrade forgets how to take it back.
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade/keep` })).statusCode).toBe(200);
    expect(await status()).toEqual({ web: true });
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/interactive-story/upgrade/undo` })).statusCode).toBe(409);
  });

  it("lists Presets and adds a Node from one", async () => {
    const app = await createPlayableApp("ohmygame-playable-presets-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();

    const presets = await app.inject({ method: "GET", url: "/playable/presets" });
    expect(presets.statusCode).toBe(200);
    expect(presets.json().presets.map((preset: { id: string }) => preset.id)).toEqual([
      "blank", "main-menu", "choice", "qte", "hotspot", "ending", "story-map", "visual-novel",
    ]);

    const created = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "main-menu", id: "menu", title: "Ash Club" },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: "menu", title: "Ash Club", signals: ["start", "story-map"] });
    const read = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` });
    const codebase = read.json();
    // The first Scene of a new project becomes its Start.
    expect(codebase.graph.nodes.map((node: { id: string }) => node.id)).toEqual(["menu"]);
    expect(codebase.graph.entryNodeId).toBe("menu");
    expect(await readFile(path.join(project.workspacePath, "nodes/menu/index.html"), "utf8")).toContain("Ash Club");
  });

  it("rejects a duplicate Node and an unknown Preset", async () => {
    const app = await createPlayableApp("ohmygame-playable-node-errors-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await addStartScene(app, project.id);

    const duplicate = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "blank", id: "start" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/playable/nodes`,
      payload: { preset: "epilogue", id: "later" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/projects/nope/playable/nodes",
      payload: { preset: "blank", id: "later" },
    });

    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain("already exists");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain("Unknown Preset");
    expect(missing.statusCode).toBe(404);
  });
  it("loads and atomically updates a Playable codebase", async () => {
    const app = await createPlayableApp("ohmygame-codebase-api-");
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await addStartScene(app, project.id);
    const loaded = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` });
    const codebase = loaded.json();
    codebase.graph.title = "Revised Story";
    codebase.editorLayout.nodes.start = { x: 360, y: 240 };
    codebase.sources = {
      "nodes/start/node.js": "export function mount(context) { context.root.innerHTML = 'Revised'; }\n",
    };

    const updated = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: codebase,
    });
    const afterUpdate = (await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    })).json();
    const invalid = structuredClone(afterUpdate);
    invalid.editorLayout.nodes = {};
    const rejected = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: invalid,
    });

    expect(loaded.statusCode).toBe(200);
    expect(updated.statusCode).toBe(200);
    const { sources: _sources, ...persistedCodebase } = { ...codebase, revision: updated.json().revision };
    expect(persistedCodebase.revision).not.toBe(loaded.json().revision);
    expect(afterUpdate).toEqual(persistedCodebase);
    expect(await readFile(path.join(project.workspacePath, "nodes/start/node.js"), "utf8"))
      .toBe(codebase.sources["nodes/start/node.js"]);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("Node IDs must exactly match");
    expect((await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    })).json()).toEqual(persistedCodebase);
  });

  it("refuses a Playable codebase update made from an older revision", async () => {
    const app = await createPlayableApp("ohmygame-codebase-revision-");
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();
    await addStartScene(app, project.id);
    const url = `/projects/${project.id}/playable/codebase`;
    const editor = (await app.inject({ method: "GET", url })).json();

    // The Agent renames the Scene in graph.json with its file tools while the editor is open.
    const graphFile = path.join(project.workspacePath, "graph.json");
    const agentGraph = JSON.parse(await readFile(graphFile, "utf8"));
    agentGraph.nodes[0].title = "Renamed by the Agent";
    await writeFile(graphFile, `${JSON.stringify(agentGraph, null, 2)}\n`);

    // The editor autosaves a moved Scene together with the graph it loaded.
    editor.editorLayout.nodes.start = { x: 480, y: 320 };
    const { revision: _revision, ...unversioned } = editor;
    const missing = await app.inject({ method: "PUT", url, payload: unversioned });
    const stale = await app.inject({ method: "PUT", url, payload: editor });
    const latest = (await app.inject({ method: "GET", url })).json();
    const carried = await app.inject({
      method: "PUT",
      url,
      payload: { ...latest, editorLayout: editor.editorLayout },
    });
    const saved = (await app.inject({ method: "GET", url })).json();

    expect(missing.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("The project changed");
    expect(latest.graph.nodes[0].title).toBe("Renamed by the Agent");
    expect(latest.editorLayout.nodes.start).not.toEqual({ x: 480, y: 320 });
    expect(carried.statusCode).toBe(200);
    expect(saved).toEqual({ ...latest, editorLayout: editor.editorLayout, revision: carried.json().revision });
  });

  it("rejects Playable codebase access for other project types", async () => {
    const app = await createPlayableApp("ohmygame-codebase-type-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game" } })).json();

    const response = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/playable/codebase`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Playable codebases require an Interactive Story project" });
  });

  it("exposes structured Playable validation for Playtest and agents", async () => {
    const app = await createPlayableApp("ohmygame-playable-validation-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    await addStartScene(app, project.id);

    const valid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/validation` });
    const graph = JSON.parse(await readFile(path.join(project.workspacePath, "graph.json"), "utf8"));
    graph.entryNodeId = "missing";
    await writeFile(path.join(project.workspacePath, "graph.json"), `${JSON.stringify(graph)}\n`);
    const invalid = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/validation?mode=publish` });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ ok: true, issues: [] });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ phase: "graph", code: "missing-node", path: "/entryNodeId" })]) });
  });

  it("opens an Interactive Story workspace again after its project was deleted", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-codebase-workspace-"));
    await writeFile(path.join(workspacePath, "notes.txt"), "keep me\n");
    const app = await createPlayableApp("ohmygame-codebase-reopen-");
    const first = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story", workspacePath },
    })).json();
    const graph = await readFile(path.join(workspacePath, "graph.json"), "utf8");
    expect((await app.inject({ method: "DELETE", url: `/projects/${first.id}` })).statusCode).toBe(204);

    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story", workspacePath },
    });

    expect(response.statusCode).toBe(201);
    const codebase = await app.inject({ method: "GET", url: `/projects/${response.json().id}/playable/codebase` });
    expect(codebase.statusCode).toBe(200);
    expect(await readFile(path.join(workspacePath, "graph.json"), "utf8")).toBe(graph);
    expect(await readFile(path.join(workspacePath, "notes.txt"), "utf8")).toBe("keep me\n");
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("exports an Interactive Story as an editable project archive", async () => {
    const app = await createPlayableApp("ohmygame-playable-export-project-");
    const webGame = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Web" } })).json();
    const story = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Story", type: "interactive-story" },
    })).json();

    const exported = await app.inject({ method: "POST", url: `/projects/${story.id}/export` });
    const webExport = await app.inject({ method: "POST", url: `/projects/${webGame.id}/export` });

    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/zip");
    expect(exported.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(webExport.statusCode).toBe(200);
  });

  it("protects Library assets declared by a Playable Nodes graph", async () => {
    const app = await createPlayableApp("ohmygame-playable-library-api-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "portrait.png"), "image bytes");
    await saveProjectAsset(app, source.id, "portrait.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=portrait.png` });
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Playable", type: "interactive-story" },
    })).json();
    await addStartScene(app, project.id);
    const read = await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` });
    const codebase = read.json();
    codebase.graph.assets.portrait = {
      type: "image",
      source: { kind: "library", assetId: asset.id },
    };
    codebase.graph.nodes[0].assets.push("portrait");
    expect((await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/playable/codebase`,
      payload: codebase,
    })).statusCode).toBe(200);

    const blocked = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Asset is used by 1 project" });

    const removed = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` });
    expect(removed.statusCode).toBe(204);
    const updated = (await app.inject({ method: "GET", url: `/projects/${project.id}/playable/codebase` })).json();
    expect(updated.graph.assets.portrait).toBeUndefined();
    expect(updated.graph.nodes[0].assets).not.toContain("portrait");
  });
});

describe("Asset Canvas projects", () => {
  async function createCanvasApp(prefix: string) {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), prefix)) });
    apps.push(app);
    return app;
  }
  async function getCanvas(app: Awaited<ReturnType<typeof createApp>>, projectId: string) {
    const workspace = (await app.inject(`/projects/${projectId}/canvas/workspace`)).json();
    return (await app.inject(`/projects/${projectId}/canvas/boards/${workspace.boards[0].id}`)).json();
  }
  async function saveCanvas(app: Awaited<ReturnType<typeof createApp>>, projectId: string, board: { id: string }) {
    const current = await getCanvas(app, projectId);
    return app.inject({ method: "PUT", url: `/projects/${projectId}/canvas/boards/${board.id}`, payload: { board, revision: current.revision } });
  }

  it("stores Asset Canvas boards in the shared canvas directory", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();

    const created = await getCanvas(app, project.id);
    expect(created.board).toMatchObject({ version: 1, nodes: [], edges: [] });

    const document = created.board;
    document.nodes = [{ id: "image", type: "image", position: { x: 96, y: 96 }, data: { prompt: "A lantern", resolution: "1K", aspectRatio: "1:1", images: [] } }];
    document.editorLayout.nodes = { image: { x: 96, y: 96 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    const files = await readdir(project.workspacePath);
    expect(files).toContain("canvas");
    expect(files).not.toContain("canvas.json");
    const workspace = (await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/workspace` })).json();
    expect(workspace.boards).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/boards/${workspace.boards[0].id}` })).json().board.nodes).toEqual(document.nodes);
    expect((await getCanvas(app, project.id)).board.nodes).toEqual([
      expect.objectContaining({ id: "image", type: "image", data: expect.objectContaining({ prompt: "A lantern" }) }),
    ]);
  });

  it("rejects canvas documents with unknown node types", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-invalid-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: {} }];
    document.editorLayout.nodes = { start: { x: 0, y: 0 } };

    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(400);
  });

  it("shares canvas endpoints with Interactive Story projects", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-story-");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();

    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/workspace` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/text/generate`, payload: { instruction: "Write" } })).statusCode).toBe(409);
  });

  it("protects and removes Library assets used by a canvas", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-library-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "portrait.png"), "image bytes");
    await saveProjectAsset(app, source.id, "portrait.png");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=portrait.png` });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [
      { id: "asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: "image" } },
      { id: "image", type: "image", position: { x: 320, y: 0 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [{ type: "node", nodeId: "asset" }, { type: "library", assetId: asset.id }] } },
    ];
    document.edges = [{ id: "asset-image", source: "asset", target: "image" }];
    document.editorLayout.nodes = { asset: { x: 0, y: 0 }, image: { x: 320, y: 0 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` })).statusCode).toBe(204);

    const updated = (await getCanvas(app, project.id)).board;
    expect(updated.nodes).toEqual([expect.objectContaining({ id: "image", data: expect.objectContaining({ images: [] }) })]);
    expect(updated.edges).toEqual([]);
    expect(Object.keys(updated.editorLayout.nodes)).toEqual(["image"]);
  });

  it("protects and removes Library models used by an Animate 3D node", async () => {
    const app = await createCanvasApp("ohmygame-asset-canvas-animate-library-");
    const source = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Source" } })).json();
    await writeFile(path.join(source.workspacePath, "hero.glb"), "glb bytes");
    await saveProjectAsset(app, source.id, "hero.glb");
    const [asset] = (await app.inject({ method: "GET", url: "/library/assets" })).json();
    await app.inject({ method: "DELETE", url: `/projects/${source.id}/assets?path=hero.glb` });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const document = (await getCanvas(app, project.id)).board;
    document.nodes = [{ id: "animate", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "library", assetId: asset.id }, heightMeters: 1.7, actionIds: [0] } }];
    document.editorLayout.nodes = { animate: { x: 0, y: 0 } };
    expect((await saveCanvas(app, project.id, document)).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}?force=true` })).statusCode).toBe(204);

    const updated = (await getCanvas(app, project.id)).board;
    expect(updated.nodes).toEqual([expect.objectContaining({ id: "animate", data: { heightMeters: 1.7, actionIds: [0] } })]);
  });
});
