import { lstat, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CANVAS_ASSETS_SCHEMA, type CanvasAsset, type CanvasAssetManifest, type CanvasAssetCatalogEntry, type UnavailableCanvasAsset } from "../shared/canvas-assets.js";
import { normalizeGenerationProvenance, type AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ProjectState } from "../shared/contracts.js";
import { getWorkspaceMedia } from "./workspace.js";
import { readMediaDimensions } from "./media-dimensions.js";
import { CanvasError, parseCanvasJson, readCanvasFile, writeCanvasJson } from "./canvas-files.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { mediaFileInfo } from "../shared/media-files.js";

// Only registered Canvas media in this directory are editor candidates. Older
// imported paths may already be in use by a game, even when listed on a board.
export function isCanvasMediaPath(file: string): boolean {
  const media = mediaFileInfo(file);
  return /^assets\/canvas\/[^./\\][^/\\]*$/.test(file) && !!media;
}

export async function canvasCandidatePaths(workspace: string): Promise<Set<string>> {
  const result = new Set<string>();
  const folder = await lstat(path.join(workspace, "assets", "canvas")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!folder?.isDirectory()) return result;
  // Budget inspection also runs on arbitrary workspaces. Bound the manifest
  // read before parsing it, including files replaced during preparation.
  const root = await realpath(workspace);
  const data = await readSafeProjectFile(root, path.join(root, "canvas/assets.json"), 4 * 1024 * 1024).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!data) return result;
  const manifest = parseCanvasAssets(data.toString("utf8"));
  for (const asset of Object.values(manifest.assets)) {
    if (!asset.canvasOnly) continue;
    for (const file of [asset.path, asset.modelPreviewPath]) {
      if (file && isCanvasMediaPath(file)) result.add(file);
    }
  }
  return result;
}

export async function readCanvasAssets(workspace: string): Promise<CanvasAssetManifest> {
  return parseCanvasAssets(await readCanvasFile(workspace, "assets.json"));
}

function parseCanvasAssets(text?: string): CanvasAssetManifest {
  const manifest = text === undefined ? { version: 1 as const, assets: {} } : parseCanvasJson<CanvasAssetManifest>(text, "assets.json", CANVAS_ASSETS_SCHEMA);
  for (const asset of Object.values(manifest.assets)) if (asset.model3d?.generation) {
    try { normalizeGenerationProvenance(asset.model3d.generation); }
    catch { throw new CanvasError("canvas/assets.json: invalid or protected 3D generation metadata"); }
  }
  return { ...manifest, assets: Object.assign(Object.create(null), manifest.assets) };
}

export async function ensureCanvasAssets(project: ProjectState, projects: ProjectManager, library: AssetLibrary, ids: readonly string[], existingIds: readonly string[] = []): Promise<CanvasAssetManifest> {
  const manifest = await readCanvasAssets(project.workspacePath);
  let changed = false;
  for (const id of new Set(ids)) {
    if (manifest.assets[id]) continue;
    const asset = library.get(id);
    if (!asset) {
      // Keep existing broken references editable without accepting new unknown assets.
      if (existingIds.includes(id)) continue;
      throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
    }
    const generation = asset.generation ?? asset.model3d?.generation;
    const model3d = asset.model3d ? { ...asset.model3d, ...(generation ? { generation: normalizeGenerationProvenance(generation) } : {}) } : undefined;
    const file = await projects.materializeLibraryAsset(project.id, id, false, project.type !== "asset-canvas");
    manifest.assets[id] = { ...(isCanvasMediaPath(file.path) ? { canvasOnly: true } : {}), ...(model3d ? { model3d } : {}), name: asset.name, path: file.path, libraryAssetId: id, ...(file.modelPreviewPath ? { modelPreviewPath: file.modelPreviewPath } : {}), ...(file.modelRuntimePath ? { modelRuntimePath: file.modelRuntimePath } : {}), ...(asset.prompt ? { prompt: asset.prompt } : {}) };
    changed = true;
  }
  if (changed) await writeCanvasJson(project.workspacePath, "assets.json", manifest);
  return manifest;
}

export async function canvasAssetCatalog(workspace: string, manifest: CanvasAssetManifest, ids: readonly string[] = Object.keys(manifest.assets)): Promise<CanvasAssetCatalogEntry[]> {
  return Promise.all([...new Set(ids)].map(async (id) => {
    const asset = manifest.assets[id];
    if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
    try {
      return await resolveCanvasAsset(workspace, id, asset);
    } catch (cause) { throw new CanvasError(`canvas/assets.json /assets/${id}/path: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }));
}

export async function inspectCanvasAssets(workspace: string, manifest: CanvasAssetManifest): Promise<{ assets: CanvasAssetCatalogEntry[]; unavailableAssets: UnavailableCanvasAsset[] }> {
  const results = await Promise.all(Object.entries(manifest.assets).map(async ([id, asset]) => {
    try { return { asset: await resolveCanvasAsset(workspace, id, asset) }; }
    catch (cause) {
      const status = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
      return { issue: { ...asset, id, status, message: cause instanceof Error ? cause.message : String(cause) } satisfies UnavailableCanvasAsset };
    }
  }));
  return { assets: results.flatMap((result) => result.asset ? [result.asset] : []), unavailableAssets: results.flatMap((result) => result.issue ? [result.issue] : []) };
}

async function resolveCanvasAsset(workspace: string, id: string, asset: CanvasAsset): Promise<CanvasAssetCatalogEntry> {
  const file = await getWorkspaceMedia(workspace, asset.path), info = await stat(file.absolutePath);
  const dimensions = file.mediaType === "image" || file.mediaType === "video" ? await readMediaDimensions(file.absolutePath) : undefined;
  return { ...asset, id, contentType: file.contentType, mediaType: file.mediaType, size: info.size, createdAt: info.mtime.toISOString(), ...dimensions };
}

export async function canvasLibraryAsset(project: ProjectState, library: AssetLibrary, id: string): Promise<string> {
  const asset = (await readCanvasAssets(project.workspacePath)).assets[id];
  if (!asset) throw new CanvasError(`canvas/assets.json: asset ${id} is not registered`);
  const file = await getWorkspaceMedia(project.workspacePath, asset.path);
  const digest = await fileDigest(file.absolutePath);
  if (asset.model3d?.originalSha256 && asset.model3d.originalSha256 !== digest) throw new CanvasError("The FBX original does not match its retained model binding", 409);
  if (asset.libraryAssetId && library.get(asset.libraryAssetId)) {
    const original = await library.content(asset.libraryAssetId);
    if (await fileDigest(original.absolutePath) === digest) return asset.libraryAssetId;
    if (file.contentType === "application/vnd.autodesk.fbx") throw new CanvasError("The FBX original changed; do not reuse its old preview", 409);
  }
  const modelPreview = asset.modelPreviewPath ? await readSafeProjectFile(project.workspacePath, (await getWorkspaceMedia(project.workspacePath, asset.modelPreviewPath)).absolutePath) : undefined;
  if (modelPreview && asset.model3d?.preview?.sha256 && createHash("sha256").update(modelPreview).digest("hex") !== asset.model3d.preview.sha256) throw new CanvasError("The GLB preview failed its integrity check; rebuild locally", 409);
  return (await library.addFile(path.basename(asset.path), file.absolutePath, { expectedSha256: digest, origin: "workspace", prompt: asset.prompt, model3d: asset.model3d, ...(modelPreview ? { modelPreview } : {}), sourceKey: `canvas:${project.id}:${file.contentType}:${digest}:${asset.model3d?.preview?.sha256 ?? ""}` })).id;
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
