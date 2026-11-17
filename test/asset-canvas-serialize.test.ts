import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument, createAssetGenerationNode, isAssetCanvasDocument, validateAssetCanvasDocument, withoutContentNodeSizes } from "../src/shared/asset-canvas.js";
import { canvasHistoryKey, model3DViewLabels, toAssetCanvasNode, toFlowNode } from "../src/renderer/asset-canvas-workspace.js";
import { imageModelsForProvider } from "../src/daemon/image-models.js";
import type { Model3DModel } from "../src/shared/contracts.js";
import { model3DModel } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { buildModel3DToolRequest } from "../src/shared/generation-config.js";
import { MODEL3D_CONNECTION_ID } from "../src/shared/model3d-operations.js";

describe("Asset Canvas node serialization", () => {
  it.each([["1K", "3:2"], ["1K", "2:3"], ["4K", "16:9"]] as const)("keeps saved %s %s settings when inheriting the default image model", (resolution, aspectRatio) => {
    const source = createAssetGenerationNode("image", { x: 20, y: 30 }, { imageResolution: resolution, imageAspectRatio: aspectRatio });
    const models = imageModelsForProvider("openai", "Fixture", ["gpt-image-2.5-sunburst"]);
    const loaded = toAssetCanvasNode(toFlowNode(source, models, []));
    expect(loaded).toEqual({ ...source, data: { ...source.data, model: { provider: models[0]!.provider, id: models[0]!.id } } });
    expect(source.data).not.toHaveProperty("model");
  });
  it("keeps requested image settings even before a model catalog is available or when its defaults differ", () => {
    const source = createAssetGenerationNode("image", { x: 0, y: 0 }, { imageResolution: "4K", imageAspectRatio: "16:9" });
    expect(toAssetCanvasNode(toFlowNode(source, [], []))).toEqual(source);
    const limited = imageModelsForProvider("openai", "Fixture", ["gpt-image-1"]);
    expect(toAssetCanvasNode(toFlowNode(source, limited, [])).data).toMatchObject({ resolution: "4K", aspectRatio: "16:9" });
  });
  it("persists selected voice versions independently of the current generated candidate", () => {
    const digest = "a".repeat(64), model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const voice = toAssetCanvasNode({ id: "voice", type: "voice", position: { x: 0, y: 0 }, data: { voiceDescription: "Warm", sampleText: "Hello", audioModel: model, assetId: "new-candidate", selectedAssetId: "old-candidate", selectedSha256: digest } });
    const speech = toAssetCanvasNode({ id: "speech", type: "speech", position: { x: 600, y: 0 }, data: { text: "Hello", referenceAssetId: "old-candidate", referenceSha256: digest, voiceSourceNodeId: "voice" } });
    const canvas = createAssetCanvasDocument(); canvas.nodes = [voice, speech]; canvas.editorLayout.nodes = { voice: voice.position, speech: speech.position };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    expect(voice.data).toMatchObject({ assetId: "new-candidate", selectedAssetId: "old-candidate", selectedSha256: digest });
    expect(speech.data).toMatchObject({ referenceAssetId: "old-candidate", referenceSha256: digest, voiceSourceNodeId: "voice" });
    if (voice.type !== "voice" || speech.type !== "speech") throw new Error();
    delete voice.data.selectedSha256; expect(isAssetCanvasDocument(canvas)).toBe(false);
    voice.data.selectedSha256 = digest; speech.data.voiceSourceNodeId = "missing"; expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
  it("stores image generation parameters and a mask reference without embedding image bytes", () => {
    const node = toAssetCanvasNode({ id: "image", type: "image", position: { x: 0, y: 0 }, data: { prompt: "A hero", model: { provider: "openai", id: "gpt-image-2.5-sunburst" }, resolution: "1K", aspectRatio: "1:1", images: [{ type: "library", assetId: "reference" }], quality: "max", outputFormat: "png", background: "transparent", mask: { type: "library", assetId: "mask" } } });
    const canvas = createAssetCanvasDocument(); canvas.nodes = [node]; canvas.editorLayout.nodes.image = { x: 0, y: 0 };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    expect(node.data).toMatchObject({ quality: "max", outputFormat: "png", background: "transparent", mask: { type: "library", assetId: "mask" } });
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.outputCompression = 101;
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
  it("round-trips a layered 2.6 image and remaps its markup when copying or deleting nodes", async () => {
    const { createCanvasClipboard, duplicateCanvasSelection } = await import("../src/renderer/asset-canvas-clipboard.js");
    const { removeNodesAndReferences } = await import("../src/renderer/asset-canvas-workspace.js");
    const source = createAssetGenerationNode("image", { x: 0, y: 0 });
    const flow = { id: "edited", type: "image" as const, position: { x: 350, y: 0 }, data: {
      prompt: "Edit here", model: { provider: "openai", id: "gpt-image-2.6-flare" }, images: [{ type: "library" as const, assetId: "subject" }],
      outputFormat: "webp" as const, background: "transparent" as const, outputCompression: 0, complexity: "medium" as const,
      pixelSize: "768x768", markup: { type: "node" as const, nodeId: source.id },
    } };
    const persisted = toAssetCanvasNode(flow);
    expect(toAssetCanvasNode(toFlowNode(persisted, [], []))).toEqual(persisted);
    expect(persisted.data).toMatchObject(flow.data);
    const board = createAssetCanvasDocument(); board.nodes = [source, persisted]; board.editorLayout.nodes = Object.fromEntries(board.nodes.map(n => [n.id, n.position]));
    expect(isAssetCanvasDocument(board)).toBe(true);
    const clip = createCanvasClipboard("project", board.nodes, []);
    const copy = duplicateCanvasSelection(clip.nodes, [], { x: 10, y: 10 });
    expect(copy.nodes[1]?.data).toMatchObject({ markup: { type: "node", nodeId: copy.nodes[0]?.id } });
    expect(createCanvasClipboard("project", [persisted], []).nodes[0]?.data).not.toHaveProperty("markup");
    expect(removeNodesAndReferences([flow], new Set([source.id]))[0]?.data.markup).toBeUndefined();
  });

  it("keeps resize history and serialization while rejecting invalid node dimensions", () => {
    const canvas = createAssetCanvasDocument();
    const node = toAssetCanvasNode({ id: "notes", type: "text", position: { x: 0, y: 0 }, width: 600, height: 400, data: { text: "Notes" } });
    canvas.nodes = [node]; canvas.editorLayout.nodes.notes = { x: 0, y: 0, width: 600, height: 400 };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    const resized = structuredClone(canvas); resized.nodes[0]!.width = 800;
    expect(canvasHistoryKey(resized)).not.toBe(canvasHistoryKey(canvas));
    resized.nodes[0]!.width = Infinity; expect(isAssetCanvasDocument(resized)).toBe(false);
  });
  it("rejects fixed sizes on nodes that size to their content", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [{ id: "boat", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "boat", mediaType: "image" } }];
    canvas.editorLayout.nodes.boat = { x: 0, y: 0 };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    canvas.nodes[0]!.width = 330; canvas.editorLayout.nodes.boat = { x: 0, y: 0, width: 330 };
    expect(isAssetCanvasDocument(canvas)).toBe(false);
    expect(() => validateAssetCanvasDocument(canvas)).toThrow("Node boat: asset nodes size to their content");
    canvas.nodes.push({ id: "notes", type: "text", position: { x: 0, y: 0 }, width: 600, height: 400, data: { text: "", instruction: "" } });
    canvas.editorLayout.nodes.notes = { x: 0, y: 0, width: 600, height: 400 };
    const restored = withoutContentNodeSizes(canvas);
    expect(isAssetCanvasDocument(restored)).toBe(true);
    expect(restored.editorLayout.nodes).toEqual({ boat: { x: 0, y: 0 }, notes: { x: 0, y: 0, width: 600, height: 400 } });
    expect(restored.nodes[1]).toMatchObject({ width: 600, height: 400 });
  });
  it("uses protocol-specific reference labels rather than applying directions to every provider", () => {
    expect(model3DViewLabels(model3DModel("hyper3d", "Hyper3D", MODEL_3D_PRESETS.hyper3d[0]!))).toEqual(["Reference 1", "Reference 2", "Reference 3", "Reference 4", "Reference 5"]);
    expect(model3DViewLabels(model3DModel("tripo", "Tripo", MODEL_3D_PRESETS.tripo[0]!))).toEqual(["Front", "Left", "Back", "Right"]);
    expect(model3DViewLabels(model3DModel("meshy", "Meshy", MODEL_3D_PRESETS.meshy[0]!))).toEqual(["Reference 1"]);
  });
  it("persists the same 3D parameters the current catalog displays", () => {
    const model: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "props", name: "Props", maxReferenceImages: 1,
      polycount: { min: 200, max: 2_000, default: 800, presets: [800] }, supportsTexture: false, supportsPbr: false };
    const node = toAssetCanvasNode({ id: "3d", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DConfig: { model: { provider: model.provider, id: model.id }, targetPolycount: 4_000, texture: true, pbr: true }, images: [],
    } }, [model]);
    expect(node.data).toMatchObject({ model: { provider: model.provider, id: model.id }, targetPolycount: 800, texture: false, pbr: false });
    const unavailable = toAssetCanvasNode({ id: "3d", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DConfig: { model: { provider: "disabled-studio", id: "props" }, targetPolycount: 4_000, texture: true, pbr: false }, images: [],
    } }, [model]);
    expect(unavailable.data).toMatchObject({ model: { provider: "disabled-studio", id: "props" }, targetPolycount: 4_000 });
  });
  it("records node changes in history independently of viewport movement and JSON key order", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [{ id: "rules", type: "text", position: { x: 0, y: 0 }, data: { text: "Rules", instruction: "" } }];
    const movedView = structuredClone(canvas); movedView.editorLayout.viewport = { x: 900, y: 600, zoom: 0.5 };
    expect(canvasHistoryKey(movedView)).toBe(canvasHistoryKey(canvas));
    movedView.nodes[0]!.data = { instruction: "", text: "Rules" };
    expect(canvasHistoryKey(movedView)).toBe(canvasHistoryKey(canvas));
    movedView.nodes[0]!.position.x = 200;
    expect(canvasHistoryKey(movedView)).not.toBe(canvasHistoryKey(canvas));
  });
  it("stores only provider and id for a catalog text model", () => {
    const catalogModel = { provider: "anthropic", id: "claude-3-haiku", name: "Claude 3 Haiku", providerName: "Anthropic", reasoningLevels: [] };
    const node = toAssetCanvasNode({
      id: "text-1",
      type: "text",
      position: { x: 0, y: 0 },
      data: { text: "", instruction: "", textModel: catalogModel, reasoningLevel: "high" },
    } as unknown as Parameters<typeof toAssetCanvasNode>[0]);
    expect(node.data).toMatchObject({ model: { provider: "anthropic", id: "claude-3-haiku" } });
    expect((node.data as { model: object }).model).toEqual({ provider: "anthropic", id: "claude-3-haiku" });
    expect(node.data).toHaveProperty("reasoningLevel", "high");

    const canvas = createAssetCanvasDocument();
    canvas.nodes = [node];
    canvas.editorLayout.nodes = { "text-1": { x: 0, y: 0 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    (node.data as { reasoningLevel: string }).reasoningLevel = "turbo";
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
  it.each(["text", "image", "video", "speech", "sound-effect", "music", "model-3d", "animate-3d", "asset", "document"] as const)("preserves %s node metadata without runtime fields", (type) => {
    const node = toAssetCanvasNode({ id: "node", type, position: { x: 0, y: 0 }, title: "Player", description: "Main character", data: { documentId: "rules", assetId: "reference", text: "Rules", nodeDetails: { title: "Runtime name", label: "Runtime label", edit: () => {} } } });
    expect(node).toMatchObject({ title: "Player", description: "Main character" });
    expect(node.data).not.toHaveProperty("nodeDetails");
  });
  it("round-trips a speech node without runtime fields and accepts it as a saved board", () => {
    const node = toAssetCanvasNode({ id: "narration", type: "speech", position: { x: 0, y: 0 }, data: {
      text: "欢迎来到雾港。", promptSource: { type: "node", nodeId: "script" }, audioModel: { provider: "volcengine-tts", id: "seed-tts-2.0" },
      voiceId: "zh_male_m191_uranus_bigtts", referenceAssetId: "local-voice-reference", speed: 25, assetId: "audio-1", audioRuntime: { models: [], providers: [] },
    } as unknown as Parameters<typeof toAssetCanvasNode>[0]["data"] });
    expect(node.type).toBe("speech");
    expect(node.data).toEqual({ text: "欢迎来到雾港。", promptSource: { type: "node", nodeId: "script" }, model: { provider: "volcengine-tts", id: "seed-tts-2.0" }, voiceId: "zh_male_m191_uranus_bigtts", referenceAssetId: "local-voice-reference", speed: 25, assetId: "audio-1" });
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [
      node,
      { id: "script", type: "text", position: { x: 0, y: 200 }, data: { text: "欢迎来到雾港。", instruction: "" } },
    ];
    canvas.editorLayout.nodes = { narration: { x: 0, y: 0 }, script: { x: 0, y: 200 } };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    if (canvas.nodes[0]!.type !== "speech") throw new Error("Expected speech node");
    canvas.nodes[0]!.data.speed = 200;
    expect(isAssetCanvasDocument(canvas)).toBe(false);
  });
  it.each([
    ["sound-effect", { prompt: "Heavy rain", durationSeconds: 10, loop: true, negativePrompt: "thunder", assetId: "sfx-1" }],
    ["music", { prompt: "Quiet harbor theme", instrumental: false, lyrics: "Follow the tide", durationSeconds: 60, loop: false, assetId: "music-1" }],
  ] as const)("round-trips a %s node", (type, data) => {
    const node = toAssetCanvasNode({ id: type, type, position: { x: 10, y: 20 }, data: { ...data, audioModel: { provider: "audio-provider", id: "audio-model" } } });
    expect(node).toMatchObject({ type, data: { ...data, model: { provider: "audio-provider", id: "audio-model" } } });
    const board = createAssetCanvasDocument();
    board.nodes = [node];
    board.editorLayout.nodes = { [type]: { x: 10, y: 20 } };
    expect(isAssetCanvasDocument(board)).toBe(true);
  });
  it.each(["speech", "sound-effect", "music"] as const)("connects text and document nodes to a %s node as its prompt source", async (type) => {
    const { connectionRelation } = await import("../src/renderer/asset-canvas-workspace.js");
    const text = { id: "script", type: "text", position: { x: 0, y: 0 }, data: { text: "Welcome", instruction: "" } } as Parameters<typeof connectionRelation>[0];
    const target = { id: "audio", type, position: { x: 200, y: 0 }, data: type === "speech" ? { text: "" } : type === "music" ? { prompt: "", instrumental: true } : { prompt: "" } } as Parameters<typeof connectionRelation>[1];
    expect(connectionRelation(text, target, undefined, [], [], [])).toBe("prompt");
    target.data.promptSource = { type: "node", nodeId: "script" };
    expect(connectionRelation(text, target, undefined, [], [], [])).toBeUndefined();
    const image = { id: "art", type: "image", position: { x: 0, y: 100 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [] } } as Parameters<typeof connectionRelation>[0];
    expect(connectionRelation(image, target, undefined, [], [], [])).toBeUndefined();
  });
});

describe("3D processing node serialization", () => {
  it.each(["meshy", "tripo"])("uses %s remesh limits for a native connection saved without runtime catalog data", (provider) => {
    const node = toAssetCanvasNode({ id: "remesh", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DOperation: "remesh", model3DSource: { type: "library", assetId: "source" }, images: [],
      model3DConfig: { model: { provider, id: MODEL3D_CONNECTION_ID }, targetPolycount: 500_000, texture: true, pbr: false },
    } });
    if (node.type !== "model-3d") throw new Error("Expected model node");
    expect(node.data.targetPolycount).toBe(provider === "meshy" ? 30_000 : 4_000);
    expect(buildModel3DToolRequest(node.data, [], node.data.operation).targetPolycount).toBe(node.data.targetPolycount);
  });
  it("keeps remesh face counts above the geometry model's generation limit in saved requests", () => {
    const node = toAssetCanvasNode({ id: "remesh", type: "model-3d", position: { x: 0, y: 0 }, data: {
      model3DOperation: "remesh", model3DSource: { type: "library", assetId: "source" }, images: [],
      model3DConfig: { model: { provider: "meshy", id: "meshy-t2" }, targetPolycount: 300_000, texture: true, pbr: false },
    } });
    if (node.type !== "model-3d") throw new Error("Expected model node");
    const saved = JSON.parse(JSON.stringify(node.data));
    expect(saved.targetPolycount).toBe(300_000);
    expect(buildModel3DToolRequest(saved, [], saved.operation).targetPolycount).toBe(300_000);
  });
  it("keeps source, prompt links and operation versions in history and clipboard", async () => {
    const { createCanvasClipboard, duplicateCanvasSelection, parseCanvasClipboard } = await import("../src/renderer/asset-canvas-clipboard.js");
    const source = toAssetCanvasNode({ id: "source", type: "model-3d", position: { x: 0, y: 0 }, data: { images: [] } });
    const text = toAssetCanvasNode({ id: "style", type: "text", position: { x: 0, y: 200 }, data: { text: "Gold" } });
    const node = toAssetCanvasNode({ id: "texture", type: "model-3d", position: { x: 300, y: 0 }, data: {
      model3DConfig: { model: { provider: "tripo", id: "P1-20260311" }, targetPolycount: 4000, texture: true, pbr: true },
      model3DOperation: "retexture", model3DSource: { type: "node", nodeId: "source" }, prompt: "Worn metal", promptSource: { type: "node", nodeId: "style" },
      model3DOptions: { textureModel: "v3.5-20260815", textureQuality: "detailed" }, images: [],
    } });
    expect(node.data).toMatchObject({ operation: "retexture", source: { nodeId: "source" }, promptSource: { nodeId: "style" }, options: { textureModel: "v3.5-20260815" } });
    const value = createCanvasClipboard("project", [source, text, node], []);
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeDefined();
    let next = 0;
    const copy = duplicateCanvasSelection(value.nodes, [], { x: 500, y: 0 }, () => `copy-${++next}`);
    expect(copy.nodes[2]!.data).toMatchObject({ source: { nodeId: "copy-1" }, promptSource: { nodeId: "copy-2" }, operation: "retexture" });
  });
  it.each(["v2.5-20260210", "v3.0-20260909"] as const)("keeps Tripo %s rig options without changing legacy Meshy nodes", (rigModel) => {
    const node = toAssetCanvasNode({ id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: {
      images: [{ type: "library", assetId: "character" }], animationModel: { provider: "tripo", id: "P1-20260311" },
      actionIds: ["preset:quadruped:walk"], model3DOptions: { rigModel, rigType: "quadruped", animateInPlace: true },
    } });
    const canvas = createAssetCanvasDocument(); canvas.nodes = [node]; canvas.editorLayout.nodes = { animation: node.position };
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    expect(node.data).toMatchObject({ model: { provider: "tripo" }, actionIds: ["preset:quadruped:walk"], options: { rigModel } });
    const legacy = toAssetCanvasNode({ id: "legacy", type: "animate-3d", position: { x: 0, y: 0 }, data: { actionIds: [0, 30] } });
    expect(legacy.data).not.toHaveProperty("model"); expect(legacy.data).toMatchObject({ actionIds: [0, 30] });
  });
  it("removes processing model connections when the source node is deleted", async () => {
    const { removeNodesAndReferences } = await import("../src/renderer/asset-canvas-workspace.js");
    const result = removeNodesAndReferences([{ id: "texture", type: "model-3d", position: { x: 0, y: 0 }, data: { model3DSource: { type: "node", nodeId: "source" }, model3DOperation: "retexture" } }], new Set(["source"]));
    expect(result[0]!.data.model3DSource).toBeUndefined();
  });
});

it.each(["speech", "voice", "sound-effect", "music"] as const)("preserves extra %s generation settings when the editor saves", (type) => {
  const node = toAssetCanvasNode({ id: type, type, position: { x: 0, y: 0 }, data: { text: "Hello", voiceDescription: "Warm", sampleText: "Hello", prompt: "Soft rain", instrumental: true, ...(type === "voice" || type === "speech" ? { language: "en", style: "Warm", speed: 10 } : {}), output: { format: "wav", sampleRate: 24000 } } });
  const canvas = createAssetCanvasDocument(); canvas.nodes = [node]; canvas.editorLayout.nodes[type] = node.position;
  expect(isAssetCanvasDocument(canvas)).toBe(true);
  expect(node.data).toMatchObject({ output: { format: "wav", sampleRate: 24000 } });
  if (type === "voice" || type === "speech") expect(node.data).toMatchObject({ language: "en", style: "Warm", speed: 10 });
});
