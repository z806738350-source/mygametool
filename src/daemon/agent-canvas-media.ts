import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AssetCanvasNode,
  AssetCanvasReference,
  Model3DAnimationAction,
  PromptImage,
  ProjectState,
  ToolId,
} from "../shared/contracts.js";
import {
  DEFAULT_ANIMATION_ACTION_IDS,
  DEFAULT_CHARACTER_HEIGHT_METERS,
  DEFAULT_MODEL_3D_CONFIG,
  DEFAULT_IMAGE_NODE_CONFIG,
  DEFAULT_VIDEO_NODE_CONFIG,
} from "../shared/generation-config.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import type { CanvasStore } from "./canvas-workspace.js";
import { projectAnimationSelection } from "./project-media-capabilities.js";
import { readCanvasAssets } from "./canvas-assets.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { AUDIO_REFERENCE_MAX_BYTES } from "../shared/audio-reference.js";
import { toolPreflightError } from "./agent-tool-errors.js";

/** Use the board from the latest user message only; an older selection may be stale. */
export function agentCanvasBoard(
  branch: readonly SessionEntry[],
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const block = text.match(
      /<editor-context>\n([\s\S]*?)\n<\/editor-context>/,
    )?.[1];
    if (!block) return;
    try {
      const items: unknown = JSON.parse(block).items;
      if (!Array.isArray(items)) return;
      const board = items.find(
        (item) =>
          item?.kind === "canvas-board" && typeof item.text === "string",
      );
      return board?.text.match(
        /^Current canvas board: canvas\/boards\/([a-zA-Z0-9_-]{1,100})\.json\n/,
      )?.[1];
    } catch {
      return;
    }
  }
}

const pick = (input: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(
    fields
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );

/** Inputs have passed the public tool schema; the resulting node is checked again before saving. */
export async function saveAgentCanvasMedia(
  projectId: string,
  store: CanvasStore,
  projects: ProjectManager,
  tools: ToolRunner,
  toolId: ToolId,
  input: Record<string, unknown>,
  nodeId: string,
  boardId?: string,
  readImageAttachment?: (reference: string, signal?: AbortSignal) => Promise<PromptImage>,
  signal?: AbortSignal,
) {
  const animation = toolId === "animate-3d" ? await resolveAgentAnimation(projects.get(projectId), tools, input, signal) : undefined;
  return store.createAgentMediaNode(
    projectId,
    nodeId,
    async (reference) => {
      const imagePaths = (input.imagePaths ??
        (input.imagePath ? [input.imagePath] : [])) as string[];
      const images = async () => {
        const result: AssetCanvasReference[] = [];
        for (const file of imagePaths) {
          if (toolId === "generate-image" && file.startsWith("attachment:")) {
            if (!readImageAttachment) throw new Error("Attachment references are unavailable. No generation was submitted.");
            const image = await readImageAttachment(file, signal);
            result.push(await reference({ attachmentReference: file, image, signal }));
          } else result.push(await reference({ path: file }));
        }
        return result;
      };
      let type: AssetCanvasNode["type"], data: Record<string, unknown>;
      if (toolId === "generate-image") {
        type = "image";
        if (
          (input.resolution === undefined) !==
          (input.aspectRatio === undefined)
        )
          throw new Error(
            "Image resolution and aspect ratio must be provided together",
          );
        if (imagePaths.length && input.resolution === undefined)
          throw new Error(
            "Reference images require resolution and aspect ratio together",
          );
        if (input.maskPath && !imagePaths.length)
          throw new Error("An edit mask requires at least one reference image");
        const legacy =
          input.size === "1536x1024"
            ? "3:2"
            : input.size === "1024x1536"
              ? "2:3"
              : DEFAULT_IMAGE_NODE_CONFIG.aspectRatio;
        data = {
          ...DEFAULT_IMAGE_NODE_CONFIG,
          aspectRatio: legacy,
          ...pick(input, [
            "prompt",
            "resolution",
            "aspectRatio",
            "quality",
            "outputFormat",
            "outputCompression",
            "background",
          ]),
          ...(input.imageModel ? { model: input.imageModel } : {}),
          images: await images(),
          ...(input.maskPath
            ? { mask: await reference({ path: input.maskPath as string }) }
            : {}),
        };
      } else if (toolId === "image-to-3d") {
        type = "model-3d";
        const operation = input.operation ?? "image";
        data = {
          ...DEFAULT_MODEL_3D_CONFIG,
          ...pick(input, [
            "model",
            "prompt",
            "targetPolycount",
            "texture",
            "pbr",
          ]),
          operation,
          ...(operation === "image"
            ? {
                options: {
                  referenceMode: "turnaround",
                  ...(input.options as object),
                },
              }
            : pick(input, ["options"])),
          images: await images(),
          ...(input.sourcePath
            ? { source: await reference({ path: input.sourcePath as string }) }
            : {}),
        };
      } else if (toolId === "generate-video") {
        type = "video";
        data = {
          ...DEFAULT_VIDEO_NODE_CONFIG,
          ...pick(input, [
            "prompt",
            "model",
            "resolution",
            "aspectRatio",
            "duration",
          ]),
          references: await images(),
        };
      } else if (toolId === "animate-3d") {
        type = "animate-3d";
        const { model, options, actions } = animation!;
        data = {
          model,
          options,
          actionIds: [...new Set(actions.map((action) => action.id))],
          heightMeters: input.heightMeters ?? DEFAULT_CHARACTER_HEIGHT_METERS,
          source: await reference({ path: input.modelPath as string }),
        };
      } else if (toolId === "generate-speech") {
        if (
          (input.voiceDesign &&
            (!String(input.voiceDescription ?? "").trim() ||
              input.referenceAssetId)) ||
          (input.voiceDescription !== undefined && !input.voiceDesign)
        )
          throw new Error(
            "Voice design requires a description and no reference audio. No generation was submitted.",
          );
        type = input.voiceDesign ? "voice" : "speech";
        data = {
          ...pick(input, ["model", "language", "style", "speed"]),
          ...(input.format || input.sampleRate
            ? { output: pick(input, ["format", "sampleRate"]) }
            : {}),
          ...(type === "voice"
            ? {
                description: input.voiceDescription ?? "",
                sampleText: input.text,
              }
            : pick(input, ["text", "referenceAssetId", "referenceSha256"])),
        };
        if (type === "speech" && input.referenceAssetId) {
          const source = await reference({
            assetId: input.referenceAssetId as string,
            audioReference: true,
          });
          // A source line is pinned to the actual bytes, as with a user-selected voice.
          const workspace = await realpath(
            projects.get(projectId)!.workspacePath,
          );
          const asset = (await readCanvasAssets(workspace)).assets[
            input.referenceAssetId as string
          ]!;
          const bytes = await readSafeProjectFile(
            workspace,
            path.join(workspace, asset.path),
            AUDIO_REFERENCE_MAX_BYTES,
          );
          data.referenceSha256 ??= createHash("sha256")
            .update(bytes)
            .digest("hex");
          if (source.type === "node") data.voiceSourceNodeId = source.nodeId;
        }
      } else {
        type = toolId === "generate-music" ? "music" : "sound-effect";
        data = {
          ...pick(input, [
            "prompt",
            "model",
            "durationSeconds",
            "loop",
            "negativePrompt",
            "instrumental",
            "lyrics",
          ]),
          ...(input.format ? { output: { format: input.format } } : {}),
        };
      }
      return {
        id: nodeId,
        type,
        position: { x: 0, y: 0 },
        title: String(
          input.prompt ?? input.voiceDescription ?? input.text ?? type,
        ).slice(0, 200),
        data,
      } as AssetCanvasNode;
    },
    boardId,
  );
}

/** Resolve all clips before creating nodes, source bindings, journals or generation work. */
export async function resolveAgentAnimation(project: ProjectState | undefined, tools: ToolRunner, input: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const selected = projectAnimationSelection(project, input.model as Parameters<typeof projectAnimationSelection>[1],
    Object.keys(pick(input, ["rigModel", "rigType", "animateInPlace"])).length ? pick(input, ["rigModel", "rigType", "animateInPlace"]) : undefined);
  const library = await tools.animationActions(selected.model, selected.options);
  signal?.throwIfAborted();
  const actions = input.actions
    ? (input.actions as string[]).map(name => findAnimationAction(library, name))
    : library.some(action => typeof action.id === "string")
      ? library.filter(action => ["Idle", "Walk", "Run", "Jump", "Slash", "Hurt", "Fall", "March"].includes(action.name)).slice(0, 5)
      : DEFAULT_ANIMATION_ACTION_IDS.flatMap(id => library.filter(action => action.id === id));
  if (!actions.length) throw toolPreflightError("No integrated preset actions are available for this rig. Use list_animation_actions with the same model, rigModel and rigType; do not invent clips. No animation workflow was submitted.", "invalid_animation_action");
  return { ...selected, actions };
}

/** Matches an agent-supplied action name to the library and suggests close names when it misses. */
export function findAnimationAction(
  library: readonly Model3DAnimationAction[],
  name: string,
): Model3DAnimationAction {
  const wanted = name.trim().toLowerCase();
  const exact = library.filter((action) => action.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]!;
  const words = wanted.split(/\s+/).filter(Boolean);
  const suggestions = library
    .filter((action) =>
      words.some((word) => action.name.toLowerCase().includes(word)),
    )
    .slice(0, 8)
    .map((action) => action.name);
  const available = library.slice(0, 16).map(action => action.name.slice(0, 100));
  throw toolPreflightError(
    `${exact.length > 1 ? "Ambiguous" : "Unknown"} animation ${JSON.stringify(name.slice(0, 120))}.${suggestions.length ? ` Similar names: ${JSON.stringify(suggestions)}.` : ""} Available names for this rig: ${JSON.stringify(available)}${library.length > available.length ? " (partial list)" : ""}. Use list_animation_actions with the same model, rigModel and rigType, then choose exact names using a new call ID. No animation workflow was submitted; do not replay the rejected ID.`,
    "invalid_animation_action",
  );
}
