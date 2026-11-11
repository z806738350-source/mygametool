import { useState } from "react";
import { rebuildModelPreview, rebuildProjectModelPreview } from "./api.js";
import { useCanvasAssetSources } from "./use-workspace-asset-url.js";
import { t } from "./i18n.js";

export const MODEL_PREVIEW_CHANGED = "ohmygame:model-preview-changed";

/** Downloads keep the source and the triangulated copy visibly distinct. All rebuilds are local. */
export function FbxAssetActions({ assetId, name, projectId, failed = false, onRebuilt }: {
  assetId?: string; name?: string; projectId?: string; path?: string; previewPath?: string; failed?: boolean; onRebuilt?: () => void;
}) {
  const local = useCanvasAssetSources().get(assetId ?? ""), fileName = local?.name ?? name ?? "";
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  if (!failed || !assetId || !fileName.toLowerCase().endsWith(".fbx")) return null;
  const perform = async () => {
    if (busy) return; setBusy(true); setError(false);
    try {
        if (projectId && !local) await rebuildProjectModelPreview(projectId, assetId);
        else await rebuildModelPreview(assetId, local?.projectId);
        window.dispatchEvent(new CustomEvent(MODEL_PREVIEW_CHANGED, { detail: assetId }));
        onRebuilt?.();
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <div className="nodrag nopan nokey">
    <div className="library-dialog-footer-actions">
      <button type="button" disabled={busy} onClick={() => void perform()}>{t(busy ? "kunpoModels.previewRebuilding" : "kunpoModels.rebuildPreview")}</button>
    </div>
    {error ? <p role="alert">{t("kunpoModels.previewFailed")}</p> : null}
  </div>;
}
