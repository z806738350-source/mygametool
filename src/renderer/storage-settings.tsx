import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  STORAGE_CATEGORIES,
  type StorageCleanupItem,
  type StorageCleanupPlan,
  type StorageCleanupReason,
  type StorageCleanupResult,
  type StorageCleanupScan,
} from "../shared/desktop-storage.js";
import {
  executeStorageCleanup,
  getStorageCleanupResult,
  planStorageCleanup,
  scanStorageCleanup,
  storageCleanupAvailable,
} from "./api.js";
import { readCanvasDraftStatus } from "./canvas-draft-safety.js";
import { LoaderCircle, RefreshCw, Trash2 } from "./icons.js";
import { t } from "./i18n.js";

// Keep the receipt discoverable when users switch settings while IPC is finishing.
let lastUnconfirmedPlanId: string | undefined;
let lastReceipt: StorageCleanupResult | undefined;
let lastRejectedPlan: { id: string; message: string } | undefined;
type Operation = "scan" | "plan" | "execute" | "result";

export function StorageSettingsPanel() {
  const available = storageCleanupAvailable();
  const [scan, setScan] = useState<StorageCleanupScan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<StorageCleanupPlan>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState(lastReceipt);
  const [pendingPlanId, setPendingPlanId] = useState(lastUnconfirmedPlanId);
  const [draftStatus, setDraftStatus] = useState(readCanvasDraftStatus);
  const [busy, setBusy] = useState<Operation>();
  const running = useRef<Operation>(undefined);
  const [error, setError] = useState<string>();

  function begin(operation: Operation): boolean {
    if (running.current) return false;
    running.current = operation;
    setBusy(operation);
    setError(undefined);
    return true;
  }
  function finish(): void {
    running.current = undefined;
    setBusy(undefined);
  }
  function invalidatePlan(): void {
    setPlan(undefined);
    setAcknowledged(false);
  }
  function checkDrafts(): void {
    const status = readCanvasDraftStatus();
    setDraftStatus(status);
    if (status !== "clear") throw new Error(t(`storage.drafts.${status}`));
  }

  async function refresh(): Promise<void> {
    if (!available || !begin("scan")) return;
    invalidatePlan();
    setSelected([]);
    setScan(undefined);
    setDraftStatus(readCanvasDraftStatus());
    try {
      setScan(await scanStorageCleanup());
    } catch (cause) {
      setError(cleanupError(cause));
    } finally {
      finish();
    }
  }

  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const changed = () => {
      setDraftStatus(readCanvasDraftStatus());
      if (running.current !== "execute") invalidatePlan();
    };
    const storage = (event: StorageEvent) => {
      if (
        event.key === null ||
        /^(canvas-board|canvas-documents|canvas-tables):/.test(event.key)
      )
        changed();
    };
    window.addEventListener("focus", changed);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("focus", changed);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    if (!plan || busy === "execute") return;
    const timer = window.setTimeout(
      () => {
        invalidatePlan();
        setError(t("storage.reasons.expired"));
      },
      Math.max(0, Date.parse(plan.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [plan, busy]);

  async function reviewSelection(): Promise<void> {
    if (!scan || !selected.length || !begin("plan")) return;
    invalidatePlan();
    try {
      checkDrafts();
      const next = await planStorageCleanup({
        scanId: scan.scanId,
        itemIds: selected,
      });
      checkDrafts();
      if (
        next.permanent !== true ||
        !next.entries.length ||
        next.entries.some((entry) => !selected.includes(entry.itemId))
      )
        throw new Error("invalid");
      setPlan(next);
    } catch (cause) {
      setError(cleanupError(cause));
    } finally {
      finish();
    }
  }

  async function showReceipt(receipt: StorageCleanupResult): Promise<void> {
    lastReceipt = receipt;
    lastUnconfirmedPlanId = undefined;
    setResult(receipt);
    setPendingPlanId(undefined);
    invalidatePlan();
    setSelected([]);
    setScan(undefined);
    try {
      setScan(await scanStorageCleanup());
    } catch (cause) {
      setError(cleanupError(cause));
    }
  }

  async function removePermanently(): Promise<void> {
    if (!plan || !acknowledged || !begin("execute")) return;
    const confirmed = plan;
    try {
      checkDrafts();
      if (Date.parse(confirmed.expiresAt) <= Date.now())
        throw new Error("expired");
      lastUnconfirmedPlanId = confirmed.planId;
      lastRejectedPlan = undefined;
      setPendingPlanId(confirmed.planId);
      let receipt: StorageCleanupResult;
      try {
        receipt = await executeStorageCleanup({
          planId: confirmed.planId,
          confirmationToken: confirmed.confirmationToken,
          confirmation: "PERMANENT_DELETE",
        });
      } catch (cause) {
        const completed = await getStorageCleanupResult(confirmed.planId).catch(
          () => undefined,
        );
        if (!completed) {
          invalidatePlan();
          if (errorReason(cause)) {
            lastRejectedPlan = {
              id: confirmed.planId,
              message: cleanupError(cause),
            };
            lastUnconfirmedPlanId = undefined;
            setPendingPlanId(undefined);
            setError(cleanupError(cause));
          } else
            setError(
              `${t("storage.resultUnconfirmed")} ${cleanupError(cause)}`,
            );
          return;
        }
        receipt = completed;
      }
      await showReceipt(receipt);
    } catch (cause) {
      invalidatePlan();
      setError(cleanupError(cause));
    } finally {
      finish();
    }
  }

  async function checkResult(): Promise<void> {
    if (!pendingPlanId || !begin("result")) return;
    try {
      if (lastRejectedPlan?.id === pendingPlanId) {
        setPendingPlanId(undefined);
        setError(lastRejectedPlan.message);
        return;
      }
      const receipt = await getStorageCleanupResult(pendingPlanId);
      if (receipt) await showReceipt(receipt);
      else setError(t("storage.resultUnconfirmed"));
    } catch (cause) {
      setError(cleanupError(cause));
    } finally {
      finish();
    }
  }

  const eligible = scan?.supported ? scan.items.filter(selectable) : [];
  const selectedItems = eligible.filter((item) => selected.includes(item.id));
  const selectedBytes = selectedItems.reduce(
    (sum, item) => sum + item.allocatedBytes,
    0,
  );
  const eligibleBytes = eligible.reduce(
    (sum, item) => sum + item.allocatedBytes,
    0,
  );
  const draftMessage =
    draftStatus === "clear" ? undefined : t(`storage.drafts.${draftStatus}`);
  const toggle = (ids: string[]) => {
    invalidatePlan();
    setSelected((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  };

  return (
    <section className="settings-panel settings-overview-panel settings-storage-panel">
      <header className="settings-panel-header">
        <h3>{t("settings.nav.storage")}</h3>
        <button
          className="settings-secondary-button"
          type="button"
          disabled={!available || Boolean(busy)}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          {t("storage.refresh")}
        </button>
      </header>
      <p className="settings-detail-hint">{t("storage.description")}</p>
      {!available ? (
        <p className="settings-detail-hint" role="status">
          {t("storage.unsupported")}
        </p>
      ) : null}
      {busy ? (
        <p className="settings-storage-status" role="status">
          <LoaderCircle size={15} className="spin" />
          {t(`storage.working.${busy}`)}
        </p>
      ) : null}
      {draftMessage ? (
        <p className="settings-storage-warning" role="status">
          {draftMessage}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {pendingPlanId ? (
        <div className="settings-storage-pending">
          <p>{t("storage.pendingResult")}</p>
          <button
            className="settings-secondary-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void checkResult()}
          >
            {t("storage.checkResult")}
          </button>
        </div>
      ) : null}
      {scan && !scan.supported ? (
        <p className="settings-storage-warning">
          {reasonLabel(scan.reason ?? "unsupported")}
        </p>
      ) : null}
      {scan?.supported ? (
        <>
          {scan.measurementComplete === false ? (
            <p className="settings-storage-warning">
              {t("storage.incomplete")}
            </p>
          ) : null}
          <div className="settings-storage-summary">
            <StorageSummary
              label={t(
                scan.measurementComplete === false
                  ? "storage.measuredPartial"
                  : "storage.measured",
              )}
              bytes={scan.allocatedBytes}
            />
            <StorageSummary
              label={t("storage.eligible")}
              bytes={eligibleBytes}
            />
            <StorageSummary
              label={t("storage.kept")}
              bytes={Math.max(0, scan.allocatedBytes - eligibleBytes)}
            />
          </div>
          <p className="settings-detail-hint">
            {t("storage.sizeHint")} {t("storage.pathsRelative")}
            {"rootPath" in scan && typeof scan.rootPath === "string" ? (
              <code className="settings-storage-root">{scan.rootPath}</code>
            ) : null}
          </p>
          <div className="settings-storage-selection">
            <button
              className="settings-secondary-button"
              type="button"
              disabled={!eligible.length || Boolean(busy)}
              onClick={() => toggle(eligible.map((item) => item.id))}
            >
              {t(
                eligible.length && selectedItems.length === eligible.length
                  ? "storage.deselectAll"
                  : "storage.selectAll",
              )}
            </button>
            <span>
              {t("storage.selected", {
                count: selectedItems.length,
                size: storageBytes(selectedBytes),
              })}
            </span>
          </div>
          <div className="settings-storage-categories">
            {STORAGE_CATEGORIES.map((category) => {
              const items = scan.items.filter(
                (item) => item.category === category,
              );
              if (!items.length) return null;
              const candidates = items.filter(selectable);
              const ids = candidates.map((item) => item.id);
              return (
                <details
                  className="settings-storage-category"
                  key={category}
                  open={candidates.length > 0}
                >
                  <summary>
                    <span>{t(`storage.categories.${category}`)}</span>
                    <strong>
                      {items.some((item) => item.measurementComplete === false)
                        ? t("storage.partialSize", {
                            size: storageBytes(
                              items.reduce(
                                (sum, item) => sum + item.allocatedBytes,
                                0,
                              ),
                            ),
                          })
                        : storageBytes(
                            items.reduce(
                              (sum, item) => sum + item.allocatedBytes,
                              0,
                            ),
                          )}
                    </strong>
                    <small>
                      {t("storage.itemCount", { count: items.length })}
                    </small>
                  </summary>
                  {candidates.length ? (
                    <button
                      type="button"
                      className="settings-storage-category-select"
                      disabled={Boolean(busy)}
                      onClick={() => toggle(ids)}
                    >
                      {t(
                        ids.every((id) => selected.includes(id))
                          ? "storage.deselectCategory"
                          : "storage.selectCategory",
                      )}
                    </button>
                  ) : null}
                  <ul
                    className="settings-storage-items"
                    tabIndex={0}
                    aria-label={t(`storage.categories.${category}`)}
                  >
                    {items.map((item) => (
                      <li key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selected.includes(item.id)}
                            disabled={Boolean(busy) || !selectable(item)}
                            aria-label={t("storage.selectItem", {
                              path: item.relativePath,
                            })}
                            onChange={() => toggle([item.id])}
                          />
                          <span>
                            <code>{item.relativePath}</code>
                            <small>
                              {!selectable(item)
                                ? reasonLabel(
                                    item.reason ??
                                      (item.measurementComplete === false
                                        ? "unknown"
                                        : "protected"),
                                  )
                                : t(`storage.impacts.${item.impact}`)}{" "}
                              ·{" "}
                              {t(
                                item.measurementComplete === false
                                  ? "storage.partialFileCount"
                                  : "storage.fileCount",
                                {
                                  count: item.fileCount,
                                },
                              )}
                            </small>
                          </span>
                        </label>
                        <StorageSize
                          bytes={item.allocatedBytes}
                          logical={item.logicalBytes}
                          complete={item.measurementComplete}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
          {scan.errors.length ? (
            <div className="settings-storage-warning">
              <p>{t("storage.scanErrors")}</p>
              <ul>
                {scan.errors.map((issue, index) => (
                  <li key={`${issue.relativePath}:${index}`}>
                    <code>{issue.relativePath}</code> ·{" "}
                    {reasonLabel(issue.reason)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="settings-form-actions">
            <button
              className="settings-danger-button"
              type="button"
              disabled={
                Boolean(busy) ||
                !selectedItems.length ||
                Boolean(draftMessage) ||
                Boolean(pendingPlanId)
              }
              onClick={() => void reviewSelection()}
            >
              <Trash2 size={14} />
              {t("storage.review")}
            </button>
          </div>
        </>
      ) : null}
      {result ? <StorageResult result={result} /> : null}
      {plan && scan ? (
        <CleanupConfirmation
          plan={plan}
          items={scan.items}
          rootPath={
            "rootPath" in scan && typeof scan.rootPath === "string"
              ? scan.rootPath
              : undefined
          }
          busy={busy === "execute"}
          checked={acknowledged}
          onChecked={setAcknowledged}
          onClose={invalidatePlan}
          onConfirm={() => void removePermanently()}
          draftMessage={draftMessage}
        />
      ) : null}
    </section>
  );
}

function StorageSummary({ label, bytes }: { label: string; bytes: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong title={exactBytes(bytes)}>{storageBytes(bytes)}</strong>
    </div>
  );
}
function StorageSize({
  bytes,
  logical,
  complete = true,
}: {
  bytes: number;
  logical: number;
  complete?: boolean;
}) {
  return (
    <span className="settings-storage-size" title={exactBytes(bytes)}>
      {complete
        ? storageBytes(bytes)
        : t("storage.partialSize", { size: storageBytes(bytes) })}
      <small>{t("storage.logicalSize", { size: storageBytes(logical) })}</small>
    </span>
  );
}
function StorageResult({ result }: { result: StorageCleanupResult }) {
  const deleted = result.entries.filter(
    (entry) => entry.status === "deleted",
  ).length;
  return (
    <section
      className="settings-storage-result"
      aria-label={t("storage.results")}
    >
      <h4>{t("storage.results")}</h4>
      <time className="settings-detail-hint" dateTime={result.completedAt}>
        {t("storage.completedAt", {
          time: new Date(result.completedAt).toLocaleString(),
        })}
      </time>
      <p role="status">
        {t("storage.completed", {
          count: deleted,
          total: result.entries.length,
          size: storageBytes(result.deletedAllocatedBytes),
        })}
      </p>
      <p className="settings-detail-hint">
        {t("storage.logicalSize", {
          size: storageBytes(result.deletedLogicalBytes),
        })}{" "}
        · {exactBytes(result.deletedAllocatedBytes)} ·{" "}
        {t("storage.resultSizeHint")}
      </p>
      <ul
        className="settings-storage-receipt"
        tabIndex={0}
        aria-label={t("storage.results")}
      >
        {result.entries.map((entry) => (
          <li key={entry.id}>
            <code>{entry.relativePath}</code>
            <span>
              {t(`storage.status.${entry.status}`)}
              {entry.reason ? ` · ${reasonLabel(entry.reason)}` : ""}
            </span>
            <StorageSize
              bytes={entry.allocatedBytes}
              logical={entry.logicalBytes}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CleanupConfirmation({
  plan,
  items,
  rootPath,
  busy,
  checked,
  onChecked,
  onClose,
  onConfirm,
  draftMessage,
}: {
  plan: StorageCleanupPlan;
  items: StorageCleanupItem[];
  rootPath?: string;
  busy: boolean;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
  draftMessage?: string;
}) {
  const dialog = useRef<HTMLElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    cancel.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      const first = controls?.[0],
        last = controls?.[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.current?.focus();
      } else if (
        !dialog.current?.contains(document.activeElement) ||
        document.activeElement === dialog.current ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [busy, onClose]);
  return createPortal(
    <div
      className="settings-storage-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="settings-storage-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="storage-cleanup-title"
        aria-describedby="storage-cleanup-warning"
        tabIndex={-1}
      >
        <h3 id="storage-cleanup-title">
          {t("storage.confirmTitle", { count: plan.entries.length })}
        </h3>
        <p id="storage-cleanup-warning" className="settings-storage-warning">
          {t("storage.permanentWarning")}
        </p>
        <p>
          {t("storage.planSize", {
            size: storageBytes(plan.allocatedBytes),
            bytes: exactBytes(plan.allocatedBytes),
          })}
        </p>
        <p className="settings-detail-hint">
          {t("storage.logicalSize", { size: storageBytes(plan.logicalBytes) })}{" "}
          ·{" "}
          {t("storage.expires", {
            time: new Date(plan.expiresAt).toLocaleTimeString(),
          })}
        </p>
        <p className="settings-detail-hint">
          {t("storage.pathsRelative")}
          {rootPath ? (
            <code className="settings-storage-root">{rootPath}</code>
          ) : null}
        </p>
        <ul
          className="settings-storage-plan"
          tabIndex={0}
          aria-label={t("storage.exactList")}
        >
          {plan.entries.map((entry) => (
            <li key={entry.id}>
              <span>
                <code>{entry.relativePath}</code>
                <small>
                  {t(
                    `storage.impacts.${items.find((item) => item.id === entry.itemId)?.impact ?? "preserved"}`,
                  )}
                </small>
              </span>
              <StorageSize
                bytes={entry.allocatedBytes}
                logical={entry.logicalBytes}
              />
            </li>
          ))}
        </ul>
        <label className="settings-checkbox-row settings-storage-acknowledgement">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy}
            onChange={(event) => onChecked(event.target.checked)}
          />
          <span>{t("storage.acknowledge")}</span>
        </label>
        {draftMessage ? (
          <p className="settings-storage-warning" role="alert">
            {draftMessage}
          </p>
        ) : null}
        <footer>
          <button
            ref={cancel}
            className="settings-secondary-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="settings-danger-button"
            type="button"
            disabled={busy || !checked || Boolean(draftMessage)}
            onClick={onConfirm}
          >
            {busy
              ? t("storage.working.execute")
              : t("storage.confirmDelete", { count: plan.entries.length })}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function storageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}
function exactBytes(bytes: number): string {
  return t("storage.exactBytes", { bytes: bytes.toLocaleString() });
}
function reasonLabel(reason: StorageCleanupReason): string {
  return t(`storage.reasons.${reason}`);
}
function selectable(item: StorageCleanupItem): boolean {
  return item.state === "eligible" && item.measurementComplete !== false;
}
function cleanupError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason = errorReason(cause);
  return reason ? reasonLabel(reason) : message;
}
function errorReason(cause: unknown): StorageCleanupReason | undefined {
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason =
    /(?:^|:\s)(unsupported|protected|running|unknown|changed|in-use|permission|linked|tracked|unverified|limit|expired|busy|invalid|failed)$/.exec(
      message,
    )?.[1] as StorageCleanupReason | undefined;
  return reason;
}
