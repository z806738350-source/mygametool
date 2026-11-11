import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssetToolbar,
  fileName,
  fileStem,
  WorkspaceAssetCard,
  WorkspaceAssetDialog,
  type MediaFilter,
} from "./asset-browser.js";
import { deleteLibraryAsset, forceDeleteLibraryAsset, getLibraryAsset, listLibraryAssetReferences, renameLibraryAsset, saveLibraryAsset, type LibraryAssetReference } from "./api.js";
import { Circle, Image as ImageIcon, LoaderCircle, RefreshCw, X } from "./icons.js";
import { readCanvasDraftStatus } from "./canvas-draft-safety.js";
import { downloadLibraryAsset, filterLibraryAssets, loadLibraryAssets, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import { LibraryCollectionFilters } from "./library-filters.js";
import type { AppNavigationTarget } from "./routes.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { saveTrimmedVideo } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import { t, tNodes } from "./i18n.js";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
}

export function LibraryPage({ onNavigate }: LibraryPageProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [referenceCheck, setReferenceCheck] = useState(0);
  const [unusedResult, setUnusedResult] = useState<{ assets: LibraryAsset[]; check: number; ids: Set<string>; failed: number; error?: string }>();
  const [draftStatus, setDraftStatus] = useState(readCanvasDraftStatus);
  const loadRequest = useRef(0);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryAssetFilters>({ includeReferences: true });
  const [selectedAsset, setSelectedAsset] = useState<LibraryAsset>();
  const [deleteTarget, setDeleteTarget] = useState<{ asset: LibraryAsset; references: LibraryAssetReference[] }>();
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LibraryAsset>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkRunning = useRef(false);
  const [bulkStatus, setBulkStatus] = useState<string>();
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<{ assets: LibraryAsset[]; protected: { asset: LibraryAsset; references: LibraryAssetReference[] }[] }>();
  const bulkDeleteDialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!bulkDeleteTarget) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    bulkDeleteDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setBulkDeleteTarget(undefined); }
      if (event.key !== "Tab") return;
      const buttons = bulkDeleteDialog.current?.querySelectorAll<HTMLButtonElement>("button");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keyboard);
    return () => { window.removeEventListener("keydown", keyboard); previousFocus?.focus(); };
  }, [bulkDeleteTarget]);

  function startBulk(): boolean {
    if (bulkRunning.current) return false;
    bulkRunning.current = true;
    setBulkBusy(true);
    setActionError(undefined);
    setBulkStatus(undefined);
    return true;
  }

  function finishBulk(): void {
    bulkRunning.current = false;
    setBulkBusy(false);
  }

  async function load(): Promise<void> {
    const request = ++loadRequest.current;
    setUnusedResult(undefined);
    setDraftStatus(readCanvasDraftStatus());
    setPhase("loading");
    setError(undefined);
    try {
      const loaded = await loadLibraryAssets();
      if (request !== loadRequest.current) return;
      setAssets(loaded);
      setPhase("ready");
    } catch (cause) {
      if (request !== loadRequest.current) return;
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, [serviceGeneration]);

  useEffect(() => {
    const focus = () => { void load(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== null && !/^(canvas-board|canvas-documents|canvas-tables):/.test(event.key)) return;
      setDraftStatus(readCanvasDraftStatus());
      setUnusedResult(undefined);
      setReferenceCheck((check) => check + 1);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("storage", storage); };
  }, []);

  useEffect(() => {
    if (!unusedOnly || phase !== "ready" || draftStatus !== "clear") return;
    let cancelled = false, next = 0;
    const controller = new AbortController();
    const result = { assets, check: referenceCheck, ids: new Set<string>(), failed: 0, error: undefined as string | undefined };
    const inspect = async () => {
      while (!cancelled && next < assets.length) {
        const asset = assets[next++]!;
        try {
          const references = await checkedLibraryAssetReferences(asset.id, controller.signal);
          if (references.length === 0) result.ids.add(asset.id);
        } catch (cause) {
          result.failed++;
          result.error ??= errorMessage(cause);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, assets.length) }, inspect)).then(() => {
      if (cancelled) return;
      const drafts = readCanvasDraftStatus();
      setDraftStatus(drafts);
      if (drafts === "clear") setUnusedResult(result);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [unusedOnly, assets, phase, draftStatus, referenceCheck]);

  function assertNoCanvasDrafts(): void {
    const drafts = readCanvasDraftStatus();
    setDraftStatus(drafts);
    if (drafts === "clear") return;
    setUnusedResult(undefined);
    throw new Error(t(`library.unreferenced.${drafts}`));
  }

  async function runAssetAction(action: () => Promise<unknown>): Promise<boolean> {
    setActionError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (cause) {
      setActionError(errorMessage(cause));
      return false;
    }
  }

  function beginRename(asset: LibraryAsset): void {
    setActionError(undefined);
    setSelectedAsset(undefined);
    setRenameTarget(asset);
  }

  async function save(asset: LibraryAsset): Promise<void> {
    if (await runAssetAction(() => saveLibraryAsset(asset.id))) setSelectedAsset(undefined);
  }

  async function remove(asset: LibraryAsset): Promise<void> {
    setActionError(undefined);
    try {
      assertNoCanvasDrafts();
      const references = await checkedLibraryAssetReferences(asset.id);
      assertNoCanvasDrafts();
      if (references.length) {
        setSelectedAsset(undefined);
        setDeleteTarget({ asset, references });
        return;
      }
      if (!window.confirm(t("library.confirmDelete", { name: fileName(asset.path) }))) return;
      if (await runAssetAction(() => { assertNoCanvasDrafts(); return deleteLibraryAsset(asset.id); })) setSelectedAsset(undefined);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  async function confirmForceDelete(): Promise<void> {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const deleted = await runAssetAction(() => { assertNoCanvasDrafts(); return forceDeleteLibraryAsset(deleteTarget.asset.id); });
    setDeleting(false);
    if (deleted) {
      setDeleteTarget(undefined);
      setSelectedAsset(undefined);
    }
  }

  async function runBulk(action: "download" | "save" | "delete", targets: LibraryAsset[]): Promise<void> {
    if (action === "delete") {
      try { assertNoCanvasDrafts(); } catch (cause) { setActionError(errorMessage(cause)); return; }
    }
    if (!targets.length || !startBulk()) return;
    const succeeded = new Set<string>(), failures: string[] = [];
    try {
      for (const asset of targets) {
        if (action === "delete") {
          try { assertNoCanvasDrafts(); } catch (cause) { failures.push(errorMessage(cause)); break; }
        }
        try {
          if (action === "download") await downloadLibraryAsset(asset.id, asset.name);
          else if (action === "save") await saveLibraryAsset(asset.id);
          else await deleteLibraryAsset(asset.id);
          succeeded.add(asset.id);
        } catch (cause) { failures.push(`${fileName(asset.path)}: ${errorMessage(cause)}`); }
      }
      if (action !== "download") {
        setSelectedIds((ids) => ids.filter((id) => !succeeded.has(id)));
        await load();
      }
      setBulkStatus(t(`library.bulk.${action}Result`, { count: succeeded.size, total: targets.length }));
      if (failures.length) setActionError(failures.join("\n"));
    } finally {
      finishBulk();
    }
  }

  async function beginBulkDelete(targets: LibraryAsset[]): Promise<void> {
    try { assertNoCanvasDrafts(); } catch (cause) { setActionError(errorMessage(cause)); return; }
    if (!targets.length || !startBulk()) return;
    try {
      const target: NonNullable<typeof bulkDeleteTarget> = { assets: [], protected: [] };
      for (const asset of targets) {
        const references = await checkedLibraryAssetReferences(asset.id);
        assertNoCanvasDrafts();
        if (references.length) target.protected.push({ asset, references });
        else target.assets.push(asset);
      }
      setBulkDeleteTarget(target);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      finishBulk();
    }
  }

  /** Saves the kept part of a video as a new Library asset and shows it. */
  async function saveTrimmed(asset: LibraryAsset, video: Blob, trim: VideoTrim): Promise<void> {
    const saved = await saveTrimmedVideo(video, trim, { name: asset.name, libraryAssetId: asset.id });
    await load();
    setSelectedAsset({ ...saved, assetId: saved.id, path: saved.name });
  }

  const checkedUnused = unusedResult?.assets === assets && unusedResult.check === referenceCheck && phase === "ready" && draftStatus === "clear" ? unusedResult : undefined;
  const visibleAssets = useMemo(() => filterLibraryAssets(assets, mediaFilter, query, filters).filter((asset) => !unusedOnly || checkedUnused?.ids.has(asset.id)), [assets, mediaFilter, query, filters, unusedOnly, checkedUnused]);
  const selectedAssets = visibleAssets.filter((asset) => selectedIds.includes(asset.id));
  const unsavedSelected = selectedAssets.filter((asset) => asset.saved === false || asset.referenceOnly);
  useEffect(() => {
    const visible = new Set(visibleAssets.map((asset) => asset.id));
    setSelectedIds((ids) => ids.every((id) => visible.has(id)) ? ids : ids.filter((id) => visible.has(id)));
  }, [visibleAssets]);

  return (
    <SidebarPageLayout active="library" onNavigate={onNavigate}>
      <SidebarPageHeader title={t("library.title")}>
        <AssetToolbar mediaFilter={unusedOnly ? undefined : mediaFilter} query={query} onMediaFilterChange={(filter) => { setUnusedOnly(false); setUnusedResult(undefined); setMediaFilter(filter); }} onQueryChange={setQuery} extraFilters={<button className={unusedOnly ? "is-active" : undefined} type="button" aria-pressed={unusedOnly} onClick={() => { setMediaFilter("all"); setUnusedResult(undefined); setDraftStatus(readCanvasDraftStatus()); setReferenceCheck((check) => check + 1); setUnusedOnly(true); }}><Circle size={15} /><span>{t("library.unreferenced.title")}</span></button>}>
          <LibraryCollectionFilters assets={assets} filters={filters} onChange={setFilters} defaultIncludeReferences />
          <button type="button" className="library-filter-trigger" aria-label={t("library.unreferenced.refresh")} title={t("library.unreferenced.refresh")} disabled={bulkBusy || phase === "loading"} onClick={() => void load()}><RefreshCw size={15} /></button>
        </AssetToolbar>
      </SidebarPageHeader>
      {unusedOnly && phase === "ready" ? <div className="library-reference-status" role="status">
        <span>{t("library.unreferenced.description")}</span>
        {draftStatus !== "clear" ? <span>{t(`library.unreferenced.${draftStatus}`)}</span> : !checkedUnused ? <span><LoaderCircle className="spin" size={15} />{t("library.unreferenced.checking")}</span> : checkedUnused.failed ? <span>{t("library.unreferenced.failed", { count: checkedUnused.failed })} {checkedUnused.error}</span> : null}
        {draftStatus !== "clear" || checkedUnused?.failed ? <button type="button" onClick={() => void load()}><RefreshCw size={14} />{t("common.retry")}</button> : null}
      </div> : null}
      {visibleAssets.length ? <div className="library-bulk-toolbar" aria-label={t("library.bulk.actions")}>
        <button type="button" disabled={bulkBusy || phase !== "ready"} onClick={() => setSelectedIds(selectedAssets.length === visibleAssets.length ? [] : visibleAssets.map((asset) => asset.id))}>{t(selectedAssets.length === visibleAssets.length ? "library.bulk.deselectAll" : "library.bulk.selectAll")}</button>
        <span>{t("library.bulk.selected", { count: selectedAssets.length, total: visibleAssets.length })}</span>
        {selectedAssets.length ? <>
          <button type="button" disabled={bulkBusy} onClick={() => setSelectedIds([])}>{t("library.bulk.clear")}</button>
          <div className="library-bulk-actions">
            <button type="button" disabled={bulkBusy || phase !== "ready"} onClick={() => void runBulk("download", selectedAssets)}>{t("library.bulk.download")}</button>
            {unsavedSelected.length ? <button type="button" disabled={bulkBusy || phase !== "ready"} onClick={() => void runBulk("save", unsavedSelected)}>{t("library.bulk.save")}</button> : null}
            <button className="library-action-delete" type="button" disabled={bulkBusy || phase !== "ready"} onClick={() => void beginBulkDelete(selectedAssets)}>{t("library.bulk.delete")}</button>
          </div>
        </> : null}
        {bulkBusy ? <LoaderCircle className="spin" size={15} aria-label={t("library.bulk.working")} /> : null}
      </div> : null}
      {bulkStatus ? <p className="library-bulk-status" role="status">{bulkStatus}</p> : null}
      {actionError ? <p className="library-action-error" role="alert">{actionError}</p> : null}
      {phase === "loading" && assets.length === 0 ? <LibraryState><LoaderCircle className="spin" size={18} />{t("library.loading")}</LibraryState> : null}
      {phase === "error" ? <LibraryState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />{t("common.retry")}</button></LibraryState> : null}
      {phase === "ready" && visibleAssets.length === 0 && (!unusedOnly || checkedUnused) ? <LibraryState><ImageIcon size={18} />{unusedOnly ? t("library.unreferenced.none") : assets.length ? t("library.noMatch") : t("library.none")}</LibraryState> : null}
      {visibleAssets.length ? <div className="library-grid">{visibleAssets.map((asset) => <WorkspaceAssetCard
        asset={asset}
        key={asset.id}
        title={fileName(asset.path)}
        onOpen={() => setSelectedAsset(asset)}
        selection={{ checked: selectedIds.includes(asset.id), disabled: bulkBusy || phase !== "ready", onChange: () => setSelectedIds((ids) => ids.includes(asset.id) ? ids.filter((id) => id !== asset.id) : [...ids, asset.id]) }}
        onRename={!bulkBusy ? () => beginRename(asset) : undefined}
        onDelete={!bulkBusy ? () => void remove(asset) : undefined}
        onSaveToLibrary={!bulkBusy && (asset.saved === false || asset.referenceOnly) ? () => void save(asset) : undefined}
      />)}</div> : null}
      {selectedAsset ? <WorkspaceAssetDialog
        asset={selectedAsset}
        onClose={() => setSelectedAsset(undefined)}
        onRename={!bulkBusy ? () => beginRename(selectedAsset) : undefined}
        onDelete={!bulkBusy ? () => void remove(selectedAsset) : undefined}
        onSaveToLibrary={!bulkBusy && (selectedAsset.saved === false || selectedAsset.referenceOnly) ? () => void save(selectedAsset) : undefined}
        trimmer={{ loadSource: (signal, contentSha256) => contentSha256 ? getLibraryAsset(selectedAsset.id, false, signal, contentSha256) : getLibraryAsset(selectedAsset.id, false, signal), onSave: (video, trim) => saveTrimmed(selectedAsset, video, trim) }}
        {...(selectedAsset.derivedFrom ? { trimmedFrom: assets.find((candidate) => candidate.id === selectedAsset.derivedFrom!.assetId)?.name ?? selectedAsset.derivedFrom.assetId } : {})}
      /> : null}
      {bulkDeleteTarget ? <div className="library-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBulkDeleteTarget(undefined); }}>
        <section ref={bulkDeleteDialog} className="library-delete-dialog library-bulk-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="library-bulk-delete-title">
          <h2 id="library-bulk-delete-title">{t("library.bulk.deleteTitle", { count: bulkDeleteTarget.assets.length })}</h2>
          {bulkDeleteTarget.assets.length ? <><p className="library-delete-warning">{t("library.bulk.deleteWarning")}</p><ul>{bulkDeleteTarget.assets.map((asset) => <li key={asset.id}>{fileName(asset.path)}</li>)}</ul></> : null}
          {bulkDeleteTarget.protected.length ? <><p>{t("library.bulk.protected", { count: bulkDeleteTarget.protected.length })}</p><ul>{bulkDeleteTarget.protected.map(({ asset, references }) => <li key={asset.id}>{fileName(asset.path)} · {references.map((reference) => reference.name).join(", ")}</li>)}</ul></> : null}
          <footer><button type="button" autoFocus onClick={() => setBulkDeleteTarget(undefined)}>{t("common.cancel")}</button>{bulkDeleteTarget.assets.length ? <button className="library-action-delete" type="button" onClick={() => { const targets = bulkDeleteTarget.assets; setBulkDeleteTarget(undefined); void runBulk("delete", targets); }}>{t("library.bulk.confirmDelete", { count: bulkDeleteTarget.assets.length })}</button> : null}</footer>
        </section>
      </div> : null}
      {deleteTarget ? <div className="library-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(undefined); }}>
        <section className="library-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="library-delete-title" onKeyDown={(event) => { if (event.key === "Escape" && !deleting) setDeleteTarget(undefined); }}>
          <h2 id="library-delete-title">{t("library.deleteEverywhereTitle")}</h2>
          <p>{tNodes(deleteTarget.references.length === 1 ? "library.usedByProject" : "library.usedByProjects", { name: <strong>{fileName(deleteTarget.asset.path)}</strong>, count: deleteTarget.references.length })}</p>
          <p className="library-delete-warning">{t("library.deleteWarning")}</p>
          <ul>{deleteTarget.references.map((reference) => <li key={reference.id}>{reference.name}</li>)}</ul>
          {actionError ? <p className="library-delete-error" role="alert">{actionError}</p> : null}
          <footer><button type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(undefined)}>{t("common.cancel")}</button><button className="library-action-delete" type="button" disabled={deleting} onClick={() => void confirmForceDelete()}>{deleting ? t("library.deletingEllipsis") : t("library.deleteEverywhere")}</button></footer>
        </section>
      </div> : null}
      {renameTarget ? <ProjectRenameDialog title={t("library.rename")} name={fileStem(renameTarget.path)} returnFocus={null} onClose={() => setRenameTarget(undefined)} onConfirm={(input) => {
        const asset = renameTarget;
        setRenameTarget(undefined);
        const name = input.trim();
        if (name && name !== fileStem(asset.path)) void runAssetAction(() => renameLibraryAsset(asset.id, name));
      }} /> : null}
    </SidebarPageLayout>
  );
}

export { filterLibraryAssets } from "./library-assets.js";

function LibraryState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`library-state${error ? " library-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkedLibraryAssetReferences(id: string, signal?: AbortSignal): Promise<LibraryAssetReference[]> {
  const references = await (signal ? listLibraryAssetReferences(id, signal) : listLibraryAssetReferences(id));
  if (!Array.isArray(references)) throw new Error(t("library.unreferenced.invalidResponse"));
  return references;
}
