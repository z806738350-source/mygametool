import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CanvasAssetCatalogEntry, UnavailableCanvasAsset } from "../shared/canvas-assets.js";
import { getLibraryAsset, getWorkspaceAsset, getCanvasModelPreview, getNativeMediaUrl } from "./api.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

export interface LocalCanvasAsset { projectId: string; path: string; name: string; revision: number; error?: string }
export function canvasAssetSources(projectId: string, assets: readonly CanvasAssetCatalogEntry[], unavailable: readonly UnavailableCanvasAsset[] = []): ReadonlyMap<string, LocalCanvasAsset> {
  return new Map([
    ...assets.map((asset): [string, LocalCanvasAsset] => [asset.id, { projectId, path: asset.path, name: asset.name, revision: Date.parse(asset.createdAt) }]),
    ...unavailable.map((asset): [string, LocalCanvasAsset] => [asset.id, { projectId, path: asset.path, name: asset.name, revision: 0, error: asset.status === "missing" ? t("assets.fileMissing", { path: asset.path }) : t("assets.fileUnavailable", { path: asset.path }) }]),
  ]);
}
const CanvasAssets = createContext<{ byId: ReadonlyMap<string, LocalCanvasAsset>; byPath: ReadonlyMap<string, LocalCanvasAsset> }>({ byId: new Map(), byPath: new Map() });
export function useCanvasAssetSources(): ReadonlyMap<string, LocalCanvasAsset> {
  return useContext(CanvasAssets).byId;
}
export function CanvasAssetProvider({ assets, children }: { assets: ReadonlyMap<string, LocalCanvasAsset>; children: ReactNode }) {
  const value = useMemo(() => ({ byId: assets, byPath: new Map([...assets.values()].map((asset) => [JSON.stringify([asset.projectId, asset.path]), asset])) }), [assets]);
  return createElement(CanvasAssets.Provider, { value }, children);
}

export function useWorkspaceAssetUrl(
  projectId: string | undefined,
  filePath: string,
  revision = 0,
  libraryAssetId?: string,
): { url?: string; error?: string; loading: boolean; retry(): void } {
  const assets = useContext(CanvasAssets);
  const runtimeGeneration = useReadyRuntimeGeneration();
  const originalAssetId = libraryAssetId;
  const local = libraryAssetId ? assets.byId.get(libraryAssetId) : assets.byPath.get(JSON.stringify([projectId, filePath]));
  if (local) { projectId = local.projectId; filePath = local.path; revision = local.revision; libraryAssetId = undefined; }
  const resourceKey = JSON.stringify([projectId, filePath, revision, libraryAssetId, local?.error, runtimeGeneration]);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent).detail === originalAssetId) retry(); };
    window.addEventListener("ohmygame:model-preview-changed", changed);
    return () => window.removeEventListener("ohmygame:model-preview-changed", changed);
  }, [originalAssetId, retry]);
  const [state, setState] = useState<{ key?: string; url?: string; error?: string; loading: boolean }>({ loading: false });

  useEffect(() => {
    if (!projectId && !libraryAssetId) {
      setState({ key: resourceKey, loading: false });
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ key: resourceKey, loading: true, error: local?.error });
    const canvasModelPreview = local?.name.toLowerCase().endsWith(".fbx") && originalAssetId;
    void (async () => {
      const nativeEligible = /\.(?:mp4|webm|mov|m4a|mp3|wav|ogg|glb|fbx)$/i.test(local?.name ?? filePath);
      if (!canvasModelPreview && nativeEligible && window.ohMyGameDesktop?.nativeMedia === true) {
        const url = await getNativeMediaUrl(libraryAssetId ? { libraryAssetId } : { projectId: projectId!, filePath }, controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (url) { setState({ key: resourceKey, url, loading: false }); return; }
      }
      const blob = await (libraryAssetId ? getLibraryAsset(libraryAssetId, true, controller.signal) : canvasModelPreview ? getCanvasModelPreview(projectId!, originalAssetId!, controller.signal) : getWorkspaceAsset(projectId!, filePath, controller.signal));
      if (disposed || controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ key: resourceKey, url: objectUrl, loading: false });
    })().catch((cause) => {
      if (!disposed && !controller.signal.aborted) setState({ key: resourceKey, error: local?.error ?? errorMessage(cause), loading: false });
    });
    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, filePath, revision, libraryAssetId, originalAssetId, local?.name, local?.error, resourceKey, attempt, runtimeGeneration]);

  return { ...(state.key === resourceKey ? state : { error: local?.error, loading: !!(projectId || libraryAssetId) }), retry };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
