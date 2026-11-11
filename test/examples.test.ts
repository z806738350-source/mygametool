import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExampleStore } from "../src/daemon/examples.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { createApp } from "../src/daemon/app.js";
import { createNodeCodebase } from "../src/daemon/playable-codebase.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import type { PreparedExampleCatalog } from "../src/shared/examples.js";
import { isPreparedExampleCatalog } from "../src/shared/examples.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

async function writeExamples(): Promise<string> {
  const directory = await temporary("ohmygame-examples-");
  const files = path.join(directory, "pond", "files");
  await mkdir(path.join(files, "src"), { recursive: true });
  await writeFile(path.join(files, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
  await writeFile(path.join(files, "src", "main.ts"), "console.log('pond');\n");
  await writeFile(path.join(directory, "pond", "cover.webp"), "RIFF-cover");
  await mkdir(path.join(directory, "pond", "play", "assets"), { recursive: true });
  await writeFile(path.join(directory, "pond", "play", "index.html"), "<title>Pond</title>");
  await writeFile(path.join(directory, "pond", "play", "assets", "game.js"), "play();");
  const catalog: PreparedExampleCatalog = {
    version: 1,
    source: { repository: "WhiteTowerAI/ohmygame-examples", commit: "0".repeat(40) },
    examples: [{
      id: "pond",
      type: "web-game",
      name: "Pond",
      description: "A small pond.",
      directory: "pond/files",
      cover: "pond/cover.webp",
      play: "pond/play",
    }],
  };
  // An interactive story example holds only the project files; the app adds
  // AGENTS.md, README.md and schemas when it copies the example.
  const story = path.join(directory, "train", "files");
  await mkdir(story, { recursive: true });
  await createNodeCodebase(story, createStarterCodebaseWithScene("Night Train", { width: 1280, height: 720 }));
  for (const owned of ["AGENTS.md", "README.md", "schemas"]) await rm(path.join(story, owned), { recursive: true });
  await writeFile(path.join(directory, "train", "cover.webp"), "RIFF-train");
  catalog.examples.push({
    id: "train",
    type: "interactive-story",
    name: "Night Train",
    description: "A short story.",
    directory: "train/files",
    cover: "train/cover.webp",
  });
  await writeFile(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  return directory;
}

async function writePlayer(): Promise<string> {
  const directory = await temporary("ohmygame-examples-player-");
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), "<h1>Published player</h1>");
  await writeFile(path.join(directory, "player.js"), "window.player = true");
  await writeFile(path.join(directory, "playable-sandbox.html"), "Playable sandbox");
  await writeFile(path.join(directory, "assets", "playable-sandbox.js"), "window.sandbox = true");
  return directory;
}

async function startApp(examplesDirectory?: string, interactiveStoryPlayerDirectory?: string) {
  const app = createApp({
    dataDirectory: await temporary("ohmygame-examples-data-"),
    examplesDirectory,
    ...(interactiveStoryPlayerDirectory ? { interactiveStoryPlayerDirectory } : {}),
  });
  apps.push(app);
  await app.ready();
  return app;
}

async function localCatalog(directory: string) {
  const dataDirectory = await temporary("ohmygame-local-example-data-");
  const projects = new ProjectManager(dataDirectory);
  await projects.load();
  const store = new ExampleStore(directory);
  await store.load();
  return { store, projects, dataDirectory };
}
async function localRemix(directory: string, id: string, type: "web-game" | "interactive-story") {
  const { store, projects, dataDirectory } = await localCatalog(directory);
  const project = await store.createProject(projects, id, { type });
  await store.close();
  const app = createApp({ dataDirectory });
  apps.push(app);
  await app.ready();
  return { app, project };
}

describe("examples: retained local data and retired startup routes", () => {
  it("preserves remixed node positions and the original viewport until explicitly edited", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    for (const folder of ["boards", "editor"]) await mkdir(path.join(canvas, folder), { recursive: true });
    await writeFile(path.join(canvas, "index.json"), JSON.stringify({ version: 1, boards: [{ id: "design", name: "Design" }, { id: "art", name: "Art" }], documents: [] }));
    const layout = { version: 1, view: "canvas", nodes: { note: { x: 96, y: 576 } }, viewport: { x: -4805, y: 44, zoom: 1.14 } };
    for (const id of ["design", "art"]) {
      const { editorLayout: _editorLayout, ...board } = createCanvasBoard();
      await writeFile(path.join(canvas, `boards/${id}.json`), JSON.stringify({ ...board, id, nodes: [{ id: "note", type: "text", data: { text: "Example", instruction: "" } }] }));
      await writeFile(path.join(canvas, `editor/${id}.json`), JSON.stringify(layout));
    }
    const { app, project } = await localRemix(directory, "pond", "web-game");
    for (const id of ["design", "art"]) {
      const url = `/projects/${project.id}/canvas/boards/${id}`;
      const detail = (await app.inject({ method: "GET", url })).json();
      expect(detail.board.nodes[0].position).toEqual({ x: 96, y: 576 });
      expect(detail.board.editorLayout).toEqual(layout);
      expect(JSON.parse(await readFile(path.join(canvas, `editor/${id}.json`), "utf8"))).toEqual(layout);
      detail.board.editorLayout.viewport = { x: 64, y: 32, zoom: 0.3 };
      const saved = await app.inject({ method: "PUT", url, payload: detail });
      expect(saved.statusCode).toBe(200);
      const reopened = (await app.inject({ method: "GET", url })).json();
      expect(reopened.board.editorLayout.fitView).toBeUndefined();
      expect(reopened.board.editorLayout.viewport).toEqual({ x: 64, y: 32, zoom: 0.3 });
      expect(reopened.board.nodes[0].position).toEqual({ x: 96, y: 576 });
    }
  });

  it("preserves generation history and binds it to the remixed project", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    await mkdir(canvas, { recursive: true });
    await writeFile(path.join(canvas, "index.json"), JSON.stringify({ version: 1, boards: [{ id: "design", name: "Design" }], documents: [] }));
    const history = ["succeeded", "failed"].map((status, index) => ({
      id: `historical-${index}`,
      toolId: "generate-image",
      createdAt: "2026-10-07T12:00:00.000Z",
      status,
      title: "Original concept",
      context: { projectId: "original-project", boardId: "design", nodeId: "concept" },
      input: {
        prompt: "Original prompt", resolution: "2K", aspectRatio: "16:9",
        images: status === "failed" ? [`data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`] : [],
      },
      ...(status === "succeeded" ? { run: { id: "original-run", assetIds: ["original-asset"] } } : { error: "Original error" }),
    }));
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify(history));
    const { app, project } = await localRemix(directory, "pond", "web-game");
    expect(project.type).toBe("web-game");
    const expected = history.map((job) => ({ ...job, context: { ...job.context, projectId: project.id } }));
    expect(JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"))).toEqual(expected);
    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/canvas/jobs` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected.map(({ input: _input, ...job }) => ({ ...job, canRecoverImage: false })));
    expect(JSON.parse(await readFile(path.join(canvas, "jobs.json"), "utf8"))).toEqual(history);
  });

  it("rejects invalid generation history without leaving a partially copied project", async () => {
    const directory = await writeExamples();
    const canvas = path.join(directory, "pond/files/canvas");
    await mkdir(canvas, { recursive: true });
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify({ jobs: [] }));
    const { store, projects } = await localCatalog(directory);
    await expect(store.createProject(projects, "pond", { type: "web-game" })).rejects.toThrow("invalid Canvas generation history");
    expect(projects.list()).toEqual([]);
  });

  it("retains explicit local catalog reading and cover data without enabling startup seeding", async () => {
    const directory = await writeExamples();
    const { store } = await localCatalog(directory);
    expect(store.list()).toEqual([
      { id: "pond", type: "web-game", name: "Pond", description: "A small pond." },
      { id: "train", type: "interactive-story", name: "Night Train", description: "A short story." },
    ]);
    expect((await store.cover("pond"))?.toString()).toBe("RIFF-cover");
    expect(await store.cover("missing")).toBeUndefined();
    await store.close();
  });

  it.each(["pond", "train"])("does not expose prepared %s downloads, covers or play servers through the application", async (id) => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("Examples must not contact author services"); });
    vi.stubGlobal("fetch", request);
    const app = await startApp(await writeExamples(), await writePlayer());
    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/examples/${id}/cover` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/examples/${id}/play` })).statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { type: "web-game", exampleId: "pond" },
    { type: "interactive-story", exampleId: "train" },
    { type: "web-game", exampleId: "pond", name: "My pond" },
    { type: "godot-game", exampleId: "pond" },
  ])("refuses retired example creation without copying source files: %j", async (payload) => {
    const workspacePath = await temporary("ohmygame-no-example-copy-");
    const app = await startApp(await writeExamples());
    const response = await app.inject({ method: "POST", url: "/projects", payload: { ...payload, workspacePath } });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error).toContain("Example not found");
    expect((await app.inject({ method: "GET", url: "/projects" })).json()).toEqual([]);
    expect(await readdir(workspacePath)).toEqual([]);
  });

  it("keeps blank local projects available without prepared examples", async () => {
    const app = await startApp();
    expect((await app.inject({ method: "GET", url: "/examples" })).json()).toEqual([]);
    const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Local project" } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().name).toBe("Local project");
  });

  it("validates prepared catalogs", () => {
    const valid = {
      version: 1,
      source: { repository: "a/b", commit: "c" },
      examples: [{ id: "pond", type: "web-game", name: "Pond", description: "", directory: "pond/files", cover: "pond/cover.webp", play: "pond/play" }],
    };
    expect(isPreparedExampleCatalog(valid)).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], directory: "../outside" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "asset-canvas" }] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [valid.examples[0], valid.examples[0]] })).toBe(false);
    const { play: _play, ...withoutPlay } = valid.examples[0];
    expect(isPreparedExampleCatalog({ ...valid, examples: [withoutPlay] })).toBe(false);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...withoutPlay, type: "interactive-story" }] })).toBe(true);
    expect(isPreparedExampleCatalog({ ...valid, examples: [{ ...valid.examples[0], type: "interactive-story" }] })).toBe(false);
  });
});

async function temporary(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
