import type { ProjectState, PromptContext } from "../shared/contracts.js";
import { CANVAS_INDEX_FILE, canvasDocumentPath, type CanvasDocumentDetail } from "../shared/canvas-document.js";
import { readCanvasIndex } from "./canvas-workspace.js";

export function gameDesignReference(detail: CanvasDocumentDetail): PromptContext {
  return {
    kind: "design-document",
    label: `${(detail.document.title || "Document").slice(0, 189)} (${detail.revision.slice(0, 8)})`,
    text: [
      "The user explicitly referenced this document snapshot for this message. It was captured from the saved Markdown source when the message was sent.",
      `Source: ${canvasDocumentPath(detail.document.id)}\nRevision: ${detail.revision}`,
      "Use this snapshot as context for the turn. The user's current request takes priority; mention relevant differences without changing the document unless asked. Before editing the document, reread the current Markdown source to preserve changes made since this snapshot.",
      "Image paths are relative to the Markdown file. Image links do not include image pixels. Read relevant images when evaluating visual direction.",
      `Document snapshot:\n${detail.document.markdown}`,
    ].join("\n\n"),
  };
}

export async function gameDesignMetadata(project: ProjectState, hadDesign = false): Promise<string | undefined> {
  try {
    const index = await readCanvasIndex(project.workspacePath);
    if (!index) return hadDesign ? `This project currently has no saved main game design in ${CANVAS_INDEX_FILE}. Do not rely on an earlier document snapshot as the current design.` : undefined;
    const canvas = `Canvas index: ${CANVAS_INDEX_FILE}.`;
    if (project.type === "asset-canvas") return `${canvas} Asset Canvas documents are production references; there is no game runtime.`;
    const main = index.documents.find((document) => document.id === index.mainDocumentId);
    return main
      ? `${canvas} Main game design: ${JSON.stringify(main.title)} at ${canvasDocumentPath(main.id)}. Read the current source when the task depends on the design.`
      : `${canvas} No main design document is selected.`;
  } catch (cause) {
    return `The current canvas workspace could not be read: ${cause instanceof Error ? cause.message : String(cause)}. Inspect ${CANVAS_INDEX_FILE} if it is relevant to the request; do not assume an earlier snapshot is current.`;
  }
}
