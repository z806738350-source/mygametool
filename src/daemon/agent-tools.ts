import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { defineTool, type SessionEntry, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { IMAGE_MAX_REFERENCE_IMAGES, type PlanMode, type PlanState, type ProjectState, type PromptImage, type QuestionnaireResult, type RunImageToolRequest, type RunToolRequest, type RunVideoToolRequest, type ToolId } from "../shared/contracts.js";
import { agentCanvasBoard, resolveAgentAnimation, saveAgentCanvasMedia } from "./agent-canvas-media.js";
import { mediaGenerationNeedsConfirmation, DEFAULT_CHARACTER_HEIGHT_METERS, MAX_ANIMATION_ACTIONS } from "../shared/generation-config.js";
import { supportsWebPreview } from "../shared/project-runtime.js";
import type { ProjectManager } from "./projects.js";
import { assertSafeGenerationInput, type ToolRunner } from "./tools.js";
import { getWorkspaceMedia } from "./workspace.js";
import { readWebpModelReference } from "./image-working-assets.js";
import type { GameRuntimeAdapter, GameUseOpenTarget } from "../shared/playtest.js";
import { createGameUseTool } from "./playtest-tools.js";
import { addPlayableNode } from "./playable-add-node.js";
import { validatePlayableProject } from "./playable-project.js";
import { PLAYABLE_PRESET_IDS, PLAYABLE_PRESETS } from "./playable-presets.js";
import { checkCanvasWorkspace } from "./canvas-check.js";
import type { CanvasStore } from "./canvas-workspace.js";
import { readCanvasAssets } from "./canvas-assets.js";
import { readAssetMetadata } from "./asset-metadata.js";
import { MediaAlreadyDelivered } from "./agent-media-recovery.js";
import { createAgentAttachmentReadTool } from "./agent-local-files.js";
import type { AuthorizeAgentAttachment } from "./agent-attachments.js";
import { projectAnimationSelection } from "./project-media-capabilities.js";
import { imageModelCapabilities } from "./image-models.js";
import { inspectModel3D } from "./model3d-inspect.js";

const PI_TOOL_NAMES: Record<ToolId, string> = {
  "generate-image": "generate_image",
  "image-to-3d": "generate_3d_asset",
  "generate-video": "generate_video",
  "animate-3d": "animate_3d_asset",
  "generate-speech": "generate_speech",
  "generate-sound-effect": "generate_sound_effect",
  "generate-music": "generate_music",
};

const REFERENCE_IMAGE_TOOL = "generate_reference_image";
const TURNAROUND_3D_TOOL = "generate_3d_from_views";
const conflicting3DImagePaths = "Use imagePath or imagePaths, not both";
const mediaToolAliases = [[REFERENCE_IMAGE_TOOL, "generate-image"], [TURNAROUND_3D_TOOL, "image-to-3d"]] as const;

function mediaToolId(name: unknown): ToolId | undefined {
  return mediaToolAliases.find(([alias]) => alias === name)?.[1] ?? (Object.keys(PI_TOOL_NAMES) as ToolId[]).find(id => PI_TOOL_NAMES[id] === name);
}

const CANVAS_MEDIA_TOOLS: Partial<Record<import("../shared/contracts.js").AssetCanvasNodeType, ToolId>> = {
  image: "generate-image", video: "generate-video", "model-3d": "image-to-3d", "animate-3d": "animate-3d",
  voice: "generate-speech", speech: "generate-speech", "sound-effect": "generate-sound-effect", music: "generate-music",
};

export function activePiToolNames(enabledTools: readonly ToolId[], registeredToolNames: readonly string[] = []): string[] {
  const extensionTools = registeredToolNames.filter((name) => ["read_workflow_guide", "list_media_capabilities", "list_animation_actions", "optimize_image_asset", "get_model_asset", "use_canvas_asset", "prepare_three_runtime", "isolated_shell", "recover_isolated_changes", "read_project_file", "build_game", "canvas_check", "canvas_initialize", "playable_add_node", "playable_check", "game_use", "read_attachment", "recall_image"].includes(name));
  const mediaTools = registeredToolNames.filter(name => ["recover_media", "recover_canvas_media"].includes(name)
    || (enabledTools.length > 0 && ["generate_canvas_media", "replace_canvas_media"].includes(name)));
  const aliases = mediaToolAliases.filter(([name, id]) => enabledTools.includes(id) && registeredToolNames.includes(name)).map(([name]) => name);
  return [...new Set([...extensionTools, "read", "write", "edit", "ls", "find", "grep", "update_plan", ...enabledTools.map((id) => PI_TOOL_NAMES[id]), ...aliases, ...mediaTools])];
}

export function planningPiToolNames(): string[] {
  return ["read", "grep", "find", "ls", "questionnaire", "update_plan"];
}

export function projectPiToolNames(
  mode: PlanMode,
  enabledTools: readonly ToolId[],
  registeredToolNames: readonly string[] = [],
): string[] {
  return mode === "planning"
    ? [...planningPiToolNames(), ...["canvas_check", "read_project_file", "read_attachment", "recall_image", "list_media_capabilities", "list_animation_actions", "read_workflow_guide"].filter(name => registeredToolNames.includes(name))]
    : activePiToolNames(enabledTools, registeredToolNames);
}

export type AskQuestionnaire = (
  toolCallId: string,
  input: {
    previousPaidCount?: number;
    questions: Array<{
      id: string;
      prompt: string;
      options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
      allowOther?: boolean;
    }>;
  },
  signal?: AbortSignal,
  paidMediaTool?: ToolId,
) => Promise<QuestionnaireResult>;


const mediaModelParameter = () => Type.Object({
  provider: Type.String({ description: "Model provider ID" }),
  id: Type.String({ description: "Provider model ID" }),
}, { description: "Omit this object to use the project selection. To override, use an exact provider and id offered for this operation by list_media_capabilities; do not guess either value." });

const animationRigParameters = {
  model: Type.Optional(mediaModelParameter()),
  rigModel: Type.Optional(Type.Union([Type.Literal("v1.0-20240301"), Type.Literal("v2.5-20260210"), Type.Literal("v3.0-20260909")])),
  rigType: Type.Optional(Type.Union([Type.Literal("biped"), Type.Literal("quadruped"), Type.Literal("hexapod"), Type.Literal("octopod"), Type.Literal("avian"), Type.Literal("serpentine"), Type.Literal("aquatic"), Type.Literal("others")])),
};

const recoverCallIdParameter = () => Type.Optional(Type.String({
  minLength: 1, maxLength: 512, description: "For recovery, use the actual original call ID from this conversation. When its arguments are in history, supply only this ID. For a new request omit this property entirely. Never send null or a placeholder.",
}));

const imageParameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: "A detailed description of the new image, required for a new generation." }),
  recoverCallId: recoverCallIdParameter(),
  imageModel: Type.Optional(mediaModelParameter()),
  imagePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: IMAGE_MAX_REFERENCE_IMAGES, description: "PNG/JPEG references: project-relative paths or exact attachment:batch/id receipts from the current conversation branch (attachments up to 20 MiB). Requires resolution and aspectRatio together. Session image IDs and URLs are not paths." })),
  maskPath: Type.Optional(Type.String({ minLength: 1, description: "Project-relative PNG edit mask. Requires at least one reference and a model that supports masks." })),
  quality: Type.Optional(Type.Union((["auto", "low", "medium", "high", "xhigh", "max"] as const).map((value) => Type.Literal(value)), { description: "Selected-model quality level; xhigh/max can require a long synchronous wait." })),
  outputFormat: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
  outputCompression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "JPEG compression only; omit for PNG." })),
  background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")], { description: "Transparent output requires a supporting model and PNG; a prompt alone does not enable alpha." })),
  size: Type.Optional(Type.Union([
    Type.Literal("1024x1024"),
    Type.Literal("1536x1024"),
    Type.Literal("1024x1536"),
  ], { description: "Legacy output size. Do not combine with resolution or aspectRatio." })),
  resolution: Type.Optional(Type.Union([
    Type.Literal("512"),
    Type.Literal("1K"),
    Type.Literal("2K"),
    Type.Literal("4K"),
  ], { description: "Output resolution. Provide together with aspectRatio. Use a value supported by the selected image model." })),
  aspectRatio: Type.Optional(Type.Union([
    Type.Literal("1:1"),
    Type.Literal("2:3"),
    Type.Literal("3:2"),
    Type.Literal("3:4"),
    Type.Literal("4:3"),
    Type.Literal("4:5"),
    Type.Literal("5:4"),
    Type.Literal("9:16"),
    Type.Literal("16:9"),
    Type.Literal("21:9"),
  ], { description: "Output aspect ratio. Provide together with resolution. Use a value supported by the selected image model." })),
});

const model3DParameters = Type.Object({
  recoverCallId: recoverCallIdParameter(),
  operation: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("text"), Type.Literal("retexture"), Type.Literal("remesh")], { description: "Defaults to image" })),
  imagePath: Type.Optional(Type.String({ description: "Project PNG, JPEG or WebP for a single-view study or Hyper3D retexture. Use imagePaths for production from concept art." })),
  imagePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "For production modeling from concept art, inspect and send separate orthographic views of the same subject in front, left, back, optional right order. Supply this field alone for the image list." })),
  prompt: Type.Optional(Type.String({ description: "Object description for text generation, or material/style description for retexture" })),
  sourcePath: Type.Optional(Type.String({ description: "Source GLB path for retexture/remesh" })),
  targetPolycount: Type.Optional(Type.Integer({ minimum: 48, maximum: 2000000 })),
  texture: Type.Optional(Type.Boolean()), pbr: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Object({
    referenceMode: Type.Optional(Type.Union([Type.Literal("turnaround"), Type.Literal("provided-views")], { description: "Image generation defaults to turnaround, requiring three distinct views before formal modeling. Use provided-views only for a deliberately requested study using the available views. Never downgrade a production request to bypass a missing view." })),
    pose: Type.Optional(Type.Union([Type.Literal("a-pose"), Type.Literal("t-pose")], { description: "For Tripo image generation this describes the required pose in the actual reference pictures. Tripo text generation does not accept this option; describe the desired pose in prompt instead. It cannot re-pose an action illustration." })),
    textureModel: Type.Optional(Type.String({ description: "Independent documented texture version, not the geometry version" })),
    textureQuality: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("detailed"), Type.Literal("extreme")])),
    quad: Type.Optional(Type.Boolean({ description: "Tripo quad output preserves an FBX original and makes a separate triangulated GLB preview locally; remesh is limited to 10,000 quads" })),
    smartUv: Type.Optional(Type.Boolean({ description: "Tripo remesh v3.0 only; unwrap UV in the same remesh operation" })),
    geometryQuality: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("detailed")], { description: "Tripo H v3 generation only" })),
  })),
  model: Type.Optional(mediaModelParameter()),
});

const turnaround3DParameters = Type.Object({
  imagePaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 3, maxItems: 4, description: "The inspected project image paths in front, left, back, optional right order." }),
  ...Type.Pick(model3DParameters, ["model", "targetPolycount", "texture", "pbr"]).properties,
  options: Type.Optional(Type.Pick(model3DParameters.properties.options, ["pose", "textureModel", "textureQuality", "quad", "geometryQuality"], { additionalProperties: false })),
}, { additionalProperties: false });

const referenceImageParameters = Type.Object({
  ...Type.Required(Type.Pick(imageParameters, ["prompt", "imagePaths", "resolution", "aspectRatio"])).properties,
  quality: imageParameters.properties.quality,
  background: imageParameters.properties.background,
}, { additionalProperties: false });

function placeholder(value: unknown): boolean {
  return value == null || typeof value === "string" && /^(?:null|undefined|none|n\/a)?$/i.test(value.trim());
}

function recoveryPlaceholder(id: unknown): boolean {
  return placeholder(id) || typeof id === "string" && id.trim().toLowerCase() === "new";
}

function usableRecoveryId(id: unknown, limit: number): id is string {
  return typeof id === "string" && id === id.trim() && id.length <= limit && !/[\u0000-\u001f\u007f]/.test(id) && !recoveryPlaceholder(id);
}

function prepare3DImageArguments(raw: Record<string, unknown>, corrections: string[], recovering: boolean): Record<string, unknown> {
  const input = { ...raw };
  const hasSingle = typeof input.imagePath === "string" && !placeholder(input.imagePath);
  const hasViews = Array.isArray(input.imagePaths) && input.imagePaths.length > 0;
  if (hasSingle || hasViews) {
    for (const key of ["imagePath", "sourcePath"]) {
      if (typeof input[key] === "string" && !input[key].trim()) delete input[key];
    }
    if (hasSingle && Array.isArray(input.imagePaths) && !input.imagePaths.length) delete input.imagePaths;
  }
  const options = input.options;
  if (options && typeof options === "object" && !Array.isArray(options) && "smartUv" in options) {
    if (options.smartUv === false) {
      const { smartUv: _disabled, ...rest } = options;
      input.options = rest;
    } else if (!recovering) {
      corrections.push("smartUv is a remesh-only option. Keep a requested Smart UV pass separate from image modeling.");
    }
  }
  if (recovering) return input;
  if (typeof input.sourcePath === "string" && !placeholder(input.sourcePath)) {
    corrections.push("sourcePath selects an existing model for remesh or retexture. Choose that operation or keep only the references for a new image-based model.");
  }
  if (typeof input.prompt === "string" && input.prompt.trim()) {
    corrections.push("Image-to-3D uses the inspected views. The provider cannot apply a text prompt to them. Keep the brief for checking the result; if a requirement is missing from the views or settings, resolve it before modeling. For text alone use operation=text without images.");
    const candidate = { ...input };
    delete candidate.operation;
    delete candidate.prompt;
    if (candidate.options && typeof candidate.options === "object" && "referenceMode" in candidate.options && candidate.options.referenceMode === "turnaround") {
      const { referenceMode: _implicit, ...rest } = candidate.options;
      candidate.options = rest;
    }
    if (corrections.length === 1 && Check(turnaround3DParameters, candidate) && !candidate.imagePaths.some(placeholder)) {
      const json = JSON.stringify(candidate);
      if (!containsKnownSensitiveValue(json)) corrections.push(`Only if the checked views and settings already cover the brief, call ${TURNAROUND_3D_TOOL} with this object: ${json}.`);
    }
  }
  return input;
}

/** Pi normalizes optional nulls before executing tools. Inspect intent before that normalization. */
function checkMediaArguments(tool: PiToolDefinition, value: unknown, options: {
  allowLegacyImageSize?: boolean; originalRecovery?: boolean; currentSelections?: () => ProjectState["modelSelections"];
} = {}): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supply a JSON object of media arguments.");
  let input = value as Record<string, unknown>;
  const corrections: string[] = [];
  const canvas = ["generate_canvas_media", "recover_canvas_media", "replace_canvas_media"].includes(tool.name);
  const recoveryKey = canvas ? "recoverJobId" : "recoverCallId";
  const { properties: fields, required = [] } = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  for (const field of required) {
    if (!Object.hasOwn(input, field)) corrections.push(`Missing required field ${field} for ${tool.name}.`);
  }
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(fields, key)) continue;
    if (key === "size" && tool.name === "generate_image") {
      if (!options.allowLegacyImageSize && input.resolution === undefined && input.aspectRatio === undefined) corrections.push("For new images remove the size key entirely. Specify resolution and aspectRatio together, or omit both for the default.");
    } else if (tool.name === REFERENCE_IMAGE_TOOL && ["maskPath", "outputFormat", "outputCompression", "imageModel"].includes(key)) {
      corrections.push(`Field ${key} is not accepted by ${REFERENCE_IMAGE_TOOL}. For an actual masked edit use generate_image with the real reference and PNG maskPath. For an explicit model or format use generate_image.`);
    } else if (tool.name === TURNAROUND_3D_TOOL && ["imagePath", "sourcePath", "prompt", "operation"].includes(key)) {
      corrections.push(`${TURNAROUND_3D_TOOL} uses only imagePaths for its source. Omit ${key}. Keep any written design requirements for checking the views; use generate_3d_asset for text-only generation or processing an existing mesh.`);
    } else if (canvas && (key === "recoverJobId" || key === "confirmedAudioJobId")) {
      corrections.push(`Remove ${key} from ${tool.name}. For an existing job use recover_canvas_media. A separately authorized replacement uses replace_canvas_media. For a new saved node send generate_canvas_media only boardId and nodeId.`);
    } else {
      corrections.push(`Unknown field ${JSON.stringify(key)} for ${tool.name}. For recovery use ${canvas ? "recover_canvas_media with recoverJobId" : "recover_media with the original tool name and recoverCallId"}.`);
    }
  }
  for (const key of canvas ? [recoveryKey, "confirmedAudioJobId"] : [recoveryKey]) {
    const id = input[key];
    if (Object.hasOwn(input, key) && !usableRecoveryId(id, canvas ? 120 : 512)) {
      const operation = key === "confirmedAudioJobId" ? "replace_canvas_media" : canvas ? "recover_canvas_media" : "recover_media";
      corrections.push(`${key} requires the actual original ID for ${operation}. Stop if the ID cannot be found. A new generation takes no recovery or replacement fields.`);
    }
  }
  if (tool.name === "recover_media" && Object.hasOwn(input, "originalArguments")) {
    const original = input.originalArguments;
    if (!original || typeof original !== "object" || Array.isArray(original) || Object.hasOwn(original, "recoverCallId")) {
      corrections.push("originalArguments must be an object containing only the original generation inputs. Omit it when the original is in history.");
    }
  }
  if (canvas && Object.hasOwn(input, recoveryKey) && Object.hasOwn(input, "confirmedAudioJobId")) {
    corrections.push("For canvas recovery call recover_canvas_media with boardId, nodeId and recoverJobId. Remove confirmedAudioJobId, which concerns a new paid generation.");
  }
  // With a real recovery ID, the original branch arguments take precedence.
  if (!Object.hasOwn(input, recoveryKey) || corrections.length) {
    if (tool.name === "generate_3d_asset" && (input.operation ?? "image") === "image" && !Object.hasOwn(input, recoveryKey)) {
      input = prepare3DImageArguments(input, corrections, options.originalRecovery === true);
    }
    if (tool.name === "generate_image" && input.size !== undefined && (input.resolution !== undefined || input.aspectRatio !== undefined)) {
      corrections.push("Conflicting fields: size and resolution/aspectRatio. For modern sizing remove the size key entirely and keep resolution and aspectRatio together. Example: {\"prompt\":\"Forest at dusk\",\"resolution\":\"1K\",\"aspectRatio\":\"16:9\"}.");
    }
    if (!options.originalRecovery && tool.name === "generate_image" && input.outputFormat === "png" && Object.hasOwn(input, "outputCompression")) {
      corrections.push("outputCompression applies only to JPEG. Keep outputFormat png and remove outputCompression for PNG.");
    }
    if (tool.name === "generate_3d_asset" && input.imagePath !== undefined && input.imagePaths !== undefined) {
      corrections.push("Choose one image input. For production keep the inspected front, left, back and optional right in imagePaths and remove imagePath. For a single image remove the imagePaths key entirely.");
    }
    for (const field of ["maskPath", "imagePath", "sourcePath", "referenceAssetId"]) {
      if (Object.hasOwn(input, field) && placeholder(input[field])) corrections.push(`Omit the unused ${field} key entirely or supply a real value.`);
    }
    if (Array.isArray(input.imagePaths) && (input.imagePaths.some(placeholder) || !input.imagePaths.length &&
      (mediaToolId(tool.name) === "generate-image" || !input.imagePath && (input.operation ?? "image") === "image"))) {
      corrections.push("imagePaths must contain real project image paths. Omit that key when no reference list is used.");
    }
  }
  if (tool.name === REFERENCE_IMAGE_TOOL && !corrections.length && !Check(referenceImageParameters, value)) {
    corrections.push("Provide prompt, imagePaths with at least one real reference, resolution and aspectRatio. Supply only supported quality and background values.");
  }
  if (tool.name === TURNAROUND_3D_TOOL && !corrections.length && !Check(turnaround3DParameters, value)) {
    corrections.push("Provide three or four distinct project paths in imagePaths: front, left, back, and optional right. Turnaround is implicit. Omit options.referenceMode and remesh-only options.smartUv.");
  }
  if (corrections.length) {
    if (tool.name === "generate_image" && options.currentSelections && (input.maskPath === null || input.maskPath === "null")
        && Array.isArray(input.imagePaths) && input.imagePaths.length && !input.imagePaths.some(placeholder)) {
      const corrected = { ...input };
      delete corrected.maskPath;
      if (corrected.outputFormat === "png") delete corrected.outputCompression;
      // Only suggest a new request if it preserves every other setting and has no recovery fields.
      if (Check({ ...tool.parameters, additionalProperties: false }, corrected)
          && corrected.resolution && corrected.aspectRatio) {
        const selected = options.currentSelections()?.image;
        const model = corrected.imageModel;
        const modelMatches = !model || selected && Check(mediaModelParameter(), model) && model.provider === selected.provider && model.id === selected.id;
        const nativeFormat = !corrected.outputFormat || corrected.outputFormat === "png" && selected?.provider === "openai"
          && imageModelCapabilities(selected.id).outputFormats?.includes("png");
        const useReference = modelMatches && nativeFormat && corrected.outputCompression === undefined;
        const args = useReference ? Object.fromEntries(Object.entries(corrected).filter(([key]) => Object.hasOwn(referenceImageParameters.properties, key))) : corrected;
        corrections.push(`For a new whole-image request without a mask, send a fresh ${useReference ? REFERENCE_IMAGE_TOOL : "generate_image"} call with this exact object: ${JSON.stringify(args)}. For a localized edit, supply the real PNG mask instead.`);
      }
    }
    throw new Error(`${tool.name}: ${corrections.join(" ")} No generation was submitted.`);
  }
  return input;
}

async function readProjectImage(workspacePath: string, file: string, purpose: "reference" | "mask" | "model", signal?: AbortSignal): Promise<PromptImage> {
  signal?.throwIfAborted();
  const source = await getWorkspaceMedia(workspacePath, file);
  const mask = purpose === "mask";
  if (purpose === "model" && source.contentType === "image/webp") return readWebpModelReference(workspacePath, source);
  if (source.contentType !== "image/png" && (mask || source.contentType !== "image/jpeg")) {
    throw new Error(mask ? "Edit masks require PNG" : purpose === "model" ? "3D generation requires PNG, JPEG or WebP reference images" : "Image references require PNG or JPEG");
  }
  if (!source.size || source.size > 32 * 1024 * 1024) throw new Error("Image inputs must be between 1 byte and 32 MiB");
  const bytes = await readFile(source.absolutePath);
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("Image inputs must be between 1 byte and 32 MiB");
  const libraryAssetId = mask ? undefined : (await readAssetMetadata(workspacePath)).libraryAssets[source.relativePath];
  return { mediaType: source.contentType as "image/png" | "image/jpeg", data: bytes.toString("base64"), ...(libraryAssetId ? { libraryAssetId } : {}) };
}

export function createAgentTools(
  project: ProjectState,
  tools: ToolRunner,
  projects: ProjectManager,
  askQuestionnaire?: AskQuestionnaire,
  playtest?: { driver: GameRuntimeAdapter; resolveOpenTarget: () => Promise<GameUseOpenTarget> },
  canvasStore?: CanvasStore,
  generationScope?: string,
  enabledMediaTools?: () => readonly ToolId[],
  authorizeAttachment?: AuthorizeAgentAttachment,
): PiToolDefinition[] {
  const attachmentRead = createAgentAttachmentReadTool(project.workspacePath, true, authorizeAttachment);
  const readImageReference = async (file: string, signal?: AbortSignal): Promise<PromptImage> => {
    if (!file.startsWith("attachment:")) return readProjectImage(project.workspacePath, file, "reference", signal);
    const result = await attachmentRead.execute("image-reference", { path: file }, signal, undefined, {} as never);
    const image = result.content.find(block => block.type === "image");
    if (image?.type !== "image" || !["image/png", "image/jpeg"].includes(image.mimeType))
      throw new Error("Image references require PNG or JPEG attachments; preserve the original. No generation was submitted.");
    signal?.throwIfAborted();
    return { mediaType: image.mimeType as "image/png" | "image/jpeg", data: image.data };
  };
  const recoveryOptions = (toolId: ToolId, callId: string, signal?: AbortSignal) => {
    const scope = [project.id, generationScope ?? project.id, toolId];
    return {
      recoveryId: createHash("sha256").update(JSON.stringify([...scope, callId])).digest("hex"),
      agentCall: { callId, scope: createHash("sha256").update(JSON.stringify(scope)).digest("hex") },
      ...(askQuestionnaire ? { confirmNew: async (previousIds: readonly string[]) => {
        const answer = await askQuestionnaire(callId, { previousPaidCount: previousIds.length, questions: [{
          id: "new-paid-media", prompt: `Previous ${toolId} requests that may already have been billed: ${previousIds.length}. Authorize one new paid generation?`,
          allowOther: false, options: [{ value: "keep", label: "Keep the original request", recommended: true }, { value: "new", label: "Authorize a new paid generation" }],
        }] }, signal, toolId);
        return !answer.cancelled && answer.answers.some((choice) => choice.questionId === "new-paid-media" && choice.value === "new" && !choice.custom);
      } } : {}),
    };
  };
  async function rememberRecovery(toolId: ToolId, callId: string, missingOriginalId = false) {
    const { agentCall, recoveryId } = recoveryOptions(toolId, callId);
    await tools.agentMedia.adopt(agentCall, recoveryId, missingOriginalId);
  }
  async function adoptBranchFailures(toolId: ToolId, branch: readonly SessionEntry[]) {
    const toolName = PI_TOOL_NAMES[toolId];
    const schema = registeredTools.find(tool => tool.name === toolName)?.parameters;
    const creationFields = Type.IsObject(schema) ? schema.properties : {};
    // Older agent calls have only a provider journal. Look up the most recent
    // unfinished same-tool batch on this branch. A successful sibling in the
    // same batch does not resolve that batch's failed asset.
    const canvasNames = ["generate_canvas_media", "recover_canvas_media", "replace_canvas_media"];
    const aliases = mediaToolAliases.filter(([, id]) => id === toolId).map(([name]) => name);
    const relevantNames = new Set([toolName, ...aliases, "recover_media", ...canvasNames]);
    const outcomes = new Map<string, { name: string; isError: boolean; rejectedBeforeExecution: boolean; legacy3DPathError: boolean }>();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message.role === "toolResult" && relevantNames.has(message.toolName)) {
        // Pi adds durationMs only after execution. Missing or truncated historical errors alone are not proof.
        const rejectedBeforeExecution = message.isError && message.durationMs === undefined && Boolean(message.content?.some(item => item.type === "text"
          && (item.text.startsWith(`Validation failed for tool "${message.toolName}":`) || item.text.endsWith("No generation was submitted.")
            && (item.text.startsWith(`${message.toolName}: `) || item.text.startsWith("Unknown field ")))));
        const legacy3DPathError = message.toolName === PI_TOOL_NAMES["image-to-3d"] && message.isError && message.durationMs === 0
          && message.content?.length === 1 && message.content[0].type === "text" && message.content[0].text === conflicting3DImagePaths;
        outcomes.set(message.toolCallId, { name: message.toolName, isError: message.isError, rejectedBeforeExecution, legacy3DPathError });
      } else if (message.role === "assistant") {
        let succeeded = false;
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const outcome = outcomes.get(block.id);
          if (!outcome || outcome.name !== block.name) continue;
          outcomes.delete(block.id);
          const args = block.arguments;
          const dedicatedRecovery = block.name === "recover_media" || block.name === "recover_canvas_media";
          const canvas = canvasNames.includes(block.name);
          if (canvas) {
            if (!outcome.isError) continue;
            const rejectedRecovery = dedicatedRecovery && outcome.rejectedBeforeExecution || Object.hasOwn(args, "recoverCallId") || Object.hasOwn(args, "recoverJobId") &&
              (outcome.rejectedBeforeExecution || !usableRecoveryId(args.recoverJobId, 120) || Object.hasOwn(args, "confirmedAudioJobId"));
            if (!canvasStore || !rejectedRecovery) continue;
            if (typeof args.boardId !== "string" || typeof args.nodeId !== "string") continue;
            const detail = await canvasStore.board(project.id, args.boardId).catch((cause) => {
              if (cause?.statusCode !== 404) throw cause;
            });
            const node = detail?.board.nodes.find(candidate => candidate.id === args.nodeId);
            if (!node || CANVAS_MEDIA_TOOLS[node.type] !== toolId) continue;
          } else if (mediaToolId(block.name) !== toolId && !(block.name === "recover_media" && mediaToolId(args.tool) === toolId)) {
            continue;
          }
          if (!outcome.isError) {
            if (mediaToolId(block.name) === toolId && !Object.hasOwn(args, "recoverCallId")) succeeded = true;
          } else if (dedicatedRecovery || Object.hasOwn(args, "recoverCallId") || Object.hasOwn(args, "recoverJobId")) {
            const suppliedIds = ["recoverCallId", "recoverJobId", "confirmedAudioJobId"].filter(key => Object.hasOwn(args, key));
            const hasGenerationInputs = canvas || Object.keys(args).some(key => !suppliedIds.includes(key) && Object.hasOwn(creationFields, key));
            // This legacy execute guard ran before any file read or provider operation.
            // An older caller could still have journaled under its literal placeholder.
            const legacy3DRejection = outcome.legacy3DPathError && args.operation === "image" && args.recoverCallId === "null"
              && suppliedIds.length === 1 && args.sourcePath === "" && typeof args.imagePath === "string" && Boolean(args.imagePath.trim())
              && Array.isArray(args.imagePaths) && args.imagePaths.length === 0
              && !await tools.mediaWasAttempted(toolId, recoveryOptions(toolId, "null").recoveryId);
            if (!dedicatedRecovery && hasGenerationInputs && (outcome.rejectedBeforeExecution || legacy3DRejection) && suppliedIds.every(key => recoveryPlaceholder(args[key]))) {
              // Older versions recorded the rejected tool call itself as an unresolved original.
              const { agentCall, recoveryId } = recoveryOptions(toolId, block.id);
              if (await tools.mediaWasAttempted(toolId, recoveryId)) await tools.agentMedia.adopt(agentCall, recoveryId);
              else await tools.agentMedia.dismissRejectedPlaceholder(agentCall, recoveryId);
              continue;
            }
            // The SDK can reject a malformed recovery before execute() records its receipt.
            const id = args.recoverCallId;
            const usable = !canvas && usableRecoveryId(id, 512);
            await rememberRecovery(toolId, usable ? id : block.id, !usable);
          } else {
            const { agentCall, recoveryId } = recoveryOptions(toolId, block.id);
            if (await tools.mediaWasAttempted(toolId, recoveryId)) await tools.agentMedia.adopt(agentCall, recoveryId);
          }
        }
        if (succeeded) break;
      }
    }
  }
  async function deliverMedia<T>(runId: string, callId: string, deliver: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await deliver(); }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Project delivery failed";
      throw new Error(`${reason}. Generated media is retained. Use recover_media with the original tool and recoverCallId ${JSON.stringify(callId)} to save the same result.`);
    }
    await tools.removeRun(runId);
    return result;
  }
  async function generateImage(originalTool: string, toolCallId: string, input: Static<typeof imageParameters>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { recoverCallId } = input;
    const options = recoveryOptions("generate-image", recoverCallId ?? toolCallId, signal);
    const configured = input.resolution !== undefined || input.aspectRatio !== undefined;
    if (input.size !== undefined && configured) throw new Error("Image size cannot be combined with resolution or aspect ratio");
    if (configured && (input.resolution === undefined || input.aspectRatio === undefined)) throw new Error("Image resolution and aspect ratio must be provided together");
    if ((input.imagePaths?.length ?? 0) > IMAGE_MAX_REFERENCE_IMAGES) throw new Error(`Provide up to ${IMAGE_MAX_REFERENCE_IMAGES} reference images`);
    if (input.imagePaths?.length && !configured) throw new Error("Reference images require resolution and aspect ratio together");
    if (input.maskPath && !input.imagePaths?.length) throw new Error("An edit mask requires at least one reference image");
    const prepareInput = async (): Promise<RunImageToolRequest> => {
      const images = await Promise.all((input.imagePaths ?? []).map((file) => readImageReference(file, signal)));
      const mask = input.maskPath ? await readProjectImage(project.workspacePath, input.maskPath, "mask", signal) : undefined;
      const settings = {
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        ...(input.outputFormat !== undefined ? { outputFormat: input.outputFormat } : {}),
        ...(input.outputCompression !== undefined ? { outputCompression: input.outputCompression } : {}),
        ...(input.background !== undefined ? { background: input.background } : {}),
        ...(mask ? { mask } : {}),
      };
      return input.resolution !== undefined && input.aspectRatio !== undefined
        ? { prompt: input.prompt, ...settings, resolution: input.resolution, aspectRatio: input.aspectRatio, ...(images.length ? { images } : {}) }
        : { prompt: input.prompt, ...settings, ...(input.size !== undefined ? { size: input.size } : {}) };
    };
    const run = await tools.run("generate-image", recoverCallId && input.imagePaths?.length ? prepareInput : await prepareInput(), signal, project.id, {
      ...options, ...(recoverCallId !== undefined ? { imageRecoveryOnly: true } : {}),
    }).catch(async (cause: unknown) => {
      if (signal?.aborted || cause instanceof MediaAlreadyDelivered) throw cause;
      if (await tools.hasSavedImageResult(options.recoveryId)) {
        const recovery = JSON.stringify({ tool: originalTool, recoverCallId: recoverCallId ?? toolCallId });
        throw new Error(`${cause instanceof Error ? cause.message : "Image could not be downloaded."} A saved provider result is available. Call recover_media with ${recovery} to download it without generating again.`);
      }
      throw cause;
    });
    let originalRetained = false;
    try {
      const output = run.files[0];
      if (!output) throw new Error("Image generator returned no output");
      const file = await tools.file(run.id, output.name);
      if (!file) throw new Error("Generated image could not be read");
      signal?.throwIfAborted();
      const extension = output.mediaType === "image/png" ? "png" : output.mediaType === "image/jpeg" ? "jpg" : "webp";
      const fileName = `image-${run.id}.${extension}`;
      const resource = await projects.addGeneratedWorkingImage(project.id, fileName, file.bytes, { prompt: input.prompt, ...(file.assetId ? { libraryAssetId: file.assetId } : {}) }, signal);
      originalRetained = true;
      const transparencyWarning = resource.ready && input.background === "transparent" && !resource.hasTransparency
        ? "Requested transparency is absent: this output has no transparent pixels. The original and working copy are retained. Do not describe it as a transparent sprite; inspect or prepare it locally before game use."
        : "";
      return {
        content: [{ type: "text" as const, text: resource.ready
          ? `Working image saved to ${resource.path} (${resource.width}×${resource.height}, ${resource.workingBytes} bytes). Original retained as ${resource.originalId} outside execution. Copy the working image into src/ or public/ for game use. Local preparation preserves dimensions by default; use optimize_image_asset with maxEdge only for an explicitly chosen runtime derivative. Execution transfer budgets still apply. Do not regenerate to repair local assets.${transparencyWarning ? `\n${transparencyWarning}` : ""}`
          : `Generated original retained as ${resource.originalId} outside execution. No oversized image was added to the workspace. ${resource.error}. Recover using optimize_image_asset with this originalId and destination ${JSON.stringify(`assets/generated/${fileName}`)}; do not regenerate.` }],
        details: { imageResource: resource, ...(resource.ready ? { artifact: { type: "image", path: resource.path, mediaType: resource.mediaType } } : {}) },
      };
    } catch (cause) {
      throw new Error(`Local image preparation failed; generated result remains in tool run ${run.id}. Recover with recover_media ${JSON.stringify({ tool: originalTool, recoverCallId: recoverCallId ?? toolCallId })}. Do not regenerate. ${cause instanceof Error ? cause.message : "Original retention failed"}`);
    } finally {
      if (originalRetained) await tools.removeRun(run.id);
    }
  }
  const saveGeneratedAudio = async (
    toolId: "generate-speech" | "generate-sound-effect" | "generate-music",
    request: RunToolRequest,
    prompt: string,
    prefix: string,
    toolCallId: string,
    signal?: AbortSignal,
    recoverCallId?: string,
  ) => {
    const callId = recoverCallId ?? toolCallId;
    const run = await tools.run(toolId, request, signal, project.id, { ...recoveryOptions(toolId, callId, signal), ...(recoverCallId ? { audioRecoveryOnly: true } : {}) });
    try {
      const output = run.files[0];
      if (!output) throw new Error("Audio generator returned no output");
      const file = await tools.file(run.id, output.name);
      if (!file) throw new Error("Generated audio could not be read");
      signal?.throwIfAborted();
      const extension = output.mediaType === "audio/wav" ? "wav" : "mp3";
      const relativePath = await projects.addGeneratedAsset(project.id, `${prefix}-${run.id}.${extension}`, file.bytes, {
        prompt,
        ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
      });
      await tools.removeRun(run.id);
      return {
        content: [{ type: "text" as const, text: `Generated audio saved to ${relativePath}` }],
        details: { artifact: { type: "audio", path: relativePath, mediaType: output.mediaType } },
      };
    } catch {
      throw new Error(`Audio was received (local run ${run.id}). Call recover_media with ${JSON.stringify({ tool: PI_TOOL_NAMES[toolId], recoverCallId: callId })} to save the existing audio without generating it again.`);
    }
  };
  const canvasNodeParameters = {
    boardId: Type.String({ minLength: 1, maxLength: 100 }),
    nodeId: Type.String({ minLength: 1, maxLength: 120 }),
  };
  const canvasJobId = Type.String({ minLength: 1, maxLength: 120, description: "Use the existing job ID from this node's history." });
  async function directCanvasResult(result: Awaited<ReturnType<PiToolDefinition["execute"]>>) {
    const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
    const job = details.canvasGeneration as import("../shared/contracts.js").ToolJob | undefined;
    const file = job?.run?.files[0];
    const asset = file?.assetId ? (await readCanvasAssets(project.workspacePath)).assets[file.assetId] : undefined;
    if (!file || !asset) return result;
    const type = file.mediaType.startsWith("image/") ? "image" : file.mediaType.startsWith("video/") ? "video" : file.mediaType.startsWith("audio/") ? "audio" : "model";
    const fbx = file.mediaType === "application/vnd.autodesk.fbx";
    if (fbx && !asset.modelPreviewPath) return result;
    return { ...result, details: { ...details, artifact: { type, path: fbx ? asset.modelPreviewPath : asset.path, mediaType: fbx ? "model/gltf-binary" : file.mediaType } } };
  }
  async function canvasGenerationResult(nodeId: string, current: import("../shared/contracts.js").ToolJob, recovering: boolean) {
    const manifest = await readCanvasAssets(project.workspacePath);
    const assets = current.run?.files?.flatMap(file => file.assetId && manifest.assets[file.assetId] ? [manifest.assets[file.assetId]!] : []) ?? [];
    const paths = assets.flatMap(asset => [asset.path, asset.modelRuntimePath ?? asset.modelPreviewPath].filter(Boolean));
    if (recovering) {
      if (!assets.length || assets.length !== current.run?.files.length) throw new Error("The job completed but its local output is unavailable in this project. Check the original project or Library. No new generation was sent.");
      for (const asset of assets) await getWorkspaceMedia(project.workspacePath, asset.path);
    }
    const canvasAssets = current.run?.files?.flatMap(file => file.assetId && manifest.assets[file.assetId]
      ? [{ assetId: file.assetId, path: manifest.assets[file.assetId]!.path, registered: true, canvasOnly: manifest.assets[file.assetId]!.canvasOnly === true }] : []) ?? [];
    const candidates = canvasAssets.filter(asset => asset.canvasOnly).map(asset => asset.assetId);
    const usage = candidates.length ? ` Canvas candidates stay editor-only and are not in isolated_shell. Call use_canvas_asset with the selected assetId (${candidates.join(", ")}) and a public/ or src/ destination, then inspect its returned runtime path.` : "";
    return { content: [{ type: "text" as const, text: `Generated media for node ${nodeId}. Saved and registered in canvas/assets.json: ${paths.join(", ")}. Inspect or play the relevant output to evaluate the actual result.${usage}` }], details: { canvasGeneration: current, canvasAssets } };
  }
  const generate3DAsset = defineTool({
    name: PI_TOOL_NAMES["image-to-3d"],
    label: "Generate 3D Asset",
    promptGuidelines: ["Options depend on the selected model and operation. Use list_media_capabilities optionFieldsByOperation rather than combining unrelated generation, texture, remesh and rig settings. Tripo text generation accepts pose requirements in prompt, not options.pose. Only a host-owned invalid_media_options receipt proves that no generation was submitted; other provider errors and unknown outcomes require original-task recovery, not a replacement."],
    description: "Use generate_3d_from_views for production modeling from checked front, left and back reference views. Generate a GLB from images or text, retexture a source GLB, or remesh it through an available reviewed connection. Kunpo Tripo uses separate generation, texture and remesh versions. Its remesh v3.0 supports quad and smartUv; an unsupported artifact format fails explicitly instead of being labeled GLB. Author Cloud is unavailable.",
    parameters: model3DParameters,
    execute: async (toolCallId, input, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      if (input.imagePath && input.imagePaths) throw new Error(conflicting3DImagePaths);
      const imagePaths = input.imagePaths ?? (input.imagePath ? [input.imagePath] : []);
      const callId = input.recoverCallId ?? toolCallId;
      const prepareInput = async (): Promise<RunToolRequest> => {
        if (!input.recoverCallId) await tools.assertMediaInputOptions("image-to-3d", await tools.prepare("image-to-3d", input as RunToolRequest, project.id));
        const images: PromptImage[] = [];
        for (const file of imagePaths) images.push(await readProjectImage(project.workspacePath, file, "model", signal));
        signal?.throwIfAborted();
        const options = !input.recoverCallId && (input.operation ?? "image") === "image"
          ? { referenceMode: "turnaround" as const, ...input.options } : input.options;
        return {
          model: input.model, operation: input.operation, prompt: input.prompt,
          sourceAssetId: input.sourcePath ? await projects.ensureLibraryAsset(project.id, input.sourcePath) : undefined,
          targetPolycount: input.targetPolycount, texture: input.texture, pbr: input.pbr, options, images,
        };
      };
      const run = await tools.run("image-to-3d", input.recoverCallId ? prepareInput : await prepareInput(), signal, project.id, { ...recoveryOptions("image-to-3d", callId, signal), agentCanInspectImages: ctx?.model?.input?.includes("image"), ...(input.recoverCallId ? { model3DRecoveryOnly: true } : {}) });
      return deliverMedia(run.id, callId, async () => {
        const output = run.files[0];
        if (!output) throw new Error("3D generator returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Generated 3D model could not be read");
        signal?.throwIfAborted();
        const sourcePrompt = input.prompt ?? (imagePaths[0] ? await projects.generatedAssetPrompt(project.id, imagePaths[0]) : undefined);
        const fbx = output.mediaType === "application/vnd.autodesk.fbx";
        const retained = output.assetId && (fbx || file.bytes.length > 2 * 1024 * 1024) ? await projects.materializeLibraryAsset(project.id, output.assetId) : undefined;
        const relativePath = retained?.path ?? await projects.addGeneratedAsset(project.id, `model-${run.id}.${fbx ? "fbx" : "glb"}`, file.bytes, {
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
          ...(sourcePrompt ? { prompt: sourcePrompt } : {}),
          ...(file.preview ? {
            preview: {
              bytes: file.preview.bytes,
              extension: file.preview.mediaType === "image/png" ? "png" : "jpg",
            },
          } : {}),
        });
        const previewPath = retained?.modelRuntimePath ?? retained?.modelPreviewPath;
        return {
          content: [{ type: "text" as const, text: !fbx && !retained ? `Generated 3D model saved to ${relativePath}` : `${fbx ? "FBX original" : "Generated 3D model"} saved to ${relativePath}. ${retained?.modelRuntimePath ? `Game-ready model saved to ${retained.modelRuntimePath}; keep all returned resources together in the build. Use get_model_asset for validated runtime resources.` : fbx ? previewPath ? `Triangulated GLB preview saved to ${previewPath}; quad topology remains only in the FBX original.` : "The original is retained; a local preview is unavailable. Do not regenerate to repair a preview." : ""}`.trim() }],
          details: { modelResources: retained, ...(retained?.modelRuntimePath || fbx && !previewPath ? {} : { artifact: { type: "model", path: previewPath ?? relativePath, mediaType: "model/gltf-binary" } }) },
        };
      });
    },
  });
  const registeredTools: PiToolDefinition[] = [...(project.type === "web-game" ? [defineTool({
    name: "prepare_three_runtime",
    label: "Prepare Three.js",
    executionMode: "sequential",
    description: "Prepare the bundled offline Three.js runtime and its matching GLTFLoader in the game's startup directory. Call again to add the loader to an older bundled installation.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _input, signal) => {
      signal?.throwIfAborted();
      const runtime = await projects.prepareThreeRuntime(project.id);
      return {
        content: [{ type: "text", text: `Three.js ${runtime.version} is ready. Import Three.js (including AnimationMixer) from ${JSON.stringify(runtime.modulePath)} and the named GLTFLoader from ${JSON.stringify(runtime.gltfLoaderPath)}. These paths are workspace-relative; make imports relative to your game's source file. Include the entire ${JSON.stringify(runtime.directory)} directory in your build at the matching relative path, including add-ons and license.` }],
        details: { threeRuntime: runtime },
      };
    },
  })] : []), defineTool({
    name: "use_canvas_asset", label: "Use a Canvas asset in the game",
    description: "Copy an existing Canvas asset into the game's public/ or src/ directory at its original quality, without generating or charging, after checking the complete eligible workspace against the current media/source budgets. Read canvas/assets.json for the exact assetId. A copy still requires actual build/preview resource validation. Canvas candidate copies in assets/canvas/ are available to editor tools only. A different existing file is never replaced.",
    parameters: Type.Object({
      assetId: Type.String({ minLength: 1 }),
      destination: Type.String({ minLength: 1, description: "Project-relative runtime file with matching format, e.g. public/media/night-raid.mp4. Prefix the game's startupDirectory when set. A retained FBX preview can be used at a .glb destination." }),
      useOriginalImage: Type.Optional(Type.Boolean({ description: "For an older resized Canvas image, use its project-bound original Library image instead of the displayed working copy." })),
    }),
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const file = await projects.useCanvasAsset(project.id, input.assetId, input.destination, input.useOriginalImage, signal);
      return { content: [{ type: "text", text: `Canvas asset copied at ${file}. Reference this runtime file from the game and include it in the build, then validate actual resources with build/preview. Copying does not establish available guest storage, dependency/build space, format decoding or target-device performance. Inspect this path in isolated_shell; the original Canvas candidate stays editor-only.` }], details: { assetId: input.assetId, path: file } };
    },
  }), defineTool({
    name: "questionnaire",
    label: "Ask Questions",
    description: "Ask the user up to three high-impact clarifying questions when their answer is necessary to produce a correct plan. Do not ask for information you can discover from the project.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80, description: "Unique question identifier" }),
        prompt: Type.String({ minLength: 1, maxLength: 500, description: "Question shown to the user" }),
        options: Type.Array(Type.Object({
          value: Type.String({ minLength: 1, maxLength: 200, description: "Value returned for this option" }),
          label: Type.String({ minLength: 1, maxLength: 120, description: "Short option label" }),
          description: Type.Optional(Type.String({ maxLength: 300, description: "Optional explanation" })),
          recommended: Type.Optional(Type.Boolean({ description: "Whether this is the recommended option" })),
        }), { minItems: 2, maxItems: 4 }),
        allowOther: Type.Optional(Type.Boolean({ description: "Allow a custom answer; defaults to true" })),
      }), { minItems: 1, maxItems: 3 }),
    }),
    execute: async (toolCallId, input, signal) => {
      if (!askQuestionnaire) throw new Error("Questionnaire is not available");
      const result = await askQuestionnaire(toolCallId, input, signal);
      if (result.cancelled) {
        return { content: [{ type: "text", text: "The user skipped these questions. Continue with reasonable defaults." }], details: result };
      }
      return {
        content: [{ type: "text", text: result.answers.map((answer) => `${answer.questionId}: ${answer.label}`).join("\n") }],
        details: result,
      };
    },
  }), defineTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or update a concise implementation plan for multi-step work. Use at most one in_progress step.",
    parameters: Type.Object({
      explanation: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional explanation for this plan update" })),
      plan: Type.Array(Type.Object({
        step: Type.String({ minLength: 1, maxLength: 500, description: "Task step" }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }), { minItems: 1, maxItems: 12, description: "The complete list of plan steps" }),
    }),
    execute: async (_toolCallId, input) => {
      const steps = input.plan.map((item) => ({ step: item.step.trim(), status: item.status }));
      if (steps.some((item) => !item.step)) throw new Error("Plan steps cannot be blank");
      if (steps.filter((item) => item.status === "in_progress").length > 1) {
        throw new Error("A plan can have at most one in_progress step");
      }
      const plan: PlanState = {
        ...(input.explanation?.trim() ? { explanation: input.explanation.trim() } : {}),
        steps,
      };
      const completed = steps.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: `Plan updated: ${completed}/${steps.length} steps completed.` }],
        details: { plan },
      };
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-image"],
    label: "Generate Image",
    description: "Generate or edit an image using the project or global default model. If a submitted result could not be downloaded, call recover_media with the original tool name and call ID to retrieve the existing result. If recovery fails, report it and stop before starting another paid generation. Retain the original outside execution. Local working-image preparation preserves dimensions by default and remains subject to decoding, working-file and execution transfer budgets. Use optimize_image_asset with maxEdge only for an explicitly chosen runtime derivative; a transfer limit does not authorize silent resizing. For sprites and cutouts needing alpha, request outputFormat=png and background=transparent; do not choose JPEG or an opaque backdrop to reduce file size. Use optimize_image_asset locally for size recovery without billing. References accept project-relative PNG/JPEG files or exact authorized attachment:batch/id receipts; attachment originals are retained and added as Canvas reference sources before generation. Masks must be project-relative PNG files. Use only the selected model's documented parameters; unsupported options are rejected. Sunburst/Flare support transparent PNG and PNG masks; Image-GI2.1 does not support transparency or masks.",
    parameters: imageParameters,
    execute: (id, input, signal) => generateImage(PI_TOOL_NAMES["generate-image"], id, input, signal),
  }), defineTool({
    name: REFERENCE_IMAGE_TOOL,
    label: "Generate Reference Image",
    description: "Create a new whole image from existing reference pictures, including a character turnaround view. Use the project-selected image model and its native output (PNG by default for Sunburst/Flare). Supply quality or background only if supported. For a localized PNG-mask edit or an explicit output format/model override, use generate_image. To retrieve a previous result use recover_media with the original tool name and call ID.",
    parameters: referenceImageParameters,
    execute: (id, input, signal) => generateImage(REFERENCE_IMAGE_TOOL, id, input, signal),
  }), generate3DAsset, defineTool({
    name: TURNAROUND_3D_TOOL,
    label: "Generate 3D From Views",
    description: "Build a production model from inspected orthographic front, left and back images of one subject; add the right view if available. Supply imagePaths in that order, plus any supported geometry and texture settings. The project-selected 3D model is used unless explicitly overridden. For an existing paid result call recover_media with the original tool name and call ID.",
    parameters: turnaround3DParameters,
    execute: (id, input, signal, update, ctx) => generate3DAsset.execute(id, {
      ...input, operation: "image", options: { ...input.options, referenceMode: "turnaround" },
    }, signal, update, ctx),
  }), defineTool({
    name: "optimize_image_asset", label: "Prepare local working images",
    executionMode: "sequential",
    description: "Prepare existing PNG/JPEG/WebP images locally without model calls or a VM. Default identity preparation preserves original dimensions and pixels; lossless preparation is preferred. Preserves verified originals outside execution and alpha. Alpha flags do not verify clean edges: assess residue by location, area, background composites and intended use; a few low-alpha pixels alone do not justify regeneration or a universal cleanup cutoff. For oversized legacy images, pass all affected paths together (up to 16); replacements keep the same paths and format after aggregate budget admission. Or use originalId plus a new destination to recover retained generation output. Set maxEdge only for an explicit runtime derivative that fits the intended display; never assign dimensions by asset category or increase quality automatically. Check atlas layout and anchors before resizing. Returns dimensions and hashes; file size, RGBA8 and mip estimates do not verify device performance or FPS. Never regenerate to repair source-budget errors.",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16 })), originalId: Type.Optional(Type.String()), destination: Type.Optional(Type.String()), maxEdge: Type.Optional(Type.Union([Type.Literal(256), Type.Literal(512), Type.Literal(1024), Type.Literal(1536), Type.Literal(2048)])) }),
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const resources = await projects.optimizeImageAssets(project.id, input, signal);
      return { content: [{ type: "text", text: JSON.stringify(resources) }], details: { imageResources: resources } };
    },
  }), defineTool({
    name: "get_model_asset", label: "Get local model resources",
    description: "List this project's model bindings, or resolve one model to its original and game runtimePath with geometry and animation clip metadata. Use runtimePath in game code, not an FBX source or private preview. Preparation uses bounded split glTF or the existing runtime-media channel for validated GLB; keep all returned resources together. Clip duration/channels do not prove looping or actual playback. Set rebuildPreview only for local repair; never generate or bill a replacement. Other projects and unbound Library assets are inaccessible.",
    promptGuidelines: ["Call without assetId/path to list only the current project's model bindings. Resolve an exact listed assetId or originalPath; a public/ runtime copy may be unbound. An invalid reference is rejected before model reading/preparation; correct it from that project list using a new call ID. Never use another project's asset or treat a denied lookup as access authorization. Rebuild only explicitly requested local previews; do not regenerate models."],
    parameters: Type.Object({ assetId: Type.Optional(Type.String({ description: "Exact assetId from this project's model bindings; omit both assetId and path to list them" })), path: Type.Optional(Type.String({ description: "Exact originalPath from this project's bindings; runtime copies may not be bound" })), rebuildPreview: Type.Optional(Type.Boolean()) }),
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const resources = await projects.modelAssetResources(project.id, input, signal);
      return { content: [{ type: "text", text: JSON.stringify(resources) }], details: { modelResources: resources } };
    },
  }), defineTool({
    name: "list_animation_actions",
    label: "List Animation Actions",
    description: "Read exact preset action names and IDs for this project's selected animation connection and requested rigModel/rigType before animate_3d_asset. Does not upload a source model or run rig-check, rigging, retargeting or generation. An empty list means no integrated presets for that rig. Available actions do not prove that a source mesh matches the rig.",
    parameters: Type.Object(animationRigParameters, { additionalProperties: false }),
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const selected = projectAnimationSelection(projects.get(project.id), input.model, { rigModel: input.rigModel, rigType: input.rigType });
      const actions = await tools.animationActions(selected.model, selected.options);
      signal?.throwIfAborted();
      const animationActions = { ...selected, actions };
      return { content: [{ type: "text", text: JSON.stringify(animationActions) }], details: { animationActions } };
    },
  }), defineTool({
    name: PI_TOOL_NAMES["animate-3d"],
    label: "Animate 3D Asset",
    promptGuidelines: ["Before requesting clips, use list_animation_actions with the same model, rigModel and rigType. Use exact returned names; do not infer that creature rigs support humanoid actions. A local unknown-name rejection submits no workflow and can be corrected with a new call ID. A rig-check failure can have an existing provider task: recover/review that original workflow, never treat it as a local parameter rejection or authorize a replacement automatically."],
    description: "Rig a project GLB and create documented preset animation clips using an available reviewed connection. Kunpo Tripo defaults to v3.0 humanoid binding; non-human rigs use v2.5. Tripo permits at most five different clips per request and uses spec=tripo for internal retargeting. Meshy is disabled; do not select it or attempt remote recovery of its tasks. Existing local assets and records are retained; use an available Kunpo Tripo connection for new work. Saved clip names can differ from requested action labels, and structural checks do not prove motion semantics. Others/avian have no integrated preset list and cannot be animated here. Local cancellation stops waiting, not the upstream task or its charges.",
    parameters: Type.Object({
      recoverCallId: recoverCallIdParameter(),
      modelPath: Type.String({ description: "Path to a GLB model in the current project workspace" }),
      ...animationRigParameters,
      animateInPlace: Type.Optional(Type.Boolean()),
      actions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_ANIMATION_ACTIONS,
        description: "Names from the selected provider's available library. Tripo accepts 1–5 different clips. Meshy is disabled and has no callable animation actions. Defaults use at most five documented clips.",
      })),
      heightMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100, description: `Approximate character height in meters; defaults to ${DEFAULT_CHARACTER_HEIGHT_METERS}` })),
    }),
    execute: async (toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const callId = input.recoverCallId ?? toolCallId;
      let clipNames: string[] | undefined;
      const prepareInput = async (): Promise<RunToolRequest> => {
        const source = await getWorkspaceMedia(project.workspacePath, input.modelPath);
        if (source.contentType !== "model/gltf-binary") throw new Error("Only GLB models can be animated");
        const { model, options, actions } = await resolveAgentAnimation(projects.get(project.id), tools, input, signal);
        clipNames = actions.map(action => action.name);
        const assetId = await projects.ensureLibraryAsset(project.id, input.modelPath);
        return {
          assetId,
          model, options,
          actionIds: [...new Set(actions.map((action) => action.id))],
          ...(input.heightMeters !== undefined ? { heightMeters: input.heightMeters } : {}),
        };
      };
      const run = await tools.run("animate-3d", input.recoverCallId ? prepareInput : await prepareInput(), signal, project.id, { ...recoveryOptions("animate-3d", callId, signal), ...(input.recoverCallId ? { model3DRecoveryOnly: true } : {}) });
      return deliverMedia(run.id, callId, async () => {
        const output = run.files[0];
        if (!output) throw new Error("3D animation returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Animated 3D model could not be read");
        signal?.throwIfAborted();
        if (output.mediaType !== "model/gltf-binary") throw new Error("The animation result is not a supported GLB. Its original is retained; do not relabel its extension or regenerate it");
        const savedClipNames = (await inspectModel3D(file.bytes, signal)).animations;
        if (file.bytes.length > 2 * 1024 * 1024 && !output.assetId) throw new Error("The animated original is retained in the generation run. A Library binding is required to prepare validated runtime resources; do not insert the large original into the execution workspace");
        const retained = output.assetId && file.bytes.length > 2 * 1024 * 1024 ? await projects.materializeLibraryAsset(project.id, output.assetId) : undefined;
        const relativePath = retained?.path ?? await projects.addGeneratedAsset(project.id, `model-animated-${run.id}.glb`, file.bytes, {
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
        });
        return {
          content: [{ type: "text" as const, text: `Animated 3D model ${retained ? "original retained" : "saved"} at ${relativePath}. Saved clip names: ${savedClipNames.join(", ")}.${clipNames ? ` Requested actions: ${clipNames.join(", ")}.` : ""} Use the saved clip names in game code; local merging can add suffixes to duplicate names. Structural checks do not verify action semantics or playback quality.${retained ? retained.modelRuntimePath ? ` Game-ready model saved to ${retained.modelRuntimePath}; keep all returned resources together in the build. Use get_model_asset for validated runtime resources.` : " Runtime resources are not ready. Use get_model_asset to inspect local preparation; do not regenerate the retained animation." : ""}` }],
          details: { savedClipNames, ...(retained ? { modelResources: retained } : { artifact: { type: "model", path: relativePath, mediaType: output.mediaType } }) },
        };
      });
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-video"],
    label: "Generate Video",
    description: "Generate a video from a text prompt, optionally animating a PNG, JPEG, or WebP image from the current project.",
    parameters: Type.Object({
      recoverCallId: recoverCallIdParameter(),
      prompt: Type.String({ description: "Describe the motion and camera movement" }),
      model: Type.Optional(mediaModelParameter()),
      imagePath: Type.Optional(Type.String({ description: "Optional path to a PNG, JPEG, or WebP image in the current project workspace" })),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Video duration in seconds" })),
      aspectRatio: Type.Optional(Type.Union([Type.Literal("adaptive"), Type.Literal("21:9"), Type.Literal("16:9"), Type.Literal("4:3"), Type.Literal("3:2"), Type.Literal("1:1"), Type.Literal("2:3"), Type.Literal("3:4"), Type.Literal("9:16"), Type.Literal("9:21")], { description: "Video aspect ratio" })),
      resolution: Type.Optional(Type.Union([Type.Literal("480p"), Type.Literal("720p"), Type.Literal("768p"), Type.Literal("1080p"), Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")], { description: "Video resolution" })),
    }),
    execute: async (toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const prepareInput = async (): Promise<RunVideoToolRequest> => {
        const source = input.imagePath ? await getWorkspaceMedia(project.workspacePath, input.imagePath) : undefined;
        if (source && source.contentType !== "image/png" && source.contentType !== "image/jpeg" && source.contentType !== "image/webp") {
          throw new Error("Video generation requires a PNG, JPEG, or WebP image");
        }
        const assetId = source ? await projects.ensureLibraryAsset(project.id, input.imagePath!) : undefined;
        return {
          prompt: input.prompt,
          model: input.model,
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          ...(assetId ? { references: [{ type: "image", assetId }] } : {}),
        };
      };
      const callId = input.recoverCallId ?? toolCallId;
      const run = await tools.run("generate-video", input.recoverCallId ? prepareInput : await prepareInput(), signal, project.id, { ...recoveryOptions("generate-video", callId, signal), ...(input.recoverCallId ? { videoRecoveryOnly: true } : {}) });
      return deliverMedia(run.id, callId, async () => {
        const output = run.files[0];
        if (!output) throw new Error("Video generator returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Generated video could not be read");
        signal?.throwIfAborted();
        const relativePath = await projects.addGeneratedAsset(project.id, `video-${run.id}.mp4`, file.bytes, {
          prompt: input.prompt,
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
        });
        return {
          content: [{ type: "text" as const, text: `Generated video saved to ${relativePath}` }],
          details: { artifact: { type: "video", path: relativePath, mediaType: output.mediaType } },
        };
      });
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-speech"],
    label: "Generate Speech",
    description: "Generate candidate speech with optional user-selected Library MP3/WAV reference (30 seconds / 10 MB). For voice design, set voiceDesign=true and voiceDescription, with text as the sample script and no reference. Output is an audio sample, never a permanent speaker ID. Exact reading and voice consistency are unverified. Do not automatically generate downstream speech or retry unknown submissions.",
    parameters: Type.Object({
      recoverCallId: recoverCallIdParameter(),
      text: Type.String({ minLength: 1, maxLength: 3_000, description: "The intended words to speak; exact script fidelity is not verified" }),
      referenceAssetId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Library asset ID of one MP3 or WAV voice reference selected by the user; omit for unconditioned speech or voice design" })),
      referenceSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "Expected content digest of an explicitly selected reference" })),
      voiceDesign: Type.Optional(Type.Boolean()),
      voiceDescription: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      model: Type.Optional(mediaModelParameter()),
      language: Type.Optional(Type.String({ maxLength: 40 })),
      style: Type.Optional(Type.String({ maxLength: 2_000, description: "Delivery or emotional direction" })),
      speed: Type.Optional(Type.Number({ minimum: -50, maximum: 100 })),
      format: Type.Optional(Type.Union([Type.Literal("mp3"), Type.Literal("wav")], { description: "Output format supported by the selected model" })),
      sampleRate: Type.Optional(Type.Union([8_000, 16_000, 24_000, 32_000, 44_100, 48_000].map((value) => Type.Literal(value)))),
    }),
    execute: async (toolCallId, input, signal) => saveGeneratedAudio("generate-speech", {
      text: input.text, referenceAssetId: input.referenceAssetId, referenceSha256: input.referenceSha256, voiceDesign: input.voiceDesign, voiceDescription: input.voiceDescription, model: input.model, language: input.language, style: input.style, speed: input.speed,
      output: { format: input.format, sampleRate: input.sampleRate },
    }, input.text, "speech", toolCallId, signal, input.recoverCallId),
  }), defineTool({
    name: PI_TOOL_NAMES["generate-sound-effect"],
    label: "Generate Sound Effect",
    description: "Generate a sound effect with a compatible connected audio provider and save it into the current project.",
    parameters: Type.Object({
      recoverCallId: recoverCallIdParameter(),
      prompt: Type.String({ minLength: 1, maxLength: 3_000, description: "Describe the sound, environment, timing, and intensity" }),
      model: Type.Optional(mediaModelParameter()),
      durationSeconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 120 })),
      loop: Type.Optional(Type.Boolean()),
      negativePrompt: Type.Optional(Type.String({ maxLength: 4_000 })),
      format: Type.Optional(Type.Union([Type.Literal("mp3"), Type.Literal("wav")])),
    }),
    execute: async (toolCallId, input, signal) => saveGeneratedAudio("generate-sound-effect", {
      prompt: input.prompt, model: input.model, durationSeconds: input.durationSeconds, loop: input.loop,
      negativePrompt: input.negativePrompt, output: { format: input.format },
    }, input.prompt, "sound-effect", toolCallId, signal, input.recoverCallId),
  }), defineTool({
    name: PI_TOOL_NAMES["generate-music"],
    label: "Generate Music",
    description: "Generate a short ambient-music candidate with a compatible connected audio provider and save it into the current project. Kunpo SeedAudio does not guarantee full BGM structure, exact duration, lyrics, instrumental purity or seamless loops; unsupported requirements are rejected.",
    parameters: Type.Object({
      recoverCallId: recoverCallIdParameter(),
      prompt: Type.String({ minLength: 1, maxLength: 3_000, description: "Describe the desired short ambient-music candidate; structure is not guaranteed" }),
      model: Type.Optional(mediaModelParameter()),
      instrumental: Type.Boolean({ description: "Generate without vocals" }),
      lyrics: Type.Optional(Type.String({ maxLength: 20_000 })),
      durationSeconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 120 })),
      loop: Type.Optional(Type.Boolean()),
      format: Type.Optional(Type.Union([Type.Literal("mp3"), Type.Literal("wav")])),
    }),
    execute: async (toolCallId, input, signal) => saveGeneratedAudio("generate-music", {
      prompt: input.prompt, model: input.model, instrumental: input.instrumental, lyrics: input.lyrics,
      durationSeconds: input.durationSeconds, loop: input.loop, output: { format: input.format },
    }, input.prompt, "music", toolCallId, signal, input.recoverCallId),
  }), ...(project.type === "interactive-story" ? [defineTool({
    name: "playable_add_node",
    label: "Add Node",
    description: [
      "Create a Playable Node from a Preset. Presets are starting points, not Node types: the starter source uses the Project Style and is yours to rewrite.",
      `Presets: ${PLAYABLE_PRESETS.map((preset) => `${preset.id} (${preset.label})`).join(", ")}.`,
      "The Node is added to graph.json with its starter Signals and placed on the canvas. Connect it with an edge afterwards, then edit the written files.",
    ].join("\n"),
    parameters: Type.Object({
      preset: Type.Union(
        PLAYABLE_PRESET_IDS.map((id) => Type.Literal(id)),
        { description: "Preset to start from" },
      ),
      id: Type.String({ minLength: 1, maxLength: 60, description: "Node ID, used as the directory name under nodes/" }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Node title; defaults to the next Node N" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const result = await addPlayableNode(project.workspacePath, input);
      const signals = result.signals.length ? result.signals.join(", ") : "none";
      return {
        content: [{
          type: "text",
          text: [
            `Added Node "${result.id}" (${result.title}) from the ${result.preset} Preset.`,
            `Files: ${result.files.join(", ")}`,
            `Starter Signals: ${signals}`,
            result.brief,
          ].join("\n"),
        }],
        details: { playableNode: { id: result.id, preset: result.preset, files: result.files, signals: result.signals } },
      };
    },
  }), defineTool({
    name: "playable_check",
    label: "Check Project",
    description: [
      "Validate the Playable Nodes project: graph.json against its schema and references, then compile every Node and the shared modules it imports.",
      "Run it after changing the project and fix every issue it reports. Use mode \"publish\" before the user publishes; it also requires every Signal other than navigation ones to be connected and every source file to exist.",
    ].join("\n"),
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("publish")], { description: "Validation strictness; defaults to draft" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const mode = input.mode ?? "draft";
      const result = await validatePlayableProject(project.workspacePath, mode);
      const issues = result.issues.map(({ phase, code, path: issuePath, message, surfaceId }) => ({ phase, code, path: issuePath, message, ...(surfaceId ? { surfaceId } : {}) }));
      const text = result.ok
        ? `The project passes ${mode} validation.`
        : [
          `The project has ${issues.length} ${mode} validation ${issues.length === 1 ? "issue" : "issues"}:`,
          ...issues.map((issue) => `- [${issue.phase}] ${issue.surfaceId ? `${issue.surfaceId} ` : ""}${issue.path}: ${issue.message} (${issue.code})`),
        ].join("\n");
      return { content: [{ type: "text", text }], details: { playableCheck: { mode, ok: result.ok, issues } } };
    },
  })] : []), defineTool({
    name: "canvas_check",
    label: "Check Canvas",
    description: "Validate the canvas workspace files, node/document/table references and local media paths. Run after editing canvas files and fix every reported issue. This tool only reads files.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _input, signal) => {
      signal?.throwIfAborted();
      const result = await checkCanvasWorkspace(project.workspacePath);
      return { content: [{ type: "text", text: result.ok ? "Canvas files and references are valid." : result.issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n") }], details: { canvasCheck: result } };
    },
  }), ...(canvasStore ? [defineTool({
    name: "canvas_initialize",
    label: "Initialize Canvas",
    description: "Initialize the canvas file contract and an empty board when the requested design or asset work needs a canvas. Preserves existing boards, documents, tables and assets. Also compacts oversized legacy jobs.json metadata while retaining original retry inputs privately; use this before source transfer or reading oversized history. Read canvas/AGENTS.md, index.json and schemas/ afterwards. Do not use for casual conversation or planning-only requests.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _input, signal) => {
      signal?.throwIfAborted();
      const workspace = await canvasStore.workspace(project.id);
      await canvasStore.jobs(project.id);
      return {
        content: [{ type: "text", text: `Canvas ready. Read canvas/AGENTS.md, canvas/index.json and canvas/schemas/. Boards: ${JSON.stringify(workspace.boards)}.` }],
        details: {},
      };
    },
  }), ...([
    {
      name: "generate_canvas_media", label: "Generate Canvas Media",
      description: "Generate media using a saved node's prompt, references and settings. Supply only its boardId and nodeId.",
      parameters: Type.Object(canvasNodeParameters),
    }, {
      name: "recover_canvas_media", label: "Recover Canvas Media",
      description: "Recover the existing media job for this board and node. Cannot submit a new generation.",
      parameters: Type.Object({ ...canvasNodeParameters, recoverJobId: canvasJobId }),
    }, {
      name: "replace_canvas_media", label: "Request New Canvas Media",
      description: "Request user authorization to replace the specified existing canvas job with a new paid generation. Use recover_canvas_media to retrieve an existing result.",
      parameters: Type.Object({ ...canvasNodeParameters, confirmedAudioJobId: canvasJobId }),
    },
  ] as const).map(definition => defineTool({
    ...definition,
    execute: async (toolCallId, input, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const recovery = definition.name === "recover_canvas_media";
      const replacement = definition.name === "replace_canvas_media";
      const recoverJobId = recovery && "recoverJobId" in input && typeof input.recoverJobId === "string" ? input.recoverJobId : undefined;
      const confirmedAudioJobId = replacement && "confirmedAudioJobId" in input && typeof input.confirmedAudioJobId === "string" ? input.confirmedAudioJobId : undefined;
      if (recovery && !usableRecoveryId(recoverJobId, 120)) throw new Error("recoverJobId requires the actual original ID. No generation was submitted.");
      if (replacement && !usableRecoveryId(confirmedAudioJobId, 120)) throw new Error("confirmedAudioJobId requires the actual original ID. No generation was submitted.");
      const { board } = await canvasStore.board(project.id, input.boardId);
      const node = board.nodes.find((entry) => entry.id === input.nodeId);
      const toolId = node && CANVAS_MEDIA_TOOLS[node.type];
      if (!toolId) throw new Error("Choose a media generation node");
      const previous = (await canvasStore.jobs(project.id)).find((job) => job.context?.boardId === input.boardId && job.context.nodeId === input.nodeId);
      if (recovery && recoverJobId !== previous?.id) {
        await rememberRecovery(toolId, toolCallId, true);
        throw new Error("recoverJobId does not match the current job for this board and node. Refresh the node history and use its original job ID for recovery; stop if it is unavailable. No new generation was sent.");
      }
      if (replacement && confirmedAudioJobId !== previous?.id) throw new Error("This canvas job no longer matches the node. Refresh its history before requesting confirmation. No generation was submitted.");
      const pending = previous && (previous.status === "failed" || previous.status === "cancelled");
      const recover = recoverJobId ?? (pending && !replacement && (previous.run || mediaGenerationNeedsConfirmation(previous)) ? previous.id : undefined);
      if (!recover) {
        if (enabledMediaTools && !enabledMediaTools().includes(toolId)) throw new Error("This media operation is unavailable. Use list_media_capabilities to check the project. No generation was submitted.");
        await adoptBranchFailures(toolId, ctx?.sessionManager?.getBranch?.() ?? []);
      }
      const currentCall = recoveryOptions(toolId, toolCallId, signal);
      if (recover && previous) await tools.agentMedia.observeCanvas(currentCall.agentCall, currentCall.recoveryId, previous.id);
      const previousCall = previous && await tools.agentMedia.canvasCall(currentCall.agentCall.scope, previous.id);
      const options = recover && previousCall ? recoveryOptions(toolId, previousCall, signal) : currentCall;
      const confirmation = replacement ? confirmedAudioJobId : undefined;
      let safeFailure = false;
      return tools.agentMedia.use(options.agentCall, options.recoveryId, Boolean(recover), options.confirmNew, async (_receipt, save) => {
        const observed = recover && (previous?.status === "running" || previous?.status === "succeeded") ? previous : undefined;
        const job = observed ?? await (recover ? canvasStore.retry(project.id, recover, true) : canvasStore.generateNode(project.id, input.boardId, input.nodeId, confirmation, "turnaround", ctx?.model?.input?.includes("image")))
          .catch((cause) => { safeFailure = true; throw cause; });
        await save({ canvasJobId: job.id });
        // A recovery observer owns its wait, not the job started from the Canvas or another turn.
        const cancel = () => { if (!observed) void canvasStore.cancel(project.id, job.id).catch(() => {}); };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
          let current = job;
          while (current.status === "running") {
            signal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 250));
            const next = (await canvasStore.jobs(project.id)).find((candidate) => candidate.id === job.id);
            if (!next) throw new Error("Generation job is no longer available");
            current = next;
          }
          signal?.throwIfAborted();
          if (current.status !== "succeeded") {
            safeFailure = !current.run && !mediaGenerationNeedsConfirmation(current);
            throw new Error(current.error || "Generation failed");
          }
          return await canvasGenerationResult(input.nodeId, current, Boolean(recover));
        } finally { signal?.removeEventListener("abort", cancel); }
      }, () => safeFailure, confirmation ? previousCall ?? confirmation : undefined);
    },
  }))] : []), ...(playtest?.driver.available && playtest.driver.capabilities.projectTypes.includes(project.type) && (project.type !== "general" || supportsWebPreview(project))
    ? [createGameUseTool(playtest.driver, playtest.resolveOpenTarget, { bridge: project.type === "interactive-story" ? "reset" : "full" })]
    : [])];
  const recover = defineTool({
    name: "recover_media",
    label: "Recover Media",
    description: "Retrieve the result of a previous direct generation in this conversation without buying a replacement. Use the name and actual call ID of the original generation. Stop if the original call cannot be identified. For a saved Canvas node use recover_canvas_media.",
    parameters: Type.Object({
      tool: Type.Union([...Object.values(PI_TOOL_NAMES), ...mediaToolAliases.map(([name]) => name)].map(name => Type.Literal(name))),
      recoverCallId: Type.String({ minLength: 1, maxLength: 512 }),
      originalArguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Only when the original call is unavailable in conversation history, supply its exact generation arguments, without recovery fields. Omit when history is available." })),
    }),
    execute: async (id, input, signal, update, ctx) => {
      const toolId = mediaToolId(input.tool);
      const source = registeredTools.find(tool => tool.name === input.tool);
      if (!toolId || !source) throw new Error("The original generation tool is unavailable. No generation was submitted.");
      const { recoverCallId } = input;
      await rememberRecovery(toolId, recoverCallId);
      if (canvasStore) {
        const options = recoveryOptions(toolId, recoverCallId, signal);
        const jobId = await tools.agentMedia.canvasJob(options.agentCall, options.recoveryId);
        if (jobId) {
          const job = (await canvasStore.jobs(project.id)).find(job => job.id === jobId);
          if (!job?.context?.boardId) throw new Error("The original Canvas job is unavailable. No generation was submitted.");
          const recover = registeredTools.find(tool => tool.name === "recover_canvas_media")!;
          return directCanvasResult(await recover.execute(id, { boardId: job.context.boardId, nodeId: job.context.nodeId, recoverJobId: jobId }, signal, update, ctx));
        }
      }
      let original: unknown = input.originalArguments;
      for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const call = entry.message.content.find(block => block.type === "toolCall" && block.id === recoverCallId);
        if (call?.type !== "toolCall") continue;
        if (call.name !== source.name) throw new Error("The call ID belongs to a different tool. Use the actual original tool and ID. No generation was submitted.");
        original = call.arguments;
        break;
      }
      if (!original || typeof original !== "object" || Object.hasOwn(original, "recoverCallId") ||
          !Check({ ...source.parameters, additionalProperties: false }, original)) {
        throw new Error("Supply the exact original generation arguments in originalArguments when history is unavailable. Stop if they are unknown. No generation was submitted.");
      }
      const checked = checkMediaArguments(source, original, { originalRecovery: true });
      assertSafeGenerationInput(checked);
      return source.execute(id, { ...checked, recoverCallId }, signal, update, ctx);
    },
  });
  return [...registeredTools, recover].map((tool: PiToolDefinition) => {
    const toolId = mediaToolId(tool.name);
    if (!toolId && ![recover.name, "generate_canvas_media", "recover_canvas_media", "replace_canvas_media"].includes(tool.name)) return tool;
    const parameters = toolId && Type.IsObject(tool.parameters)
      ? Type.Omit(tool.parameters, toolId === "generate-image" ? ["recoverCallId", "size"] : ["recoverCallId"])
      : tool.parameters;
    const media = { ...tool, ...(toolId && canvasStore ? { description: `${tool.description} New requests are saved as visible Canvas generation nodes before submission, including reference links and job history. Prefer generate_canvas_media for an existing node.` } : {}), parameters: { ...parameters, additionalProperties: false } };
    return {
      ...media,
      ...(canvasStore && ["generate_canvas_media", "replace_canvas_media"].includes(tool.name) ? {
        recoverAfterHttp500: async (...args: Parameters<PiToolDefinition["execute"]>) => {
          args[2]?.throwIfAborted();
          const input = args[1] as { boardId: string; nodeId: string };
          const { board } = await canvasStore.board(project.id, input.boardId);
          const node = board.nodes.find(node => node.id === input.nodeId), toolId = node && CANVAS_MEDIA_TOOLS[node.type];
          if (!toolId) throw new Error("The original Canvas node is unavailable. No generation was submitted.");
          const options = recoveryOptions(toolId, args[0], args[2]);
          const jobId = await tools.agentMedia.canvasJob(options.agentCall, options.recoveryId);
          if (!jobId) throw new Error("The original Canvas job ID is unknown. Check its history; no generation was submitted.");
          const completed = async () => {
            const saved = (await canvasStore.jobs(project.id)).find(job => job.id === jobId && job.context?.boardId === input.boardId && job.context.nodeId === input.nodeId);
            return saved?.status === "succeeded" ? canvasGenerationResult(input.nodeId, saved, true) : undefined;
          };
          const result = await completed();
          if (result) return result;
          const recover = registeredTools.find(tool => tool.name === "recover_canvas_media")!;
          try { return await recover.execute(args[0], { ...input, recoverJobId: jobId }, args[2], args[3], args[4]); }
          catch (cause) {
            if (cause instanceof MediaAlreadyDelivered) { const result = await completed(); if (result) return result; }
            if (cause instanceof Error) cause.message += ` Original Canvas job ${jobId}, board ${input.boardId}, node ${input.nodeId}. Recovery did not authorize a replacement request.`;
            throw cause;
          }
        },
      } : {}),
      prepareArguments: (args) => checkMediaArguments(media, args, { currentSelections: () => projects.get(project.id)?.modelSelections }),
      execute: async (...args) => {
        // Direct callers may still replay a legacy image size. Pi advertises and validates only the modern pair.
        const input = checkMediaArguments(media, args[1], { allowLegacyImageSize: true, currentSelections: () => projects.get(project.id)?.modelSelections });
        args[1] = input;
        if (toolId) await adoptBranchFailures(toolId, args[4]?.sessionManager?.getBranch?.() ?? []);
        try {
          if (toolId && canvasStore && !Object.hasOwn(input, "recoverCallId")) {
            args[2]?.throwIfAborted();
            assertSafeGenerationInput(input);
            if (enabledMediaTools && !enabledMediaTools().includes(toolId)) throw new Error("This media operation is unavailable. No generation was submitted.");
            const { agentCall, recoveryId } = recoveryOptions(toolId, args[0]);
            const previousId = await tools.agentMedia.canvasJob(agentCall, recoveryId);
            const previous = previousId ? (await canvasStore.jobs(project.id)).find(job => job.id === previousId) : undefined;
            if (previousId && !previous) throw new Error("The original Canvas job is unavailable. No generation was submitted.");
            if (!previous && toolId === "image-to-3d")
              await tools.assertMediaInputOptions(toolId, await tools.prepare(toolId, input as RunToolRequest, project.id));
            if (!previous && ["generate-speech", "generate-sound-effect", "generate-music"].includes(toolId))
              await tools.assertMediaAvailable(toolId, { ...input, output: { format: input.format, sampleRate: input.sampleRate } } as RunToolRequest);
            const target = previous?.context?.boardId ? { boardId: previous.context.boardId, nodeId: previous.context.nodeId }
              : await saveAgentCanvasMedia(project.id, canvasStore, projects, tools, toolId, input, `agent-${recoveryId}`, agentCanvasBoard(args[4]?.sessionManager?.getBranch?.() ?? []), readImageReference, args[2]);
            args[2]?.throwIfAborted();
            const generate = registeredTools.find(tool => tool.name === "generate_canvas_media")!;
            try { return await directCanvasResult(await generate.execute(args[0], target, args[2], args[3], args[4])); }
            catch (cause) {
              if (!(cause instanceof MediaAlreadyDelivered)) await canvasStore.recordAgentMediaFailure(project.id, target.boardId, target.nodeId, toolId, cause instanceof Error ? cause.message : String(cause)).catch(() => {});
              throw cause;
            }
          }
          return await tool.execute(...args);
        }
        catch (cause) {
          if (!(cause instanceof MediaAlreadyDelivered)) throw cause;
          return { content: [{ type: "text" as const, text: cause.message }], details: { previouslyDeliveredCallId: cause.callId } };
        }
      },
    };
  });
}
