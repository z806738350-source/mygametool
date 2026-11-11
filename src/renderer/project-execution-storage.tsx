import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import {
  getProjectExecutionStorage,
  openProjectExecutionStorage,
  recoverProjectExecutionStorage,
  ApiError,
  type ProjectExecutionStorage,
} from "./api.js";
import { assertProjectCanvasDraftsSaved } from "./project-deletion.js";
import { LoaderCircle, X } from "./icons.js";
import { t } from "./i18n.js";

// A lost response must be resolved by state inspection, never by an automatic second write.
const uncertainRecoveries = new Map<string, string>();
const states = new Set([
  "absent",
  "resident",
  "archived",
  "recovery-pending",
  "busy",
  "unavailable",
]);

function checkedState(
  value: ProjectExecutionStorage,
  projectId: string,
): ProjectExecutionStorage {
  if (
    !value ||
    value.projectId !== projectId ||
    !states.has(value.state) ||
    typeof value.supported !== "boolean" ||
    typeof value.dirty !== "boolean" ||
    typeof value.recoverable !== "boolean" ||
    (value.generation !== undefined &&
      (typeof value.generation !== "string" ||
        !/^[0-9]{1,32}$/.test(value.generation))) ||
    (value.reason !== undefined && typeof value.reason !== "string")
    || (value.approvedReviewId !== undefined && !/^[a-f0-9]{64}$/.test(value.approvedReviewId))
  )
    throw new Error(t("projects.executionStorage.invalid"));
  return value;
}

function recoverable(
  value: ProjectExecutionStorage | undefined,
): value is ProjectExecutionStorage & { generation: string } {
  return Boolean(
    value?.supported &&
    value.recoverable &&
    value.dirty &&
    value.generation &&
    !["absent", "busy", "unavailable"].includes(value.state),
  );
}

export function ProjectExecutionStorageDialog({
  project,
  returnFocus,
  onClose,
}: {
  project: Pick<ProjectState, "id" | "name">;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const revision = useRef(0);
  const [storage, setStorage] = useState<ProjectExecutionStorage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(
    uncertainRecoveries.has(project.id),
  );
  const [result, setResult] = useState<{
    changed: string[];
    recovery?: string;
  }>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = checkedState(
        await getProjectExecutionStorage(project.id),
        project.id,
      );
      if (request !== revision.current) return;
      const previous = uncertainRecoveries.get(project.id);
      if (
        previous &&
        (!next.dirty || (next.generation && next.generation !== previous))
      )
        uncertainRecoveries.delete(project.id);
      setUncertain(uncertainRecoveries.has(project.id));
      setStorage(next);
    } catch (cause) {
      if (request === revision.current) {
        setStorage(undefined);
        setError(message(cause));
      }
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (!pending.current) void load();
    };
    window.addEventListener("focus", refresh);
    return () => {
      revision.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  useEffect(() => {
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined);
    close.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending.current) {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const items = [
        ...dialog.current.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      ];
      const first = items[0],
        last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (!dialog.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [returnFocus]);

  async function recover(): Promise<void> {
    if (
      pending.current ||
      (uncertainRecoveries.has(project.id) && !storage?.approvedReviewId) ||
      !recoverable(storage)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      assertProjectCanvasDraftsSaved(project.id);
      const latest = checkedState(
        await getProjectExecutionStorage(project.id),
        project.id,
      );
      if (!recoverable(latest) || latest.generation !== storage.generation || latest.approvedReviewId !== storage.approvedReviewId) {
        setStorage(latest);
        throw new Error(t("projects.executionStorage.changed"));
      }
      if (
        !window.confirm(
          t("projects.executionStorage.confirm", { name: project.name }),
        )
      )
        return;
      assertProjectCanvasDraftsSaved(project.id);
      uncertainRecoveries.set(project.id, latest.generation);
      const restored = await recoverProjectExecutionStorage(
        project.id,
        latest.generation,
      );
      if (
        !restored ||
        !Array.isArray(restored.changed) ||
        !restored.changed.every((path) => typeof path === "string") ||
        (restored.recovery !== undefined &&
          typeof restored.recovery !== "string")
      )
        throw new Error(t("projects.executionStorage.invalid"));
      uncertainRecoveries.delete(project.id);
      setUncertain(false);
      setResult(restored);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "execution_recovery_not_started")
        uncertainRecoveries.delete(project.id);
      setUncertain(uncertainRecoveries.has(project.id));
      setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function openStorage(): Promise<void> {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await openProjectExecutionStorage(project.id); await load(); }
    catch (cause) { setError(message(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return (
    <div
      className="project-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending.current) onClose();
      }}
    >
      <section
        ref={dialog}
        className="project-create-dialog project-execution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>
            {t("projects.executionStorage.title", { name: project.name })}
          </h2>
          <button
            ref={close}
            type="button"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="project-execution-content">
          <p>{t("projects.executionStorage.description")}</p>
          <p>{t("projects.executionStorage.mediaReturnHint")}</p>
          <p>{t("projects.executionStorage.openHint")}</p>
          {loading ? (
            <p role="status">
              <LoaderCircle className="spin" size={13} />
              {t("projects.executionStorage.loading")}
            </p>
          ) : storage ? (
            <p className="project-execution-state" role="status">
              {t(`projects.executionStorage.state.${storage.state}`)}
            </p>
          ) : null}
          {storage?.reason ? <p>{storage.reason}</p> : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          {uncertain ? (
            <p role="alert">{t(storage?.approvedReviewId ? "projects.executionStorage.approvedResume" : "projects.executionStorage.uncertain")}</p>
          ) : null}
          {result ? (
            <div role="status">
              <p>
                {t("projects.executionStorage.success", {
                  count: result.changed.length,
                })}
              </p>
              {result.recovery ? (
                <p>
                  {t("projects.executionStorage.recoveryPath", {
                    path: result.recovery,
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          <footer>
            <button type="button" disabled={busy || loading || storage?.supported === false || storage?.state === "busy"} onClick={() => void openStorage()}>{t("projects.executionStorage.open")}</button>
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              {t("projects.executionStorage.refresh")}
            </button>
            <button
              className="project-create-submit"
              type="button"
              disabled={busy || loading || (uncertain && !storage?.approvedReviewId) || !recoverable(storage)}
              onClick={() => void recover()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={12} />
                  {t("projects.executionStorage.recovering")}
                </>
              ) : (
                t("projects.executionStorage.recover")
              )}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
