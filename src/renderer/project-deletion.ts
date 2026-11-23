import type { ProjectState } from "../shared/contracts.js";
import { storedBrowserProjectId } from "../shared/project-browser-storage.js";
import { t } from "./i18n.js";
import { readCanvasDraftStatus, type CanvasDraftStatus } from "./canvas-draft-safety.js";
import { composerDrafts } from "./composer-drafts.js";

export function clearProjectBrowserData(projectId: string): void {
  composerDrafts.deleteProject(projectId);
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  for (const key of keys) if (key && storedBrowserProjectId(key) === projectId) localStorage.removeItem(key);
}

/** A missing/corrupt recovery cannot authorize removing its project. */
export function projectDraftStatus(projectId: string): CanvasDraftStatus {
  const canvas = readCanvasDraftStatus(undefined, projectId);
  let composer: CanvasDraftStatus;
  try { composer = composerDrafts.projectStatus(projectId, localStorage); }
  catch { composer = "unknown"; }
  if (canvas === "unknown" || composer === "unknown") return "unknown";
  return canvas === "pending" || composer === "pending" ? "pending" : "clear";
}

export function assertProjectCanvasDraftsSaved(projectId: string): void {
  const status = readCanvasDraftStatus(undefined, projectId);
  if (status !== "clear") throw new Error(t(`projects.canvasDrafts.${status}`));
}

export function assertProjectDraftsSaved(projectId: string): void {
  const status = projectDraftStatus(projectId);
  if (status !== "clear") throw new Error(t(`projects.drafts.${status}`));
}

export function confirmProjectDeletion(project: ProjectState): boolean {
  const status = projectDraftStatus(project.id);
  if (status !== "clear") {
    window.alert(t(`projects.drafts.${status}`));
    return false;
  }
  return window.confirm(projectDeletionConfirmation(project));
}

export function projectDeletionConfirmation(project: ProjectState): string {
  if (project.workspaceLocation === "external") {
    return t("projects.confirmRemove", { name: project.name, path: project.workspacePath });
  }
  return t("projects.confirmDelete", { name: project.name });
}
