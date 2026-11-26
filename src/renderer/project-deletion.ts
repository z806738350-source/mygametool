import type { ProjectState } from "../shared/contracts.js";
import { storedBrowserProjectId } from "../shared/project-browser-storage.js";
import { t } from "./i18n.js";
import { readCanvasDraftStatus, type CanvasDraftStatus } from "./canvas-draft-safety.js";
import { composerDrafts } from "./composer-drafts.js";

export interface ConfirmedProjectDeletion {
  id: string;
  name: string;
  draftStatus: CanvasDraftStatus;
}

export function clearProjectBrowserData(projectId: string): void {
  composerDrafts.deleteProject(projectId);
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key && storedBrowserProjectId(key) === projectId) localStorage.removeItem(key);
  } catch { /* Storage access can fail even after the host has confirmed deletion. */ }
}

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

export function confirmProjectDeletion(project: ProjectState): ConfirmedProjectDeletion | undefined {
  const draftStatus = projectDraftStatus(project.id);
  const warning = draftStatus === "clear" ? "" : `\n\n${t(`projects.discardDraftWarning.${draftStatus}`)}`;
  if (window.confirm(projectDeletionConfirmation(project) + warning)) {
    return { id: project.id, name: project.name, draftStatus };
  }
}

export function projectDeletionConfirmation(project: ProjectState): string {
  if (project.workspaceLocation === "external") {
    return t("projects.confirmRemove", { name: project.name, path: project.workspacePath });
  }
  return t("projects.confirmDelete", { name: project.name });
}
