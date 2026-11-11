import { Equal as equal } from "typebox/value";
import {
  isAssetCanvasDocument,
  withoutContentNodeSizes,
} from "../shared/asset-canvas.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import { isCanvasTable } from "../shared/canvas-table.js";

export type CanvasDraftStatus = "clear" | "pending" | "unknown";
const readers = new Map<string, Set<() => CanvasDraftStatus>>();

/** Keep in-memory save failures visible even when recovery storage could not be written. */
export function registerCanvasDraftReader(projectId: string, read: () => CanvasDraftStatus): () => void {
  let project = readers.get(projectId);
  if (!project) readers.set(projectId, project = new Set());
  const entries = project;
  entries.add(read);
  return () => {
    entries.delete(read);
    if (!entries.size) readers.delete(projectId);
  };
}

/** Library cleanup must not mistake a recoverable, unsaved reference for an unused asset. */
export function readCanvasDraftStatus(
  storage?: Pick<Storage, "length" | "key" | "getItem">,
  projectId?: string,
): CanvasDraftStatus {
  try {
    if (projectId !== undefined && !projectId) return "unknown";
    const drafts = storage ?? localStorage;
    let status: CanvasDraftStatus = "clear";
    for (const [id, project] of readers) {
      if (projectId !== undefined && id !== projectId) continue;
      for (const read of project) {
        const memory = read();
        if (memory !== "clear" && memory !== "pending") return "unknown";
        if (memory === "pending") status = "pending";
      }
    }
    for (let index = 0; index < drafts.length; index++) {
      const key = drafts.key(index);
      if (!key) return "unknown";
      const board = key.startsWith("canvas-board:"),
        documents = key.startsWith("canvas-documents:"),
        tables = key.startsWith("canvas-tables:");
      if (!board && !documents && !tables) continue;
      if (projectId !== undefined) {
        const prefix = `${board ? "canvas-board" : documents ? "canvas-documents" : "canvas-tables"}:${projectId}`;
        if (key !== prefix && !key.startsWith(`${prefix}:`)) continue;
      }
      const raw = drafts.getItem(key);
      if (raw === null) return "unknown";
      const value = JSON.parse(raw);
      if (board) {
        const base = withoutContentNodeSizes(value.base),
          local = withoutContentNodeSizes(value.local);
        if (!isAssetCanvasDocument(base) || !isAssetCanvasDocument(local))
          return "unknown";
        if (!equal(base, local)) status = "pending";
      } else {
        if (!Array.isArray(value)) return "unknown";
        for (const draft of value) {
          const base = documents ? draft?.base?.document : draft?.base?.table,
            local = draft?.local,
            valid = documents ? isCanvasDocument : isCanvasTable;
          if (
            typeof draft?.base?.revision !== "string" ||
            !valid(base) ||
            !valid(local) ||
            base.id !== local.id
          )
            return "unknown";
          if (!equal(base, local)) status = "pending";
        }
      }
    }
    if (projectId !== undefined) {
      for (const prefix of ["canvas-document-generations", "canvas-table-generations"]) {
        const raw = drafts.getItem(`${prefix}:${projectId}`);
        if (raw === null) continue;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
        for (const state of Object.values(value)) {
          if (!state || typeof state !== "object" || Array.isArray(state)) return "unknown";
          const generation = state as Record<string, unknown>;
          if (typeof generation.instruction !== "string"
            || generation.generating !== undefined && typeof generation.generating !== "boolean"
            || generation.applying !== undefined && typeof generation.applying !== "boolean"
            || generation.proposal !== undefined && (prefix === "canvas-document-generations" ? typeof generation.proposal !== "string" : !isCanvasTable(generation.proposal))) return "unknown";
          if (generation.proposal || generation.generating || generation.applying) status = "pending";
        }
      }
    }
    return status;
  } catch {
    return "unknown";
  }
}
