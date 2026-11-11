import { createHash } from "node:crypto";
import fs from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { ChildProcess } from "node:child_process";
import type { IsolatedProjectExecution } from "../src/daemon/isolated-project-execution.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl, { type Entry } from "yauzl";
import {
  ArtifactBuilder,
  createPluginArchive,
} from "../src/daemon/publish/archive.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { projectFiles } from "../src/daemon/isolated-project-files.js";
import { createBuildGameTool } from "../src/daemon/isolated-shell-tool.js";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";

afterEach(() => vi.unstubAllEnvs());

describe("publish archives", () => {
  it("carries the offline Three.js browser modules and license through isolated source and the static game archive", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-three-archive-")));
    try {
      const projects = new ProjectManager(directory);
      await projects.load();
      const project = await projects.create("Offline 3D", "web-game");
      const runtime = await projects.prepareThreeRuntime(project.id);
      await writeFile(path.join(project.workspacePath, "index.html"), `<script type="module">import './${runtime.modulePath}'</script>`);
      const files = await projectFiles(project.workspacePath);
      const entry = files.find(file => file.path === runtime.modulePath);
      expect(entry).toBeDefined();
      const source = Buffer.from(entry!.data, "base64").toString("utf8");
      const core = source.match(/from\s*["']\.\/(three\.core(?:\.min)?\.js)["']/)?.[1];
      expect(core).toBeDefined();
      const required = ["index.html", runtime.modulePath, runtime.gltfLoaderPath, `${runtime.directory}/addons/BufferGeometryUtils.js`, `${runtime.directory}/${core}`, `${runtime.directory}/LICENSE`, `${runtime.directory}/provenance.json`];
      expect(files.map(file => file.path)).toEqual(expect.arrayContaining(required));
      const entries = await zipEntries(await new ArtifactBuilder().create(project));
      expect(entries.map(entry => entry.fileName)).toEqual(expect.arrayContaining(required));
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  });
  it("builds a vendored static project in the isolated VM without invoking a dependency installation", async () => {
    const workspacePath = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-static-build-")));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ dependencies: { three: "0.180.0" }, scripts: { build: "node build.mjs" } }));
    const start = vi.fn(async (_project, mode) => { expect(mode).toBe("build"); const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); setImmediate(() => child.emit("close", 0)); return child; });
    const execution = { start, artifacts: async () => { await mkdir(path.join(workspacePath, "dist")); await writeFile(path.join(workspacePath, "dist/index.html"), "vendored static build"); }, settled: async () => {}, owns: () => true, stop: async () => {} } as unknown as IsolatedProjectExecution;
    const project = { id: "static-fixture", type: "web-game", name: "Static", previewMode: "static", workspacePath, preview: { status: "stopped" } } as ProjectState;
    expect(await new ArtifactBuilder(undefined, undefined, execution).buildLocal(project)).toBe("dist"); expect(start).toHaveBeenCalledOnce();
  });
  it("returns the selected nested package relative to its workspace even under an aliased data directory", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-nested-build-")));
    const workspacePath = path.join(directory, "real/workspace");
    const nested = path.join(workspacePath, "games/demo");
    await mkdir(nested, { recursive: true });
    const alias = path.join(directory, "alias");
    await fs.promises.symlink(path.dirname(workspacePath), alias, "junction");
    await writeFile(path.join(nested, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
    await writeFile(path.join(nested, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    await mkdir(path.join(workspacePath, "dist"));
    await writeFile(path.join(workspacePath, "dist/index.html"), "unrelated root output");
    const start = vi.fn(async (_project: ProjectState, _mode: string, _cwd: string) => {
      const child = new ChildProcess();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => child.emit("close", 0));
      return child;
    });
    const artifacts = vi.fn(async (_project: ProjectState, directory: string) => {
      expect(directory).toBe(nested);
      await mkdir(path.join(directory, "dist"), { recursive: true });
      await writeFile(path.join(directory, "dist/index.html"), "nested game output");
    });
    const execution = { start, artifacts, settled: vi.fn(async () => {}), owns: () => true, stop: vi.fn(async () => {}) } as unknown as IsolatedProjectExecution;
    const project: ProjectState = { id: "nested-fixture", name: "Nested", type: "general", webPreviewEnabled: true, workspacePath: path.join(alias, "workspace"), startupDirectory: "games/demo", updatedAt: new Date(0).toISOString(), preview: { status: "stopped" } };
    const builder = new ArtifactBuilder(undefined, undefined, execution);
    try {
      const build = createBuildGameTool(signal => builder.buildLocal(project, signal));
      expect(projectPiToolNames("normal", [], [build.name])).toContain("build_game");
      expect(projectPiToolNames("normal", [], [])).not.toContain("build_game");
      expect(projectPiToolNames("planning", [], [build.name])).not.toContain("build_game");
      expect((await build.execute("test", {}, undefined, undefined, {} as never)).details).toEqual({ directory: "games/demo/dist" });
      expect(await readFile(path.join(nested, "dist/index.html"), "utf8")).toBe("nested game output");
      expect((await zipEntries(await builder.create(project))).map((entry) => entry.fileName)).toEqual(["index.html"]);
      expect(start.mock.calls.map(call => call.slice(0, 3))).toEqual([[project, "build", nested], [project, "build", nested]]);
      expect(artifacts).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(workspacePath, "dist/index.html"), "utf8")).toBe("unrelated root output");
      await expect(access(path.join(workspacePath, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await builder.close(); await fs.promises.rm(directory, { recursive: true, force: true }); }
  });

  it("blocks known credentials in uncompressed plugin/game entries and explicit cover bytes", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-protected-"));
    const canary = "CANARY_PLUGIN_STORY_ARCHIVE_KEY_ONLY"; registerSensitiveValue(canary);
    await writeFile(path.join(source, "index.html"), "safe game");
    await writeFile(path.join(source, "ordinary.dat"), Buffer.concat([Buffer.alloc(65_530, 0), Buffer.from(canary), Buffer.alloc(70_000, 0)]));
    await expect(createPluginArchive(source)).rejects.toMatchObject({ statusCode: 403, message: "Protected credential data cannot be served" });
    const builder = new ArtifactBuilder();
    const project = { id: "key-test", name: "Game", type: "web-game" as const, updatedAt: new Date(0).toISOString(), workspacePath: source, preview: { status: "stopped" as const } };
    try {
      await expect(builder.create(project)).rejects.toMatchObject({ statusCode: 403 });
      await fs.promises.rm(path.join(source, "ordinary.dat"));
      await expect(builder.create(project, Buffer.from(canary))).rejects.toMatchObject({ statusCode: 403 });
    } finally { await builder.close(); }
  });

  it("compresses an immutable checked snapshot even if the original file changes afterwards", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-snapshot-"));
    const file = path.join(source, "ordinary.txt"); await writeFile(file, "approved original bytes");
    const canary = "CANARY_ARCHIVE_CHANGED_AFTER_CHECK_ONLY"; registerSensitiveValue(canary);
    const from = Readable.from.bind(Readable);
    const snapshot = vi.spyOn(Readable, "from").mockImplementationOnce((input, options) => {
      fs.writeFileSync(file, canary);
      return from(input, options);
    });
    try {
      const archive = await createPluginArchive(source);
      expect(archive.includes(Buffer.from("approved original bytes"))).toBe(true);
      expect(archive.includes(Buffer.from(canary))).toBe(false);
      expect(await readFile(file, "utf8")).toBe(canary);
    } finally { snapshot.mockRestore(); }
  });

  it("refuses an entry over its inspection budget before allocating or compressing it", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-entry-budget-"));
    const file = path.join(source, "large.dat"); await writeFile(file, ""); await truncate(file, 129 * 1024 * 1024);
    try { await expect(createPluginArchive(source)).rejects.toMatchObject({ statusCode: 413, message: "Archive source exceeds the secure inspection budget" }); }
    finally { await fs.promises.rm(source, { recursive: true, force: true }); }
  });
  it("refuses host project builds without an isolated executor and leaves app environment intact", async () => {
    vi.stubEnv("ESBUILD_BINARY_PATH", "/app/esbuild");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-env-"));
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
    await writeFile(path.join(workspacePath, "build.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      if (process.env.ESBUILD_BINARY_PATH) throw new Error("app binary leaked into build");
      mkdirSync("dist", { recursive: true });
      writeFileSync("dist/index.html", "built game");
    `);
    await expect(new ArtifactBuilder().create({
      id: "environment-test", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(),
      workspacePath, preview: { status: "stopped" },
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(access(path.join(workspacePath, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.env.ESBUILD_BINARY_PATH).toBe("/app/esbuild");
  });

  it("creates identical ZIPs in different time zones", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-"));
    await writeFile(path.join(source, "example.txt"), "same content");
    const originalTimeZone = process.env.TZ;

    try {
      process.env.TZ = "UTC";
      const utc = await createPluginArchive(source);
      process.env.TZ = "Asia/Shanghai";
      const shanghai = await createPluginArchive(source);
      expect(shanghai).toEqual(utc);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("creates identical Plugin ZIPs from different file modes", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-mode-"));
    await writeFile(path.join(source, "example.txt"), "same content");

    expect(await archiveWithMode(source, 0o100666)).toEqual(
      await archiveWithMode(source, 0o100644),
    );
  });

  it("stores Plugin ZIP entries so the bytes do not depend on zlib", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-stored-"));
    await mkdir(path.join(source, "skills"));
    await writeFile(path.join(source, "example.txt"), "same content ".repeat(4096));
    await writeFile(path.join(source, "skills", "SKILL.md"), "# Skill\n".repeat(4096));

    const archive = await createPluginArchive(source);
    const entries = await zipEntries(archive);

    expect(entries.map((entry) => entry.fileName)).toEqual(["example.txt", "skills/SKILL.md"]);
    for (const entry of entries) {
      expect(entry.compressionMethod).toBe(0);
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
    }
    expect(createHash("sha256").update(archive).digest("hex"))
      .toBe("6ec94c765105d7eea3633546bc65955e30c9eaab10579ab12ba8a3b7d00952ff");
  });

  it("uses a Web Game's configured startup directory as its publish source", async () => {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-archive-web-game-"),
    );
    const startupDirectory = path.join(workspacePath, "apps", "game");
    await mkdir(startupDirectory, { recursive: true });
    await writeFile(path.join(startupDirectory, "index.html"), "nested game");

    await expect(
      new ArtifactBuilder().create({
        id: "project-1",
        name: "Nested game",
        type: "web-game",
        updatedAt: new Date(0).toISOString(),
        workspacePath,
        startupDirectory: "apps/game",
        preview: { status: "stopped" },
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects when a file in the publish output cannot be read", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-unreadable-"));
    await writeFile(path.join(workspacePath, "index.html"), "game");
    await writeFile(path.join(workspacePath, "save.dat"), "locked");
    await chmod(path.join(workspacePath, "save.dat"), 0o000);

    await expect(new ArtifactBuilder().create({
      id: "unreadable-test", name: "Game", type: "web-game", updatedAt: new Date(0).toISOString(),
      workspacePath, preview: { status: "stopped" },
    })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects when files are removed after they are listed", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-removed-"));
    await writeFile(path.join(source, "first.txt"), "first");
    await writeFile(path.join(source, "second.txt"), "second");
    const join = path.join.bind(path);
    const mocked = vi.spyOn(path, "join").mockImplementation((...args) => {
      const result = join(...args);
      if (args[0] === source && args[1] === "second.txt") fs.rmSync(result, { force: true });
      return result;
    });

    try {
      await expect(createPluginArchive(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      mocked.mockRestore();
    }
  });
});

async function archiveWithMode(source: string, mode: number): Promise<Buffer> {
  const stat = fs.stat.bind(fs);
  const mocked = vi.spyOn(fs, "stat").mockImplementation(((
    ...args: unknown[]
  ) => {
    const target = args[0] as fs.PathLike;
    const callback = args.at(-1) as (
      error: NodeJS.ErrnoException | null,
      stats?: fs.Stats,
    ) => void;
    stat(target, (error, stats) => {
      if (error) callback(error);
      else callback(null, Object.assign(stats, { mode }));
    });
  }) as typeof fs.stat);
  try {
    return await createPluginArchive(source);
  } finally {
    mocked.mockRestore();
  }
}

function zipEntries(archive: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP could not be opened."));
        return;
      }
      const entries: Entry[] = [];
      zip.once("error", reject);
      zip.once("end", () => resolve(entries));
      zip.on("entry", (entry: Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
