import { describe, expect, it } from "vitest";
import type { ImageModel, VideoModel, Model3DModel } from "../src/shared/contracts.js";
import type { AudioModel } from "../src/shared/audio.js";
import { applyRememberedSettings, canvasNodeTypeAvailable, compatibleImageSettings, compatibleVideoDraft, nodeGenerationSettings, tripoRigTypes } from "../src/renderer/asset-canvas-workspace.js";
import { kunpoVideoModels, seedanceModel } from "../src/daemon/seedance-models.js";
import { videoReferenceAspectRatios } from "../src/shared/video-references.js";

type FlowNode = Parameters<typeof applyRememberedSettings>[0];

it.each([seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!, ...kunpoVideoModels()])("normalizes explicit draft edits for $id without losing references or modifying input", (model) => {
  for (const referenceMode of ["frame", "reference"] as const) for (const count of [0, 1, 2, 3]) {
    const references = Array.from({ length: count }, (_, index) => ({ type: "library" as const, assetId: `fixture-${index}` }));
    const input = { videoModel: { provider: model.provider, id: model.id }, videoResolution: "unsupported" as VideoModel["resolutions"][number], videoAspectRatio: "16:9" as const, duration: 99, referenceMode, references };
    const snapshot = structuredClone(input), result = compatibleVideoDraft(input, [model]);
    expect(result.references).toBe(references); expect(result.references).toHaveLength(count);
    expect(model.resolutions).toContain(result.videoResolution); expect(model.durations).toContain(result.duration);
    expect(videoReferenceAspectRatios(model, count, referenceMode)).toContain(result.videoAspectRatio);
    expect(result.videoAspectRatio).toBe(referenceMode === "frame" ? "adaptive" : "16:9");
    expect(input).toEqual(snapshot);
  }
});

it.each([seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!, ...kunpoVideoModels()])("limits no-reference ratios and preserves reference modes for $id", (model) => {
  const noReferences = videoReferenceAspectRatios(model, 0, "reference");
  expect(noReferences).not.toContain("adaptive"); expect(noReferences).toContain("16:9");
  expect(videoReferenceAspectRatios(model, 1, "reference")).toContain("adaptive");
  expect(videoReferenceAspectRatios(model, 2, "reference")).toContain("16:9");
  expect(videoReferenceAspectRatios(model, 1, "frame")).toEqual(["adaptive"]);
  expect(videoReferenceAspectRatios(model, 0, "frame")).toEqual(["adaptive"]);
  const node: FlowNode = { id: "new-video", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
  const settings = { videoModel: { provider: model.provider, id: model.id }, videoAspectRatio: "adaptive" as const };
  const selected = applyRememberedSettings(node, settings, { imageModels: [], videoModels: [model], textModels: [] });
  expect(selected.data.videoAspectRatio).toBe("16:9");
  expect(selected.data.referenceMode).toBe("reference");
  const frame = applyRememberedSettings({ ...node, data: { ...node.data, referenceMode: "frame" } }, settings, { imageModels: [], videoModels: [model], textModels: [] });
  expect(frame.data.referenceMode).toBe("frame"); expect(frame.data.videoAspectRatio).toBe("adaptive");
  expect(settings.videoAspectRatio).toBe("adaptive"); expect(node.data.videoAspectRatio).toBeUndefined();
});

it("preserves another protocol's configured default ratio order", () => {
  const model: VideoModel = { provider: "legacy", id: "other-video", providerName: "Legacy", name: "Other video", resolutions: ["720p"], durations: [6], aspectRatios: ["1:1", "16:9"], maxImageReferences: 1 };
  const node: FlowNode = { id: "new-other-video", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
  expect(applyRememberedSettings(node, undefined, { imageModels: [], videoModels: [model], defaultVideoModel: model, textModels: [] }).data.videoAspectRatio).toBe("1:1");
});

const openRouterImage = { provider: "openrouter", id: "gpt-image-2", name: "GPT Image 2", providerName: "OpenRouter", generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }] } as unknown as ImageModel;
const openAIImage = {
  provider: "openai",
  id: "gpt-image-2",
  name: "GPT Image 2",
  providerName: "OpenAI",
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "2K", aspectRatio: "16:9" }],
} as unknown as ImageModel;
const video = { provider: "fal", id: "kling", name: "Kling", providerName: "fal", resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16"], durations: [5, 10], maxImageReferences: 1 } as unknown as VideoModel;
const catalogs = { imageModels: [openRouterImage, openAIImage], videoModels: [video], textModels: [] };

function imageNode(data: FlowNode["data"] = {}): FlowNode {
  return { id: "image-1", type: "image", position: { x: 0, y: 0 }, data: { prompt: "", images: [], model: { provider: "openrouter", id: "gpt-image-2" }, resolution: "1K", aspectRatio: "1:1", ...data } };
}

describe("Asset Canvas remembered settings", () => {
  it("offers audio node types only when a catalog model supports their operation", () => {
    const none = new Set<"speech" | "sound-effect" | "music">();
    const speech = new Set(["speech"] as const);
    expect(canvasNodeTypeAvailable("image", none)).toBe(true);
    expect(canvasNodeTypeAvailable("speech", none)).toBe(false);
    expect(canvasNodeTypeAvailable("speech", speech)).toBe(true);
    expect(canvasNodeTypeAvailable("sound-effect", speech)).toBe(false);
    expect(canvasNodeTypeAvailable("music", speech)).toBe(false);
  });

  it("remembers text reasoning and adjusts it when the model's supported levels change", () => {
    const model = { provider: "openai", id: "gpt-test", name: "GPT Test", providerName: "OpenAI", reasoningLevels: ["off", "high"] as const };
    const base: FlowNode = { id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { text: "", instruction: "" } };
    const settings = nodeGenerationSettings({ type: "text", data: { textModel: model, reasoningLevel: "xhigh" } });
    expect(settings).toMatchObject({ reasoningLevel: "xhigh" });
    expect(applyRememberedSettings(base, settings, { ...catalogs, textModels: [{ ...model, reasoningLevels: [...model.reasoningLevels] }] }).data).toMatchObject({ textModel: { provider: "openai", id: "gpt-test" }, reasoningLevel: "high" });
  });
  it("starts a new image node with the last picked model and options", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "2K", aspectRatio: "16:9", prompt: "a cat" }));
    const node = applyRememberedSettings(imageNode(), settings, catalogs);
    expect(node.data).toMatchObject({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "2K", aspectRatio: "16:9", prompt: "" });
  });

  it("falls back to an option the remembered model offers", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "4K", aspectRatio: "21:9" }));
    expect(applyRememberedSettings(imageNode(), settings, catalogs).data).toMatchObject({ resolution: "1K", aspectRatio: "1:1" });
  });

  it("keeps the defaults when the remembered model is no longer offered", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "gemini", id: "nano-banana" } }));
    const node = imageNode();
    expect(applyRememberedSettings(node, settings, catalogs)).toBe(node);
  });

  it("uses the configured image default ahead of the remembered provider and keeps compatible options", () => {
    const settings = nodeGenerationSettings(imageNode({ resolution: "2K", aspectRatio: "16:9" }));
    const defaultImageModel = { provider: "openai", id: "gpt-image-2" };
    const selectedCatalog = { ...catalogs, defaultImageModel };
    expect(applyRememberedSettings(imageNode(), settings, selectedCatalog).data).toMatchObject({ model: defaultImageModel, resolution: "2K", aspectRatio: "16:9" });
    expect(applyRememberedSettings(imageNode(), undefined, selectedCatalog).data.model).toEqual(defaultImageModel);
  });

  it("keeps an unavailable image default visible instead of choosing another provider", () => {
    const defaultImageModel = { provider: "disabled-relay", id: "gpt-image-2" };
    expect(applyRememberedSettings(imageNode(), undefined, { ...catalogs, defaultImageModel }).data.model).toEqual(defaultImageModel);
  });

  it("carries video settings the model supports", () => {
    const base: FlowNode = { id: "video-1", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
    const settings = nodeGenerationSettings({ type: "video", data: { videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "1:1", duration: 10 } });
    expect(applyRememberedSettings(base, settings, catalogs).data).toMatchObject({ videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "16:9", duration: 10 });
  });

  it("starts new video nodes with the configured default and retains unavailable selections", () => {
    const base: FlowNode = { id: "video-1", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
    const customVideo: VideoModel = { ...video, provider: "custom-studio", id: "video-alias", referenceModes: ["frame"], imageReferenceMode: "frame" };
    const defaultVideoModel = { provider: customVideo.provider, id: customVideo.id };
    const settings = nodeGenerationSettings({ type: "video", data: { videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", duration: 10 } });
    expect(applyRememberedSettings(base, settings, { ...catalogs, videoModels: [video, customVideo], defaultVideoModel }).data).toMatchObject({
      videoModel: defaultVideoModel, videoResolution: "1080p", duration: 10, referenceMode: "frame",
    });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, defaultVideoModel }).data.videoModel).toEqual(defaultVideoModel);
  });

  it("uses custom 3D defaults and face count ranges when creating nodes", () => {
    const base: FlowNode = { id: "3d-1", type: "model-3d", position: { x: 0, y: 0 }, data: { images: [] } };
    const customModel: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "mesh-alias", name: "Mesh alias", maxReferenceImages: 4,
      polycount: { min: 20_000, max: 200_000, default: 75_000, presets: [75_000, 150_000] }, supportsTexture: false, supportsPbr: false };
    const defaultModel3D = { provider: customModel.provider, id: customModel.id };
    const selectedCatalog = { ...catalogs, model3DModels: [customModel], defaultModel3D };
    expect(applyRememberedSettings(base, undefined, selectedCatalog).data.model3DConfig).toEqual({ model: defaultModel3D, targetPolycount: 75_000, texture: false, pbr: false });
    const remembered = nodeGenerationSettings({ type: "model-3d", data: { model3DConfig: { model: { provider: "meshy", id: "meshy-7.1" }, targetPolycount: 100_000, texture: true, pbr: true } } });
    expect(applyRememberedSettings(base, remembered, selectedCatalog).data.model3DConfig).toEqual({ model: defaultModel3D, targetPolycount: 100_000, texture: false, pbr: false });
    expect(applyRememberedSettings(base, remembered, { ...catalogs, model3DModels: [] }).data.model3DConfig?.model).toEqual({ provider: "meshy", id: "meshy-7.1" });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, model3DModels: [], defaultModel3D }).data.model3DConfig?.model).toEqual(defaultModel3D);
  });

  it("carries a text model only while it remains available", () => {
    const model = { provider: "openai", id: "gpt-test", name: "GPT Test", providerName: "OpenAI", reasoningLevels: [] };
    const base: FlowNode = { id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { text: "", instruction: "" } };
    const settings = nodeGenerationSettings({ type: "text", data: { textModel: model } });
    expect(applyRememberedSettings(base, settings, { ...catalogs, textModels: [model] }).data.textModel).toEqual({ provider: model.provider, id: model.id });
    expect(applyRememberedSettings(base, settings, catalogs)).toBe(base);
  });

  it("does not inherit legacy IDs or reference audio, but remembers rate and model and defaults the model to the catalog entry", () => {
    const base: FlowNode = { id: "speech-1", type: "speech", position: { x: 0, y: 0 }, data: { text: "" } };
    const audioModel = { provider: "volcengine-tts", id: "seed-tts-2.0", name: "Seed TTS", providerName: "Doubao Speech", protocol: "volcengine-tts-v3", capabilities: { operations: ["speech"], executionModes: ["streaming"], formats: ["mp3"] } } satisfies AudioModel;
    const settings = nodeGenerationSettings({ type: "speech", data: { audioModel: { provider: "volcengine-tts", id: "seed-tts-2.0" }, voiceId: "zh_female_vv_uranus_bigtts", referenceAssetId: "old-private-reference", speed: 25 } });
    expect(settings).not.toHaveProperty("referenceAssetId");
    expect(settings).not.toHaveProperty("voiceId");
    expect(settings).toEqual({ audioModel: { provider: "volcengine-tts", id: "seed-tts-2.0" }, speed: 25 });
    expect(applyRememberedSettings(base, settings, { ...catalogs, audioModels: [audioModel] }).data).toMatchObject({ audioModel: { provider: "volcengine-tts", id: "seed-tts-2.0" }, speed: 25 });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, audioModels: [audioModel] }).data.audioModel).toEqual({ provider: "volcengine-tts", id: "seed-tts-2.0" });
    expect(applyRememberedSettings(base, settings, { ...catalogs }).data).toMatchObject({ audioModel: { provider: "volcengine-tts", id: "seed-tts-2.0" } });
  });

  it.each(["sound-effect", "music"] as const)("remembers %s settings and only selects a model with that capability", (type) => {
    const speechModel = { provider: "volcengine-tts", id: "seed-tts-2.0", name: "Seed TTS", providerName: "Doubao Speech", protocol: "volcengine-tts-v3", capabilities: { operations: ["speech"], executionModes: ["streaming"], formats: ["mp3"] } } satisfies AudioModel;
    const model = { provider: "audio-lab", id: type, name: type, providerName: "Audio Lab", protocol: "test", capabilities: { operations: [type], executionModes: ["async-task"], formats: ["mp3"], supportsLoop: true, supportsInstrumental: true } } satisfies AudioModel;
    const base: FlowNode = { id: type, type, position: { x: 0, y: 0 }, data: type === "music" ? { prompt: "", instrumental: true } : { prompt: "" } };
    const settings = nodeGenerationSettings({ type, data: { audioModel: model, durationSeconds: 30, loop: true, ...(type === "music" ? { instrumental: false } : {}) } });
    expect(applyRememberedSettings(base, settings, { ...catalogs, audioModels: [speechModel, model] }).data).toMatchObject({
      audioModel: { provider: "audio-lab", id: type }, durationSeconds: 30, loop: true, ...(type === "music" ? { instrumental: false } : {}),
    });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, audioModels: [speechModel, model] }).data.audioModel).toEqual(type === "music" ? undefined : { provider: "audio-lab", id: type });
  });

  it("uses explicit project speech choices without inventing a full music default or replacing unavailable models", () => {
    const speech: FlowNode = { id: "speech", type: "speech", position: { x: 0, y: 0 }, data: { text: "" } };
    const music: FlowNode = { id: "music", type: "music", position: { x: 0, y: 0 }, data: { prompt: "", instrumental: true } };
    const selected = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    expect(applyRememberedSettings(speech, undefined, { ...catalogs, modelSelections: { speech: selected } }).data.audioModel).toEqual(selected);
    expect(applyRememberedSettings(music, undefined, { ...catalogs, audioModels: [{ ...selected, capabilities: { operations: ["music"] } } as AudioModel] }).data.audioModel).toBeUndefined();
  });

  it("clears mask and alpha-only settings when switching to a model that cannot honor them", () => {
    const image = { ...openAIImage, qualities: ["auto", "medium", "max"], outputFormats: ["png", "jpeg"], supportsTransparency: true, supportsMask: true } as ImageModel;
    const settings = { quality: "max", outputFormat: "jpeg", background: "transparent", outputCompression: 50, mask: { type: "library", assetId: "mask" } } as const;
    expect(compatibleImageSettings(settings, image)).toEqual({ quality: "max", outputFormat: "png", background: "transparent", outputCompression: undefined, mask: settings.mask });
    expect(compatibleImageSettings(settings, { ...image, qualities: undefined, outputFormats: undefined, supportsTransparency: false, supportsMask: false })).toEqual({ quality: undefined, outputFormat: undefined, background: undefined, outputCompression: undefined, mask: undefined });
    expect(tripoRigTypes("v3.0-20260909")).toEqual(["biped", "others"]);
    expect(tripoRigTypes("v2.5-20260210")).toContain("quadruped");
  });
});
