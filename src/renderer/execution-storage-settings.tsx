import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ExecutionStorageOverview,
  ExecutionStorageProject,
  ExecutionStorageTaskPhase,
} from "../shared/execution-storage.js";
import { getExecutionStorageOverview } from "./api.js";
import { Check, Folder, InfoCircle, LoaderCircle, RefreshCw } from "./icons.js";
import { language, t } from "./i18n.js";
import { projectHash } from "./routes.js";
import "./execution-storage-settings.css";

const phases: Record<
  ExecutionStorageTaskPhase,
  | "preparing"
  | "running"
  | "awaiting"
  | "releasing"
  | "stopping"
  | "idle"
  | "unknown"
> = {
  idle: "idle",
  prepared: "preparing",
  running: "running",
  "finished-awaiting-ack": "awaiting",
  finished: "releasing",
  "cancel-requested": "stopping",
  "expired-uncertain": "unknown",
};

function checkedOverview(
  value: ExecutionStorageOverview,
): ExecutionStorageOverview {
  const count = (number: number) => Number.isSafeInteger(number) && number >= 0;
  const timestamp = (time: string) =>
    typeof time === "string" && Number.isFinite(Date.parse(time));
  const snapshot = value?.snapshot;
  if (
    !value ||
    typeof value.supported !== "boolean" ||
    !["running", "stopped", "unknown"].includes(value.vmState) ||
    !["current", "stale", "unavailable"].includes(value.dataStatus) ||
    !timestamp(value.checkedAt) ||
    (value.dataStatus === "current" &&
      (value.vmState !== "running" || !snapshot)) ||
    (value.dataStatus === "stale" && !snapshot) ||
    (value.dataStatus === "unavailable" && snapshot !== null) ||
    (snapshot &&
      (!timestamp(snapshot.observedAt) ||
        !snapshot.limits ||
        snapshot.limits.residentVolumes !== 8 ||
        !count(snapshot.residentReserved) ||
        snapshot.residentReserved > 8 ||
        !count(snapshot.allocatedProjects) ||
        !count(snapshot.resident) ||
        !count(snapshot.sleeping) ||
        typeof snapshot.countsTrusted !== "boolean" ||
        (snapshot.countsTrusted
          ? !count(snapshot.freeResidentSlots!) ||
            snapshot.freeResidentSlots !== 8 - snapshot.residentReserved
          : snapshot.freeResidentSlots !== null) ||
        !Array.isArray(snapshot.projects) ||
        snapshot.allocatedProjects !== snapshot.projects.length ||
        !snapshot.projects.every(
          (project) =>
            project &&
            ["manual", "test"].includes(project.namespace) &&
            typeof project.projectId === "string" &&
            !!project.projectId &&
            typeof project.generation === "string" &&
            (project.projectName === null ||
              typeof project.projectName === "string") &&
            typeof project.currentStore === "boolean" &&
            ["resident", "archived", "creating", "recovery"].includes(
              project.residency,
            ) &&
            typeof project.dirty === "boolean" &&
            typeof project.syncPending === "boolean" &&
            Object.hasOwn(phases, project.taskPhase) &&
            typeof project.expiredTask === "boolean" &&
            (project.transition === null ||
              (project.transition &&
                ["resident", "archived", "creating", "recovery"].includes(
                  project.transition.from,
                ) &&
                ["resident", "archived", "deleted"].includes(
                  project.transition.to,
                ))),
        ))) ||
    (value.unallocatedProjects !== null &&
      (!Array.isArray(value.unallocatedProjects) ||
        value.dataStatus !== "current" ||
        !snapshot?.countsTrusted ||
        !value.unallocatedProjects.every(
          (project) =>
            project &&
            typeof project.projectId === "string" &&
            !!project.projectId &&
            typeof project.projectName === "string",
        )))
  ) {
    throw new Error(t("executionStorage.invalid"));
  }
  return value;
}

function observedTime(time: string): string {
  return new Date(time).toLocaleString(language, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function ExecutionStorageSettingsPanel() {
  const titleId = useId();
  const [overview, setOverview] = useState<ExecutionStorageOverview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const revision = useRef(0);

  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++revision.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = checkedOverview(
        await getExecutionStorageOverview(controller.signal),
      );
      if (controller.signal.aborted || current !== revision.current) return;
      setOverview(next);
    } catch (cause) {
      if (controller.signal.aborted || current !== revision.current) return;
      setError(
        cause instanceof Error &&
          cause.message === t("executionStorage.invalid")
          ? cause.message
          : t("executionStorage.error"),
      );
      setOverview((previous) =>
        previous
          ? {
              ...previous,
              vmState: "unknown",
              dataStatus: previous.snapshot ? "stale" : "unavailable",
              unallocatedProjects: null,
            }
          : undefined,
      );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      revision.current++;
      request.current?.abort();
      request.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const snapshot = overview?.snapshot;
  const current = overview?.dataStatus === "current";
  const stale = overview?.dataStatus === "stale";
  const available =
    current && snapshot?.countsTrusted ? snapshot.freeResidentSlots : null;
  const unallocated =
    current && snapshot?.countsTrusted ? overview.unallocatedProjects : null;
  const records = (snapshot?.projects.length ?? 0) + (unallocated?.length ?? 0);
  const state = loading
    ? "loading"
    : error
      ? "error"
      : current
        ? "success"
        : "default";

  return (
    <section
      className="settings-panel settings-overview-panel execution-storage-panel"
      aria-labelledby={titleId}
      aria-busy={loading}
    >
      <header className="settings-panel-header execution-storage-header">
        <h3 id={titleId}>{t("settings.nav.executionStorage")}</h3>
        <button
          className="settings-secondary-button execution-storage-refresh"
          type="button"
          disabled={loading}
          aria-disabled={loading}
          data-state={state}
          onClick={() => void load()}
        >
          {loading ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {t("executionStorage.refresh")}
        </button>
      </header>
      <p className="execution-storage-description">
        {t("executionStorage.description")}
      </p>
      <div
        className="execution-storage-quota"
        aria-label={t("executionStorage.reserved")}
      >
        <div className="execution-storage-reserved">
          <span>{t("executionStorage.reserved")}</span>
          <strong>
            {snapshot?.residentReserved ?? "--"}
            <small> / {snapshot?.limits.residentVolumes ?? 8}</small>
          </strong>
        </div>
        <dl>
          <div>
            <dt>{t("executionStorage.available")}</dt>
            <dd>{available ?? "--"}</dd>
          </div>
          <div>
            <dt>{t("executionStorage.sleeping")}</dt>
            <dd>{snapshot?.sleeping ?? "--"}</dd>
          </div>
        </dl>
      </div>
      <p className="execution-storage-hint">
        {t("executionStorage.quotaHint")}
      </p>
      <div
        className={`execution-storage-status${stale || !snapshot || !snapshot.countsTrusted ? " is-warning" : ""}`}
        role="status"
        aria-live="polite"
      >
        <div className="execution-storage-status-line">
          {current ? <Check size={14} aria-hidden="true" /> : null}
          <strong>
            {t(
              overview?.vmState === "stopped"
                ? "executionStorage.vmStopped"
                : overview?.vmState === "running"
                  ? "executionStorage.vmRunning"
                  : "executionStorage.vmUnknown",
            )}
          </strong>
          {loading ? <span>{t("executionStorage.refreshing")}</span> : null}
        </div>
        {snapshot ? (
          <p>
            <span>
              {t(stale ? "executionStorage.stale" : "executionStorage.current")}
            </span>
            <time dateTime={snapshot.observedAt}>
              {t("executionStorage.observedAt", {
                time: observedTime(snapshot.observedAt),
              })}
            </time>
          </p>
        ) : !loading ? (
          <p>
            {t(
              overview?.supported === false
                ? "executionStorage.unsupported"
                : "executionStorage.unavailable",
            )}
          </p>
        ) : null}
        {snapshot && !snapshot.countsTrusted ? (
          <p>{t("executionStorage.verificationNeeded")}</p>
        ) : null}
      </div>
      {error ? (
        <p className="execution-storage-error" role="alert">
          {error}
        </p>
      ) : null}
      <section
        className="execution-storage-projects"
        aria-labelledby={`${titleId}-projects`}
      >
        <header>
          <h4 id={`${titleId}-projects`}>{t("executionStorage.projects")}</h4>
          {snapshot ? (
            <span>
              {t("executionStorage.projectCount", { count: records })}
            </span>
          ) : null}
        </header>
        {stale ? (
          <p className="execution-storage-hint">
            {t("executionStorage.staleProjects")}
          </p>
        ) : null}
        {snapshot && records > 0 ? (
          <ul className="execution-storage-list">
            {snapshot.projects.map((project) => (
              <VolumeRow
                key={`${project.namespace}:${project.projectId}:${project.generation}`}
                project={project}
              />
            ))}
            {unallocated?.map((project) => (
              <VolumeRow
                key={`unallocated:${project.projectId}`}
                unallocated={project}
              />
            ))}
          </ul>
        ) : loading && !snapshot ? (
          <div className="execution-storage-skeleton" aria-hidden="true">
            <span />
            <span />
          </div>
        ) : (
          <p className="execution-storage-empty">
            <Folder size={18} aria-hidden="true" />
            {t(
              current && snapshot?.countsTrusted
                ? "executionStorage.empty"
                : "executionStorage.unknownProjects",
            )}
          </p>
        )}
        {snapshot && unallocated === null ? (
          <p className="execution-storage-hint">
            {t("executionStorage.unallocatedUnknown")}
          </p>
        ) : null}
      </section>
    </section>
  );
}

function VolumeRow({
  project,
  unallocated,
}: {
  project?: ExecutionStorageProject;
  unallocated?: { projectId: string; projectName: string };
}) {
  const id = project?.projectId ?? unallocated!.projectId;
  const linked =
    !!unallocated || !!(project?.currentStore && project.projectName !== null);
  const name = linked
    ? (project?.projectName ?? unallocated!.projectName)
    : t("executionStorage.orphan");
  const location = unallocated
    ? "unallocated"
    : project?.transition ||
        project?.residency === "creating" ||
        project?.residency === "recovery"
      ? "processing"
      : project?.residency === "resident"
        ? "resident"
        : project?.residency === "archived"
          ? "sleeping"
          : "unknown";
  const phase = project
    ? project.expiredTask
      ? "unknown"
      : phases[project.taskPhase]
    : "unknown";
  const pending = !!(project?.dirty || project?.syncPending);
  return (
    <li className="execution-storage-row">
      <div className="execution-storage-identity">
        {linked ? (
          <a
            href={projectHash(id)}
            aria-label={`${t("executionStorage.details")}: ${name}`}
          >
            {name}
          </a>
        ) : (
          <strong>{name}</strong>
        )}
        <div>
          <span>{t("executionStorage.shortId", { id: id.slice(0, 8) })}</span>
          {project ? (
            <span>
              {t("executionStorage.namespace", {
                namespace: t(
                  `executionStorage.namespaces.${project.namespace}`,
                ),
              })}
            </span>
          ) : null}
        </div>
      </div>
      <dl className="execution-storage-fields">
        <div>
          <dt>{t("executionStorage.location")}</dt>
          <dd data-location={location}>
            {t(`executionStorage.locationState.${location}`)}
          </dd>
        </div>
        <div>
          <dt>{t("executionStorage.task")}</dt>
          <dd>{t(`executionStorage.phase.${phase}`)}</dd>
        </div>
        <div>
          <dt>{t("executionStorage.sync")}</dt>
          <dd className={pending ? "is-pending" : undefined}>
            {pending ? (
              <InfoCircle
                className="execution-storage-pending-icon"
                size={13}
                aria-hidden="true"
              />
            ) : null}
            <span>
              {t(
                !project
                  ? "executionStorage.syncUnknown"
                  : pending
                    ? "executionStorage.pendingReturn"
                    : "executionStorage.returned",
              )}
            </span>
          </dd>
        </div>
      </dl>
    </li>
  );
}
