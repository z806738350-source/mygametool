import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/daemon/projects.js";
import { KUNPO_DEFAULT_MODEL_REFS } from "../src/shared/kunpo-models.js";
import { model3DFixture } from "./model3d-fixture.js";

describe("Web Game project codebase", () => {
  it("prepares the bundled Three.js files on demand inside the selected game directory without altering project dependencies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-three-"));
    try {
      const manager = new ProjectManager(directory), project = await manager.create("Game");
      const game = path.join(project.workspacePath, "client");
      await mkdir(game);
      const manifest = JSON.stringify({ type: "module", dependencies: { three: "0.128.0" } });
      await writeFile(path.join(game, "package.json"), manifest);
      await manager.setStartupDirectory(project.id, "client");
      const reopened = new ProjectManager(directory);
      await reopened.load();
      expect(await readdir(game)).toEqual(["package.json"]);
      const [runtime, same] = await Promise.all([manager.prepareThreeRuntime(project.id), reopened.prepareThreeRuntime(project.id)]);
      const pin = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).dependencies.three;
      expect(same).toEqual(runtime);
      expect(runtime).toEqual({ version: pin, directory: `client/vendor/ohmygame-three-${pin}`, modulePath: `client/vendor/ohmygame-three-${pin}/three.module.js`, gltfLoaderPath: `client/vendor/ohmygame-three-${pin}/addons/GLTFLoader.js` });
      const location = path.join(project.workspacePath, runtime.directory);
      const provenance = JSON.parse(await readFile(path.join(location, "provenance.json"), "utf8"));
      expect(provenance).toMatchObject({ name: "three", version: pin, license: "MIT", files: ["build/three.module.js", "build/three.core.js", "LICENSE"] });
      for (const source of provenance.files) {
        expect(await readFile(path.join(location, path.basename(source)))).toEqual(await readFile(new URL(`../node_modules/three/${source}`, import.meta.url)));
      }
      // Reproduce a core-only project created by the previous preparation tool.
      await rm(path.join(location, "addons"), { recursive: true });
      await Promise.all([manager.prepareThreeRuntime(project.id), reopened.prepareThreeRuntime(project.id)]);
      const modules = (relative: string) => import(/* @vite-ignore */ pathToFileURL(path.join(project.workspacePath, relative)).href);
      const { GLTFLoader } = await modules(runtime.gltfLoaderPath);
      const { AnimationMixer, Bone } = await modules(runtime.modulePath);
      const bytes = await model3DFixture({ textured: false, rigged: true, clips: ["idle", "run"] });
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const joint = gltf.scene.getObjectByName("Root");
      expect(joint).toBeInstanceOf(Bone);
      const mixer = new AnimationMixer(gltf.scene);
      for (const name of ["idle", "run"]) {
        const action = mixer.clipAction(gltf.animations.find((clip: { name: string }) => clip.name === name)).play();
        mixer.update(0.5);
        expect(action.isRunning()).toBe(true);
        expect(joint.position.x).toBeCloseTo(0.5);
        action.stop();
      }
      expect(await readFile(path.join(game, "package.json"), "utf8")).toBe(manifest);
      await writeFile(path.join(location, "three.module.js"), "keep my version");
      await expect(reopened.prepareThreeRuntime(project.id)).rejects.toThrow("Existing Three.js file differs");
      expect(await readFile(path.join(location, "three.module.js"), "utf8")).toBe("keep my version");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects foreign project types and a linked Three.js destination without writing outside the game", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-three-links-"));
    try {
      const manager = new ProjectManager(directory);
      const story = await manager.create("Story", "interactive-story");
      await expect(manager.prepareThreeRuntime(story.id)).rejects.toThrow("Web Game");
      const game = await manager.create("Game"), outside = path.join(directory, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(game.workspacePath, "vendor"));
      await expect(manager.prepareThreeRuntime(game.id)).rejects.toThrow("Symbolic links");
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects private application and agent roots, their parents and their children as external workspaces", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-private-workspace-"));
    try {
      const data = path.join(directory, "data"), agent = path.join(directory, "agent"), external = path.join(directory, "game");
      for (const folder of [data, agent, external, path.join(data, "keys"), path.join(agent, "sessions")]) await mkdir(folder, { recursive: true });
      await writeFile(path.join(agent, "auth.json"), "fake-key-canary-local-only");
      const manager = new ProjectManager(data, undefined, [agent]);
      for (const folder of [directory, data, agent, path.join(data, "keys"), path.join(agent, "sessions")]) {
        await expect(manager.create("Unsafe", "general", folder)).rejects.toThrow("Private application or agent storage");
      }
      const project = await manager.create("External", "general", external);
      const record = path.join(data, "projects", project.id, "project.json");
      const original = JSON.parse(await readFile(record, "utf8"));
      await writeFile(record, JSON.stringify({ ...original, workspacePath: agent }));
      const restored = new ProjectManager(data, undefined, [agent]);
      const failures: unknown[] = [];
      await restored.load((_folder, cause) => failures.push(cause));
      expect(restored.get(project.id)).toBeUndefined();
      expect(failures).toHaveLength(1);
      expect(await readFile(path.join(agent, "auth.json"), "utf8")).toBe("fake-key-canary-local-only");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("duplicates project assets and Canvas while excluding credential names and agent runtime data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-private-duplicate-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Game", "general");
      const contents = { ".gitignore": "dist", ".data/assets.json": "{}", ".data/asset-previews/hero.png": "preview", "canvas/board.json": "{}", "src/game.js": "game", "auth.json": "fake-key-canary-local-only", "config/api-key.json": "fake-key-canary-local-only", ".data/local-api-keys.json": "fake-key-canary-local-only", "pi-agent/models.json": "fake-key-canary-local-only", "agent-runtimes/session.txt": "fake-key-canary-local-only", "config/private.key.bak": "fake-key-canary-local-only" };
      for (const [file, text] of Object.entries(contents)) {
        await mkdir(path.dirname(path.join(project.workspacePath, file)), { recursive: true });
        await writeFile(path.join(project.workspacePath, file), text);
      }
      const copy = await manager.duplicate(project.id);
      for (const file of [".gitignore", ".data/assets.json", ".data/asset-previews/hero.png", "canvas/board.json", "src/game.js"]) {
        expect(await readFile(path.join(copy.workspacePath, file), "utf8")).toBe(contents[file as keyof typeof contents]);
      }
      for (const [file, text] of Object.entries(contents).filter(([, text]) => text.includes("fake-key-canary"))) {
        await expect(readFile(path.join(copy.workspacePath, file))).rejects.toThrow();
        expect(text).toBe("fake-key-canary-local-only");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects linked duplicate files before copying a canary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-linked-duplicate-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Game", "general");
      await writeFile(path.join(project.workspacePath, ".env"), "fake-key-canary-local-only");
      await link(path.join(project.workspacePath, ".env"), path.join(project.workspacePath, "public.txt"));
      await expect(manager.duplicate(project.id)).rejects.toThrow("Linked files");
      await rm(path.join(project.workspacePath, "public.txt"));
      if (process.platform !== "win32") {
        await symlink(path.join(project.workspacePath, ".env"), path.join(project.workspacePath, "public.txt"));
        await expect(manager.duplicate(project.id)).rejects.toThrow("Linked files");
      }
      expect(await readFile(path.join(project.workspacePath, ".env"), "utf8")).toBe("fake-key-canary-local-only");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("persists name ownership and leaves legacy projects unchanged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-names-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create(undefined, "general");
      const manual = await manager.create("My title", "general");
      expect(project.nameSource).toBe("default");
      expect(manual.nameSource).toBe("manual");
      expect(await manager.nameAutomatically(manual.id, "AI title")).toBeUndefined();
      const updatedAt = project.updatedAt;
      expect(await manager.nameAutomatically(project.id, "Moon Garden")).toMatchObject({ nameSource: "ai", updatedAt });
      await manager.touch(project.id);
      expect(await manager.nameAutomatically(project.id, "Another title")).toBeUndefined();
      expect((await manager.duplicate(project.id)).nameSource).toBe("manual");
      const metadataPath = path.join(directory, "projects", manual.id, "project.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      delete metadata.nameSource;
      await writeFile(metadataPath, JSON.stringify(metadata));
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.get(project.id)).toMatchObject({ name: "Moon Garden", nameSource: "ai" });
      expect(restored.get(manual.id)?.nameSource).toBeUndefined();
      expect(await restored.nameAutomatically(manual.id, "Changed legacy title")).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("checks name ownership inside queued writes and never recreates a deleted project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-name-races-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create(undefined, "general");
      await Promise.all([manager.rename(project.id, "My title"), manager.nameAutomatically(project.id, "Late AI title"), manager.touch(project.id)]);
      expect(project).toMatchObject({ name: "My title", nameSource: "manual" });
      const removed = await manager.create(undefined, "general");
      await Promise.all([manager.delete(removed.id), manager.nameAutomatically(removed.id, "Late AI title")]);
      expect(await readdir(path.join(directory, "projects"))).not.toContain(removed.id);
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.get(project.id)).toMatchObject({ name: "My title", nameSource: "manual" });
      expect(restored.get(removed.id)).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === "win32")("does not delete through an external workspace's replaced attachment directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-external-deletion-"));
    try {
      const workspace = path.join(directory, "game");
      const outside = path.join(directory, "other");
      await mkdir(workspace);
      await mkdir(path.join(outside, "agent-attachments"), { recursive: true });
      const retained = path.join(outside, "agent-attachments", "unrelated.txt");
      await writeFile(retained, "keep this");
      const manager = new ProjectManager(path.join(directory, "data"));
      const project = await manager.create("External", "general", workspace);
      await symlink(outside, path.join(workspace, ".data"));
      await manager.delete(project.id);
      expect(await readFile(retained, "utf8")).toBe("keep this");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps an engine-independent General Game workspace through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-general-projects-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native game", "general");
    expect(await readdir(project.workspacePath)).toEqual([]);
    await writeFile(path.join(project.workspacePath, "project.godot"), "config_version=5\n");

    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ type: "general", preview: { status: "waiting" } });
    const copy = await restored.duplicate(project.id);
    expect(copy.type).toBe("general");
    expect(await readdir(copy.workspacePath)).toEqual(["project.godot"]);
  });
  it("binds copied Canvas generation history to the duplicate", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-duplicate-history-")));
    const project = await manager.create("Sky garden", "asset-canvas");
    const canvas = path.join(project.workspacePath, "canvas");
    await mkdir(canvas);
    const history = ["succeeded", "failed"].map((status, index) => ({
      id: `historical-${index}`,
      toolId: "generate-image",
      createdAt: "2026-10-07T12:00:00.000Z",
      status,
      title: "Original concept",
      context: { projectId: project.id, boardId: "design", nodeId: "concept" },
      // Retry inputs can hold inline images larger than a board file may be.
      input: { prompt: "Original prompt", images: status === "failed" ? [`data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`] : [] },
    }));
    await writeFile(path.join(canvas, "jobs.json"), JSON.stringify(history));
    const copy = await manager.duplicate(project.id);
    expect(JSON.parse(await readFile(path.join(copy.workspacePath, "canvas/jobs.json"), "utf8"))).toEqual(history.map((job) => ({ ...job, context: { ...job.context, projectId: copy.id } })));
    expect(JSON.parse(await readFile(path.join(canvas, "jobs.json"), "utf8"))).toEqual(history);
  });
  it.each([
    ["invalid JSON", "not JSON"],
    ["no job list", "{}\n"],
    ["entries without a project", '[\n  null,\n  "job"\n]\n'],
  ])("duplicates a project whose Canvas generation history has %s", async (_case, history) => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-duplicate-history-")));
    const project = await manager.create("Sky garden", "asset-canvas");
    await mkdir(path.join(project.workspacePath, "canvas"));
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), history);
    const copy = await manager.duplicate(project.id);
    expect(await readFile(path.join(copy.workspacePath, "canvas/jobs.json"), "utf8")).toBe(history);
  });
  it.each(["electron .", "electron-forge start", "electron-vite dev", "tauri dev", "godot --editor", "NODE_ENV=dev electron .", "npx electron .", "npx --yes electron .", "cross-env NODE_ENV=dev electron .", "env NODE_OPTIONS='--trace-warnings --no-warnings' electron .", "./node_modules/.bin/electron .", "vite && electron .", "vite build", "bun format"])("does not treat a non-server dev script as a Web preview server: %s", async (dev) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-native-project-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Native", "general");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "waiting" } });
    // Projects created before the switch existed must also remain opt-in.
    const metadataPath = path.join(directory, "projects", project.id, "project.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata.webPreviewEnabled;
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it.each(["vite --host 127.0.0.1", "vite --config godot/vite.config.ts", "vite --open /tauri/index.html", "vite --config build/vite.config.ts", "vite --define 'godot | tauri'", "NODE_ENV=dev pnpm exec vite"])("keeps Web servers runnable when arguments contain task or engine names: %s", async (dev) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-server-project-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Browser", "general");
      await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev } }));
      expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ preview: { status: "stopped" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enables preview for new General projects and preserves an explicit opt-out through reload and duplication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-preview-opt-in-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Browser output", "general");
    const settings = { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit" as const, webPreviewEnabled: true };
    expect(project).toMatchObject({ webPreviewEnabled: true, preview: { status: "waiting" } });
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    expect(await manager.refreshPreviewReadiness(project.id)).toMatchObject({ preview: { status: "stopped" } });
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    expect(await restored.duplicate(project.id)).toMatchObject({ webPreviewEnabled: true, preview: { status: "stopped" } });
    await manager.setRunSettings(project.id, { ...settings, webPreviewEnabled: false });
    expect(await manager.duplicate(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
    const disabled = new ProjectManager(directory);
    await disabled.load();
    expect(disabled.get(project.id)).toMatchObject({ webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it("allows disabling preview when its configured directory has been removed", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-preview-disable-")));
    const project = await manager.create("Browser", "general");
    const client = path.join(project.workspacePath, "client");
    await mkdir(client);
    await writeFile(path.join(client, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const settings = { startupDirectory: "client", startupScript: "dev", previewPath: "/", previewViewport: "fit" as const, webPreviewEnabled: true };
    await manager.setRunSettings(project.id, settings);
    await rm(client, { recursive: true });
    expect(await manager.setRunSettings(project.id, { ...settings, webPreviewEnabled: false })).toMatchObject({ startupDirectory: "client", webPreviewEnabled: false, preview: { status: "waiting" } });
  });

  it("starts with an empty workspace; the platform contract lives in the system prompt", async () => {
    const manager = new ProjectManager(await mkdtemp(path.join(tmpdir(), "ohmygame-projects-")));
    const project = await manager.create("Game", "web-game");

    expect(await readdir(project.workspacePath)).toEqual([]);
  });

  it("keeps project media defaults through unrelated saves and removes cleared overrides on disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-projects-"));
    const manager = new ProjectManager(directory);
    const project = await manager.create("Canvas", "asset-canvas");
    await manager.setMediaModelDefaults(project.id, { image: { provider: "studio", id: "image" }, "3d": { provider: "meshy", id: "meshy-t2" } });
    await Promise.all([manager.rename(project.id, "New name"), manager.setMediaModelDefaults(project.id, { image: { provider: "studio", id: "latest" } })]);
    expect(project.name).toBe("New name");
    expect(project.mediaModelDefaults).toEqual({ image: { provider: "studio", id: "latest" } });
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)?.mediaModelDefaults).toEqual(project.mediaModelDefaults);
    await restored.setMediaModelDefaults(project.id, {});
    const cleared = new ProjectManager(directory);
    await cleared.load();
    expect(cleared.get(project.id)?.mediaModelDefaults).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8"))).not.toHaveProperty("mediaModelDefaults");
  });

  it("snapshots new-project model choices and preserves explicit choices, retired choices and legacy metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-models-"));
    try {
      const manager = new ProjectManager(directory);
      const project = await manager.create("Canvas", "asset-canvas");
      expect(project.modelSelections).toEqual(KUNPO_DEFAULT_MODEL_REFS);
      expect(project.modelSelections).not.toHaveProperty("music");
      const selected = { agent: { provider: "kunpo", id: "claude-fable-5-2" }, image: { provider: "openai", id: "gpt-image-2.5-flare" } };
      await Promise.all([manager.rename(project.id, "Chosen"), manager.setModelSelections(project.id, selected)]);
      const expected = { ...KUNPO_DEFAULT_MODEL_REFS, ...selected };
      expect(project.modelSelections).toEqual(expected);
      await Promise.all([manager.setModelSelections(project.id, { speech: { provider: "volcengine-tts", id: "seed-audio-1.0-multilingual" } }), manager.setModelSelections(project.id, { "sound-effect": { provider: "volcengine-seed-audio", id: "seed-audio-1.0-multilingual" } })]);
      expect(project.modelSelections).toMatchObject({ speech: { id: "seed-audio-1.0-multilingual" }, "sound-effect": { id: "seed-audio-1.0-multilingual" } });
      const duplicate = await manager.duplicate(project.id);
      expect(duplicate.modelSelections).toEqual(project.modelSelections);
      const record = path.join(directory, "projects", project.id, "project.json");
      const saved = JSON.parse(await readFile(record, "utf8"));
      delete saved.modelSelections;
      saved.mediaModelDefaults = { image: { provider: "legacy-studio", id: "explicit-legacy" } };
      await writeFile(record, JSON.stringify(saved));
      const duplicateRecord = path.join(directory, "projects", duplicate.id, "project.json");
      const legacy = JSON.parse(await readFile(duplicateRecord, "utf8"));
      const retired = { provider: "kunpo", id: "gemini-3.8-flash" };
      legacy.modelSelections.agent = retired;
      await writeFile(duplicateRecord, JSON.stringify(legacy));
      const restored = new ProjectManager(directory);
      await restored.load();
      expect(restored.get(duplicate.id)?.modelSelections).toEqual({ ...project.modelSelections, agent: retired });
      await expect(restored.setModelSelections(duplicate.id, { agent: retired })).rejects.toThrow("Invalid project model selection");
      expect(restored.get(project.id)?.modelSelections).toBeUndefined();
      expect(restored.get(project.id)?.mediaModelDefaults).toEqual(saved.mediaModelDefaults);
      await restored.rename(project.id, "Legacy name");
      expect(JSON.parse(await readFile(record, "utf8"))).not.toHaveProperty("modelSelections");
      await expect(restored.setModelSelections(project.id, { image: { provider: "kunpo", id: "gpt-5.6-sol" } })).rejects.toThrow("Invalid project model selection");
      await expect(restored.setModelSelections(project.id, { image: { provider: "openai", id: "gpt-image-2.5-sunburst", apiKey: "fake-key-not-stored" } } as never)).rejects.toThrow("Invalid project model selection");
      await restored.setModelSelections(duplicate.id, Object.fromEntries(Object.keys(project.modelSelections ?? {}).map((role) => [role, null])));
      expect(restored.get(duplicate.id)?.modelSelections).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["web-game", "general"] as const)("persists a runnable startup directory for %s below the workspace root", async (type) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-projects-"));
    const manager = new ProjectManager(dataDirectory);
    const project = await manager.create("Game", type);
    const gameDirectory = path.join(project.workspacePath, "apps", "game");
    await mkdir(gameDirectory, { recursive: true });
    await writeFile(path.join(gameDirectory, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "vite" } }));

    const updated = await manager.setRunSettings(project.id, {
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
      ...(type === "general" ? { webPreviewEnabled: true } : {}),
    });
    expect(updated).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });
    expect(updated.preview).toEqual({ status: type === "general" ? "stopped" : "waiting" });
    expect(JSON.parse(await readFile(path.join(dataDirectory, "projects", project.id, "project.json"), "utf8"))).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
    });

    const restored = new ProjectManager(dataDirectory);
    await restored.load();
    expect(restored.get(project.id)).toMatchObject({
      startupDirectory: "apps/game",
      startupScript: "start",
      packageManager: "pnpm",
      previewPath: "/play",
      previewViewport: "mobile",
      preview: { status: "stopped" },
    });
    await expect(manager.setStartupDirectory(project.id, "../outside")).rejects.toThrow("Startup directory must be a relative path");
    await expect(manager.setStartupDirectory(project.id, "missing")).rejects.toThrow("Startup directory does not exist");
  });
});
