import { assertLocalExecutionAllowed } from "../local-execution-policy.js";
import type { IsolatedProjectExecution } from "../isolated-project-execution.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { ProjectState } from "../../shared/contracts.js";
import { isWebRuntimeProjectType } from "../../shared/project-runtime.js";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES } from "../../shared/plugins.js";
import { PUBLISH_ARTIFACT_MAX_BYTES, PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";
import type { AssetLibrary } from "../asset-library.js";
import { packageManagerCommand, packageManagerRunArguments, resolvePackageManager } from "../package-manager.js";
import { ensureProjectDependencies } from "../project-dependencies.js";
import { projectProcessEnvironment } from "../project-process.js";
import { resolveStartupDirectory } from "../projects.js";
import { buildPlayableProject, nodeGraphSignature } from "../playable-project.js";
import { isCompiledNodeGraph } from "../../shared/playable-compiled.js";
import type { NodePlayerDefinition } from "../../shared/playable-player-protocol.js";
import { isPublishedNodeManifest, PLAYTEST_SCOPE_PREFIX, type PublishedNodeAsset, type PublishedNodeManifest } from "../../shared/playable-publish.js";
import { isNodeGraph } from "../../shared/playable-graph-validation.js";
import { getWorkspaceMedia } from "../workspace.js";
import { isWebStory, publishableWebStoryFiles } from "../story-web-project.js";
import { compressArchiveFile } from "../archive-compression.js";
import { PublishMediaOptimizer } from "./media.js";
import { assertNoKnownSecretBytes } from "../safe-project-file.js";

const MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

interface PackageJson {
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

export class PublishError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class ArtifactBuilder {
  readonly #running = new Map<string, ChildProcess>();

  constructor(private readonly library?: AssetLibrary, private readonly playerDirectory?: string, private readonly execution?: IsolatedProjectExecution) {}

  /** Local output only; this route never contacts a publishing service. */
  async buildLocal(project: ProjectState, signal?: AbortSignal): Promise<string> {
    if (!this.execution) assertLocalExecutionAllowed("Project builds");
    if (!isWebRuntimeProjectType(project.type)) throw new PublishError("This isolated build supports web npm projects only");
    signal?.throwIfAborted();
    try {
      const startup = await publishStartupDirectory(project);
      const source = await prepareSource(startup.absolutePath, (child) => this.#running.set(project.id, child), project, this.execution, signal);
      return path.join(startup.relativePath, path.relative(startup.absolutePath, source)).split(path.sep).join("/");
    } finally { this.#running.delete(project.id); }
  }

  async create(project: ProjectState, cover?: Buffer): Promise<Buffer> {
    return this.#create(project, cover, PUBLISH_ARTIFACT_MAX_BYTES);
  }

  async buildInteractiveStory(project: ProjectState): Promise<Buffer> {
    if (project.type !== "interactive-story") throw new PublishError("Build requires an Interactive Story project");
    return this.#create(project);
  }

  async #create(project: ProjectState, cover?: Buffer, maxBytes?: number): Promise<Buffer> {
    let temporary: string | undefined;
    const media = maxBytes !== undefined && project.type === "interactive-story"
      ? new PublishMediaOptimizer((child) => this.#running.set(project.id, child))
      : undefined;
    let optimizeZip = media;
    try {
      let source: string;
      if (project.type === "interactive-story" && await isWebStory(project.workspacePath)) {
        temporary = await prepareWebStory(project);
        source = temporary;
      } else if (project.type === "interactive-story") {
        temporary = await prepareInteractiveStory(project, this.library, this.playerDirectory, media);
        source = temporary;
        // Legacy manifests hash the optimized bytes during preparation.
        optimizeZip = undefined;
      } else {
        const workspacePath = isWebRuntimeProjectType(project.type) || project.type === "general"
          ? (await publishStartupDirectory(project)).absolutePath
          : project.workspacePath;
        source = await prepareSource(workspacePath, (child) => this.#running.set(project.id, child), project, this.execution);
      }
      return await createZip(source, false, cover, maxBytes, false, optimizeZip);
    } finally {
      this.#running.delete(project.id);
      if (temporary) await rm(temporary, { recursive: true, force: true });
      await media?.close();
    }
  }

  /**
   * A Published Player directory that runs the project's current draft, for
   * agent playtests. The draft need not pass publish validation, and its save
   * is kept apart from the published game's. The caller removes the directory.
   */
  async preparePlayableDraft(project: ProjectState): Promise<string> {
    if (project.type !== "interactive-story") throw new PublishError("Playable drafts require an Interactive Story project");
    if (!this.library || !this.playerDirectory) throw new PublishError("Published Player is not built. Run bun run build:player first.");
    await assertNodePlayerBuilt(this.playerDirectory);
    let definition: NodePlayerDefinition | undefined;
    try {
      definition = await buildPlayableProject(project.workspacePath, "draft");
    } catch (cause) {
      throw new PublishError(`The project does not build: ${cause instanceof Error ? cause.message : String(cause)}. Run playable_check for every issue.`);
    }
    if (!definition) throw new PublishError("This project has no graph.json.");
    return preparePlayableProject(project, definition, this.library, this.playerDirectory, `${PLAYTEST_SCOPE_PREFIX}${project.id}`);
  }

  /**
   * Builds a Published Player for an example workspace that is not a project.
   * Draft rules, like agent playtests: packaging already checked the example
   * against the publish rules.
   */
  async preparePlayableExample(workspacePath: string, exampleId: string): Promise<string> {
    if (!this.library || !this.playerDirectory) throw new PublishError("Published Player is not built. Run bun run build:player first.");
    await assertNodePlayerBuilt(this.playerDirectory);
    const definition = await buildPlayableProject(workspacePath, "draft");
    if (!definition) throw new PublishError("This example has no graph.json.");
    return preparePlayableProject({ id: exampleId, workspacePath }, definition, this.library, this.playerDirectory, `example:${exampleId}`);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map((child) => this.execution?.owns(child) ? this.execution.stop(child) : terminate(child)));
    this.#running.clear();
  }
}

async function publishStartupDirectory(project: ProjectState) {
  try {
    return await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * A web story publishes as its own page: the files that play it, checked
 * against the publish rules first, as a static site.
 */
async function prepareWebStory(project: ProjectState): Promise<string> {
  try {
    if (!await buildPlayableProject(project.workspacePath, "publish")) throw new Error("This project has no graph.json.");
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
  let files: string[];
  try {
    files = await publishableWebStoryFiles(project.workspacePath);
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
  const output = await mkdtemp(path.join(tmpdir(), "ohmygame-web-story-build-"));
  try {
    for (const relative of files) {
      const destination = path.join(output, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(project.workspacePath, ...relative.split("/")), destination);
    }
    return output;
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw cause;
  }
}

async function prepareInteractiveStory(project: ProjectState, library?: AssetLibrary, playerDirectory?: string, media?: PublishMediaOptimizer): Promise<string> {
  if (!library || !playerDirectory) throw new PublishError("The Published Player is not available.");
  await assertNodePlayerBuilt(playerDirectory);
  let playable: NodePlayerDefinition | undefined;
  try {
    playable = await buildPlayableProject(project.workspacePath, "publish");
  } catch (cause) {
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
  if (!playable) throw new PublishError("This project has no graph.json.");
  return preparePlayableProject(project, playable, library, playerDirectory, undefined, media);
}

async function preparePlayableProject(
  project: Pick<ProjectState, "id" | "workspacePath">,
  definition: NodePlayerDefinition,
  library: AssetLibrary,
  playerDirectory: string,
  scope = `published:${project.id}`,
  media?: PublishMediaOptimizer,
): Promise<string> {
  const output = await mkdtemp(path.join(tmpdir(), "ohmygame-playable-build-"));
  try {
    await cp(playerDirectory, output, { recursive: true });
    await mkdir(path.join(output, "assets", "media"), { recursive: true });
    const assets: Record<string, PublishedNodeAsset> = {};
    const writtenAssets = new Set<string>();
    for (const [id, assetDefinition] of Object.entries(definition.graph.assets).sort(([left], [right]) => left.localeCompare(right))) {
      let absolutePath: string;
      let mediaType: string;
      let contentType: string;
      let extension: string;
      if (assetDefinition.source.kind === "library") {
        const result = await library.content(assetDefinition.source.assetId);
        absolutePath = result.absolutePath;
        mediaType = result.asset.mediaType;
        contentType = result.asset.contentType;
        extension = path.extname(result.asset.name).toLowerCase();
      } else {
        const result = await getWorkspaceMedia(project.workspacePath, assetDefinition.source.path);
        absolutePath = result.absolutePath;
        mediaType = result.mediaType;
        contentType = result.contentType;
        extension = path.extname(result.relativePath).toLowerCase();
      }
      if (mediaType !== assetDefinition.type) {
        throw new PublishError(`Asset "${id}" is not a compatible ${assetDefinition.type} asset.`);
      }
      const bytes = await readFile(media ? await media.optimize(absolutePath) : absolutePath);
      const digest = sha256Hex(bytes);
      const relative = `assets/media/${digest}${extension}`;
      if (!writtenAssets.has(relative)) {
        await writeFile(path.join(output, ...relative.split("/")), bytes);
        writtenAssets.add(relative);
      }
      assets[id] = {
        path: `./${relative}`,
        type: assetDefinition.type,
        contentType,
        size: bytes.length,
        integrity: sha256Integrity(bytes),
      };
    }
    const definitionBytes = Buffer.from(`${JSON.stringify(definition)}\n`);
    await writeFile(path.join(output, "playable.json"), definitionBytes);
    const manifest: PublishedNodeManifest = {
      version: 1,
      runtime: "playable-nodes",
      scope,
      graphSignature: definition.graphSignature,
      definition: {
        path: "./playable.json",
        integrity: sha256Integrity(definitionBytes),
      },
      assets,
    };
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await validatePlayablePublishDirectory(output);
    return output;
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    if (cause instanceof PublishError) throw cause;
    throw new PublishError(cause instanceof Error ? cause.message : String(cause));
  }
}

export async function validatePlayablePublishDirectory(directory: string): Promise<void> {
  const manifestValue = await readJsonFile(path.join(directory, "manifest.json"), "Published manifest");
  if (!isPublishedNodeManifest(manifestValue)) {
    throw new PublishError("Published Player manifest is invalid.");
  }
  const manifest = manifestValue;
  const definitionBytes = await readPublishedFile(directory, manifest.definition.path, "Published Node definition");
  assertIntegrity("Published Node definition", definitionBytes, manifest.definition.integrity);
  let definition: NodePlayerDefinition;
  try {
    definition = JSON.parse(definitionBytes.toString("utf8")) as NodePlayerDefinition;
  } catch {
    throw new PublishError("Published Node definition is not valid JSON.");
  }
  if (definition.version !== 1 || !isNodeGraph(definition.graph) ||
    !isCompiledNodeGraph(definition.compiled, definition.graph) ||
    definition.graphSignature !== nodeGraphSignature(definition.graph) || definition.graphSignature !== manifest.graphSignature) {
    throw new PublishError("Published Node definition does not match its manifest.");
  }
  const graphAssets = Object.entries(definition.graph?.assets ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const manifestAssets = Object.entries(manifest.assets).sort(([left], [right]) => left.localeCompare(right));
  if (graphAssets.length !== manifestAssets.length || graphAssets.some(([id], index) => id !== manifestAssets[index]?.[0])) {
    throw new PublishError("Published asset manifest does not match the Node Graph.");
  }
  for (const [id, asset] of manifestAssets) {
    const declared = definition.graph.assets[id]!;
    if (asset.type !== declared.type) {
      throw new PublishError(`Published Asset "${id}" does not match its declared type.`);
    }
    const bytes = await readPublishedFile(directory, asset.path, `Published Asset "${id}"`);
    if (bytes.length !== asset.size) {
      throw new PublishError(`Published Asset "${id}" does not match its declared size.`);
    }
    assertIntegrity(`Published Asset "${id}"`, bytes, asset.integrity);
    if (path.basename(asset.path, path.extname(asset.path)) !== sha256Hex(bytes)) {
      throw new PublishError(`Published Asset "${id}" does not use its content-addressed path.`);
    }
  }
}

async function readJsonFile(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new PublishError(`${label} is not valid JSON.`);
    throw new PublishError(`${label} is missing.`);
  }
}

async function readPublishedFile(directory: string, publishedPath: string, label: string): Promise<Buffer> {
  const relative = publishedPath.replace(/^\.\//, "");
  const absolute = path.resolve(directory, ...relative.split("/"));
  const relation = path.relative(path.resolve(directory), absolute);
  if (!relative || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new PublishError(`${label} has an unsafe path.`);
  }
  try {
    return await readFile(absolute);
  } catch {
    throw new PublishError(`${label} is missing.`);
  }
}

function assertIntegrity(label: string, bytes: Buffer, expected: string): void {
  if (sha256Integrity(bytes) !== expected) throw new PublishError(`${label} failed integrity validation.`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Integrity(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

async function assertNodePlayerBuilt(playerDirectory: string): Promise<void> {
  const required = [
    "index.html",
    "playable-sandbox.html",
    "assets/playable-sandbox.js",
  ];
  const missing = (
    await Promise.all(required.map(async (file) =>
      await exists(path.join(playerDirectory, ...file.split("/"))) ? undefined : file,
    ))
  ).filter((file): file is string => file !== undefined);
  if (missing.length) {
    throw new PublishError(
      `Published Player build is incomplete. Missing: ${missing.join(", ")}. Run bun run build:player first.`,
    );
  }
}

export async function createPluginArchive(source: string, maxBytes = 25 * 1024 * 1024, preserveExecutable = false): Promise<Buffer> {
  return createZip(source, true, undefined, maxBytes, preserveExecutable);
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void, project?: ProjectState, execution?: IsolatedProjectExecution, signal?: AbortSignal): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson) {
    const build = packageJson.scripts?.build;
    if (typeof build !== "string" || !build.trim()) {
      throw new PublishError("Projects with package.json need a non-empty scripts.build command before publishing");
    }
    const { manager: packageManager } = await resolvePackageManager(workspacePath, project?.packageManager);
    if (execution && packageManager !== "npm") throw new PublishError("This isolated runtime currently supports npm projects only");
    // Static projects can vendor their browser dependencies; their build still runs inside the same isolated VM.
    if (hasDependencies(packageJson) && project?.previewMode !== "static") {
      await ensureProjectDependencies(workspacePath, packageManager,
        (command, args) => run(command, args, workspacePath, track, execution, project, "install", signal), false, () => signal?.throwIfAborted(), execution);
    }
    await run(packageManagerCommand(packageManager), packageManagerRunArguments("build"), workspacePath, track, execution, project, "build", signal);
    if (execution && project) await execution.artifacts(project, workspacePath, { playable: true, signal });
    const output = await findBuildOutput(workspacePath);
    if (!output) throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    return output;
  }
  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
}

async function createZip(source: string, plugin = false, cover?: Buffer, maxBytes?: number, preserveExecutable = false, media?: PublishMediaOptimizer): Promise<Buffer> {
  const zip = new ZipFile();
  const files = await filesIn(source, "", plugin);
  if (files.length > MAX_ARCHIVE_ENTRIES) throw new PublishError("Archive source exceeds the secure entry budget", 413);
  const zipOptions = {
    mtime: new Date(1980, 0, 2),
    forceDosTimestamp: true,
    // Deflate output differs between zlib builds, so Plugin entries are stored
    // to keep the archive's checksum the same on every runtime.
    ...(plugin ? { mode: 0o100644, compress: false } : {}),
  } as const;
  if (cover !== undefined && files.includes(PUBLISH_GAME_COVER_PATH)) {
    throw new PublishError(`Publish output uses reserved path: ${PUBLISH_GAME_COVER_PATH}`);
  }
  if (cover !== undefined) { cover = Buffer.from(cover); assertNoKnownSecretBytes(cover); }
  const budget = { bytes: cover?.byteLength ?? 0 };
  const active = new Set<Readable>();
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    const fail = (cause: Error) => { for (const stream of active) stream.destroy(); output.destroy(); reject(cause); };
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) { fail(new PublishError(`Publish artifact exceeds ${maxBytes / (1024 * 1024)} MB`, 413)); return; }
      chunks.push(chunk);
    });
    output.once("error", fail);
    zip.on("error", fail);
    output.once("end", () => resolve(Buffer.concat(chunks)));
  });
  // A preparation error can precede the awaited output promise.
  void completed.catch(() => {});
  try {
    for (const file of files) {
      assertNoKnownSecretBytes(Buffer.from(file));
      const original = path.join(source, ...file.split("/"));
      const filename = media ? await media.optimize(original) : original;
      const info = await stat(filename);
      const executable = preserveExecutable && (info.mode & 0o111) !== 0;
      const options = { mode: info.mode, ...zipOptions, size: info.size, compress: !plugin && compressArchiveFile(file) };
      zip.addReadStreamLazy(file, executable ? { ...options, mode: 0o100755 } : options, (callback) => {
        void archiveSnapshot(filename, budget).then((bytes) => {
          if (output.destroyed) { callback(new PublishError("Archive creation was stopped"), undefined as unknown as Readable); return; }
          const stream = Readable.from(bytes); active.add(stream); stream.once("close", () => active.delete(stream));
          callback(null, stream);
        }, (cause) => callback(cause, undefined as unknown as Readable));
      });
    }
    if (cover !== undefined) zip.addBuffer(cover, PUBLISH_GAME_COVER_PATH, { ...zipOptions, compress: false });
    zip.end();
    return await completed;
  } catch (cause) { for (const stream of active) stream.destroy(); output.destroy(); throw cause; }
}

/** Inspect the exact immutable bytes the ZIP will consume, without reopening the pathname. */
async function archiveSnapshot(filename: string, budget: { bytes: number }): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n) throw new PublishError("Linked or non-ordinary archive entries are unavailable");
    if (initial.size > BigInt(MAX_ARCHIVE_ENTRY_BYTES) || budget.bytes + Number(initial.size) > MAX_ARCHIVE_SOURCE_BYTES) throw new PublishError("Archive source exceeds the secure inspection budget", 413);
    budget.bytes += Number(initial.size);
    const bytes = Buffer.alloc(Number(initial.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (offset !== Number(initial.size) || final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs || final.nlink !== 1n) throw new PublishError("Archive source changed during secure inspection; retry the export");
    const snapshot = bytes.subarray(0, offset); assertNoKnownSecretBytes(snapshot); return snapshot;
  } finally { await handle.close(); }
}

async function filesIn(root: string, relative = "", plugin = false): Promise<string[]> {
  const files: string[] = [];
  const directory = path.join(root, relative);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(entry.name, relative, plugin) || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, child, plugin));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function readPackageJson(workspacePath: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PublishError("package.json is not valid JSON");
  }
}

function hasDependencies(packageJson: PackageJson): boolean {
  return Object.keys(packageJson.dependencies ?? {}).length > 0 || Object.keys(packageJson.devDependencies ?? {}).length > 0;
}

async function findBuildOutput(workspacePath: string): Promise<string | undefined> {
  for (const directory of ["dist", "build", "out"]) {
    const candidate = path.join(workspacePath, directory);
    if (await exists(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

async function run(command: string, args: string[], cwd: string, track: (child: ChildProcess) => void, execution?: IsolatedProjectExecution, project?: ProjectState, mode: "install" | "build" = "build", signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!execution) assertLocalExecutionAllowed("Project publish build execution");
  if (execution && !project) throw new PublishError("The isolated project is unavailable");
  const child = execution ? await execution.start(project!, mode, cwd, [], undefined, { signal }) : spawn(command, args, {
    cwd,
    env: { ...projectProcessEnvironment(), BROWSER: "none" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  track(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  let stopping: Promise<void> | undefined;
  const cancel = () => {
    stopping = execution?.stop(child);
    void stopping?.catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try { await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new PublishError(stderr.trim() || `${command} exited with ${code}`)));
    if (signal?.aborted) cancel();
  }); completed = true; } finally {
    signal?.removeEventListener("abort", cancel);
    try { await stopping; } finally { await execution?.settled(child, completed); }
  }
  signal?.throwIfAborted();
}

function ignored(name: string, relative: string, plugin: boolean): boolean {
  if (name === "node_modules" || name === ".git" || name === ".data" || (!plugin && name === "AGENTS.md")) return true;
  if (!name.startsWith(".")) return false;
  return !(plugin && !relative && PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES.includes(name));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
