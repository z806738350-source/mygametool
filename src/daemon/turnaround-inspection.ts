import { createHash } from "node:crypto";
import { defineTool, type SessionEntry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectState, PromptImage } from "../shared/contracts.js";
import type { AuthorizeAgentAttachment } from "./agent-attachments.js";
import { createAgentAttachmentReadTool, localAgentPath } from "./agent-local-files.js";
import { readWebpModelReference } from "./image-working-assets.js";
import { prepareSessionImageDisplay, type SessionImageMimeType } from "./retained-image-display.js";
import { RASTER_BYTES } from "./raster-policy.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { getWorkspaceMedia } from "./workspace.js";

const VIEW_LABELS = [
  "Front: compare the silhouette and asymmetric landmarks with the original; trace both endpoints on the subject's own left and right.",
  "Subject's left profile: trace the same endpoints from this camera. Check which near-side parts should be visible and which far-side parts should be hidden.",
  "Back: check which surfaces should face the camera. On humanoids compare thumbs, fingers, heels and toes with the front in this exact pose.",
  "Subject's right profile: check visibility against the left profile and original.",
  "Additional view: check its actual angle and continuity with the other views.",
];

interface Inspection {
  inspectionCallId: string;
  originalPath?: string;
  original?: PromptImage;
}

function identity(image: PromptImage) {
  return image.mediaType + ":" + createHash("sha256").update(image.data, "base64").digest("hex");
}

export function createTurnaroundInspection(project: ProjectState, authorizeAttachment?: AuthorizeAgentAttachment) {
  const workspace = project.workspacePath;
  const readAttachment = createAgentAttachmentReadTool(workspace, true, authorizeAttachment);
  let latest: { hashes: string[]; inspection: Inspection } | undefined;

  const tool: ToolDefinition = defineTool({
    name: "inspect_3d_views",
    label: "Inspect 3D reference views",
    description: "Read the actual reference pixels together before a new turnaround-to-3D submission. Include originalPath whenever concept art exists. Compare each labeled view and tell the user the specific visual findings before opening human review. Correct visible errors and inspect the final set again.",
    parameters: Type.Object({
      imagePaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 3, maxItems: 5, description: "Project-relative view paths in front, subject's left profile, back, optional right and additional view order." }),
      originalPath: Type.Optional(Type.String({ minLength: 1, description: "Original design's project-relative path or exact current-branch attachment receipt, when available." })),
    }),
    execute: async (callId, input, signal, onUpdate, context) => {
      signal?.throwIfAborted();
      if (!context?.model?.input?.includes("image")) throw new Error("Inspecting reference views requires an image-enabled model.");
      if (input.imagePaths.length < 3 || input.imagePaths.length > VIEW_LABELS.length) throw new Error("Provide three to five ordered reference views.");
      const inspection: Inspection = { inspectionCallId: callId };
      const hashes: string[] = [];
      const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];
      const sources = input.imagePaths.map((path, index) => ({ path, label: VIEW_LABELS[index]!, original: false }));
      if (input.originalPath) sources.unshift({ path: input.originalPath, label: "Original design: establish the subject's own sides before checking the generated views.", original: true });
      for (const source of sources) {
        signal?.throwIfAborted();
        let image: PromptImage;
        if (source.original && source.path.startsWith("attachment:")) {
          const result = await readAttachment.execute(callId, { path: source.path }, signal, onUpdate, context);
          const block = result.content.find(part => part.type === "image");
          if (!block || !["image/png", "image/jpeg", "image/webp"].includes(block.mimeType)) throw new Error("The original reference must be a PNG, JPEG or WebP image.");
          image = { mediaType: block.mimeType as SessionImageMimeType, data: block.data };
        } else {
          const file = await localAgentPath(workspace, source.path);
          const media = await getWorkspaceMedia(workspace, source.path);
          if (!["image/png", "image/jpeg", "image/webp"].includes(media.contentType)) throw new Error("Reference views must be PNG, JPEG or WebP files.");
          if (!source.original && media.contentType === "image/webp") {
            image = await readWebpModelReference(workspace, { absolutePath: file, size: media.size });
          } else {
            const bytes = await readSafeProjectFile(workspace, file, RASTER_BYTES);
            image = { mediaType: media.contentType as SessionImageMimeType, data: bytes.toString("base64") };
          }
        }
        const display = await prepareSessionImageDisplay(Buffer.from(image.data, "base64"), image.mediaType as SessionImageMimeType, signal);
        content.push({ type: "text", text: source.label }, { type: "image", mimeType: display.mimeType, data: display.bytes.toString("base64") });
        if (source.original) {
          inspection.original = image;
          inspection.originalPath = source.path;
        } else hashes.push(image.mediaType + ":" + display.sourceSha256);
      }
      signal?.throwIfAborted();
      latest = { hashes, inspection };
      return { content, details: {} };
    },
  });
  return {
    tool,
    match(paths: readonly string[], images: readonly PromptImage[]): Inspection | undefined {
      if (!latest || paths.length !== images.length || images.length !== latest.hashes.length) return;
      if (images.every((image, i) => identity(image) === latest!.hashes[i])) return latest.inspection;
    },
  };
}

/** A visible finding must follow receipt of the pixels and precede this specific submission. */
export function hasTurnaroundAssessment(branch: readonly SessionEntry[] | undefined, inspectionCallId: string, submissionCallId: string): boolean {
  if (!branch || !inspectionCallId || !submissionCallId) return false;
  const start = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user");
  if (start < 0) return false;
  let inspected = false;
  let assessed = false;
  for (let index = start + 1; index < branch.length; index++) {
    const entry = branch[index]!;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult" && message.toolCallId === inspectionCallId && message.toolName === "inspect_3d_views") {
      inspected = !message.isError && message.content.some(part => part.type === "image" && !!part.data);
      assessed = false;
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall" && part.id === submissionCallId) return inspected && assessed;
        if (inspected && part.type === "text" && part.text.trim()) assessed = true;
      }
    }
  }
  return false;
}
