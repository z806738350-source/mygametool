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
    description: "Read the current project's configured models, effective defaults and locally listed candidates for image, video, 3D, animation, voice, sound and music. Use this before generation or to correct a model selection. No provider requests, generation or billing checks are made.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _input, signal) => {
      signal?.throwIfAborted();
      const current = project();
      if (!current) throw new Error("Project not found");
      const deferredImages = new Set<string>(), deferredVideos = new Set<string>();
      const [images, videos, models3D, connections] = await Promise.all([
        catalogs.images.catalog(signal, deferredImages), catalogs.videos.catalog(signal, deferredVideos),
        catalogs.models3D.catalog(), catalogs.models3D.operationModels(),
      ]);
      const models = catalogs.audio.catalog().models;
      const audio = (operation: "speech" | "sound-effect" | "music") => selection(models.filter((model) => model.capabilities.operations.includes(operation))
        .map((model) => ({ ...ref(model), capabilities: model.capabilities })), current.modelSelections?.[operation], undefined, undefined, operation === "music");
      const geometry = projectMediaPreference(current, "3d");
      const animation = await catalogs.models3D.resolveOperationModel(geometry, "animate");
      const snapshot = {
        image: selection(images.models.map(imageCandidate), projectMediaPreference(current, "image"), catalogs.defaultModel("image"), deferredImages),
        video: selection(videos.models.map(videoCandidate), projectMediaPreference(current, "video"), catalogs.defaultModel("video"), deferredVideos),
        "3d-generation": { ...selection(models3D.models.map(model3DCandidate), geometry, catalogs.defaultModel("3d")),
          turnaroundTool: "generate_3d_from_views" },
        "3d-processing": { connections: connections.map(model3DCandidate),
          projectRig: current.modelSelections?.["3d-rig"] ? ref(current.modelSelections["3d-rig"]) : null,
          projectTexture: current.modelSelections?.["3d-texture"] ? ref(current.modelSelections["3d-texture"]) : null,
          projectRemesh: current.modelSelections?.["3d-remesh"] ? ref(current.modelSelections["3d-remesh"]) : null,
          animationConnection: animation ? ref(animation) : null,
          hint: "A processing version is not a geometry model. With the Tripo animation connection, the rig version is the rigModel argument." },
        speech: audio("speech"), "sound-effect": audio("sound-effect"), music: audio("music"),
      };
      // Only model references and capability fields are projected. Protect even a credential accidentally saved as a model ID.
      const text = JSON.stringify(snapshot, (_key, value) => typeof value === "string" ? redactKnownSensitiveValues(value) : value);
      return { content: [{ type: "text", text }], details: { mediaCapabilities: JSON.parse(text) } };
    },
  });
}
