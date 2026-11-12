import { PREVIEW_SETTING_KEYS, previewSettings, validPreviewSettings, validatePreviewSettings, type ProjectPreviewSettings } from "../shared/preview-settings.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryAssetProject, MediaModelDefaults, PreviewViewport, ProjectCoverMode, ProjectCoverState, ProjectModelSelectionPatch, ProjectPackageManager, ProjectRunSettings, ProjectState, ProjectType, PublicationState, ToolJob } from "../shared/contracts.js";
import { defaultProjectName } from "../shared/project-names.js";
import { isProjectType, isWebRuntimeProjectType, supportsWebPreview } from "../shared/project-runtime.js";
import { deleteAssetMetadata, readAssetMetadata, renameAssetMetadata, writeAssetMetadata } from "./asset-metadata.js";
import { getWorkspaceMedia, resolveWorkspaceDirectory, resolveWorkspaceEntry, WorkspaceError } from "./workspace.js";
import type { AssetLibrary } from "./asset-library.js";
import { isProjectPackageManager } from "./package-manager.js";
import { validateNodeGraph } from "../shared/playable-graph-validation.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import { changeNodeCodebase } from "./playable-codebase.js";
import { canvasLibraryAssetUsage, canvasReferencesAsset, removeCanvasAssetReferences, renameCanvasAssetPaths } from "./canvas-workspace.js";
import { isCanvasMediaPath, readCanvasAssets } from "./canvas-assets.js";
import { mediaFileInfo } from "../shared/media-files.js";
import { readCanvasFile, writeCanvasJson } from "./canvas-files.js";
import { ProjectCovers } from "./project-covers.js";
import { PROJECT_ARCHIVE_SETTING_KEYS, type ProjectArchiveSettings } from "../shared/project-archive.js";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";
import { KUNPO_DEFAULT_MODEL_REFS, KUNPO_MODEL_OPTIONS } from "../shared/kunpo-models.js";
import { inspectSafeProjectMedia, readSafeProjectFile } from "./safe-project-file.js";
import { imageDigest, prepareWorkingImage, retainImageOriginal, retainImagePreparation, replaceWorkingImages, serializeWorkingImages, withLocalImageRecovery } from "./image-working-assets.js";
import { assertLocalImagePublicationsSettled, recoveryWorkspacePath, reserveDerivedMediaSpace, type DerivedMediaSpaceReservation, type LocalImageRecoveryAnchor } from "./recovery-space.js";
import { localAgentPath } from "./agent-local-files.js";
import { blenderAuthoringPath, inspectProjectSourceBudget, mediaHeaderMatches, withCheckedFileStream, type ProjectSourceProfile } from "./isolated-project-files.js";
import { runtimeMediaFileLimit } from "../shared/execution-capacity-profiles.js";
import { knownSensitiveValueRevision } from "../shared/sensitive-values.js";
import { inheritToolPreflightFailure, toolPreflightError } from "./agent-tool-errors.js";
import { prepareThreeRuntime } from "./three-runtime.js";
import { readModelResources, storeModelResources } from "./model-resources.js";
import { inspectModel3D } from "./model3d-inspect.js";

const PROJECT_LOAD_CONCURRENCY = 8;
// Imports assemble a project here, next to the projects, and then move it into place.
const IMPORT_STAGING_PREFIX = ".import-";

interface ProjectMetadata extends ProjectPreviewSettings {
  version: 1;
  id: string;
  name: string;
  nameSource?: ProjectState["nameSource"];
  type: ProjectType;
  integration?: ProjectState["integration"];
  updatedAt: string;
  webPreviewEnabled?: boolean;
  /** Present only when a Web Game starts from a directory below its workspace root. */
  startupDirectory?: string;
  /** Present only when a Web Game starts with a script other than `dev`. */
  startupScript?: string;
  /** Present only when automatic package-manager detection is overridden. */
  packageManager?: ProjectPackageManager;
  /** Present only when a Web Game preview starts below the root route. */
  previewPath?: string;
  /** Present only when a Web Game preview defaults to a device preset other than fit. */
  previewViewport?: PreviewViewport;
  /** Present only when the user chose a workspace outside OhMyGame storage. */
  workspacePath?: string;
  publication?: PublicationState;
  mediaModelDefaults?: MediaModelDefaults;
  modelSelections?: ProjectState["modelSelections"];
}
type ProjectMetadataChanges = Partial<Pick<ProjectMetadata, "integration" | "name" | "nameSource" | "updatedAt" | "webPreviewEnabled" | "startupDirectory" | "startupScript" | "packageManager" | "previewPath" | "previewViewport" | "publication" | "mediaModelDefaults" | "modelSelections" | keyof ProjectPreviewSettings>>;

export class ProjectLibraryReferenceError extends Error {}

export class ProjectWorkspaceError extends Error {}

export class ProjectAssetError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

interface LoadedMetadata {
  metadata: ProjectMetadata;
  missing: boolean;
}

const PLAYABLE_GRAPH_FILE = "graph.json";

function workspaceEntryName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/<>:"|?*\x00-\x1f]/.test(name) || name.endsWith(".")) throw new ProjectAssetError("Invalid file or folder name", 400);
  return name;
}

function assertEditableWorkspacePath(value: string): void {
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => [".git", ".data", ".ohmygame"].includes(part))) throw new ProjectAssetError("Internal project files cannot be changed here", 400);
  if (parts[0] === "canvas") throw new ProjectAssetError("Manage Canvas documents and boards in Design", 409);
}

async function assetDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class ProjectManager {
  readonly #projects = new Map<string, ProjectState>();
  readonly #metadataWrites = new Map<string, Promise<unknown>>();
  readonly #covers = new ProjectCovers();
  readonly #assetMetadataWrites = new Map<string, Promise<unknown>>();
  readonly #workspaceWrites = new Map<string, Promise<unknown>>();
  readonly #projectsDirectory: string;
  readonly #privateRoots: readonly string[];

  constructor(dataDirectory: string, private readonly assetLibrary?: AssetLibrary, privateRoots: readonly string[] = [], private readonly sourceProfile?: (project: ProjectState) => Promise<ProjectSourceProfile | undefined>) {
    this.#projectsDirectory = path.join(dataDirectory, "projects");
    this.#privateRoots = [dataDirectory, ...privateRoots].map((root) => path.resolve(root));
  }

  async load(onError?: (projectDirectory: string, cause: unknown) => void): Promise<void> {
    await mkdir(this.#projectsDirectory, { recursive: true });
    const entries = await readdir(this.#projectsDirectory, { withFileTypes: true });
    // An import interrupted by a crash leaves its staging folder behind. It can
    // hold gigabytes, so remove it without delaying startup; new imports use
    // other folder names.
    for (const entry of entries.filter((item) => item.name.startsWith(IMPORT_STAGING_PREFIX))) {
      void rm(path.join(this.#projectsDirectory, entry.name), { recursive: true, force: true }).catch(() => {});
    }
    const projects = await mapConcurrent(
      entries.filter((entry) => entry.isDirectory() && isProjectId(entry.name)),
      PROJECT_LOAD_CONCURRENCY,
      async (entry) => {
        const projectDirectory = path.join(this.#projectsDirectory, entry.name);
        try {
          const { metadata, missing } = await readMetadata(projectDirectory, entry.name, (await lstat(projectDirectory)).mtime.toISOString());
          const registeredWorkspace = metadata.workspacePath ?? path.join(projectDirectory, "workspace");
          const workspaceEntry = await lstat(registeredWorkspace).catch((cause) => {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw cause;
          });
          if (workspaceEntry?.isSymbolicLink()) throw new ProjectWorkspaceError("Workspace root must not be a symbolic link");
          const workspacePath = metadata.workspacePath
            ? await this.#assertExternalWorkspaceBoundary(metadata.workspacePath)
            : registeredWorkspace;
          const workspaceAvailable = await isDirectory(workspacePath);
          const project = projectState(
            workspacePath,
            metadata,
            await isRunnableStartupWorkspace({ ...metadata, workspacePath }),
            projectDirectory,
            workspaceAvailable,
          );
          if (missing) await writeMetadata(projectDirectory, metadata);
          return project;
        } catch (cause) {
          onError?.(projectDirectory, cause);
          return undefined;
        }
      },
    );
    for (const project of projects) {
      if (project) this.#projects.set(project.id, project);
    }
  }

  async create(name?: string, type: ProjectType = "web-game", selectedWorkspacePath?: string, integration?: ProjectState["integration"]): Promise<ProjectState> {
    const id = randomUUID();
    const projectDirectory = path.join(this.#projectsDirectory, id);
    const hasExternalWorkspace = selectedWorkspacePath !== undefined;
    const workspacePath = hasExternalWorkspace
      ? await this.#validateExternalWorkspace(selectedWorkspacePath)
      : path.join(projectDirectory, "workspace");
    const metadata: ProjectMetadata = {
      version: 1,
      id,
      name: name?.trim() || defaultProjectName(type),
      nameSource: name?.trim() ? "manual" : "default",
      type,
      ...(integration ? { integration } : {}),
      ...(type === "general" ? { webPreviewEnabled: integration?.preview !== "external" } : {}),
      updatedAt: new Date().toISOString(),
      modelSelections: structuredClone(KUNPO_DEFAULT_MODEL_REFS),
      ...(hasExternalWorkspace ? { workspacePath } : {}),
    };
    await mkdir(projectDirectory, { recursive: true });
    if (!hasExternalWorkspace) {
      await mkdir(workspacePath, { recursive: true });
    }
    await writeMetadata(projectDirectory, metadata);
    const project = projectState(workspacePath, metadata, await isRunnableStartupWorkspace({ ...metadata, workspacePath }), projectDirectory, true);
    this.#projects.set(id, project);
    return project;
  }

  list(): ProjectState[] {
    return [...this.#projects.values()]
      .map((project, index) => ({ project, index }))
      .sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt) || right.index - left.index)
      .map(({ project }) => project);
  }

  get(id: string): ProjectState | undefined { return this.#projects.get(id); }

  prepareThreeRuntime(id: string) {
    return this.#mutateWorkspace(id, async () => {
      const project = this.#projects.get(id);
      if (!project) throw new ProjectAssetError("Project not found", 404);
      if (project.type !== "web-game") throw new ProjectAssetError("The bundled Three.js runtime is available for Web Game projects", 400);
      const configured = project.startupDirectory ?? ".";
      await localAgentPath(project.workspacePath, configured);
      const startup = await resolveStartupDirectory(project.workspacePath, configured);
      return prepareThreeRuntime(project.workspacePath, startup.relativePath);
    });
  }

  async ensureLibraryAsset(id: string, assetPath: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!this.assetLibrary) throw new ProjectAssetError("Asset Library is not configured", 503);
    const metadata = await readAssetMetadata(project.workspacePath);
    const media = await getWorkspaceMedia(project.workspacePath, assetPath);
    const digest = await assetDigest(media.absolutePath);
    const existing = metadata.libraryAssets[media.relativePath];
    if (existing && this.assetLibrary.get(existing)) {
      const original = await this.assetLibrary.content(existing);
      if (await assetDigest(original.absolutePath) === digest) return existing;
      if (media.contentType === "application/vnd.autodesk.fbx") throw new ProjectAssetError("The FBX original changed; import it as a new model instead of reusing its old preview", 409);
    }
    const previewPath = metadata.previews[media.relativePath];
    const modelPreview = media.contentType === "application/vnd.autodesk.fbx" && previewPath ? await readSafeProjectFile(project.workspacePath, (await getWorkspaceMedia(project.workspacePath, previewPath)).absolutePath) : undefined;
    const canvasAsset = Object.values((await readCanvasAssets(project.workspacePath)).assets).find(asset => asset.path === media.relativePath);
    if (modelPreview && canvasAsset?.model3d?.preview?.sha256 && createHash("sha256").update(modelPreview).digest("hex") !== canvasAsset.model3d.preview.sha256) throw new ProjectAssetError("The retained preview failed its integrity check", 409);
    const asset = await this.assetLibrary.addFile(path.basename(assetPath), media.absolutePath, {
      expectedSha256: digest,
      origin: metadata.origins[media.relativePath] ?? "workspace",
      purpose: metadata.purposes[media.relativePath],
      ...(metadata.prompts[assetPath] ? { prompt: metadata.prompts[assetPath] } : {}),
      sourceKey: `project:${id}:${media.relativePath}:${digest}`,
      ...(modelPreview ? { modelPreview, model3d: canvasAsset?.model3d } : {}),
    });
    await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, media.relativePath, { libraryAssetId: asset.id }));
    return asset.id;
  }

  async rename(id: string, name: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const normalized = name.trim();
    if (!normalized) throw new Error("Project name must not be empty");
    await this.#save(project, { name: normalized, nameSource: "manual", updatedAt: new Date().toISOString() });
    return project;
  }

  async nameAutomatically(id: string, name: string): Promise<ProjectState | undefined> {
    const project = this.#projects.get(id);
    const normalized = name.trim();
    if (!project || !normalized) return undefined;
    const saved = await this.#save(project, { name: normalized, nameSource: "ai" });
    return saved ? project : undefined;
  }

  async setStartupDirectory(id: string, startupDirectory: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return this.setRunSettings(id, { ...projectRunSettings(project), startupDirectory });
  }

  async setRunSettings(id: string, input: ProjectRunSettings): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!isWebRuntimeProjectType(project.type)) throw new ProjectWorkspaceError("Run settings require a Web Game or General Game project");

    if (project.type !== "general" && input.webPreviewEnabled !== undefined) throw new ProjectWorkspaceError("Only General Game projects have a Web preview switch");
    if (input.webPreviewEnabled !== undefined && typeof input.webPreviewEnabled !== "boolean") throw new ProjectWorkspaceError("Web preview enabled must be a boolean");
    try { validatePreviewSettings(input); } catch (cause) { throw new ProjectWorkspaceError((cause as Error).message); }
    const webPreviewEnabled = project.type === "general" ? input.webPreviewEnabled ?? project.webPreviewEnabled ?? false : true;
    if (webPreviewEnabled && project.integration?.preview === "external") throw new ProjectWorkspaceError("This project uses its plugin preview");
    if (!isValidStartupDirectory(input.startupDirectory)) throw new ProjectWorkspaceError("Startup directory must be a relative path inside the project workspace");
    const startupDirectory = normalizeStartupDirectory(input.startupDirectory) ?? ".";
    const startupScript = normalizeStartupScript(input.startupScript);
    if (!startupScript) throw new ProjectWorkspaceError("Startup script must be a package.json script name");
    const previewPath = normalizePreviewPath(input.previewPath);
    if (previewPath === undefined) throw new ProjectWorkspaceError("Preview route must be a local path");
    const previewViewport = input.previewViewport;
    if (!isPreviewViewport(previewViewport)) throw new ProjectWorkspaceError("Preview device preset is not supported");
    const packageManager = input.packageManager;
    if (packageManager !== undefined && !isProjectPackageManager(packageManager)) {
      throw new ProjectWorkspaceError("Package manager is not supported");
    }
    const status = webPreviewEnabled
      ? await resolvePreviewWorkspace({ workspacePath: project.workspacePath, startupDirectory, startupScript, ...previewSettings(input) })
      : undefined;

    const configuredDirectory = status?.relativePath ?? startupDirectory;

    await this.#save(project, {
      ...Object.fromEntries(PREVIEW_SETTING_KEYS.map((key) => [key, input[key]])),
      startupDirectory: configuredDirectory === "." ? undefined : configuredDirectory,
      startupScript: startupScript === "dev" ? undefined : startupScript,
      packageManager,
      previewPath: previewPath === "/" ? undefined : previewPath,
      previewViewport: previewViewport === "fit" ? undefined : previewViewport,
      ...(project.type === "general" ? { webPreviewEnabled } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (project.type === "general" && (!webPreviewEnabled || ["waiting", "stopped"].includes(project.preview.status))) {
      project.preview = { ...project.preview, status: status?.runnable ? "stopped" : "waiting" };
    }
    return project;
  }

  async setMediaModelDefaults(id: string, defaults: MediaModelDefaults): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!validMediaModelDefaults(defaults)) throw new Error("Invalid generation model defaults");
    await this.#save(project, {
      mediaModelDefaults: Object.keys(defaults).length ? structuredClone(defaults) : undefined,
      updatedAt: new Date().toISOString(),
    });
    return project;
  }

  async setModelSelections(id: string, patch: ProjectModelSelectionPatch): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!validModelSelectionPatch(patch)) {
      throw new ProjectAssetError("Invalid project model selection", 400);
    }
    const changes = structuredClone(patch);
    await this.#save(project, (current) => {
      const next = { ...current.modelSelections };
      for (const [role, ref] of Object.entries(changes)) {
        if (ref === null) delete next[role as keyof typeof next];
        else next[role as keyof typeof next] = ref;
      }
      return { modelSelections: Object.keys(next).length ? next : undefined, updatedAt: new Date().toISOString() };
    });
    return project;
  }

  async setIntegration(id: string, integration: NonNullable<ProjectState["integration"]>): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectWorkspaceError("Project not found");
    if (project.integration && project.integration.pluginId !== integration.pluginId) throw new ProjectWorkspaceError("This workspace is connected through another plugin");
    await this.#save(project, { integration, ...(integration.preview === "external" && project.type === "general" ? { webPreviewEnabled: false } : {}) });
    return project;
  }

  /** Web preview stays off; the user re-enables it in Project settings. */
  async clearIntegration(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectWorkspaceError("Project not found");
    if (project.integration) await this.#save(project, { integration: undefined });
    return project;
  }

  async duplicate(id: string): Promise<ProjectState> {
    const source = this.#projects.get(id);
    if (!source) throw new Error(`Project not found: ${id}`);
    const duplicateId = randomUUID();
    const duplicateDirectory = path.join(this.#projectsDirectory, duplicateId);
    const updatedAt = new Date().toISOString();
    const metadata: ProjectMetadata = {
      version: 1,
      id: duplicateId,
      name: `${source.name} copy`,
      nameSource: "manual",
      type: source.type,
      ...(source.integration ? { integration: source.integration } : {}),
      ...(source.type === "general" ? { webPreviewEnabled: source.webPreviewEnabled ?? false } : {}),
      updatedAt,
      ...previewSettings(source),
      ...(source.startupDirectory ? { startupDirectory: source.startupDirectory } : {}),
      ...(source.startupScript ? { startupScript: source.startupScript } : {}),
      ...(source.packageManager ? { packageManager: source.packageManager } : {}),
      ...(source.previewPath ? { previewPath: source.previewPath } : {}),
      ...(source.previewViewport ? { previewViewport: source.previewViewport } : {}),
      ...(source.mediaModelDefaults ? { mediaModelDefaults: structuredClone(source.mediaModelDefaults) } : {}),
      ...(source.modelSelections ? { modelSelections: structuredClone(source.modelSelections) } : {}),
    };
    try {
      await cp(source.workspacePath, path.join(duplicateDirectory, "workspace"), {
        recursive: true,
        errorOnExist: true,
        filter: async (sourcePath) => {
          const relative = path.relative(source.workspacePath, sourcePath).replaceAll(path.sep, "/");
          if (isPrivateProjectPath(relative) || relative.split("/").some((part) => ["node_modules", ".git"].includes(part.toLowerCase()))) return false;
          const entry = await lstat(sourcePath);
          if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink !== 1)) throw new ProjectWorkspaceError("Linked files cannot be duplicated");
          if (!entry.isDirectory() && !entry.isFile()) throw new ProjectWorkspaceError("Only ordinary project files can be duplicated");
          return true;
        },
      });
      await bindCanvasHistory(path.join(duplicateDirectory, "workspace"), duplicateId);
      await this.#covers.copy(this.#projectDirectory(source.id), duplicateDirectory);
      await writeMetadata(duplicateDirectory, metadata);
    } catch (error) {
      await rm(duplicateDirectory, { recursive: true, force: true });
      throw error;
    }
    const workspacePath = path.join(duplicateDirectory, "workspace");
    const project = projectState(workspacePath, metadata, await isRunnableStartupWorkspace({ ...metadata, workspacePath }), duplicateDirectory, true);
    this.#projects.set(project.id, project);
    return project;
  }

  /** A folder in which an import stages its files, on the same volume as the projects. */
  async createImportStaging(): Promise<string> {
    await mkdir(this.#projectsDirectory, { recursive: true });
    return mkdtemp(path.join(this.#projectsDirectory, IMPORT_STAGING_PREFIX));
  }

  /**
   * Creates a managed project around a workspace staged in a folder from
   * createImportStaging, moving the workspace into it. Like a duplicate, the
   * project gets a new id and no publication, and copied Canvas generation
   * history is bound to it.
   */
  async import(workspacePath: string, settings: ProjectArchiveSettings): Promise<ProjectState> {
    if (!isProjectType(settings.type)) throw new ProjectWorkspaceError("The project type is not supported");
    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    const staging = await this.createImportStaging();
    let metadata: ProjectMetadata;
    try {
      const candidate = {
        ...Object.fromEntries(PROJECT_ARCHIVE_SETTING_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])),
        version: 1, id, nameSource: "manual", updatedAt,
      };
      try {
        // Imported settings pass the same checks as saved ones, before writing.
        ({ metadata } = parseMetadata(candidate, id, updatedAt));
      } catch {
        throw new ProjectWorkspaceError("The project settings are invalid");
      }
      await writeMetadata(staging, metadata);
      await rename(workspacePath, path.join(staging, "workspace"));
      await bindCanvasHistory(path.join(staging, "workspace"), id);
      await rename(staging, this.#projectDirectory(id));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    const workspace = path.join(this.#projectDirectory(id), "workspace");
    const project = projectState(workspace, metadata, await isRunnableStartupWorkspace({ ...metadata, workspacePath: workspace }), this.#projectDirectory(id), true);
    this.#projects.set(project.id, project);
    return project;
  }

  async assertRecoveryPreserved(id: string): Promise<void> {
    for (const folder of ["image-originals", "image-preparations"]) {
      try { await lstat(path.join(this.#projectDirectory(id), folder)); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
      throw new Error("Legacy image recovery must be preserved outside the project before deletion; no project files were removed");
    }
    await assertLocalImagePublicationsSettled(await this.getLocalImageRecoveryAnchor(id, true));
  }

  async delete(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const operation = (this.#metadataWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.assertRecoveryPreserved(id);
      if (project.workspaceLocation === "external") {
        // Only clean the app's own attachment directory inside the originally selected workspace.
        const attachments = path.join(project.workspacePath, ".data", "agent-attachments");
        const canonical = await realpath(attachments).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        });
        if (canonical === attachments && (await lstat(attachments)).isDirectory())
          await rm(attachments, { recursive: true, force: true });
      }
      await rm(this.#projectDirectory(id), { recursive: true, force: false });
      this.#projects.delete(id);
    });
    this.#metadataWrites.set(id, operation);
    try { await operation; }
    finally { if (this.#metadataWrites.get(id) === operation) this.#metadataWrites.delete(id); }
    return project;
  }

  /** Re-checks whether the workspace can start a preview, e.g. after files were added to it. */
  async refreshPreviewReadiness(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.preview.status !== "waiting" && project.preview.status !== "stopped") return project;
    const runnable = await isRunnableStartupWorkspace(project);
    project.preview = { ...project.preview, status: runnable ? "stopped" : "waiting" };
    return project;
  }

  async touch(id: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await this.#save(project, { updatedAt: new Date().toISOString() });
  }

  async cover(id: string): Promise<Buffer | undefined> {
    if (!this.#projects.has(id)) return undefined;
    return this.#covers.read(this.#projectDirectory(id));
  }

  async coverState(id: string): Promise<ProjectCoverState> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    return this.#covers.state(this.#projectDirectory(id));
  }

  async setCover(id: string, contents: Uint8Array, source: ProjectCoverMode = "custom"): Promise<void> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    return this.#covers.set(this.#projectDirectory(id), contents, source);
  }

  async setCoverMode(id: string, mode: ProjectCoverMode, fallback?: Uint8Array): Promise<void> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    await this.#covers.setMode(this.#projectDirectory(id), mode, fallback);
  }

  async addGeneratedAsset(
    id: string,
    fileName: string,
    contents: Uint8Array,
    metadata: { prompt?: string; preview?: { bytes: Uint8Array; extension: "png" | "jpg" }; libraryAssetId?: string } = {},
  ): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName)) throw new Error(`Invalid asset name: ${fileName}`);
    const assetsDirectory = path.join(project.workspacePath, "assets");
    const generatedDirectory = path.join(assetsDirectory, "generated");
    await ensureDirectory(project.workspacePath);
    await ensureDirectory(assetsDirectory, true);
    await ensureDirectory(generatedDirectory, true);

    const relativePath = path.join("assets", "generated", fileName);
    const destination = path.join(generatedDirectory, fileName);
    const temporary = path.join(generatedDirectory, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    const assetPath = relativePath.split(path.sep).join("/");
    const normalizedPrompt = metadata.prompt?.trim();
    let previewPath: string | undefined;
    if (metadata.preview) {
      const dataDirectory = path.join(project.workspacePath, ".data");
      const previewDirectory = path.join(dataDirectory, "asset-previews");
      await ensureDirectory(dataDirectory, true);
      await ensureDirectory(previewDirectory, true);
      previewPath = `.data/asset-previews/${path.parse(fileName).name}.${metadata.preview.extension}`;
      const previewDestination = path.join(project.workspacePath, ...previewPath.split("/"));
      const previewTemporary = `${previewDestination}.${randomUUID()}.tmp`;
      try {
        await writeFile(previewTemporary, metadata.preview.bytes, { flag: "wx" });
        await rename(previewTemporary, previewDestination);
      } finally {
        await rm(previewTemporary, { force: true });
      }
    }
    const libraryAssetId = metadata.libraryAssetId && this.assetLibrary?.get(metadata.libraryAssetId)
      ? metadata.libraryAssetId
      : (await this.assetLibrary?.add(fileName, contents, {
      origin: "generated",
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      sourceKey: `project:${id}:${assetPath}`,
      }))?.id;
    await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, assetPath, {
      origin: "generated",
      purpose: "asset",
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      ...(previewPath ? { previewPath } : {}),
      ...(libraryAssetId ? { libraryAssetId } : {}),
    }));
    await this.touch(id);
    return relativePath.split(path.sep).join("/");
  }

  /** These are real, existing application storage anchors; discovery never creates a workspace or directory. */
  async getLocalImageRecoveryAnchor(id: string, inspectMissingExternal = false): Promise<LocalImageRecoveryAnchor> {
    const project = this.#projects.get(id); if (!project) throw new Error(`Project not found: ${id}`);
    const data = await realpath(path.join(this.#projectsDirectory, ".."));
    const allowMissingWorkspace = inspectMissingExternal && project.workspaceLocation === "external";
    return { workspace: await recoveryWorkspacePath(project.workspacePath, allowMissingWorkspace), storage: path.join(data, "image-recovery", id), projectId: id,
      ...(allowMissingWorkspace ? { allowMissingWorkspace: true } : {}) };
  }

  async localImageRecoveryAnchors(): Promise<readonly LocalImageRecoveryAnchor[]> {
    const data = await realpath(path.join(this.#projectsDirectory, "..")), result: LocalImageRecoveryAnchor[] = [];
    const root = path.join(data, "image-recovery"); let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return result; throw cause; }
    if (await realpath(root) !== root) throw new Error("Linked local image recovery index");
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isProjectId(entry.name)) throw new Error("Unknown local image recovery index entry");
      const storage = path.join(root, entry.name), project = this.#projects.get(entry.name);
      if (project) result.push(await this.getLocalImageRecoveryAnchor(project.id, true));
      else {
        let promises: string[]; try { promises = await readdir(path.join(storage, "space-reservations")); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; promises = []; }
        if (promises.length) throw new Error("A local image recovery promise belongs to an unavailable project; inspect storage before allocating again");
      }
    }
    return result;
  }

  async optimizeImageAssets(id: string, input: { paths?: string[]; originalId?: string; destination?: string; maxEdge?: number }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return serializeWorkingImages(() => this.#prepareImageAssets(id, input, signal));
  }

  async #prepareImageAssets(id: string, input: { paths?: string[]; originalId?: string; destination?: string; maxEdge?: number }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const project = this.#projects.get(id); if (!project) throw new Error(`Project not found: ${id}`);
    const anchor = await this.getLocalImageRecoveryAnchor(id);
    const profile = await this.sourceProfile?.(project);
    if (input.originalId && (!/^[a-f0-9]{64}$/.test(input.originalId) || !input.destination || input.paths?.length)) throw new Error("Choose existing paths or a retained originalId and destination");
    const paths = input.originalId ? [input.destination!] : input.paths ?? [];
    if (!paths.length || paths.length > 16 || new Set(paths).size !== paths.length) throw new Error("Choose 1–16 distinct project image paths");
    const originals: Array<{ path: string; before?: Buffer; original: Buffer }> = []; let inputBytes = 0;
    for (const relative of paths) {
      signal?.throwIfAborted(); const destination = await localAgentPath(project.workspacePath, relative, true);
      const before = input.originalId ? undefined : await readSafeProjectFile(project.workspacePath, destination);
      const original = before ?? await readSafeProjectFile(anchor.storage, path.join(anchor.storage, "image-originals", input.originalId!));
      if (input.originalId && imageDigest(original) !== input.originalId) throw new Error("Retained original hash mismatch");
      inputBytes += original.length; if (inputBytes > 64 * 1024 * 1024) throw new Error("Image recovery batch exceeds the 64 MiB preparation budget; use smaller batches");
      originals.push({ path: relative, before, original });
    }
    const bindings = [];
    for (const file of originals) {
      const sha256 = imageDigest(file.original), retained = path.join(anchor.storage, "image-originals", sha256);
      try { const stored = await readSafeProjectFile(anchor.storage, retained); if (!stored.equals(file.original)) throw new Error("Retained original identity conflicts"); bindings.push({ kind: "raw" as const, sha256, size: stored.length }); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    return withLocalImageRecovery(anchor, { rawBytes: inputBytes, workingBytes: 0, beforeBytes: originals.reduce((sum, file) => sum + (file.before?.length ?? 0), 0), afterBytes: Math.min(72 * 1024 * 1024, paths.length * 32 * 1024 * 1024), manifestBytes: 2 * 1024 * 1024, reviewBytes: 2 * 1024 * 1024, additionalEntries: 256, existingArtifacts: bindings }, async () => {
      const retained = [];
      for (const file of originals) { signal?.throwIfAborted(); const originalId = await retainImageOriginal(anchor.storage, file.original); retained.push({ ...file, originalId }); }
      const prepared = []; let workingBytes = 0;
      for (const file of retained) {
        signal?.throwIfAborted(); const image = await prepareWorkingImage(file.original, input.maxEdge, undefined, signal); signal?.throwIfAborted();
        workingBytes += image.bytes.length; if (workingBytes > 72 * 1024 * 1024) throw new Error("Prepared image batch exceeds the existing aggregate working budget; all originals are retained");
        const extensions = image.mediaType === "image/png" ? [".png"] : image.mediaType === "image/jpeg" ? [".jpg", ".jpeg"] : [".webp"];
        if (!extensions.includes(path.extname(file.path).toLowerCase())) throw new Error(`Destination extension must match ${image.mediaType}; original retained as ${file.originalId}`);
        prepared.push({ path: file.path, before: file.before, ...image, originalId: file.originalId, originalBytes: file.original.length });
      }
      for (const resource of prepared) { signal?.throwIfAborted(); await retainImagePreparation(anchor.storage, resource); }
      const budget = await inspectProjectSourceBudget(project.workspacePath, prepared.map(file => ({ path: file.path, size: file.bytes.length })), true, signal, profile ? { profile } : undefined);
      if (!budget.complete || Object.values(budget.overage).some(Boolean)) throw new Error("Projected working images still exceed isolated source limits; originals retained. Choose a supported storage/workflow or an explicit runtime derivative; do not regenerate");
      signal?.throwIfAborted(); await replaceWorkingImages(project.workspacePath, prepared, anchor.storage, signal, profile);
      await this.touch(id);
      return prepared.map(({ bytes, before: _before, ...resource }) => ({ ...resource, workingBytes: bytes.length }));
    }, signal);
  }

  async addGeneratedWorkingImage(id: string, fileName: string, contents: Uint8Array, metadata: { prompt?: string; libraryAssetId?: string } = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return serializeWorkingImages(async () => {
      signal?.throwIfAborted();
      const project = this.#projects.get(id); if (!project) throw new Error(`Project not found: ${id}`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName)) throw new Error("Invalid image file name");
      const anchor = await this.getLocalImageRecoveryAnchor(id);
      return withLocalImageRecovery(anchor, { rawBytes: contents.byteLength, workingBytes: 0, beforeBytes: 0, afterBytes: 32 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024, reviewBytes: 2 * 1024 * 1024, additionalEntries: 256 }, async () => {
        signal?.throwIfAborted(); const originalId = await retainImageOriginal(anchor.storage, Buffer.from(contents)), relative = `assets/generated/${fileName}`;
        await localAgentPath(project.workspacePath, relative, true);
        try {
          const [resource] = await this.#prepareImageAssets(id, { originalId, destination: relative }, signal);
          signal?.throwIfAborted();
          const libraryAssetId = metadata.libraryAssetId && this.assetLibrary?.get(metadata.libraryAssetId)
            ? metadata.libraryAssetId : (await this.assetLibrary?.add(fileName, contents, { origin: "generated", ...(metadata.prompt ? { prompt: metadata.prompt } : {}), sourceKey: `project:${id}:original:${originalId}` }))?.id;
          await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, relative, { origin: "generated", purpose: "asset", ...(metadata.prompt ? { prompt: metadata.prompt } : {}), ...(libraryAssetId ? { libraryAssetId } : {}) }));
          return { ready: true as const, ...resource };
        } catch (error) { if (signal?.aborted) throw error; return { ready: false as const, originalId, error: error instanceof Error ? error.message : "Local working image preparation failed" }; }
      }, signal);
    });
  }

  async generatedAssetPrompt(id: string, assetPath: string): Promise<string | undefined> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return (await readAssetMetadata(project.workspacePath)).prompts[assetPath];
  }

  async modelAssetResources(id: string, reference?: { assetId?: string; path?: string; rebuildPreview?: boolean }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (reference?.assetId && reference.path) {
      const message = "Choose a model asset ID or a project path, not both. Call get_model_asset without a reference to list this project's bindings. No model was read or prepared.";
      throw inheritToolPreflightFailure(new ProjectAssetError(message, 400), toolPreflightError(message, "invalid_model_reference"));
    }
    const project = this.#projects.get(id);
    if (!project || !this.assetLibrary) throw new ProjectAssetError("The project or Library is unavailable", 404);
    const metadata = await readAssetMetadata(project.workspacePath), canvas = await readCanvasAssets(project.workspacePath);
    const bindings = new Map(Object.entries(metadata.libraryAssets));
    for (const [key, value] of Object.entries(canvas.assets)) bindings.set(value.path, value.libraryAssetId ?? key);
    if (!reference?.assetId && !reference?.path) return [...bindings].filter(([file]) => [".fbx", ".glb"].includes(path.extname(file).toLowerCase())).map(([file, assetId]) => ({ assetId, originalPath: file }));
    const binding = [...bindings].find(([file, assetId]) => reference.path ? file === reference.path : assetId === reference.assetId || canvas.assets[reference.assetId!]?.path === file);
    if (!binding) {
      const message = "The reference does not match a model bound to this project. A runtime copy may not be a bound original. Call get_model_asset without a reference, then use an exact listed assetId or originalPath with a new call ID. No model was read, prepared or rebound; other projects' resources remain inaccessible.";
      throw inheritToolPreflightFailure(new ProjectAssetError(message, 403), toolPreflightError(message, "invalid_model_reference"));
    }
    const assetId = await this.ensureLibraryAsset(id, binding[0]);
    if (reference.rebuildPreview && this.assetLibrary.get(assetId)?.contentType === "application/vnd.autodesk.fbx") await this.assetLibrary.rebuildModelPreview(assetId, signal);
    const file = await this.materializeLibraryAsset(id, assetId, reference.rebuildPreview, false, signal);
    if (file.modelRuntimePath || file.path.startsWith(".data/model-assets/")) return await readModelResources(project.workspacePath, assetId, signal);
    const asset = this.assetLibrary.get(assetId)!;
    const runtimePath = file.modelPreviewPath ?? (asset.contentType === "model/gltf-binary" ? file.path : undefined);
    return { assetId, originalPath: file.path, previewPath: file.modelPreviewPath, runtimePath,
      ready: Boolean(runtimePath), ...(runtimePath ? { model: await inspectModel3D(await readSafeProjectFile(project.workspacePath, await localAgentPath(project.workspacePath, runtimePath)), signal) } : {}) };
  }

  async materializeLibraryAsset(id: string, assetId: string, rebuild = false, canvasCandidate = false, signal?: AbortSignal): Promise<{ path: string; assetId: string; modelPreviewPath?: string; modelRuntimePath?: string }> {
    signal?.throwIfAborted();
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!this.assetLibrary) throw new ProjectAssetError("Asset Library is not configured", 503);
    await this.assetLibrary.associateProject(assetId, id);
    const { asset, absolutePath } = await this.assetLibrary.content(assetId);
    const candidate = canvasCandidate && isCanvasMediaPath(`assets/canvas/${asset.name}`);
    const folder = [candidate ? "canvas" : "imported"];
    return this.#writeAssetMetadata(id, async () => {
      signal?.throwIfAborted();
      if (candidate && asset.mediaType === "model") {
        const existing = await readModelResources(project.workspacePath, assetId, signal).catch(() => undefined);
        if (existing) return { path: existing.originalPath, assetId, modelPreviewPath: existing.previewPath, modelRuntimePath: existing.runtimePath };
      }
      if (!candidate && asset.mediaType === "model" && project.type !== "asset-canvas" && (asset.contentType === "application/vnd.autodesk.fbx" || asset.size > 2 * 1024 * 1024)) {
        const collect = async (preview = false) => { const source = await this.assetLibrary!.openContent(assetId, 64 * 1024 * 1024, preview, signal), chunks: Buffer[] = []; for await (const chunk of source.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); };
        const original = await collect(), preview = asset.contentType === "model/gltf-binary" ? original : asset.model3d?.preview?.status === "ready" ? await collect(true) : undefined;
        const existing = !rebuild ? await readModelResources(project.workspacePath, assetId, signal).catch(() => undefined) : undefined;
        const resources = existing?.ready && existing.model && existing.originalSha256 === createHash("sha256").update(original).digest("hex") && existing.previewSha256 === (preview ? createHash("sha256").update(preview).digest("hex") : undefined) ? existing : await storeModelResources(project.workspacePath, asset, original, preview, rebuild || !existing, signal);
        await writeAssetMetadata(project.workspacePath, resources.originalPath, { libraryAssetId: assetId, previewPath: resources.previewPath, origin: asset.origin, purpose: asset.purpose });
        return { path: resources.originalPath, assetId, modelPreviewPath: resources.previewPath, modelRuntimePath: resources.runtimePath };
      }
      const metadata = await readAssetMetadata(project.workspacePath);
      const finish = async (assetPath: string) => {
        let modelPreviewPath: string | undefined;
        if (asset.contentType === "application/vnd.autodesk.fbx" && asset.model3d?.preview?.status === "ready") {
          modelPreviewPath = metadata.previews[assetPath];
          const retained = modelPreviewPath ? await getWorkspaceMedia(project.workspacePath, modelPreviewPath).catch(() => undefined) : undefined;
          if (!retained || createHash("sha256").update(await readSafeProjectFile(project.workspacePath, retained.absolutePath)).digest("hex") !== asset.model3d.preview.sha256) {
            const preview = await this.assetLibrary!.openContent(assetId, 64 * 1024 * 1024, true), chunks: Buffer[] = [];
            for await (const chunk of preview.stream) chunks.push(Buffer.from(chunk));
            const bytes = Buffer.concat(chunks);
            modelPreviewPath = await this.#storeImportedAsset(id, `${path.parse(asset.name).name}-preview-${asset.model3d.preview.sha256?.slice(0, 12)}.glb`, temporary => writeFile(temporary, bytes, { flag: "wx" }), folder);
          }
          await writeAssetMetadata(project.workspacePath, assetPath, { previewPath: modelPreviewPath, libraryAssetId: assetId, origin: asset.origin, purpose: asset.purpose });
        }
        return { path: assetPath, assetId, ...(modelPreviewPath ? { modelPreviewPath } : {}) };
      };
      const stalePaths: string[] = [];
      for (const [assetPath, linkedId] of Object.entries(metadata.libraryAssets)) {
        if (linkedId !== assetId || isCanvasMediaPath(assetPath) !== candidate || blenderAuthoringPath(assetPath)) continue;
        try {
          await getWorkspaceMedia(project.workspacePath, assetPath);
          return await finish(assetPath);
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          stalePaths.push(assetPath);
        }
      }
      const prepareImage = !candidate && project.type !== "asset-canvas" && asset.mediaType === "image" && ["image/png", "image/jpeg", "image/webp"].includes(asset.contentType);
      const store = () => this.#storeImportedAsset(id, asset.name, (temporary) => copyFile(absolutePath, temporary), folder, prepareImage, asset.size);
      const assetPath = await (prepareImage ? serializeWorkingImages(store) : store());
      for (const stalePath of stalePaths) await deleteAssetMetadata(project.workspacePath, stalePath);
      await writeAssetMetadata(project.workspacePath, assetPath, { libraryAssetId: assetId, origin: asset.origin, purpose: asset.purpose });
      return finish(assetPath);
    });
  }

  async useCanvasAsset(id: string, assetId: string, destination: string, useOriginalImage = false, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const app = project.startupDirectory || ".";
    const relative = path.posix.relative(app, destination);
    if (!/^(public|src)\//.test(relative) || destination.includes("\\") || destination.split("/").some(part => !part || part === "." || part === "..")) {
      throw new ProjectAssetError("Choose a file under the game's public/ or src/ directory", 400);
    }
    return this.#mutateWorkspace(id, async () => {
      signal?.throwIfAborted();
      const root = project.workspacePath;
      const asset = (await readCanvasAssets(root)).assets[assetId];
      if (!asset) throw new ProjectAssetError("Choose an asset registered in this project's canvas/assets.json", 404);
      const targetType = mediaFileInfo(destination)?.contentType;
      const usePreview = targetType === "model/gltf-binary" && mediaFileInfo(asset.path)?.contentType === "application/vnd.autodesk.fbx";
      const source = usePreview ? asset.modelPreviewPath : asset.path;
      if (!source || !targetType || targetType === "image/svg+xml" || targetType === "application/vnd.autodesk.fbx" || mediaFileInfo(source)?.contentType !== targetType)
        throw new ProjectAssetError("Keep the media format and file extension; FBX requires a ready GLB preview for GLB use", 400);
      const budgetFailure = (message: string) => inheritToolPreflightFailure(new ProjectAssetError(message, 413), toolPreflightError(message, "runtime_media_budget"));
      const guidance = "Preserve the original. Inspect the project storage/capacity diagnostic and explicitly choose a supported runtime derivative or another supported workflow. Do not automatically transcode, shrink or regenerate the asset.";
      const profile = await this.sourceProfile?.(project);
      signal?.throwIfAborted();
      const limit = runtimeMediaFileLimit(destination, profile);
      let sourceRoot = root, sourcePath: string, expectedOriginalSha256: string | undefined;
      if (useOriginalImage) {
        const linkedId = (await readAssetMetadata(root, { strict: true })).libraryAssets[source];
        const original = linkedId && linkedId === asset.libraryAssetId && this.assetLibrary?.get(linkedId);
        if (!original || original.mediaType !== "image" || original.contentType !== targetType) throw new ProjectAssetError("The project's original Library image is unavailable. Use the current Canvas copy or choose another asset.", 409);
        expectedOriginalSha256 = original.contentSha256;
        const content = await this.assetLibrary!.content(original.id);
        sourceRoot = await realpath(path.dirname(content.absolutePath));
        sourcePath = path.join(sourceRoot, path.basename(content.absolutePath));
      } else sourcePath = await localAgentPath(root, source);
      // Only this pre-scan size refusal is a proven, correctable budget failure.
      // Integrity, permissions, scanner changes and uncertain cleanup stay unbranded.
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.nlink !== 1 || sourceInfo.mode & 0o111) throw new ProjectAssetError("Only ordinary non-executable Canvas media can be copied to the game", 400);
      if (sourceInfo.size > limit)
        throw budgetFailure(`Canvas runtime copy was not written: a runtime file exceeds the current ${limit / 1024 ** 2} MiB per-file limit for this format. ${guidance}`);
      const expected = usePreview ? asset.model3d?.preview?.sha256 : asset.model3d?.originalSha256;
      const target = await localAgentPath(root, destination, true);
      const differentTarget = () => new ProjectAssetError("A different file already exists at the game destination. Choose a new filename.", 409);
      const existing = await lstat(target).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
      if (existing && (!existing.isFile() || existing.nlink !== 1 || existing.size !== sourceInfo.size)) throw differentTarget();
      const budget = await inspectProjectSourceBudget(root, [{ path: destination, size: sourceInfo.size }], true, signal, { profile });
      if (!budget.complete) throw new ProjectAssetError("Canvas runtime copy was not written: the eligible workspace inventory is incomplete, so its capacity is unknown. Inspect the project storage/capacity diagnostic before trying another copy. Preserve all originals.", 409);
      if (Object.values(budget.overage).some(value => value > 0)) {
        const selected = profile ? `verified ${profile} profile` : "legacy lower-bound check; the actual isolated profile is unverified and needs current storage diagnostics";
        throw budgetFailure(`Canvas runtime copy was not written: projected complete eligible workspace exceeds the ${selected}. Runtime media ${budget.mediaBytes}/${budget.limits.mediaBytes} bytes, format-specific file limit ${limit} bytes; source ${budget.totalBytes}/${budget.limits.totalBytes} bytes, per-file limit ${budget.limits.fileBytes} bytes; files ${budget.fileCount}/${budget.limits.fileCount}, entries ${budget.entryCount}/${budget.limits.entries}. ${guidance}`);
      }
      return withCheckedFileStream(sourceRoot, sourcePath, { maxBytes: limit, expectedSize: sourceInfo.size, signal }, async (stream, checked) => {
        if (!mediaHeaderMatches(destination, checked.prefix, checked.size, profile)) throw new ProjectAssetError("The Canvas asset content does not match the runtime file format. Preserve the original and inspect the asset; no runtime copy was written.", 400);
        if (expectedOriginalSha256 && checked.sha256 !== expectedOriginalSha256) throw new ProjectAssetError("The saved image no longer matches the Library original integrity binding. Preserve the files and inspect the Library asset; no runtime copy was written.", 409);
        if (expected && checked.sha256 !== expected) throw new ProjectAssetError("The saved model no longer matches the Canvas binding", 409);
        const assertPolicy = () => { if (checked.scannerRevision !== knownSensitiveValueRevision()) throw new ProjectAssetError("The protected-data policy changed; inspect the asset again before copying.", 409); };
        const sameTarget = async () => {
          const info = await lstat(target);
          if (!info.isFile() || info.nlink !== 1 || info.mode & 0o111 || info.size !== checked.size) throw differentTarget();
          const actual = await inspectSafeProjectMedia(root, target, limit, 16, signal);
          if (actual.size !== checked.size || actual.sha256 !== checked.sha256 || (await lstat(target)).mode & 0o111) throw differentTarget();
          signal?.throwIfAborted();
          assertPolicy();
        };
        signal?.throwIfAborted(); assertPolicy();
        if (existing) { await sameTarget(); return destination; }
        await mkdir(path.dirname(target), { recursive: true });
        const staging = await mkdtemp(path.join(path.dirname(target), ".adopt-"));
        const temporary = path.join(staging, "payload");
        let reservation: DerivedMediaSpaceReservation | undefined, identity: { dev: number; ino: number } | undefined;
        let closed = true, complete = false, removed = false, published = false;
        try {
          reservation = await reserveDerivedMediaSpace(staging, checked.size, signal);
          signal?.throwIfAborted();
          const writer = await open(temporary, "wx", 0o600); closed = false;
          try {
            const info = await writer.stat(); identity = { dev: info.dev, ino: info.ino };
            for await (const chunk of stream) { signal?.throwIfAborted(); await writer.writeFile(chunk); }
            await writer.sync(); complete = true;
          } finally { await writer.close(); closed = true; }
          signal?.throwIfAborted(); assertPolicy();
          await localAgentPath(root, destination, true);
          const info = await lstat(temporary);
          if (!info.isFile() || info.nlink !== 1 || info.mode & 0o111 || info.size !== checked.size || info.dev !== identity.dev || info.ino !== identity.ino) throw new ProjectAssetError("The temporary runtime copy changed before publication; inspect storage before retrying.", 409);
          try { await link(temporary, target); published = true; }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
          await unlink(temporary); removed = true;
          await sameTarget();
          if (!published) return destination;
        } finally {
          if (!removed) {
            const info = await lstat(temporary).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
            if (info) {
              if (!identity || info.dev !== identity.dev || info.ino !== identity.ino || !info.isFile()) throw new ProjectAssetError("Runtime copy cleanup is unconfirmed; inspect storage before retrying.", 409);
              await unlink(temporary);
            }
            removed = true;
          }
          await rmdir(staging);
          if (closed && (complete || removed)) await reservation?.release();
        }
        signal?.throwIfAborted();
        await this.touch(id);
        return destination;
      });
    });
  }

  /**
   * Stores canvas files under `assets/files/`, including files in imported folders.
   * Raster images in game projects use the same bounded working-copy preparation as Library imports.
   */
  async importWorkspaceFile(id: string, fileName: string, contents: Uint8Array, directory = "assets/files"): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const [assets, files, ...folder] = directory.split("/");
    if (assets !== "assets" || files !== "files") throw new ProjectAssetError("Imported files belong under assets/files", 400);
    const prepareImage = project.type !== "asset-canvas" && /\.(?:png|jpe?g|webp)$/i.test(fileName);
    const store = () => this.#storeImportedAsset(id, fileName, (temporary) => writeFile(temporary, contents, { flag: "wx" }), ["files", ...folder], prepareImage, contents.byteLength);
    return this.#mutateWorkspace(id, () => prepareImage ? serializeWorkingImages(store) : store());
  }

  /** Creates the `assets/files/` folder a folder imported on the canvas fills; a repeated name gets a suffix. */
  async createImportFolder(id: string, name: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    if (!validAssetName(name)) throw new ProjectAssetError("Invalid folder name", 400);
    return this.#mutateWorkspace(id, async () => {
      const parent = await importDirectory(project.workspacePath, ["files"]);
      for (let suffix = 1; ; suffix += 1) {
        const candidate = suffix === 1 ? name : `${name}-${suffix}`;
        try {
          await mkdir(path.join(parent, candidate));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw cause;
        }
        await this.touch(id);
        return path.posix.join("assets", "files", candidate);
      }
    });
  }

  async #storeImportedAsset(id: string, fileName: string, writeTemporary: (temporary: string) => Promise<unknown>, folder: readonly string[] = ["imported"], prepareImage = false, inputSize?: number): Promise<string> {
    const project = this.#projects.get(id); if (!project) throw new Error(`Project not found: ${id}`);
    if (!validAssetName(fileName)) throw new ProjectAssetError("Invalid asset name", 400);
    const anchor = prepareImage ? await this.getLocalImageRecoveryAnchor(id) : undefined;
    const profile = prepareImage ? await this.sourceProfile?.(project) : undefined;
    if (prepareImage && (!Number.isSafeInteger(inputSize) || inputSize! < 1 || inputSize! > 64 * 1024 * 1024)) throw new ProjectAssetError("Imported image input exceeds its bounded retention limit", 400);
    const store = async () => {
      const importedDirectory = await importDirectory(project.workspacePath, folder), parsed = path.parse(fileName);
      let candidate = fileName;
      for (let suffix = 2; await exists(path.join(importedDirectory, candidate)); suffix++) candidate = `${parsed.name}-${suffix}${parsed.ext}`;
      const destination = path.join(importedDirectory, candidate), temporary = path.join(importedDirectory, `.${candidate}.${randomUUID()}.tmp`);
      const relative = path.posix.join("assets", ...folder, candidate);
      try {
        await writeTemporary(temporary);
        if (prepareImage) {
          const original = await readSafeProjectFile(project.workspacePath, path.join(await realpath(importedDirectory), path.basename(temporary)));
          if (original.length !== inputSize) throw new ProjectAssetError("Imported image changed after storage admission; no working image was published", 400);
          const originalId = await retainImageOriginal(anchor!.storage, original);
          try {
            const image = await prepareWorkingImage(original);
            const extension = path.extname(candidate).toLowerCase();
            if (!(image.mediaType === "image/png" ? [".png"] : image.mediaType === "image/jpeg" ? [".jpg", ".jpeg"] : [".webp"]).includes(extension)) throw new Error("Imported image extension must match its verified format");
            await retainImagePreparation(anchor!.storage, { path: relative, originalId, originalBytes: original.length, ...image });
            const budget = await inspectProjectSourceBudget(project.workspacePath, [{ path: relative, size: image.bytes.length }], true, undefined, profile ? { profile } : undefined);
            if (!budget.complete || Object.values(budget.overage).some(Boolean)) throw new Error("Imported working image exceeds isolated source limits; preserve the original and choose a supported workflow");
            await replaceWorkingImages(project.workspacePath, [{ path: relative, bytes: image.bytes }], anchor!.storage, undefined, profile);
          } catch (cause) { throw new ProjectAssetError(`${cause instanceof Error ? cause.message : "Image preparation failed"}. Original retained as ${originalId}; recover with optimize_image_asset, do not regenerate.`, 400); }
        } else await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      await this.touch(id); return relative;
    };
    return prepareImage ? withLocalImageRecovery(anchor!, { rawBytes: inputSize!, workingBytes: 0, beforeBytes: 0, afterBytes: Math.min(inputSize!, 32 * 1024 * 1024), manifestBytes: 2 * 1024 * 1024, reviewBytes: 2 * 1024 * 1024, additionalEntries: 256 }, store) : store();
  }

  async renameAsset(id: string, assetPath: string, name: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!validAssetName(name.trim())) throw new ProjectAssetError("Invalid asset name", 400);
    const source = await getWorkspaceMedia(project.workspacePath, assetPath);
    return this.renameWorkspaceEntry(id, assetPath, `${name.trim()}${path.extname(source.absolutePath)}`);
  }

  async deleteAsset(id: string, assetPath: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await getWorkspaceMedia(project.workspacePath, assetPath);
    await this.deleteWorkspaceEntry(id, assetPath);
  }

  async createWorkspaceEntry(id: string, parent: string, name: string, kind: "file" | "folder"): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const normalizedName = workspaceEntryName(name);
    const entryPath = path.posix.join(parent, normalizedName);
    assertEditableWorkspacePath(entryPath);
    return this.#mutateWorkspace(id, async () => {
      const directory = await resolveWorkspaceDirectory(project.workspacePath, parent);
      const destination = path.join(directory, normalizedName);
      try {
        if (kind === "folder") await mkdir(destination);
        else await writeFile(destination, "", { flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectAssetError("A file or folder with that name already exists", 409);
        throw cause;
      }
      await this.touch(id);
      return entryPath;
    });
  }

  async renameWorkspaceEntry(id: string, entryPath: string, name: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const normalizedName = workspaceEntryName(name);
    assertEditableWorkspacePath(entryPath);
    return this.#mutateWorkspace(id, async () => {
      const source = await resolveWorkspaceEntry(project.workspacePath, entryPath);
      assertEditableWorkspacePath(source.relativePath);
      const renamedPath = path.posix.join(path.posix.dirname(source.relativePath), normalizedName);
      assertEditableWorkspacePath(renamedPath);
      const destination = path.join(path.dirname(source.absolutePath), normalizedName);
      if (source.absolutePath === destination) return source.relativePath;
      try {
        const existing = await lstat(destination);
        // On a case-insensitive file system a name that differs only in letter case is the source entry itself.
        if (existing.isSymbolicLink() || await realpath(destination) !== source.absolutePath) throw new ProjectAssetError("A file or folder with that name already exists", 409);
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await rename(source.absolutePath, destination);
      try {
        await renameCanvasAssetPaths(project.workspacePath, source.relativePath, renamedPath);
        await this.#writeAssetMetadata(id, () => renameAssetMetadata(project.workspacePath, source.relativePath, renamedPath));
      } catch (cause) {
        await rename(destination, source.absolutePath);
        await renameCanvasAssetPaths(project.workspacePath, renamedPath, source.relativePath);
        throw cause;
      }
      await this.touch(id);
      return renamedPath;
    });
  }

  async deleteWorkspaceEntry(id: string, entryPath: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    assertEditableWorkspacePath(entryPath);
    await this.#mutateWorkspace(id, async () => {
      const source = await resolveWorkspaceEntry(project.workspacePath, entryPath);
      assertEditableWorkspacePath(source.relativePath);
      const manifest = await readCanvasAssets(project.workspacePath);
      const canvasIds = Object.entries(manifest.assets).filter(([, asset]) => asset.path === source.relativePath || asset.path.startsWith(`${source.relativePath}/`)).map(([assetId]) => assetId);
      await removeCanvasAssetReferences(project.workspacePath, canvasIds, { localOnly: true, checkOnly: true });
      const removed = `${source.absolutePath}.${randomUUID()}.removed`;
      await rename(source.absolutePath, removed);
      let previewPaths: string[];
      try {
        await removeCanvasAssetReferences(project.workspacePath, canvasIds, { localOnly: true });
        previewPaths = await this.#writeAssetMetadata(id, () => deleteAssetMetadata(project.workspacePath, source.relativePath));
      } catch (cause) {
        await rename(removed, source.absolutePath);
        throw cause;
      }
      await rm(removed, { recursive: true, force: true });
      if (previewPaths.length) {
        await ensureDirectory(path.join(project.workspacePath, ".data"));
        await ensureDirectory(path.join(project.workspacePath, ".data", "asset-previews"));
        for (const preview of previewPaths) await rm(path.join(project.workspacePath, ...preview.split("/")), { force: true });
      }
      await this.touch(id);
    });
  }

  async #writeAssetMetadata<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#serialize(id, this.#assetMetadataWrites, operation);
  }

  async #mutateWorkspace<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#serialize(id, this.#workspaceWrites, operation);
  }

  async #serialize<T>(id: string, writes: Map<string, Promise<unknown>>, operation: () => Promise<T>): Promise<T> {
    const write = (writes.get(id)?.catch(() => {}) ?? Promise.resolve()).then(operation);
    writes.set(id, write);
    try {
      return await write;
    } finally {
      if (writes.get(id) === write) writes.delete(id);
    }
  }

  async libraryAssetAssociations(onError: (project: ProjectState, cause: unknown) => void): Promise<Map<string, { projects: LibraryAssetProject[]; hasAssetUsage: boolean }>> {
    const associations = new Map<string, { projects: LibraryAssetProject[]; hasAssetUsage: boolean }>();
    for (const project of this.#projects.values()) {
      if (project.workspaceAvailable === false) continue;
      const metadata = await readAssetMetadata(project.workspacePath);
      const usage = new Map<string, boolean>(Object.values(metadata.libraryAssets).map((id) => [id, false]));
      try {
        for (const [id, asAsset] of await canvasLibraryAssetUsage(project.workspacePath)) usage.set(id, asAsset);
      } catch (cause) { onError(project, cause); }
      if (project.type === "interactive-story" && await exists(path.join(project.workspacePath, PLAYABLE_GRAPH_FILE))) {
        try {
          const graph = await readNodeGraphForReferences(project.workspacePath);
          for (const asset of Object.values(graph.assets)) {
            if (asset.source.kind === "library") usage.set(asset.source.assetId, true);
          }
        } catch (cause) { onError(project, cause); }
      }
      for (const [id, asAsset] of usage) {
        const association = associations.get(id) ?? { projects: [], hasAssetUsage: false };
        association.projects.push({ id: project.id, name: project.name, type: project.type });
        association.hasAssetUsage ||= asAsset;
        associations.set(id, association);
      }
    }
    return associations;
  }

  async referencesLibraryAsset(assetId: string, excludingProjectId?: string): Promise<ProjectState[]> {
    try {
      const storage = await lstat(this.#projectsDirectory);
      if (!storage.isDirectory() || storage.isSymbolicLink()) throw new Error("Project storage is not a regular directory");
      const entries = (await readdir(this.#projectsDirectory, { withFileTypes: true })).filter((entry) => isProjectId(entry.name));
      const registered = new Set(entries.map((entry) => entry.name));
      for (const entry of entries) {
        const directory = path.join(this.#projectsDirectory, entry.name), project = this.#projects.get(entry.name);
        const stats = await lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink() || !project) throw new Error(`Project ${entry.name} is unavailable or has not been loaded`);
        const file = await lstat(path.join(directory, "project.json"));
        if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Project metadata for ${project.name} is unavailable`);
        const { metadata } = await readMetadata(directory, project.id, stats.mtime.toISOString());
        if (metadata.type !== project.type || (metadata.workspacePath ?? path.join(directory, "workspace")) !== project.workspacePath) throw new Error(`Project ${project.name} changed since it was loaded`);
      }
      for (const project of this.#projects.values()) if (!registered.has(project.id)) throw new Error(`Project ${project.name} is missing from project storage`);
    } catch (cause) {
      throw new ProjectLibraryReferenceError(`Cannot verify registered projects: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const references: ProjectState[] = [];
    for (const project of this.#projects.values()) {
      if (project.id === excludingProjectId) continue;
      let referenced = false;
      try {
        if (project.workspaceAvailable === false) throw new Error("Project workspace is unavailable");
        const workspace = await lstat(project.workspacePath);
        if (!workspace.isDirectory() || workspace.isSymbolicLink()) throw new Error("Project workspace is not a regular directory");
        await access(project.workspacePath, constants.R_OK | constants.X_OK);
        const metadata = await readAssetMetadata(project.workspacePath, { strict: true });
        const localPaths = Object.entries(metadata.libraryAssets).filter(([, id]) => id === assetId).map(([file]) => file);
        // Asset Canvas keeps independent local copies after nodes are removed; provenance alone is not live usage.
        referenced = project.type !== "asset-canvas" && localPaths.length > 0;
        referenced ||= await canvasReferencesAsset(project.workspacePath, assetId, localPaths);
      } catch (cause) {
        throw new ProjectLibraryReferenceError(`Cannot verify canvas references in ${project.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (project.type === "interactive-story") {
        try {
          const graph = await readNodeGraphForReferences(project.workspacePath);
          referenced ||= Object.values(graph.assets).some((asset) => (
            asset.source.kind === "library" && asset.source.assetId === assetId
          ));
        } catch (cause) {
          throw new ProjectLibraryReferenceError(`Cannot verify Library references in ${project.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (referenced) {
        references.push(project);
        continue;
      }
    }
    return references;
  }

  async removeLibraryAssetReferences(assetId: string): Promise<void> {
    const projects = await this.referencesLibraryAsset(assetId);
    for (const project of projects) {
      try { await removeCanvasAssetReferences(project.workspacePath, assetId, { checkOnly: true }); }
      catch (cause) { throw new ProjectLibraryReferenceError(`${project.name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    for (const project of projects) {
      await removeCanvasAssetReferences(project.workspacePath, assetId);
      const metadata = await readAssetMetadata(project.workspacePath);
      for (const [assetPath, linkedId] of Object.entries(metadata.libraryAssets)) {
        if (linkedId !== assetId) continue;
        try {
          await this.deleteAsset(project.id, assetPath);
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          await this.#writeAssetMetadata(project.id, () => deleteAssetMetadata(project.workspacePath, assetPath));
        }
      }
      if (project.type === "interactive-story" && await exists(path.join(project.workspacePath, PLAYABLE_GRAPH_FILE))) {
        let changed = false;
        await changeNodeCodebase(project.workspacePath, (codebase) => {
          const removedIds = new Set(Object.entries(codebase.graph.assets).flatMap(([id, asset]) => (
            asset.source.kind === "library" && asset.source.assetId === assetId ? [id] : []
          )));
          if (!removedIds.size) return;
          for (const id of removedIds) delete codebase.graph.assets[id];
          codebase.graph.nodes = codebase.graph.nodes.map((node) => ({
            ...node,
            assets: node.assets.filter((id) => !removedIds.has(id)),
          }));
          changed = true;
          return codebase;
        });
        if (changed) await this.touch(project.id);
      }
    }
  }

  async setPublication(id: string, publication: PublicationState | undefined): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await this.#save(project, { publication, updatedAt: new Date().toISOString() });
  }

  async #save(
    project: ProjectState,
    changes: ProjectMetadataChanges | ((current: ProjectMetadata) => ProjectMetadataChanges),
  ): Promise<boolean> {
    const operation = (this.#metadataWrites.get(project.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.#projects.get(project.id) !== project) return false;
      const current = metadataFor(project);
      const updates = typeof changes === "function" ? changes(current) : changes;
      if (updates.nameSource === "ai" && project.nameSource !== "default") return false;
      const metadata = { ...current, ...updates };
      await writeMetadata(this.#projectDirectory(project.id), metadata);
      for (const key of PREVIEW_SETTING_KEYS) { delete project[key]; }
      Object.assign(project, previewSettings(metadata));
      project.integration = metadata.integration;
      project.name = metadata.name;
      if (metadata.nameSource) project.nameSource = metadata.nameSource;
      project.updatedAt = metadata.updatedAt;
      if (project.type === "general") project.webPreviewEnabled = metadata.webPreviewEnabled ?? false;
      if (metadata.startupDirectory) project.startupDirectory = metadata.startupDirectory;
      else delete project.startupDirectory;
      if (metadata.startupScript) project.startupScript = metadata.startupScript;
      else delete project.startupScript;
      if (metadata.packageManager) project.packageManager = metadata.packageManager;
      else delete project.packageManager;
      if (metadata.previewPath) project.previewPath = metadata.previewPath;
      else delete project.previewPath;
      if (metadata.previewViewport) project.previewViewport = metadata.previewViewport;
      else delete project.previewViewport;
      if (metadata.mediaModelDefaults) project.mediaModelDefaults = metadata.mediaModelDefaults;
      else delete project.mediaModelDefaults;
      if (metadata.modelSelections) project.modelSelections = metadata.modelSelections;
      else delete project.modelSelections;
      if (metadata.publication) project.publication = metadata.publication;
      else delete project.publication;
      return true;
    });
    this.#metadataWrites.set(project.id, operation);
    try { return await operation; }
    finally { if (this.#metadataWrites.get(project.id) === operation) this.#metadataWrites.delete(project.id); }
  }

  /**
   * The project whose workspace is the selected folder. Choosing that folder
   * again opens the project rather than creating a second one on its files.
   */
  async findByWorkspace(selectedWorkspacePath: string): Promise<ProjectState | undefined> {
    try {
      return this.#workspaceOwner(await realpath(selectedWorkspacePath));
    } catch {
      return undefined;
    }
  }

  #workspaceOwner(workspacePath: string): ProjectState | undefined {
    return [...this.#projects.values()].find((project) => path.resolve(project.workspacePath) === workspacePath);
  }

  async #validateExternalWorkspace(selectedWorkspacePath: string): Promise<string> {
    if (!path.isAbsolute(selectedWorkspacePath)) throw new ProjectWorkspaceError("Workspace path must be absolute");
    let entry: Awaited<ReturnType<typeof lstat>>;
    let workspacePath: string;
    try {
      entry = await lstat(selectedWorkspacePath);
      workspacePath = await realpath(selectedWorkspacePath);
    } catch {
      throw new ProjectWorkspaceError("Selected workspace folder is not available");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ProjectWorkspaceError("Selected workspace must be a directory, not a symbolic link");
    }
    if (path.parse(workspacePath).root === workspacePath) {
      throw new ProjectWorkspaceError("The filesystem root cannot be used as a workspace");
    }
    await this.#assertExternalWorkspaceBoundary(workspacePath);
    const owner = this.#workspaceOwner(workspacePath);
    if (owner) throw new ProjectWorkspaceError(`This folder is already the workspace of “${owner.name}”`);
    return workspacePath;
  }

  /** Managed projects own only their workspace subtree; external projects never own daemon data or agent credentials. */
  async #assertExternalWorkspaceBoundary(selectedWorkspacePath: string): Promise<string> {
    const workspacePath = await boundaryPath(selectedWorkspacePath);
    for (const root of this.#privateRoots) {
      if (pathsOverlap(workspacePath, await boundaryPath(root))) {
        throw new ProjectWorkspaceError("Private application or agent storage cannot be used as a workspace");
      }
    }
    return workspacePath;
  }

  #projectDirectory(id: string): string {
    return path.join(this.#projectsDirectory, id);
  }

}

function projectState(
  workspacePath: string,
  metadata: ProjectMetadata,
  runnable: boolean,
  storagePath: string,
  workspaceAvailable: boolean,
): ProjectState {
  return {
    id: metadata.id,
    name: metadata.name,
    ...(metadata.nameSource ? { nameSource: metadata.nameSource } : {}),
    type: metadata.type,
    ...(metadata.integration ? { integration: metadata.integration } : {}),
    ...(metadata.type === "general" ? { webPreviewEnabled: metadata.webPreviewEnabled ?? false } : {}),
    updatedAt: metadata.updatedAt,
    workspacePath,
    ...previewSettings(metadata),
    ...(metadata.startupDirectory ? { startupDirectory: metadata.startupDirectory } : {}),
    ...(metadata.startupScript ? { startupScript: metadata.startupScript } : {}),
    ...(metadata.packageManager ? { packageManager: metadata.packageManager } : {}),
    ...(metadata.previewPath ? { previewPath: metadata.previewPath } : {}),
    ...(metadata.previewViewport ? { previewViewport: metadata.previewViewport } : {}),
    ...(metadata.mediaModelDefaults ? { mediaModelDefaults: metadata.mediaModelDefaults } : {}),
    ...(metadata.modelSelections ? { modelSelections: metadata.modelSelections } : {}),
    storagePath,
    workspaceLocation: metadata.workspacePath ? "external" : "managed",
    workspaceAvailable,
    preview: { status: runnable ? "stopped" : "waiting" },
    ...(metadata.publication ? { publication: metadata.publication } : {}),
  };
}

async function isRunnableStartupWorkspace(project: Pick<ProjectState, "type" | "integration" | "webPreviewEnabled" | "workspacePath" | "startupDirectory" | "startupScript" | keyof ProjectPreviewSettings>): Promise<boolean> {
  if (project.type === "general" && !supportsWebPreview(project)) return false;
  try {
    return (await resolvePreviewWorkspace(project)).runnable;
  } catch {
    return false;
  }
}

export interface PreviewWorkspaceStatus {
  mode?: "script" | "static" | "command";
  runnable: boolean;
  error?: string;
}

/** Resolve the configured directory and inspect its preview script in one place. */
export async function resolvePreviewWorkspace(project: Pick<ProjectState, "workspacePath" | "startupDirectory" | "startupScript" | keyof ProjectPreviewSettings>): Promise<PreviewWorkspaceStatus & { absolutePath: string; relativePath: string }> {
  const directory = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  if (project.previewMode === "command") return { ...directory, runnable: !!project.previewCommand?.trim(), mode: "command" as const };
  const script = await previewWorkspaceStatus(directory.absolutePath, project.startupScript ?? "dev");
  if (project.previewMode === "static" || ((project.previewMode ?? "auto") === "auto" && !script.runnable && await exists(path.join(directory.absolutePath, "index.html")))) {
    const runnable = await exists(path.join(directory.absolutePath, "index.html"));
    return { ...directory, runnable, mode: "static" as const, ...(!runnable ? { error: "This folder has no index.html to preview." } : {}) };
  }
  return { ...directory, ...script, mode: "script" as const };
}

export async function previewWorkspaceStatus(workspacePath: string, startupScript = "dev"): Promise<PreviewWorkspaceStatus> {
  const script = normalizeStartupScript(startupScript) ?? "dev";
  const label = script === "dev" ? "dev script" : `${script} script`;
  try {
    const packageJson = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const command = packageJson.scripts?.[script];
    if (typeof command !== "string" || !command.trim()) {
      return { runnable: false, error: `This folder has no ${label} that starts a preview server.` };
    }
    if (isNonServerDevCommand(command)) {
      return {
        runnable: false,
        error: `This folder's ${label} runs a non-server task: ${command.trim()}`,
      };
    }
    return { runnable: true };
  } catch {
    return { runnable: false, error: `This folder has no package.json ${label} that starts a preview server.` };
  }
}

function isNonServerDevCommand(command: string): boolean {
  // Inspect launchers and task names, not words inside server options or paths.
  const tokens = command.match(/&&|\|\||[;|]|(?:[^\s;&|"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  let start = 0;
  for (let end = 0; end <= tokens.length; end++) {
    if (end < tokens.length && !/^(?:&&|\|\||[;|])$/.test(tokens[end]!)) continue;
    const words = tokens.slice(start, end).map((word) => word.replace(/^(["'])(.*)\1$/, "$2").toLowerCase());
    start = end + 1;
    if (/^(?:env|cross-env|cross-env-shell)$/.test(words[0] ?? "")) words.shift();
    while (/^[a-z_]\w*=/.test(words[0] ?? "")) words.shift();
    if (/^(?:npm|pnpm|yarn|bun|npx|bunx)$/.test(words[0] ?? "")) {
      words.shift();
      while (/^(?:--yes|-y|--no-install|--silent|-s)$/.test(words[0] ?? "")) words.shift();
      if (/^(?:run|exec|x)$/.test(words[0] ?? "")) words.shift();
    }
    const launcher = path.posix.basename(words[0] ?? "");
    if (/^(?:build|check|eslint|fmt|format|lint|prettier|test|typecheck|electron(?:-forge|-vite|-builder)?|tauri|godot4?)$/.test(launcher)) return true;
    if (/^(?:vite|next|nuxt|astro|svelte-kit|react-scripts)$/.test(launcher) && /^(?:build|check|lint|test|typecheck)$/.test(words[1] ?? "")) return true;
  }
  return false;
}

export async function resolveStartupDirectory(workspacePath: string, input: string): Promise<{ absolutePath: string; relativePath: string }> {
  if (!isValidStartupDirectory(input)) {
    throw new ProjectWorkspaceError("Startup directory must be a relative path inside the project workspace");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(workspacePath);
  } catch {
    throw new ProjectWorkspaceError("The project workspace is not available");
  }
  const configured = normalizeStartupDirectory(input) ?? ".";
  const candidate = path.resolve(workspaceRoot, configured);
  if (!pathContains(workspaceRoot, candidate)) {
    throw new ProjectWorkspaceError("Startup directory must be inside the project workspace");
  }
  let absolutePath: string;
  try {
    absolutePath = await realpath(candidate);
  } catch {
    throw new ProjectWorkspaceError("Startup directory does not exist");
  }
  if (!pathContains(workspaceRoot, absolutePath)) {
    throw new ProjectWorkspaceError("Startup directory must be inside the project workspace");
  }
  if (!(await lstat(absolutePath)).isDirectory()) {
    throw new ProjectWorkspaceError("Startup directory must be a folder");
  }
  const relativePath = path.relative(workspaceRoot, absolutePath).replaceAll(path.sep, "/");
  return { absolutePath, relativePath: relativePath || "." };
}

function isValidStartupDirectory(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "." || normalizeStartupDirectory(trimmed) !== undefined;
}

function normalizeStartupDirectory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized === ".") return undefined;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function normalizeStartupScript(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(normalized) ? normalized : undefined;
}

function normalizePreviewPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return undefined;
  return `/${normalized.replace(/^\/+/, "")}`;
}

function isPreviewViewport(value: unknown): value is PreviewViewport {
  return value === "fit" || value === "tablet" || value === "mobile";
}

function projectRunSettings(project: ProjectState): ProjectRunSettings {
  return {
    ...previewSettings(project),
    ...(project.type === "general" ? { webPreviewEnabled: project.webPreviewEnabled ?? false } : {}),
    startupDirectory: project.startupDirectory ?? ".",
    startupScript: project.startupScript ?? "dev",
    ...(project.packageManager ? { packageManager: project.packageManager } : {}),
    previewPath: project.previewPath ?? "/",
    previewViewport: project.previewViewport ?? "fit",
  };
}

async function readMetadata(projectDirectory: string, id: string, fallbackUpdatedAt: string): Promise<LoadedMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8")) as Partial<ProjectMetadata>;
    return parseMetadata(parsed, id, fallbackUpdatedAt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { metadata: { version: 1, id, name: "Untitled project", type: "web-game", updatedAt: fallbackUpdatedAt }, missing: true };
  }
}

/** Validates and normalizes persisted or imported metadata without disk I/O. */
function parseMetadata(value: unknown, id: string, fallbackUpdatedAt: string): LoadedMetadata {
  const parsed = value as Partial<ProjectMetadata>;
  if (
    validPreviewSettings(parsed) && parsed.version === 1 && parsed.id === id && typeof parsed.name === "string" && parsed.name.trim() &&
    (parsed.nameSource === undefined || ["default", "ai", "manual"].includes(parsed.nameSource)) &&
    (parsed.type === undefined || isProjectType(parsed.type)) &&
    (parsed.integration === undefined || (typeof parsed.integration?.pluginId === "string" && !!parsed.integration.pluginId && (parsed.integration.preview === undefined || parsed.integration.preview === "external"))) &&
    (parsed.webPreviewEnabled === undefined || typeof parsed.webPreviewEnabled === "boolean") &&
    (parsed.startupDirectory === undefined || isValidStartupDirectory(parsed.startupDirectory)) &&
    (parsed.startupScript === undefined || normalizeStartupScript(parsed.startupScript) !== undefined) &&
    (parsed.packageManager === undefined || isProjectPackageManager(parsed.packageManager)) &&
    (parsed.previewPath === undefined || normalizePreviewPath(parsed.previewPath) !== undefined) &&
    (parsed.previewViewport === undefined || isPreviewViewport(parsed.previewViewport)) &&
    (parsed.workspacePath === undefined || (typeof parsed.workspacePath === "string" && path.isAbsolute(parsed.workspacePath))) &&
    (parsed.mediaModelDefaults === undefined || validMediaModelDefaults(parsed.mediaModelDefaults)) &&
    (parsed.modelSelections === undefined || validModelSelections(parsed.modelSelections)) &&
    (parsed.publication === undefined || validPublication(parsed.publication))
  ) {
    const updatedAt = typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))
      ? parsed.updatedAt
      : fallbackUpdatedAt;
    const type = parsed.type ?? "web-game";
    const startupDirectory = normalizeStartupDirectory(parsed.startupDirectory);
    const startupScript = normalizeStartupScript(parsed.startupScript);
    const packageManager = parsed.packageManager;
    const previewPath = normalizePreviewPath(parsed.previewPath);
    const previewViewport = parsed.previewViewport;
    const workspacePath = parsed.workspacePath;
    return {
      metadata: {
        ...previewSettings(parsed),
        version: 1,
        id,
        name: parsed.name.trim(),
        ...(parsed.nameSource ? { nameSource: parsed.nameSource } : {}),
        type,
        ...(parsed.integration ? { integration: parsed.integration } : {}),
        ...(type === "general" ? { webPreviewEnabled: parsed.webPreviewEnabled ?? false } : {}),
        updatedAt,
        ...(startupDirectory ? { startupDirectory } : {}),
        ...(startupScript && startupScript !== "dev" ? { startupScript } : {}),
        ...(packageManager ? { packageManager } : {}),
        ...(previewPath && previewPath !== "/" ? { previewPath } : {}),
        ...(previewViewport && previewViewport !== "fit" ? { previewViewport } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        ...(parsed.publication ? { publication: parsed.publication } : {}),
        ...(parsed.mediaModelDefaults ? { mediaModelDefaults: parsed.mediaModelDefaults } : {}),
        ...(parsed.modelSelections ? { modelSelections: parsed.modelSelections } : {}),
      },
      missing: parsed.updatedAt !== updatedAt || parsed.type !== type || parsed.startupDirectory !== startupDirectory ||
        parsed.startupScript !== startupScript || parsed.packageManager !== packageManager ||
        parsed.previewPath !== previewPath || parsed.previewViewport !== previewViewport || parsed.workspacePath !== workspacePath,
    };
  }
  throw new Error("Invalid project metadata");
}

function metadataFor(project: ProjectState): ProjectMetadata {
  return {
    ...previewSettings(project),
    version: 1,
    id: project.id,
    name: project.name,
    ...(project.nameSource ? { nameSource: project.nameSource } : {}),
    type: project.type,
    ...(project.integration ? { integration: project.integration } : {}),
    ...(project.type === "general" ? { webPreviewEnabled: project.webPreviewEnabled ?? false } : {}),
    updatedAt: project.updatedAt,
    ...(project.startupDirectory ? { startupDirectory: project.startupDirectory } : {}),
    ...(project.startupScript ? { startupScript: project.startupScript } : {}),
    ...(project.packageManager ? { packageManager: project.packageManager } : {}),
    ...(project.previewPath ? { previewPath: project.previewPath } : {}),
    ...(project.previewViewport ? { previewViewport: project.previewViewport } : {}),
    ...(project.mediaModelDefaults ? { mediaModelDefaults: project.mediaModelDefaults } : {}),
    ...(project.modelSelections ? { modelSelections: project.modelSelections } : {}),
    ...(project.workspaceLocation === "external" ? { workspacePath: project.workspacePath } : {}),
    ...(project.publication ? { publication: project.publication } : {}),
  };
}

async function writeMetadata(projectDirectory: string, metadata: ProjectMetadata): Promise<void> {
  const destination = path.join(projectDirectory, "project.json");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Binds copied Canvas generation history to the project that now owns it.
 * Canvas rejects history recorded for another project; node IDs, status,
 * settings and outputs stay intact.
 */
async function bindCanvasHistory(workspacePath: string, projectId: string): Promise<void> {
  let jobs: unknown;
  try {
    // Retry inputs can contain inline images, exceeding the board-file limit.
    const history = await readCanvasFile(workspacePath, "jobs.json", Infinity);
    if (history === undefined) return;
    jobs = JSON.parse(history) as unknown;
  } catch {
    // History that cannot be read stays as copied; Canvas reports it when opened.
    return;
  }
  if (!Array.isArray(jobs)) return;
  await writeCanvasJson(workspacePath, "jobs.json", (jobs as (ToolJob | null)[]).map((job) => (
    job?.context && typeof job.context === "object" ? { ...job, context: { ...job.context, projectId } } : job
  )));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readNodeGraphForReferences(workspacePath: string): Promise<NodeGraph> {
  const file = path.join(workspacePath, PLAYABLE_GRAPH_FILE);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("graph.json is not a regular file.");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error("graph.json is not valid JSON.");
    throw cause;
  }
  const validation = validateNodeGraph(value, { mode: "draft" });
  if (!validation.ok) {
    const issue = validation.issues[0]!;
    throw new Error(`${issue.path}: ${issue.message}`);
  }
  return value as NodeGraph;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

/** Resolve aliases even when an old project's directory or an agent directory is currently absent. */
async function boundaryPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...suffix.reverse()); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Creates `assets/<folder...>` one level at a time, refusing a symbolic link at any level. */
async function importDirectory(workspacePath: string, folder: readonly string[]): Promise<string> {
  if (!folder.every(validAssetName)) throw new ProjectAssetError("Invalid folder name", 400);
  let directory = path.join(workspacePath, "assets");
  await ensureDirectory(workspacePath);
  await ensureDirectory(directory, true);
  for (const part of folder) {
    directory = path.join(directory, part);
    await ensureDirectory(directory, true);
  }
  return directory;
}

async function ensureDirectory(target: string, create = false): Promise<void> {
  if (create) {
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe generated asset path: ${target}`);
}

function isProjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validAssetName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") && !/[\u0000-\u001f]/.test(value);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await transform(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function validPublication(value: unknown): value is PublicationState {
  if (!value || typeof value !== "object") return false;
  const publication = value as Partial<PublicationState>;
  return typeof publication.gameId === "string" && typeof publication.deploymentId === "string" &&
    typeof publication.playUrl === "string" && typeof publication.publishedAt === "string" &&
    (publication.title === undefined || typeof publication.title === "string") &&
    (publication.description === undefined || typeof publication.description === "string");
}

function validMediaModelDefaults(value: unknown): value is MediaModelDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([usage, ref]) => ["image", "video", "3d"].includes(usage)
    && ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).every((key) => key === "provider" || key === "id")
    && typeof ref.provider === "string" && ref.provider.trim().length > 0 && ref.provider.length <= 100
    && typeof ref.id === "string" && ref.id.trim().length > 0 && ref.id.length <= 200);
}

function validModelSelections(value: unknown): value is NonNullable<ProjectState["modelSelections"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([role, ref]) => KUNPO_MODEL_OPTIONS.some((option) => option.role === role)
    && ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).every((key) => key === "provider" || key === "id")
    && typeof ref.provider === "string" && ref.provider.trim().length > 0 && ref.provider.length <= 100
    && typeof ref.id === "string" && ref.id.trim().length > 0 && ref.id.length <= 200);
}

function validModelSelectionPatch(value: unknown): value is ProjectModelSelectionPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([role, ref]) => KUNPO_MODEL_OPTIONS.some((option) => option.role === role)
    && (ref === null || validModelSelections({ [role]: ref }) && KUNPO_MODEL_OPTIONS.some((option) => option.role === role && option.provider === ref.provider && option.id === ref.id)));
}
