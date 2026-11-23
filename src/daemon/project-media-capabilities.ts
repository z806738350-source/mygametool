import { GPT_IMAGE_26_DEFAULTS, GPT_IMAGE_SVG_MODELS, GPT_IMAGE_SVG_EFFORTS, isGptImage26 } from "../shared/gpt-image-26.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImageModel, Model3DModel, Model3DOptions, ModelRef, ProjectState, VideoModel } from "../shared/contracts.js";
import { redactKnownSensitiveValues } from "../shared/sensitive-values.js";
import { model3DOptionFields } from "../shared/model3d-operations.js";
import type { ProviderAudio } from "./audio-generation.js";
import type { ProviderImages } from "./provider-images.js";
import type { ProviderModels3D } from "./provider-models3d.js";
import type { ProviderVideos } from "./provider-videos.js";

type Usage = "image" | "video" | "3d";
const capabilities = ["image", "video", "3d-generation", "3d-processing", "speech", "sound-effect", "music"] as const;

export function projectMediaPreference(project: ProjectState | undefined, usage: Usage) {
  return project?.modelSelections?.[usage === "3d" ? "3d-generation" : usage] ?? project?.mediaModelDefaults?.[usage];
}

function ref({ provider, id }: ModelRef) { return { provider, id }; }

export function projectAnimationSelection(project: ProjectState | undefined, requested?: ModelRef, options?: Model3DOptions) {
  const model = requested ?? projectMediaPreference(project, "3d");
  const rig = model?.provider === "tripo" ? project?.modelSelections?.["3d-rig"] : undefined;
  return { model, options: !options?.rigModel && rig?.provider === "tripo" ? { ...options, rigModel: rig.id as Model3DOptions["rigModel"] } : options };
}

function selection<T extends ModelRef>(candidates: readonly T[], project: ModelRef | undefined, globalDefault?: ModelRef, deferred = new Set<string>(), explicitOnly = false) {
  const preference = project ?? globalDefault;
  const selected = preference
    ? candidates.find((model) => model.id === preference.id && model.provider === preference.provider)
    : !explicitOnly && !deferred.size ? candidates[0] : undefined;
  const status = selected ? "locally-configured"
    : (preference ? deferred.has(preference.provider) : deferred.size > 0) ? "catalog-not-queried"
    : preference ? "selected-model-unavailable" : candidates.length ? "explicit-selection-required" : "no-configured-model";
  return { projectSelection: project ? ref(project) : null, ...(globalDefault ? { globalDefault: ref(globalDefault) } : {}),
    effectiveModel: selected ? ref(selected) : null, status, candidates,
    ...(deferred.size ? { providersRequiringDiscovery: [...deferred] } : {}) };
}

function imageCandidate(model: ImageModel) {
  return { ...ref(model), sizes: model.sizes, generationOptions: model.generationOptions, outputFormats: model.outputFormats, qualities: model.qualities,
    ...(isGptImage26(model.id) && model.complexities ? {
      complexities: model.complexities, supportsMarkup: model.supportsMarkup, transparentFormats: ["png", "webp", "svg"], compressionFormats: ["jpeg", "webp"],
      svg: { textOnly: true, outputs: 1, authors: GPT_IMAGE_SVG_MODELS, reasoningEfforts: GPT_IMAGE_SVG_EFFORTS, unavailableEffort: { "gpt-6.1-sol": "none" } },
      gif: { staticReferences: true, squareFrameSize: "512x512", frameCount: [2, 16], frameDurationMs: [20, 2000], mask: false, markup: false },
      pixelSize: "Optional explicit WxH, multiples of 16, ratio 1:3 to 3:1. Applies per frame for GIF.", defaults: GPT_IMAGE_26_DEFAULTS,
    } : {}),
    supportsResolution: model.supportsResolution, supportsAspectRatio: model.supportsAspectRatio, maxOutputs: model.maxOutputs,
    supportsReferenceImage: model.supportsReferenceImage, maxReferenceImages: model.maxReferenceImages, supportsMask: model.supportsMask, supportsTransparency: model.supportsTransparency };
}
function videoCandidate(model: VideoModel) {
  return { ...ref(model), durations: model.durations, resolutions: model.resolutions, aspectRatios: model.aspectRatios,
    imageReferenceMode: model.imageReferenceMode, referenceModes: model.referenceModes, maxImageReferences: model.maxImageReferences,
    imageAspectRatios: model.imageAspectRatios, textAspectRatios: model.textAspectRatios, frameAspectRatios: model.frameAspectRatios };
}
function model3DCandidate(model: Model3DModel) {
  return { ...ref(model), operations: model.operations, maxReferenceImages: model.maxReferenceImages, referenceImageLabels: model.referenceImageLabels,
    optionFieldsByOperation: Object.fromEntries((model.operations ?? ["image"]).map(operation => [operation, model3DOptionFields(model.protocol, operation, true)])) };
}

interface LocalMediaCatalogs {
  images: ProviderImages;
  videos: ProviderVideos;
  models3D: ProviderModels3D;
  audio: ProviderAudio;
  defaultModel: (usage: Usage) => ModelRef | undefined;
}

export function createProjectMediaCapabilitiesTool(project: () => ProjectState | undefined, catalogs: LocalMediaCatalogs) {
  return defineTool({
    name: "list_media_capabilities",
    label: "Check project media models",
    description: "Read configured models, defaults and all model options for the current stage. Pass capability for one media type; omit for a project-wide inventory. Local query only.",
    parameters: Type.Object({ capability: Type.Optional(Type.Union(capabilities.map(name => Type.Literal(name)))) }, { additionalProperties: false }),
    execute: async (_id, { capability }, signal) => {
      signal?.throwIfAborted();
      const current = project();
      if (!current) throw new Error("Project not found");
      if (capability !== undefined && !capabilities.includes(capability)) throw new Error("Unknown media capability");
      let audioModels: ReturnType<ProviderAudio["catalog"]>["models"] | undefined;
      async function read(name: typeof capabilities[number]) {
        switch (name) {
          case "image": {
            const deferred = new Set<string>();
            const catalog = await catalogs.images.catalog(signal, deferred);
            return selection(catalog.models.map(imageCandidate), projectMediaPreference(current, name), catalogs.defaultModel(name), deferred);
          }
          case "video": {
            const deferred = new Set<string>();
            const catalog = await catalogs.videos.catalog(signal, deferred);
            return selection(catalog.models.map(videoCandidate), projectMediaPreference(current, name), catalogs.defaultModel(name), deferred);
          }
          case "3d-generation": {
            const catalog = await catalogs.models3D.catalog();
            return { ...selection(catalog.models.map(model3DCandidate), projectMediaPreference(current, "3d"), catalogs.defaultModel("3d")),
              turnaroundTool: "generate_3d_from_views" };
          }
          case "3d-processing": {
            const [connections, animation] = await Promise.all([catalogs.models3D.operationModels(),
              catalogs.models3D.resolveOperationModel(projectMediaPreference(current, "3d"), "animate")]);
            const selected = current?.modelSelections;
            return { connections: connections.map(model3DCandidate),
              projectRig: selected?.["3d-rig"] ? ref(selected["3d-rig"]) : null,
              projectTexture: selected?.["3d-texture"] ? ref(selected["3d-texture"]) : null,
              projectRemesh: selected?.["3d-remesh"] ? ref(selected["3d-remesh"]) : null,
              animationConnection: animation ? ref(animation) : null,
              hint: "A processing version is not a geometry model. With the Tripo animation connection, the rig version is the rigModel argument." };
          }
          default:
            audioModels ??= catalogs.audio.catalog().models;
            return selection(audioModels.filter(model => model.capabilities.operations.includes(name))
              .map(model => ({ ...ref(model), capabilities: model.capabilities })), current?.modelSelections?.[name], undefined, undefined, name === "music");
        }
      }
      const names = capability === undefined ? capabilities : [capability];
      const snapshot = Object.fromEntries(await Promise.all(names.map(async name => [name, await read(name)] as const)));
      signal?.throwIfAborted();
      // Only model references and capability fields are projected. Protect even a credential accidentally saved as a model ID.
      const text = JSON.stringify(snapshot, (_key, value) => typeof value === "string" ? redactKnownSensitiveValues(value) : value);
      return { content: [{ type: "text", text }], details: { mediaCapabilities: JSON.parse(text) } };
    },
  });
}
