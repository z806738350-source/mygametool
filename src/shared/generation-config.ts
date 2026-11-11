import { type Model3DGenerationConfig, type Model3DModel, type Model3DModelRef, type Model3DOperation, type PromptImage, type Run3DToolRequest, type ToolJob } from "./contracts.js";
import { MODEL3D_CONNECTION_ID, remeshPolycount } from "./model3d-operations.js";
import { BUILTIN_CLOUD_CATALOG, cloudModelId } from "./cloud-models.js";
import { model3DModel } from "./custom-models.js";
import { isNative3DProvider, MODEL_3D_PRESETS, NATIVE_3D_PROVIDER_NAMES, type Native3DProviderId } from "./model3d-presets.js";
import { videoGenerationNeedsConfirmation } from "./video-references.js";
import { isMeshyModelReference } from "./disabled-media-providers.js";
import { KUNPO_DEFAULT_MODEL_REFS } from "./kunpo-models.js";

/** A locally retained run is restored before the store can start a new generation. */
export function mediaGenerationNeedsConfirmation(job: ToolJob | undefined): job is ToolJob {
  if (!job || job.run || (job.status !== "failed" && job.status !== "cancelled")) return false;
  if (job.toolId === "generate-video") return job.submissionOutcome === "unknown" || videoGenerationNeedsConfirmation(job);
  return job.submissionOutcome === "unknown" || Boolean(job.canRecoverImage || job.canRecoverModel3D);
}

export const DEFAULT_IMAGE_NODE_CONFIG = { resolution: "1K", aspectRatio: "1:1" } as const;
export const DEFAULT_VIDEO_NODE_CONFIG = { resolution: "720p", aspectRatio: "adaptive", duration: 6 } as const;

/** Built-in 3D models. Custom providers add their saved definitions at runtime. */
export const MODEL_3D_MODELS: readonly Model3DModel[] = [
  ...Object.entries(MODEL_3D_PRESETS).flatMap(([provider, models]) => models.map((model) => model3DModel(provider, NATIVE_3D_PROVIDER_NAMES[provider as Native3DProviderId], model))).filter((model) => !isMeshyModelReference(model)),
  ...BUILTIN_CLOUD_CATALOG.models.filter((model) => model.capability === "3d").map((model) => ({ ...model, providerName: "Hyper3D", maxReferenceImages: model.maxReferenceImages!, polycount: model.polycount! })),
];

export const DEFAULT_MODEL_3D = MODEL_3D_MODELS.find((model) => model.provider === KUNPO_DEFAULT_MODEL_REFS["3d-generation"]!.provider && model.id === KUNPO_DEFAULT_MODEL_REFS["3d-generation"]!.id)!;
export const MODEL_3D_MAX_REFERENCE_IMAGES = Math.max(...MODEL_3D_MODELS.map((model) => model.maxReferenceImages));
export const MODEL_3D_MAX_POLYCOUNT = Math.max(...MODEL_3D_MODELS.map((model) => model.polycount.max));

/** The known 3D model a request or node names, or the default when it names none. Unknown models return undefined. */
export function resolveModel3D(model: unknown, models: readonly Model3DModel[] = MODEL_3D_MODELS): Model3DModel | undefined {
  if (model === undefined) return models.find((candidate) => !isMeshyModelReference(candidate));
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as Record<string, unknown>;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  if (isMeshyModelReference({ provider, id })) return undefined;
  const canonicalId = cloudModelId(provider, id);
  return models.find((candidate) => !isMeshyModelReference(candidate) && candidate.provider === provider && candidate.id === id)
    ?? (canonicalId !== id ? models.find((candidate) => !isMeshyModelReference(candidate) && candidate.provider === provider && candidate.id === canonicalId) : undefined);
}

/** Older boards name a geometry version where processing now selects its native connection. */
export function resolveModel3DConnection(ref: Model3DModelRef | undefined, models: readonly Model3DModel[]): Model3DModel | undefined {
  if (!ref) return models.find((model) => !isMeshyModelReference(model));
  if (isMeshyModelReference(ref)) return undefined;
  if (typeof ref.provider !== "string" || typeof ref.id !== "string") return undefined;
  return models.find((model) => !isMeshyModelReference(model) && model.provider === ref.provider && model.id === ref.id)
    ?? (isNative3DProvider(ref.provider) ? models.find((model) => !isMeshyModelReference(model) && model.provider === ref.provider && model.id === MODEL3D_CONNECTION_ID) : undefined);
}

/** Existing Meshy adapter batch size; a whole job can span several batches. Upstream compatibility is separate. */
export const ANIMATION_ACTIONS_PER_REQUEST = 10;
/** Existing maximum action selections accepted by a job, independent of batch size. This is not a credit or price budget. */
export const MAX_ANIMATION_ACTIONS = 30;
export const DEFAULT_CHARACTER_HEIGHT_METERS = 1.7;
/** Starter actions for newly created Tripo v3 biped nodes; saved selections remain unchanged. */
export const DEFAULT_ANIMATION_ACTION_IDS: readonly string[] = ["preset:idle", "preset:walk", "preset:run"];

export const DEFAULT_MODEL_3D_CONFIG: Model3DGenerationConfig = {
  targetPolycount: DEFAULT_MODEL_3D.polycount.default,
  texture: true,
  pbr: false,
};

export function normalizeModel3DConfig(value: Partial<Model3DGenerationConfig> | undefined, model?: Model3DModel, operation: Model3DOperation = "image"): Model3DGenerationConfig {
  const texture = model?.supportsTexture === false ? false : value?.texture ?? model?.defaults?.texture ?? DEFAULT_MODEL_3D_CONFIG.texture;
  const selected = model ?? resolveModel3D(value?.model);
  const protocol = selected?.protocol ?? (value?.model?.id === MODEL3D_CONNECTION_ID && isNative3DProvider(value.model.provider) ? value.model.provider : undefined);
  const polycount = operation === "remesh" ? remeshPolycount(protocol) : selected?.polycount ?? (value?.model
    ? { min: 100, max: MODEL_3D_MAX_POLYCOUNT, default: DEFAULT_MODEL_3D.polycount.default } : DEFAULT_MODEL_3D.polycount);
  const targetPolycount = value?.targetPolycount;
  return {
    ...(value?.model ? { model: value.model } : {}),
    targetPolycount: Number.isInteger(targetPolycount) && targetPolycount! >= polycount.min && targetPolycount! <= polycount.max ? targetPolycount! : polycount.default,
    texture,
    pbr: texture && model?.supportsPbr !== false ? value?.pbr ?? model?.defaults?.pbr ?? DEFAULT_MODEL_3D_CONFIG.pbr : false,
  };
}

export function buildModel3DToolRequest(configValue: Partial<Model3DGenerationConfig>, images: PromptImage[], operation: Model3DOperation = "image"): Run3DToolRequest {
  const config = normalizeModel3DConfig(configValue, undefined, operation);
  return {
    images,
    ...(config.model ? { model: config.model } : {}),
    targetPolycount: config.targetPolycount,
    texture: config.texture,
    pbr: config.pbr,
  };
}
