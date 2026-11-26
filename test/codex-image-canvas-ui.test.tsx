import { webcrypto } from "node:crypto";
import { referenceMp3, referenceWav } from "./audio-reference-fixture.js";
import { kunpoAudioModels } from "../src/daemon/kunpo-audio.js";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_IMAGE_MODEL } from "../src/daemon/agent-runtimes/codex-image-provider.js";
import { imageModelsForProvider } from "../src/daemon/image-models.js";
import { GPT_IMAGE_26_IDS } from "../src/shared/gpt-image-26.js";
import { kunpoVideoModels, seedanceModel } from "../src/daemon/seedance-models.js";
import { MODEL_3D_MODELS } from "../src/shared/generation-config.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
} from "../src/shared/asset-canvas.js";
import type { AssetCanvasNode, ProjectState, ToolJob } from "../src/shared/contracts.js";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import { t } from "../src/renderer/i18n.js";
import { VIDEO_REFERENCE_BUDGET_ERROR } from "../src/shared/video-reference-preparation.js";

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
let canvasProps: CanvasProps;
let speechReferences: LibraryAsset[] = [];
let imageCatalog = [CODEX_IMAGE_MODEL];
let model3DCatalog: typeof MODEL_3D_MODELS = [];
let showAddControl = false;
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    canvasProps = props;
    return (
      <ReactFlowProvider>
        {showAddControl ? props.addControl : null}
        {props.nodes.map((node) => {
          const Component = props.nodeTypes![node.type!];
          return (
            <Component
              key={node.id}
              {...node}
              type={node.type!}
              selected
              dragging={false}
              draggable
              selectable
              deletable
              zIndex={0}
              isConnectable
              positionAbsoluteX={0}
              positionAbsoluteY={0}
            />
          );
        })}
      </ReactFlowProvider>
    );
  },
}));
vi.doMock(
  path.resolve("src/renderer/model-selector.tsx"),
  async (original) => ({
    ...(await original<typeof import("../src/renderer/model-selector.js")>()),
    useAgentModels: () => ({ models: [], status: "ready" }),
  }),
);
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listImageModelCatalog: async () => ({
    models: imageCatalog,
    providers: [],
  }),
  listAudioModelCatalog: async () => ({ models: kunpoAudioModels("volcengine-tts", "Kunpo Speech", true), providers: [] }),
  listVideoModelCatalog: async () => ({ models: [seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!, ...kunpoVideoModels()], providers: [] }),
  listModel3DCatalog: async () => ({ models: model3DCatalog, providers: [] }),
  listModel3DOperations: async () => model3DCatalog,
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => speechReferences,
}));
const inspectDownload = vi.fn(async (): Promise<{ state: "fake-ip" | "ready" }> => ({ state: "fake-ip" }));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...await original<typeof import("../src/renderer/canvas-api.js")>(), inspectImageDownloadNetwork: inspectDownload,
}));
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  speechReferences = [];
  model3DCatalog = [];
  imageCatalog = [CODEX_IMAGE_MODEL];
  showAddControl = false;
  vi.restoreAllMocks();
  inspectDownload.mockReset().mockResolvedValue({ state: "fake-ip" });
  await act(async () => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { mode: undefined, pose: "t-pose", ids: ["front"], missing: ["Left", "Back"] },
  { mode: "provided-views", pose: "a-pose", ids: ["front", "front", "back"], missing: ["Left"] },
  { mode: "turnaround", ids: ["front", "unresolved", "back"], missing: ["Left"] },
  { mode: "turnaround", ids: ["front", "left", "back"], missing: [] },
  { mode: "turnaround", ids: ["front", "left", "back", "right"], missing: [] },
  { mode: "turnaround", ids: ["front"], singleViewModel: true, missing: [] },
  { mode: undefined, ids: ["front"], missing: [] },
] as const)("checks the resolved views before new 3D generation ($mode, $ids)", async (fixture) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => { expect(init?.method ?? "GET").toBe("GET"); return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }); }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:turnaround-view");
  const tripo = MODEL_3D_MODELS.find(model => model.provider === "tripo" && model.id === "v3.1-20260211")!;
  const model = "singleViewModel" in fixture ? { ...tripo, provider: "synthetic-single-view", maxReferenceImages: 1 } : tripo;
  model3DCatalog = [model];
  speechReferences = ["front", "left", "back", "right", "corrected-front"].map(id => ({ id, assetId: id, path: id + ".png", name: id, mediaType: "image", contentType: "image/png", size: 64, createdAt: "now" }));
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
  if (node.type !== "model-3d") throw new Error();
  Object.assign(node.data, { operation: "image", prompt: "Legacy draft description", model: { provider: model.provider, id: model.id }, targetPolycount: 30_000,
    options: { referenceMode: fixture.mode, ...("pose" in fixture ? { pose: fixture.pose } : {}) },
    images: fixture.ids.map(id => id === "unresolved" ? { type: "node", nodeId: "unproduced" } : { type: "library", assetId: id }) });
  const source = createAssetGenerationNode("image", { x: 0, y: 300 });
  if (source.type !== "image") throw new Error();
  if (fixture.ids.length === 4) {
    source.data.assetId = "front";
    node.data.images[0] = { type: "node", nodeId: source.id };
    board.nodes = [source, node];
  } else board.nodes = [node];
  board.editorLayout.nodes = Object.fromEntries(board.nodes.map(item => [item.id, item.position]));
  const job: ToolJob = { id: "existing", toolId: "image-to-3d", status: "failed", createdAt: "now", title: "Model", canRecoverModel3D: true,
    error: "pose" in fixture ? "Use text generation for a prompt" : "Download failed", context: { projectId: "views", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "views:board", boardId: "board", load: async () => board, save: vi.fn(async value => value), refresh: async () => undefined,
    reconcile: (_s, current) => current, resolveConflict: async (_v, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(async () => ({ ...job, status: "running" as const })) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "views", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("views"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const generate = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.model.generate")}"]`)!;
  expect(generate.disabled).toBe(fixture.missing.length > 0 || "singleViewModel" in fixture);
  if (fixture.missing.length) {
    expect(generate.title).toBe(t("assetCanvas.turnaroundMissing", { views: fixture.missing.map(view => t(`assetCanvas.view.${view}`)).join(t("assetCanvas.viewSeparator")) }));
    expect(host.textContent).toContain(t("assetCanvas.optionalRight"));
  }
  if ("singleViewModel" in fixture) expect(generate.title).toBe(t("assetCanvas.turnaroundModelRequired"));
  if ("pose" in fixture) {
    expect(host.textContent).toContain(t(fixture.pose === "t-pose" ? "assetCanvas.tPoseViews" : "assetCanvas.aPoseViews"));
    expect(host.textContent).not.toContain("Use text generation for a prompt");
  } else expect(host.textContent).toContain("Download failed");
  if (fixture.mode === "turnaround" && fixture.ids.length >= 3) {
    const removeFront = host.querySelector<HTMLButtonElement>('.story-media-reference button[aria-description]')!;
    expect(removeFront.disabled).toBe(true);
  }
  if (fixture.ids.length === 4) {
    const frontEdge = canvasProps.edges!.find(edge => edge.source === source.id && edge.target === node.id)!;
    let allowed: unknown;
    await act(async () => { allowed = await canvasProps.onBeforeDelete!({ nodes: [], edges: [frontEdge] }); });
    expect(allowed).toBe(false);
    await act(async () => { allowed = await canvasProps.onBeforeDelete!({ nodes: canvasProps.nodes.filter(n => n.id === source.id), edges: [frontEdge] }); });
    expect(allowed).toBe(false);
    const replace = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.replaceView", { view: t("assetCanvas.view.Front") })}"]`)!;
    await act(async () => replace.click());
    await act(async () => document.querySelector<HTMLButtonElement>('.story-video-picker-list button[title="corrected-front"]')!.click());
    expect(canvasProps.nodes.find(item => item.id === node.id)!.data.images).toEqual(["corrected-front", "left", "back", "right"].map(assetId => ({ type: "library", assetId })));
    expect(canvasProps.nodes.find(item => item.id === source.id)?.data.assetId).toBe("front");
    expect(generate.disabled).toBe(false);
  }
  if (fixture.ids.length === 3 && !fixture.missing.length) {
    const imported = speechReferences.find(asset => asset.id === "corrected-front")!;
    const upload = vi.spyOn(await import("../src/renderer/api.js"), "createLibraryImage").mockResolvedValue(imported);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.replaceView", { view: t("assetCanvas.view.Front") })}"]`)!.click());
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(false);
    Object.defineProperty(input, "files", { value: [new File(["test"], "corrected-front.png", { type: "image/png" })] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(upload).toHaveBeenCalled(), { timeout: 5000 });
    });
    expect(upload).toHaveBeenCalledWith(
      {
        name: "corrected-front.png",
        purpose: "reference",
        image: { mediaType: "image/png", data: "dGVzdA==" },
      },
      "views",
    );
    expect(canvasProps.nodes[0]!.data.images).toEqual(["corrected-front", "left", "back"].map(assetId => ({ type: "library", assetId })));
  }
  if (!fixture.mode && !("pose" in fixture)) {
    const select = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.modelViewMode")}: ${t("assetCanvas.providedViews")}"]`)!;
    await act(async () => select.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === t("assetCanvas.turnaroundViews"))!.click());
    expect(generate.disabled).toBe(true);
    expect(canvasProps.nodes[0]?.data.model3DOptions).toMatchObject({ referenceMode: "turnaround" });
  }
  const recover = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("kunpoModels.recoverModel"))!;
  await act(async () => recover.click());
  expect(storage.recoverImage).toHaveBeenCalledWith(job.id); expect(storage.generate).not.toHaveBeenCalled();
});

it.each([false, true])("enables supported quad output without extra explanation and recovers without a new generation (%s)", async (quad) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  model3DCatalog = MODEL_3D_MODELS.filter(model => model.provider === "tripo" && model.id === "v3.1-20260211");
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
  if (node.type !== "model-3d") throw new Error();
  Object.assign(node.data, { operation: "text", prompt: "A goose", model: { provider: "tripo", id: "v3.1-20260211" }, targetPolycount: 30_000, texture: true, pbr: false, options: { quad } });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "existing-model-job", toolId: "image-to-3d", canRecoverModel3D: true, status: "failed", createdAt: "now", title: "Model", error: "download failed", context: { projectId: "quad", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "quad:board", boardId: "board", load: async () => board, save: vi.fn(async value => value), refresh: async () => undefined,
    reconcile: (_s, current) => current, resolveConflict: async (_v, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(async () => ({ ...job, status: "running" as const, model3DRecoveryOnly: true })) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "quad", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("quad"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("kunpoModels.quad"))!;
  const generate = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.model.generate")}"]`)!;
  expect(host.textContent).not.toContain("turn off Quad mesh");
  expect(host.textContent).not.toMatch(/Quad mesh keeps an FBX original|四边面会保留 FBX 原件/);
  expect(toggle.getAttribute("aria-pressed")).toBe(String(quad)); expect(toggle.disabled).toBe(false); expect(generate.disabled).toBe(false);
  if (quad) {
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("false"); expect(toggle.disabled).toBe(false); expect(generate.disabled).toBe(false);
    expect(canvasProps.nodes[0]!.data).toMatchObject({ prompt: "A goose", model3DOptions: { quad: false }, model3DConfig: { targetPolycount: 30_000, texture: true, pbr: false } });
  }
  if (quad) {
    await act(async () => generate.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(t("assetCanvas.newMediaDescription"));
    expect(storage.generate).not.toHaveBeenCalled();
  }
  const actions = quad ? document.querySelector('[role="alertdialog"]')! : host;
  const recover = [...actions.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("kunpoModels.recoverModel"))!;
  await act(async () => { recover.click(); await vi.advanceTimersByTimeAsync(350); });
  expect(storage.recoverImage).toHaveBeenCalledWith(job.id);
  expect(storage.generate).not.toHaveBeenCalled();
});

async function confirmationFixture(previous?: Partial<ToolJob>, kind: "image" | "video" = "video") {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode(kind, { x: 0, y: 0 });
  if (node.type === "image") Object.assign(node.data, { prompt: "A test lantern", model: { provider: CODEX_IMAGE_MODEL.provider, id: CODEX_IMAGE_MODEL.id }, resolution: "1K", aspectRatio: "1:1" });
  else Object.assign(node.data, { prompt: "Synthetic test prompt", model: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" }, aspectRatio: "16:9", resolution: "480p", duration: 4, referenceMode: "reference" });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "private-local-job", toolId: kind === "image" ? "generate-image" : "generate-video", createdAt: "now", title: "private prompt must not enter confirmation", status: "failed", error: "Kunpo rejected the video request (HTTP 400; unclassified)", context: { projectId: "confirm", boardId: "board", nodeId: node.id }, ...previous };
  let finish!: (job: ToolJob) => void;
  const generate = vi.fn(() => new Promise<ToolJob>((resolve) => { finish = resolve; }));
  const resumeVideo = vi.fn(() => new Promise<ToolJob>((resolve) => { finish = resolve; }));
  const storage: CanvasBoardStorage = { key: "confirm:board", boardId: "board", load: async () => board, save: vi.fn(async value => value), refresh: async () => undefined, reconcile: (_s, current) => current, resolveConflict: async (_v, value) => value, jobs: async () => previous ? [job] : [], generate, resumeVideo, recoverImage: vi.fn(), cancel: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "confirm", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("confirm"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${t(`assetCanvas.media.${kind}.generate`)}"]`)!;
  expect(button.disabled).toBe(false);
  return { node, job, storage, generate, resumeVideo, button, finish: (next: ToolJob) => finish(next) };
}

it.each([
  undefined,
  { videoSubmission: "not-submitted" as const },
  { videoSubmission: "not-submitted" as const, status: "cancelled" as const },
  { status: "succeeded" as const, videoSubmission: "attempted" as const },
  { error: "Video aspect ratio is not supported by the selected model and reference mode" },
])("does not confirm first, successful or locally unsubmitted video generation (%j)", async previous => {
  const f = await confirmationFixture(previous);
  await act(async () => { f.button.click(); f.button.click(); });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(f.generate).toHaveBeenCalledOnce(); expect(f.resumeVideo).not.toHaveBeenCalled();
});

it.each([
  { videoSubmission: "attempted" as const },
  { videoDiagnostic: { phase: "submission" as const, category: "http" as const, httpStatus: 400 } },
  { error: "Video submission could not be confirmed. Do not repeat the paid request." },
  { error: "Kunpo returned no valid video task ID; submission outcome is unknown. Do not repeat the paid request." },
  { status: "cancelled" as const, error: "Generation was interrupted. Recover a saved result; unknown submissions are never resubmitted." },
])("confirms a new paid video after %j; cancel is free and confirmation is single-use", async previous => {
  const f = await confirmationFixture(previous), before = JSON.stringify(f.job);
  f.button.focus(); await act(async () => { f.button.click(); f.button.click(); });
  let dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1); expect(dialog.className).toBe("design-modal");
  expect(dialog.textContent).toContain(t("assetCanvas.newVideoDescription")); expect(dialog.textContent).not.toContain(f.job.id); expect(dialog.textContent).not.toContain(f.job.title);
  expect(dialog.querySelector("dialog, select")).toBeNull(); expect(f.generate).not.toHaveBeenCalled(); expect(f.resumeVideo).not.toHaveBeenCalled();
  expect([...dialog.querySelectorAll("button")].some(button => button.textContent === t("assetCanvas.recoverVideo"))).toBe(false);
  expect(document.activeElement?.textContent).toBe(t("common.cancel"));
  await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(document.activeElement).toBe(f.button); expect(f.generate).not.toHaveBeenCalled();
  await act(async () => f.button.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === t("common.cancel"))!.click());
  expect(f.generate).not.toHaveBeenCalled(); expect(f.resumeVideo).not.toHaveBeenCalled();
  await act(async () => f.button.click()); dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const confirm = [...dialog.querySelectorAll("button")].find(b => b.textContent === t("assetCanvas.newVideoConfirm"))!;
  await act(async () => { confirm.click(); confirm.click(); });
  expect(f.generate).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledWith(f.node.id, f.job.id); expect(f.resumeVideo).not.toHaveBeenCalled();
  await act(async () => f.finish({ ...f.job, id: "new-local-job", status: "succeeded" }));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(JSON.stringify(f.job)).toBe(before);
});

it.each([false, true])("confirms new image spend for an unresolved result, offering recovery only for a saved result (%s)", async (saved) => {
  const f = await confirmationFixture({ submissionOutcome: "unknown", canRecoverImage: saved }, "image");
  await act(async () => f.button.click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(t("assetCanvas.newMediaDescription"));
  const actions = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
  expect(actions.some(button => button.textContent === t("assetCanvas.recoverImage"))).toBe(saved);
  expect(f.generate).not.toHaveBeenCalled();
  const confirm = actions.find(button => button.textContent === t("assetCanvas.newVideoConfirm"))!;
  await act(async () => { confirm.click(); confirm.click(); });
  expect(f.generate).toHaveBeenCalledOnce();
  expect(f.generate).toHaveBeenCalledWith(f.node.id, f.job.id);
  expect(f.storage.recoverImage).not.toHaveBeenCalled();
});

it("offers GET-only recovery in the confirmation only when a saved video exists", async () => {
  const f = await confirmationFixture({ canRecoverVideo: true, videoSubmission: "attempted" });
  await act(async () => f.button.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!, buttons = [...dialog.querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  buttons[0]!.focus(); await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[2]);
  await act(async () => buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[0]);
  const recover = buttons.find(b => b.textContent === t("assetCanvas.recoverVideo"))!;
  await act(async () => { recover.click(); recover.click(); });
  expect(f.resumeVideo).toHaveBeenCalledOnce(); expect(f.resumeVideo).toHaveBeenCalledWith(f.job.id); expect(f.generate).not.toHaveBeenCalled();
  await act(async () => f.finish({ ...f.job, id: "retrieving", status: "running", videoRecoveryOnly: true }));
});

it.each([false, true])("uses the existing feedback and action styles for request budget met=%s without a paid replay", async met => {
  const summary = { version: 3 as const, optimized: 0, unchanged: 0, unsupported: 0, invalid: 0, limited: 0, originalBytes: 0, sentBytes: 0,
    jpegConverted: 0, jpegSkipped: 0, jpegTransparent: 0, jpegLimited: 0, jpegResized: 0, jpegOriented: 0, jpegQuality: 95 as const, jpegMaxEdge: 2048 as const,
    requestBytes: met ? 700_000 : 900_000, originalRequestBytes: 2_000_000, requestBudgetBytes: 786432 as const, requestBudgetMet: met,
    requestBudgetPasses: 8, requestBudgetConverted: 2, requestBudgetResized: 2, requestBudgetQuality: 90 as const, requestBudgetMaxEdge: 384 as const };
  const f = await confirmationFixture({ videoReferencePreparation: summary, videoSubmission: "not-submitted", error: met ? "Synthetic connection failure" : VIDEO_REFERENCE_BUDGET_ERROR });
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain(t(met ? "assetCanvas.referenceBudgetResized" : "assetCanvas.videoReferenceBudgetExceeded"));
  expect(host.querySelectorAll(".story-media-composer > p")).toHaveLength(1);
  expect(host.querySelector("select, dialog")).toBeNull(); expect(f.generate).not.toHaveBeenCalled(); expect(f.resumeVideo).not.toHaveBeenCalled();
  await act(async () => f.button.click());
  expect(host.querySelector('[role="alertdialog"]')).toBeNull(); expect(f.generate).toHaveBeenCalledOnce(); expect(f.resumeVideo).not.toHaveBeenCalled();
  await act(async () => f.finish({ ...f.job, status: "failed" }));
});

it.each([
  ["optimized", "pngLosslesslyOptimized"], ["unchanged", "pngOriginalUnchanged"], ["unsupported", "pngOriginalUnsupported"],
  ["invalid", "pngOriginalInvalid"], ["limited", "pngOriginalLimited"],
  ["jpegConverted", "referenceJpegConverted"], ["jpegTransparent", "referenceJpegTransparent"], ["jpegLimited", "referenceJpegLimited"], ["jpegSkipped", "referenceJpegSkipped"],
] as const)("uses existing video feedback for %s PNG without new controls or automatic generation", async (status, key) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "png-feedback", toolId: "generate-video", status: "failed", createdAt: "now", title: "Video", error: "Kunpo rejected the video request (HTTP 400; unclassified)",
    videoReferencePreparation: status.startsWith("jpeg") ? { version: 2, optimized: 0, unchanged: status === "jpegConverted" ? 0 : 1, unsupported: 0, invalid: 0, limited: 0, originalBytes: 1000, sentBytes: 500,
      jpegConverted: 0, jpegTransparent: 0, jpegLimited: 0, jpegSkipped: 0, jpegResized: 0, jpegOriented: 0, jpegQuality: 95, jpegMaxEdge: 2048, requestBytes: 1000, originalRequestBytes: 1500, [status]: 1 }
      : { version: 1, optimized: 0, unchanged: 0, unsupported: 0, invalid: 0, limited: 0, originalBytes: 1000, sentBytes: 500, [status]: 1 },
    context: { projectId: "png", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "png:board", boardId: "board", load: async () => board, save: vi.fn(async (value) => value), refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(), resumeVideo: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "png", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("png"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const notice = t(`assetCanvas.${key}`);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(notice);
  const generate = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.video.generate")}"]`)!;
  expect(generate.getAttribute("aria-description")).toBe(notice);
  expect(host.querySelectorAll(".story-media-composer > p")).toHaveLength(1);
  expect(host.querySelector("select, dialog, input[type=file]")).toBeNull();
  expect(storage.generate).not.toHaveBeenCalled(); expect(storage.resumeVideo).not.toHaveBeenCalled();
});

it.each([false, true])("offers video retrieval only for a saved task (%s), coalesces double clicks and labels cancellation", async (canRecoverVideo) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "original-video", toolId: "generate-video", status: "failed", createdAt: new Date().toISOString(), title: "Video", canRecoverVideo, error: "Kunpo video task status is unknown; resume its saved ID instead of resubmitting", context: { projectId: "video", boardId: "board", nodeId: node.id } };
  let finish!: (job: ToolJob) => void;
  const resumeVideo = vi.fn(() => new Promise<ToolJob>((resolve) => { finish = resolve; }));
  const storage: CanvasBoardStorage = { key: "video:board", boardId: "board", load: async () => board, save: async (value) => value, refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(async (): Promise<ToolJob> => ({ ...job, status: "cancelled" })), recoverImage: vi.fn(), resumeVideo };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "video", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("video"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("assetCanvas.recoverVideo"));
  if (!canRecoverVideo) { expect(button).toBeUndefined(); expect(resumeVideo).not.toHaveBeenCalled(); return; }
  expect(button).toBeTruthy(); expect(button!.classList.contains("canvas-chip")).toBe(true);
  expect(button!.title).toBe(t("assetCanvas.recoverVideoHint"));
  await act(async () => { button!.click(); button!.click(); });
  expect(resumeVideo).toHaveBeenCalledOnce(); expect(resumeVideo).toHaveBeenCalledWith("original-video");
  expect(storage.generate).not.toHaveBeenCalled(); expect(storage.recoverImage).not.toHaveBeenCalled();
  await act(async () => finish({ ...job, id: "retrieving", status: "running", videoRecoveryOnly: true }));
  expect(host.textContent).toContain(t("assetCanvas.recoveringVideo"));
  const stop = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.cancelVideoRecovery")}"]`)!;
  expect(stop).toBeTruthy();
  await act(async () => stop.click());
  expect(storage.cancel).toHaveBeenCalledWith("retrieving"); expect(storage.generate).not.toHaveBeenCalled();
});

it.each(["bad-response-status", "unclassified", "reason unknown"])("shows %s as an unknown cause without changing saved history or submitting", async (reason) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const original = `Kunpo rejected the video request (HTTP 400; ${reason})`;
  const job: ToolJob = { id: "unknown-video", toolId: "generate-video", status: "failed", createdAt: "now", title: "Video", error: original, context: { projectId: "video", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "video:board", boardId: "board", load: async () => board, save: vi.fn(async (value) => value), refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(), resumeVideo: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "video", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("video"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(`Kunpo rejected the video request (HTTP 400; ${t("assetCanvas.providerReasonUnknown")})`);
  expect(job.error).toBe(original); expect(storage.generate).not.toHaveBeenCalled(); expect(storage.resumeVideo).not.toHaveBeenCalled();
});

it.each([seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!, ...kunpoVideoModels()])("preserves an old invalid video ratio and requires the first frame for $id", async (model) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }));
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
  if (node.type !== "video") throw new Error();
  Object.assign(node.data, { prompt: "Fixture", model: { provider: model.provider, id: model.id }, resolution: model.resolutions[0], aspectRatio: "adaptive", referenceMode: "reference" });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "saved-adaptive", toolId: "generate-video", status: "failed", createdAt: "2026-10-29T00:00:00Z", title: "Fixture", canRecoverVideo: true, context: { projectId: "adaptive", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "adaptive:board", boardId: "board", load: async () => board, save: vi.fn(async (value) => value), refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(), resumeVideo: vi.fn(async () => job) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "adaptive", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("adaptive"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const current = () => canvasProps.nodes[0]!.data as { videoAspectRatio: string; referenceMode: string; references: unknown[]; videoRuntime: { onAddLibraryReference: (asset: object) => void; onRemoveReference: (index: number) => void } };
  const generation = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.video.generate")}"]`)!;
  const select = async (label: string, value: string) => {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${label}:`))!;
    await act(async () => trigger.click());
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const choice = options.find((option) => option.textContent === value);
    expect(choice).toBeTruthy(); await act(async () => choice!.click());
  };
  expect(current().videoAspectRatio).toBe("adaptive");
  expect(host.textContent).toContain(t("assetCanvas.videoAspectNeedsReferences"));
  expect(generation().disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  for (const [saved] of vi.mocked(storage.save).mock.calls) expect(saved.nodes[0]!.data).toEqual(node.data);
  const recovery = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("assetCanvas.recoverVideo"))!;
  expect(recovery.disabled).toBe(false); await act(async () => recovery.click());
  expect(storage.resumeVideo).toHaveBeenCalledWith("saved-adaptive"); expect(storage.generate).not.toHaveBeenCalled();
  expect(current().videoAspectRatio).toBe("adaptive");
  await select(t("assetCanvas.videoAspect"), "16:9"); expect(generation().disabled).toBe(false);
  await select(t("assetCanvas.referenceMode"), t("assetCanvas.firstLast"));
  expect(current().videoAspectRatio).toBe("adaptive"); expect(generation().disabled).toBe(true);
  expect(generation().title).toBe(t("assetCanvas.videoNeedsFirstFrame"));
  expect(host.textContent).toContain(t("assetCanvas.videoNeedsFirstFrame"));
  const aspectTrigger = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${t("assetCanvas.videoAspect")}:`))!;
  await act(async () => aspectTrigger().click());
  expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["adaptive"]);
  await act(async () => aspectTrigger().click());
  await act(async () => current().videoRuntime.onAddLibraryReference({ id: "reference", name: "Fixture.png", mediaType: "image", contentType: "image/png" }));
  expect(current().referenceMode).toBe("frame"); expect(current().videoAspectRatio).toBe("adaptive");
  expect(generation().disabled).toBe(false);
  await act(async () => current().videoRuntime.onRemoveReference(0));
  expect(current().videoAspectRatio).toBe("adaptive"); expect(generation().disabled).toBe(true);
  await act(async () => current().videoRuntime.onAddLibraryReference({ id: "reference", name: "Fixture.png", mediaType: "image", contentType: "image/png" }));
  expect(host.textContent).not.toContain(t("kunpoModels.settingsReset"));
  expect(host.textContent).not.toContain(t("assetCanvas.videoAspectIncompatible"));
  await select(t("assetCanvas.referenceMode"), t("assetCanvas.imageReferences"));
  await act(async () => current().videoRuntime.onRemoveReference(0));
  expect(current().videoAspectRatio).toBe("16:9"); expect(generation().disabled).toBe(false);
  expect(host.textContent).not.toContain(t("assetCanvas.videoAspectNeedsReferences"));
  await act(async () => {
    for (const id of ["first", "second", "third"]) current().videoRuntime.onAddLibraryReference({ id, name: `${id}.png`, mediaType: "image", contentType: "image/png" });
  });
  const modeTrigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${t("assetCanvas.referenceMode")}:`))!;
  await act(async () => modeTrigger.click());
  expect([...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === t("assetCanvas.firstLast"))!.disabled).toBe(true);
  expect(current().references).toHaveLength(3);
  expect(storage.generate).not.toHaveBeenCalled();
});

it("displays the empty frame constraint across reopen without rewriting an old draft or blocking saved-task recovery", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("video", { x: 0, y: 0 });
  if (node.type !== "video") throw new Error();
  Object.assign(node.data, { prompt: "Legacy empty frame", model: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" }, aspectRatio: "16:9", referenceMode: "frame" });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const job: ToolJob = { id: "saved-empty-frame", toolId: "generate-video", status: "failed", createdAt: "2026-10-29T00:00:00Z", title: "Fixture", canRecoverVideo: true, context: { projectId: "empty-frame", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "empty-frame:board", boardId: "board", load: async () => structuredClone(board), save: vi.fn(async (value) => value), refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn(), resumeVideo: vi.fn(async () => job) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  for (let open = 0; open < 2; open++) {
    await act(async () => root.render(<CanvasBoardEditor key={open} project={{ id: "empty-frame", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("empty-frame"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
    await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
    const generate = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.video.generate")}"]`)!;
    expect(generate.disabled).toBe(true); expect(generate.title).toBe(t("assetCanvas.videoNeedsFirstFrame"));
    expect(host.querySelector(`button[aria-label="${t("assetCanvas.videoAspect")}: adaptive"]`)).toBeTruthy();
    expect(canvasProps.nodes[0]!.data.videoAspectRatio).toBe("16:9");
    const recover = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("assetCanvas.recoverVideo"))!;
    expect(recover.disabled).toBe(false); await act(async () => recover.click());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  }
  expect(storage.resumeVideo).toHaveBeenCalledTimes(2); expect(storage.generate).not.toHaveBeenCalled();
  for (const [saved] of vi.mocked(storage.save).mock.calls) expect(saved.nodes[0]!.data).toEqual(node.data);
});

it("reloads reference choices on every open without pruning existing canvas references", async () => {
  showAddControl = true;
  vi.spyOn(await import("../src/renderer/api.js"), "getLibraryAsset").mockResolvedValue(new Blob(["synthetic image"], { type: "image/png" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-reference");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const reference: LibraryAsset = { id: "kept-reference", assetId: "kept-reference", name: "kept.png", path: "kept.png", size: 1, mediaType: "image", contentType: "image/png", purpose: "reference", saved: true, createdAt: "now" };
  const deleted: LibraryAsset = { ...reference, id: "deleted-reference", assetId: "deleted-reference", name: "deleted.png", path: "deleted.png" };
  speechReferences = [reference, deleted];
  const f = await confirmationFixture();
  const runtime = () => canvasProps.nodes[0]!.data.videoRuntime as any;
  const references = [{ type: "library", assetId: reference.id }];
  await act(async () => runtime().onChange({ ...canvasProps.nodes[0]!.data, references }));
  speechReferences = [reference];
  const open = async () => act(async () => host.querySelector<HTMLButtonElement>(".story-media-reference-add")!.click());
  await open();
  expect([...document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")].map(button => button.title)).toEqual(["kept.png"]);
  expect(canvasProps.nodes[0]!.data.references).toEqual(references);
  await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("nodeWorkbench.closePicker")}"]`)!.click());
  speechReferences = [];
  await open();
  expect(document.querySelectorAll(".story-video-picker-list > button")).toHaveLength(0);
  expect(canvasProps.nodes[0]!.data.references).toEqual(references);
  await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("nodeWorkbench.closePicker")}"]`)!.click());
  speechReferences = [{ ...reference, id: "new-choice", assetId: "new-choice", name: "new-choice.png", path: "new-choice.png", purpose: "asset", projects: [{ id: "confirm", name: "Current project", type: "asset-canvas" }] }];
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.addNode")}"]`)!.click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(button => button.querySelector("strong")?.textContent === t("assetCanvas.fromLibrary"))!.click());
  expect([...document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")].map(button => button.title)).toEqual(["new-choice.png"]);
  expect(canvasProps.nodes[0]!.data.references).toEqual(references);
  expect(f.generate).not.toHaveBeenCalled();
});

it("switches Kunpo 2.6 formats and models, keeping transparent WebP and blocking conflicting GIF settings", async () => {
  const [sunburst, flare] = GPT_IMAGE_26_IDS;
  imageCatalog = [CODEX_IMAGE_MODEL, ...imageModelsForProvider("openai", "Kunpo", [sunburst, flare])];
  const f = await confirmationFixture({ submissionOutcome: "unknown" }, "image");
  const data = () => canvasProps.nodes[0]!.data;
  const chip = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}:"]`);
  async function pick(label: string, option: string) {
    await act(async () => chip(label)!.click());
    const choice = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(button => button.textContent?.includes(option));
    expect(choice).toBeDefined();
    await act(async () => choice!.click());
  }
  async function input(label: string, value: string) {
    const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  await pick(t("assetCanvas.imageModel"), "GPT Image 2.6 Sunburst");
  await pick(t("kunpoModels.background"), t("kunpoModels.transparent"));
  await pick(t("kunpoModels.format"), "WebP");
  await act(async () => host.querySelector("summary")!.click());
  await input(t("kunpoModels.compression"), "0");
  expect(data()).toMatchObject({ model: { id: sunburst }, outputFormat: "webp", outputCompression: 0, background: "transparent" });
  await pick(t("assetCanvas.imageModel"), "GPT Image 2.6 Flare");
  expect(data()).toMatchObject({ model: { id: flare }, outputFormat: "webp", outputCompression: 0, background: "transparent" });
  await pick(t("kunpoModels.format"), "SVG");
  expect(chip(t("kunpoModels.svgAuthor"))?.textContent).toBe("gpt-6-sol");
  expect(chip(t("kunpoModels.svgEffort"))?.textContent).toContain("low");
  expect(f.button.disabled).toBe(false);
  await pick(t("kunpoModels.format"), "GIF");
  expect(data().background).toBe("transparent");
  expect(host.textContent).toContain(t("kunpoModels.imageProblem.transparency"));
  expect(f.button.disabled).toBe(true);
  await pick(t("kunpoModels.background"), t("kunpoModels.opaque"));
  expect(chip(t("assetCanvas.imageResolution"))).toBeNull();
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${t("kunpoModels.frameSize")}"]`)?.placeholder).toBe("512x512");
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${t("kunpoModels.frameDuration")}"]`)?.placeholder).toBe("200");
  await input(t("kunpoModels.frameDuration"), "1");
  expect(f.button.disabled).toBe(true);
  expect(data().frameDurationMs).toBeUndefined();
  await input(t("kunpoModels.frameDuration"), "120");
  await input(t("kunpoModels.frameSize"), "768×432");
  expect(f.button.disabled).toBe(false);
  expect(data()).toMatchObject({ frameDurationMs: 120, pixelSize: "768x432", outputFormat: "gif" });
  await pick(t("assetCanvas.imageModel"), "GPT Image 2.6 Sunburst");
  expect(data()).toMatchObject({ model: { id: sunburst }, frameDurationMs: 120, pixelSize: "768x432", outputFormat: "gif" });
  await act(async () => f.button.click());
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("768x432");
  expect(dialog.textContent).toContain(t("kunpoModels.animationSummary", { frames: 9, ms: 120 }));
  expect(f.generate).not.toHaveBeenCalled();
  await act(async () => [...dialog.querySelectorAll("button")].find(button => button.textContent === t("assetCanvas.newVideoConfirm"))!.click());
  expect(f.generate).toHaveBeenCalledOnce();
  expect(vi.mocked(f.storage.save).mock.calls.at(-1)?.[0].nodes[0]?.data).toMatchObject({ frameDurationMs: 120, pixelSize: "768x432", outputFormat: "gif" });
});

it("selects Codex without fake dimension options and hides its dimension controls", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const board = createAssetCanvasDocument();
  const node = createAssetGenerationNode("image", { x: 0, y: 0 });
  if (node.type !== "image") throw new Error("Expected image node");
  node.data.prompt = "Combine the references";
  node.data.resolution = "4K";
  node.data.aspectRatio = "16:9";
  board.nodes = [node];
  board.editorLayout.nodes = { [node.id]: node.position };
  const storage: CanvasBoardStorage = {
    key: "codex:board",
    boardId: "board",
    load: async () => board,
    save: async (value) => value,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
    recoverImage: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "codex", type: "asset-canvas" } as ProjectState}
        storage={storage}
        documents={{ documents: [] } as unknown as CanvasDocuments}
        tables={{
          storage: new CanvasTableStorage("codex"),
          open: vi.fn(),
          add: vi.fn(),
        }}
        assets={[]}
      />,
    ),
  );
  await act(async () =>
    canvasProps.onNodesChange!([
      { type: "select", id: node.id, selected: true },
    ]),
  );
  const picker = host.querySelector<HTMLButtonElement>(
    `button[aria-label^="${t("assetCanvas.imageModel")}:"]`,
  )!;
  await act(async () => picker.click());
  const option = [
    ...document.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
  ].find((button) => button.textContent?.includes("Codex Image"))!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
  expect(canvasProps.nodes[0]!.data).toMatchObject({
    model: { provider: "codex-cli", id: "codex-image" },
    resolution: "4K",
    aspectRatio: "16:9",
  });
  expect(
    host.querySelector(
      `button[aria-label^="${t("assetCanvas.imageAspect")}:"]`,
    ),
  ).toBeNull();
  expect(
    host.querySelector(
      `button[aria-label^="${t("assetCanvas.imageResolution")}:"]`,
    ),
  ).toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Generate image"]')
      ?.disabled,
  ).toBe(false);
});

it.each([
  ["download", "The image result was received, but its download failed. Recover the existing result; do not generate again.", "imageDownloadFailed"],
  ["cancelled", "This operation was aborted", "imageWaitCancelled"],
  ["legacy-address", "Invalid provider artifact address", "imageAddressRejected"],
  ["fake-ip", "Invalid provider artifact address: Fake-IP DNS is not supported. No generation request was submitted.", "imageFakeIpNotSubmitted"],
  ["fake-ip-received", "Invalid provider artifact address: Fake-IP DNS is not supported. The image result was received; recover it after fixing the network.", "imageFakeIpReceived"],
  ["cdn", "Image CDN could not be reached safely. No generation request was submitted.", "imageCdnNotSubmitted"],
  ["unknown", "The previous image submission could not be confirmed.", "imageRecoveryUnavailable"],
] as const)("handles %s without offering recovery for missing results or submitting implicitly", async (reason, error, message) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument(), node = createAssetGenerationNode("image", { x: 0, y: 0 });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  const canRecoverImage = ["download", "cancelled", "fake-ip-received"].includes(reason);
  const job: ToolJob = { id: "paid-original", toolId: "generate-image", createdAt: new Date().toISOString(), title: "Recovery", status: "failed", error, canRecoverImage, context: { projectId: "recover", boardId: "board", nodeId: node.id } };
  let finish!: (value: ToolJob) => void;
  const recoverImage = vi.fn(() => new Promise<ToolJob>((resolve) => { finish = resolve; }));
  const storage: CanvasBoardStorage = { key: "recover:board", boardId: "board", load: async () => board, save: async (value) => value, refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "recover", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("recover"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("assetCanvas.recoverImage"))!;
  const status = host.querySelector(".story-media-status")!;
  expect(status.textContent).toBe(t(`assetCanvas.${message}Short`));
  expect(status.getAttribute("aria-label")).toBe(t(`assetCanvas.${message}`));
  expect(status.getAttribute("title")).toBe(t(`assetCanvas.${message}`));
  expect(status.getAttribute("role")).toBe(reason === "cancelled" ? "status" : "alert");
  if (!canRecoverImage) {
    expect(button).toBeUndefined(); expect(storage.generate).not.toHaveBeenCalled(); expect(recoverImage).not.toHaveBeenCalled();
    if (reason === "fake-ip") {
      const check = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("assetCanvas.imageNetworkCheck"))!;
      await act(async () => { check.click(); check.click(); });
      expect(inspectDownload).toHaveBeenCalledOnce();
      expect(host.textContent).toContain(t("assetCanvas.imageNetwork.fake-ip"));
      inspectDownload.mockResolvedValue({ state: "ready" });
      await act(async () => check.click());
      expect(host.textContent).toContain(t("assetCanvas.imageNetwork.ready"));
      expect(storage.generate).not.toHaveBeenCalled(); expect(recoverImage).not.toHaveBeenCalled();
    }
    return;
  }
  expect(button).toBeTruthy(); expect(button.classList.contains("canvas-chip")).toBe(true);
  expect(button.classList.contains("canvas-asset-retry")).toBe(false);
  expect(button.closest(".story-media-controls")).toBeTruthy();
  expect(button.title).toBe(t("assetCanvas.recoverImageHint"));
  await act(async () => { button.click(); button.click(); });
  expect(recoverImage).toHaveBeenCalledOnce(); expect(recoverImage).toHaveBeenCalledWith("paid-original");
  expect(storage.generate).not.toHaveBeenCalled(); expect(button.disabled).toBe(true);
  await act(async () => finish({ ...job, id: "recovering", status: "running", imageRecoveryOnly: true }));
  expect(host.querySelector(`button[aria-label="${t("assetCanvas.cancelImageRecovery")}"]`)).toBeTruthy();
  expect(host.textContent).toContain(t("assetCanvas.recoveringImage"));
  expect(host.querySelector(".story-media-generation span")).toBeNull();
});


it("uses a local speech reference, preserves old ID data, auditions locally and coalesces generate clicks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  const bytes = referenceWav();
  speechReferences = [{ id: "voice-reference", assetId: "voice-reference", path: "voice.wav", name: "voice.wav", mediaType: "audio", contentType: "audio/wav", size: bytes.length, duration: 1, createdAt: "2026-10-29T00:00:00Z", purpose: "reference", saved: true }];
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/wav" } });
  }); vi.stubGlobal("fetch", request);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-reference"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  const board = createAssetCanvasDocument(), node = { id: "speech", type: "speech" as const, position: { x: 0, y: 0 }, data: { text: "" } };
  Object.assign(node.data, { text: "Hello traveler", voiceId: "legacy-private-id", model: { provider: "volcengine-tts", id: "seed-audio-1.0" } });
  board.nodes = [node]; board.editorLayout.nodes = { [node.id]: node.position };
  let finish!: (job: ToolJob) => void;
  const generate = vi.fn(() => new Promise<ToolJob>((resolve) => { finish = resolve; }));
  const storage: CanvasBoardStorage = { key: "speech:board", boardId: "board", load: async () => board, save: vi.fn(async (value) => value), refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [], generate, cancel: vi.fn(), recoverImage: vi.fn(), resumeVideo: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "speech", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("speech"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: node.id, selected: true }]));
  const current = () => canvasProps.nodes.find((candidate) => candidate.id === node.id)!.data as any;
  expect(host.querySelector(".canvas-node-label")?.textContent).toContain(t("assetCanvas.node.speech"));
  expect(host.textContent).toContain(t("assetCanvas.media.speech.none"));
  const button = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.media.speech.generate")}"]`)!;
  expect(button().disabled).toBe(true); expect(host.textContent).not.toContain("legacy-private-id"); expect(host.querySelector("select")).toBeNull();
  const referenceAdd = host.querySelector<HTMLButtonElement>(".story-media-reference-add")!;
  expect(referenceAdd.textContent?.trim()).toBe("");
  expect(referenceAdd.querySelector("svg")).toBeTruthy();
  expect(referenceAdd.getAttribute("aria-label")).toBe(t("assetCanvas.audioReference"));
  expect(button().title).toBe(t("assetCanvas.legacyVoice"));
  expect(host.querySelector(".story-media-composer .canvas-chip-menu-note")).toBeNull();
  await act(async () => { await current().audioRuntime.voiceReference.onAddLibraryReference(speechReferences[0]); });
  expect(current().referenceAssetId).toBe("voice-reference"); expect(current().voiceId).toBeUndefined();
  expect(host.querySelector(".story-media-reference > small")).toBeNull();
  expect(button().disabled).toBe(false); expect(generate).not.toHaveBeenCalled();
  const audition = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.playReference", { name: "voice.wav" })}"]`)!;
  expect(audition).toBeTruthy(); expect(host.querySelector("audio[controls]")).toBeNull();
  await act(async () => audition.click()); expect(play).toHaveBeenCalledOnce();
  await act(async () => current().audioRuntime.voiceReference.onRemoveReference(0));
  expect(pause).toHaveBeenCalled(); expect(current().referenceAssetId).toBeUndefined(); expect(button().disabled).toBe(false);
  await act(async () => current().audioRuntime.voiceReference.onUploadReferences([new File(["not audio"], "renamed.m4a")]));
  expect(current().referenceAssetId).toBeUndefined(); expect(host.textContent).toContain(t("assetCanvas.audioReferenceInvalid")); expect(generate).not.toHaveBeenCalled();
  const uploads = vi.spyOn(await import("../src/renderer/api.js"), "uploadLibraryAsset").mockImplementation(async (file, contentType, duration, purpose) => ({ id: `import-${file.name}`, assetId: `import-${file.name}`, path: file.name, name: file.name, size: file.size, mediaType: "audio", contentType, duration, purpose, createdAt: "now", saved: true } as LibraryAsset));
  for (const [actualBytes, name, contentType, importedName] of [
    [referenceMp3(), "sample.WAV", "audio/mpeg", "sample.mp3"],
    [referenceWav(), "sample.MP3", "audio/wav", "sample.wav"],
  ] as const) {
    const source = new File([new Uint8Array(actualBytes)], name, { type: name.endsWith("WAV") ? "audio/wav" : "audio/mpeg", lastModified: 1234 });
    await act(async () => {
      current().audioRuntime.voiceReference.onUploadReferences([source]);
      await vi.waitFor(() => expect(uploads.mock.calls.at(-1)?.[0].name).toBe(importedName));
    });
    expect(current().referenceAssetId).toBe(`import-${importedName}`);
    const [imported, detectedType, duration, purpose] = uploads.mock.calls.at(-1)!;
    expect(imported.name).toBe(importedName); expect(imported.type).toBe(contentType); expect(detectedType).toBe(contentType);
    expect(duration).toBeGreaterThan(0); expect(duration).toBeLessThan(30); expect(purpose).toBe("reference");
    expect(new Uint8Array(await imported.arrayBuffer())).toEqual(new Uint8Array(actualBytes));
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(actualBytes));
    expect(source.name).toBe(name); expect(source.lastModified).toBe(1234); expect(imported.lastModified).toBe(1234);
    expect(current().referenceSha256).toMatch(/^[a-f0-9]{64}$/); expect(generate).not.toHaveBeenCalled();
  }
  expect(uploads).toHaveBeenCalledTimes(2);
  await act(async () => current().audioRuntime.voiceReference.onUploadReferences([new File(["not actual MP3 or WAV"], "renamed.wav")]));
  expect(uploads).toHaveBeenCalledTimes(2); expect(current().referenceAssetId).toBe("import-sample.wav");
  await act(async () => current().audioRuntime.voiceReference.onAddLibraryReference(speechReferences[0]));
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.playReference", { name: "voice.wav" })}"]`)!.click());
  await act(async () => { button().click(); button().click(); }); expect(generate).toHaveBeenCalledOnce();
  const pauseWhileBusy = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("assetCanvas.pauseReference", { name: "voice.wav" })}"]`)!;
  expect(pauseWhileBusy.disabled).toBe(false); await act(async () => pauseWhileBusy.click());
  await act(async () => finish({ id: "speech-job", toolId: "generate-speech", status: "failed", createdAt: "now", title: "Speech", submissionOutcome: "unknown", error: "Unknown result", context: { projectId: "speech", boardId: "board", nodeId: node.id } }));
  expect(host.textContent).toContain("Unknown result"); expect(generate).toHaveBeenCalledOnce();
  await act(async () => button().click()); expect(generate).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain(t("assetCanvas.newAudioDescription"));
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === t("common.cancel"))!.click());
  expect(generate).toHaveBeenCalledOnce();

  await act(async () => current().audioRuntime.voiceReference.onUploadReferences([new File(["not audio"], "unsupported.m4a")]));
  expect(host.textContent).toContain(t("assetCanvas.audioReferenceInvalid"));
  expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
});

it("connects an unselected voice output directly and keeps connected speech pinned until update", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); localStorage.clear();
  const wav = referenceWav();
  speechReferences = ["sample-a", "sample-b"].map((id) => ({ id, assetId: id, path: `${id}.wav`, name: `${id}.wav`, mediaType: "audio", contentType: "audio/wav", size: wav.length, duration: 1, createdAt: "2026-10-31T00:00:00Z", purpose: "reference", saved: true }));
  speechReferences.push({ id: "too-large", assetId: "too-large", path: "too-large.wav", name: "too-large.wav", mediaType: "audio", contentType: "audio/wav", size: 10_000_001, createdAt: "now", saved: true });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => { expect(init?.method ?? "GET").toBe("GET"); return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav" } }); }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-local"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const board = createAssetCanvasDocument(), model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
  board.nodes = [{ id: "voice", type: "voice", position: { x: 0, y: 0 }, data: { description: "Warm", sampleText: "Hello", model, assetId: "sample-a" } }, { id: "speech", type: "speech", position: { x: 600, y: 0 }, data: { text: "Begin", model } }];
  board.editorLayout.nodes = Object.fromEntries(board.nodes.map((node) => [node.id, node.position]));
  const generate = vi.fn(), save = vi.fn(async (value) => value);
  const storage: CanvasBoardStorage = { key: "voice:board", boardId: "board", load: async () => board, save, refresh: async () => undefined, reconcile: (_s, current) => current, resolveConflict: async (_v, value) => value, jobs: async () => [], generate, cancel: vi.fn(), recoverImage: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "voice-project", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("voice-project"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  const data = (id: string) => canvasProps.nodes.find((node) => node.id === id)!.data as any;
  await act(async () => canvasProps.onNodesChange!([{ type: "select", id: "voice", selected: true }]));
  expect(host.querySelector(`textarea[aria-label="${t("assetCanvas.voiceDescription")}"]`)).toBeTruthy();
  expect(host.querySelector(`textarea[aria-label="${t("assetCanvas.voiceSampleText")}"]`)).toBeTruthy();
  expect(data("voice").selectedAssetId).toBeUndefined();
  await act(async () => canvasProps.onConnect!({ source: "voice", target: "speech", sourceHandle: "out", targetHandle: null }));
  expect(data("voice").selectedAssetId).toBe("sample-a"); expect(data("voice").selectedSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(data("speech").referenceAssetId).toBe("sample-a");
  expect(generate).not.toHaveBeenCalled();
  await act(async () => canvasProps.onConnect!({ source: "speech", target: "voice", sourceHandle: "out", targetHandle: null }));
  expect(data("voice").referenceAssetId).toBeUndefined();
  await act(async () => canvasProps.onConnect!({ source: "voice", target: "voice", sourceHandle: "out", targetHandle: null }));
  expect(data("voice").voiceSourceNodeId).toBeUndefined();
  await act(async () => data("voice").audioRuntime.onChange({ ...data("voice"), assetId: "sample-b" }));
  expect(data("voice").selectedAssetId).toBe("sample-a"); expect(data("speech").referenceAssetId).toBe("sample-a");
  await act(async () => { await data("voice").audioRuntime.onSelectSample(); });
  expect(data("voice").selectedAssetId).toBe("sample-b"); expect(data("speech").referenceAssetId).toBe("sample-a");
  await act(async () => data("speech").audioRuntime.onUpdateVoice());
  expect(data("speech").referenceAssetId).toBe("sample-b"); expect(generate).not.toHaveBeenCalled();
  await act(async () => data("speech").audioRuntime.voiceReference.onRemoveReference(0));
  expect(data("speech").referenceAssetId).toBeUndefined(); expect(data("speech").voiceSourceNodeId).toBeUndefined();
  const connectionApi = await import("../src/renderer/api.js");
  await act(async () => data("speech").audioRuntime.onChange({ ...data("speech"), referenceAssetId: "sample-a", referenceSha256: data("voice").selectedSha256, voiceSourceNodeId: undefined }));
  const changedRead = vi.spyOn(connectionApi, "getLibraryAsset").mockResolvedValue(new Blob([new Uint8Array(referenceWav(0.5))], { type: "audio/wav" }));
  try {
    await act(async () => canvasProps.onConnect!({ source: "voice", target: "speech", sourceHandle: "out", targetHandle: null }));
    expect(data("speech").referenceAssetId).toBe("sample-a"); expect(data("speech").voiceSourceNodeId).toBeUndefined();
    expect(host.textContent).toContain(t("assetCanvas.audioReferenceChanged"));
  } finally { changedRead.mockRestore(); }
  const failedRead = vi.spyOn(connectionApi, "getLibraryAsset").mockRejectedValue(new Error("Synthetic local read failure"));
  try {
    await act(async () => canvasProps.onConnect!({ source: "voice", target: "speech", sourceHandle: "out", targetHandle: null }));
    expect(data("speech").referenceAssetId).toBe("sample-a"); expect(data("speech").voiceSourceNodeId).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  } finally { failedRead.mockRestore(); }
  for (const concurrent of [{ referenceAssetId: "sample-b" }, { voiceId: "explicit-legacy-choice" }]) {
    await act(async () => data("speech").audioRuntime.onChange({ ...data("speech"), referenceAssetId: "sample-a", voiceSourceNodeId: undefined, voiceId: undefined }));
    let resolveRead!: (value: Blob) => void;
    const delayedRead = new Promise<Blob>((resolve) => { resolveRead = resolve; });
    const waiting = vi.spyOn(connectionApi, "getLibraryAsset").mockReturnValue(delayedRead);
    let connecting!: void | Promise<void>;
    try {
      await act(async () => { connecting = canvasProps.onConnect!({ source: "voice", target: "speech", sourceHandle: "out", targetHandle: null }); });
      await act(async () => data("speech").audioRuntime.onChange({ ...data("speech"), ...concurrent }));
      await act(async () => { resolveRead(new Blob([new Uint8Array(wav)], { type: "audio/wav" })); await connecting; });
      expect(data("speech")).toMatchObject(concurrent); expect(data("speech").voiceSourceNodeId).toBeUndefined();
    } finally { waiting.mockRestore(); }
  }
  await act(async () => data("voice").audioRuntime.onChange({ ...data("voice"), assetId: "too-large" }));
  await act(async () => { await data("voice").audioRuntime.onSelectSample(); });
  expect(data("voice").selectedAssetId).toBe("sample-b");
  expect(host.textContent).toContain(t("assetCanvas.audioReferenceInvalid"));
  await act(async () => data("voice").audioRuntime.onChange({ ...data("voice"), assetId: "sample-a" }));
  const arrayBuffer = vi.fn(), oversized = { size: 10_000_001, arrayBuffer } as unknown as Blob;
  const api = await import("../src/renderer/api.js");
  const read = vi.spyOn(api, "getLibraryAsset").mockResolvedValue(oversized);
  try {
    await act(async () => { await data("voice").audioRuntime.onSelectSample(); });
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(data("voice").selectedAssetId).toBe("sample-b");
  } finally { read.mockRestore(); }
  expect(host.querySelector("select")).toBeNull(); expect(generate).not.toHaveBeenCalled();
});

it.each((["image", "video", "model-3d", "animate-3d", "voice", "speech", "sound-effect", "music"] as const).flatMap(type => (["failed", "cancelled"] as const).map(status => ({ type, status }))))("shows $status on an unexpanded $type card without starting another request", async ({ type, status }) => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const board = createAssetCanvasDocument();
  const position = { x: 0, y: 0 };
  const node: AssetCanvasNode = type === "image" || type === "video" || type === "model-3d" ? createAssetGenerationNode(type, position)
    : type === "animate-3d" ? { id: "animated", type, position, data: { actionIds: [], heightMeters: 1.7 } }
    : type === "voice" ? { id: "voice", type, position, data: { description: "Warm", sampleText: "Hello" } }
    : type === "speech" ? { id: "speech", type, position, data: { text: "Hello" } }
    : type === "music" ? { id: "music", type, position, data: { prompt: "Quiet", instrumental: true } }
    : { id: "sound", type, position, data: { prompt: "Rain" } };
  board.nodes = [node]; board.editorLayout.nodes[node.id] = position;
  const toolId = ({ image: "generate-image", video: "generate-video", "model-3d": "image-to-3d", "animate-3d": "animate-3d", voice: "generate-speech", speech: "generate-speech", "sound-effect": "generate-sound-effect", music: "generate-music" } as const)[type];
  const job: ToolJob = { id: "visible-status", toolId, status, model: { provider: "fixture", id: "original-model" }, sources: [{ assetId: "original-source", name: "Original concept.png" }], title: "Fixture", createdAt: "now", error: "Fixture provider stopped", context: { projectId: "visible", boardId: "board", nodeId: node.id } };
  const storage: CanvasBoardStorage = { key: "visible:board", boardId: "board", load: async () => board, save: async value => value, refresh: async () => undefined, reconcile: (_submitted, current) => current, resolveConflict: async (_version, value) => value, jobs: async () => [job], generate: vi.fn(), cancel: vi.fn(), recoverImage: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CanvasBoardEditor project={{ id: "visible", type: "asset-canvas" } as ProjectState} storage={storage} documents={{ documents: [] } as unknown as CanvasDocuments} tables={{ storage: new CanvasTableStorage("visible"), open: vi.fn(), add: vi.fn() }} assets={[]} />));
  expect(host.querySelector(".canvas-node-auxiliary")).toBeNull();
  const badge = host.querySelector(".story-media-job-error")!;
  expect(badge.textContent).toContain(t(status === "cancelled" ? "assetCanvas.generationCancelled" : "assetCanvas.generationFailed"));
  expect(badge.getAttribute("role")).toBe(status === "cancelled" ? "status" : "alert");
  expect(badge.getAttribute("title")).toBe(job.error);
  const edit = host.querySelector<HTMLButtonElement>(".canvas-node-details")!;
  expect(edit).toBeTruthy();
  await act(async () => edit.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Original concept.png");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("fixture/original-model");

  expect(storage.generate).not.toHaveBeenCalled(); expect(storage.recoverImage).not.toHaveBeenCalled();
});
