// @vitest-environment happy-dom
import path from "node:path";
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { Model3DActionId, Model3DOptions, ModelRef, ProjectState } from "../src/shared/contracts.js";
import { t } from "../src/renderer/i18n.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { CanvasBoardDetail, CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { CanvasDocumentDetail } from "../src/shared/canvas-document.js";
import { desktopSave } from "../src/renderer/desktop-save.js";
import { readCanvasDraftStatus } from "../src/renderer/canvas-draft-safety.js";
import { model3DModel } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { MODEL_3D_MODELS } from "../src/shared/generation-config.js";
import { MODEL3D_CONNECTION_ID, tripoActions } from "../src/shared/model3d-operations.js";
import type {
  NodeCodebaseDetail,
  NodeCodebaseUpdate,
} from "../src/shared/playable-codebase.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

type FlowNode = Node & { title?: string };
type CanvasProps = Parameters<typeof EditorCanvas<FlowNode>>[0];
const captured = { props: undefined as CanvasProps | undefined };
let canvasFlush: (() => Promise<void>) | undefined;
let canvasSync: (() => Promise<void>) | undefined;
const canvasStatus = vi.fn();
const api = {
  model3DCatalog: vi.fn(),
  model3DOperations: vi.fn(),
  animationActions: vi.fn(),
  generateMedia: vi.fn(),
  balance: vi.fn(),
  getBoard: vi.fn<() => Promise<CanvasBoardDetail>>(),
  getWorkspace: vi.fn<() => Promise<CanvasWorkspaceDetail>>(),
  saveDocument: vi.fn<(projectId: string, detail: CanvasDocumentDetail, id?: string) => Promise<CanvasDocumentDetail>>(),
  saveBoard:
    vi.fn<
      (
        projectId: string,
        detail: CanvasBoardDetail,
      ) => Promise<CanvasBoardDetail>
    >(),
  getCodebase: vi.fn<() => Promise<NodeCodebaseDetail>>(),
  saveCodebase:
    vi.fn<
      (
        projectId: string,
        update: NodeCodebaseUpdate,
      ) => Promise<{ revision: string }>
    >(),
};
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    captured.props = props;
    return <ReactFlowProvider>{props.nodes.filter((node) => node.type === "animate-3d").map((node) => {
      const Component = props.nodeTypes![node.type!];
      return <Component key={node.id} {...node} type={node.type!} selected={Boolean(node.selected)} dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={node.position.x} positionAbsoluteY={node.position.y} />;
    })}</ReactFlowProvider>;
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
  listImageModelCatalog: async () => ({ models: [], providers: [] }),
  listVideoModelCatalog: async () => ({ models: [], providers: [] }),
  listAudioModelCatalog: async () => ({ models: [], providers: [] }),
  listModel3DCatalog: api.model3DCatalog,
  listModel3DOperations: api.model3DOperations,
  listModel3DAnimations: api.animationActions,
  model3DBalance: api.balance,
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  getStoryUpgrade: async () => ({ web: false }),
  getWorkspaceFile: async (_projectId: string, file: string) => ({
    path: file,
    content: `Source of ${file}`,
    truncated: false,
  }),
  getNodeCodebase: api.getCodebase,
  updateNodeCodebase: api.saveCodebase,
}));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  getCanvasBoard: api.getBoard,
  getCanvasWorkspace: api.getWorkspace,
  saveCanvasDocument: api.saveDocument,
  saveCanvasBoard: api.saveBoard,
  listCanvasJobs: async () => [],
  generateCanvasMedia: api.generateMedia,
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [],
}));

const { createCanvasBoardStorage } =
  await import("../src/renderer/canvas-board-storage.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasWorkspace } = await import("../src/renderer/canvas-workspace.js");
const { useCanvasDocuments } = await import("../src/renderer/use-canvas-documents.js");
let currentDocs: ReturnType<typeof useCanvasDocuments>;
function DocumentHarness() { currentDocs = useCanvasDocuments("p"); return null; }
const { PlayableEditorWorkspace } =
  await import("../src/renderer/playable-editor-workspace.js");
const { ApiError } = await import("../src/renderer/api.js");

let boardDisk: CanvasBoardDetail;
let workspaceDisk: CanvasWorkspaceDetail;
let storyDisk: NodeCodebaseDetail;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  captured.props = undefined;
  canvasFlush = undefined; canvasSync = undefined;
  api.model3DCatalog.mockResolvedValue({ models: [], providers: [] });
  api.model3DOperations.mockResolvedValue([]);
  api.animationActions.mockResolvedValue([{ id: 0, name: "Idle", category: "Daily", subCategory: "Idle" }]);
  api.balance.mockResolvedValue({ balance: 123 });
  api.generateMedia.mockRejectedValue(new Error("No provider submission in renderer fixtures"));
  const canvas = createAssetCanvasDocument();
  canvas.nodes = [
    {
      id: "n",
      type: "text",
      title: "Original",
      position: { x: 0, y: 0 },
      data: { text: "Rules", instruction: "" },
    },
  ];
  canvas.editorLayout.nodes.n = { x: 0, y: 0 };
  boardDisk = { board: { ...canvas, id: "b" }, revision: "initial" };
  workspaceDisk = { version: 1, boards: [{ id: "b", name: "Board" }], documents: [{ id: "rules", title: "Rules", markdown: "Original", revision: "initial", source: "canvas/documents/rules.md", main: false }], assets: [] };
  storyDisk = {
    ...createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    revision: "initial",
  };
  api.getBoard.mockImplementation(async () => structuredClone(boardDisk));
  api.getWorkspace.mockImplementation(async () => structuredClone(workspaceDisk));
  api.saveDocument.mockImplementation(async (_id, detail) => ({ ...detail, revision: "saved-document" }));
  api.saveBoard.mockImplementation(async (_projectId, detail) => {
    if (detail.revision !== boardDisk.revision)
      throw new ApiError("The board changed", 409);
    boardDisk = {
      board: structuredClone(detail.board),
      revision: `save-${api.saveBoard.mock.calls.length}`,
    };
    return structuredClone(boardDisk);
  });
  api.getCodebase.mockImplementation(async () => structuredClone(storyDisk));
  api.saveCodebase.mockImplementation(async (_projectId, update) => {
    if (update.revision !== storyDisk.revision)
      throw new ApiError("The project changed", 409);
    storyDisk = {
      graph: structuredClone(update.graph),
      editorLayout: structuredClone(update.editorLayout),
      revision: `save-${api.saveCodebase.mock.calls.length}`,
    };
    return { revision: storyDisk.revision };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); desktopSave.cancel(); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sends the active board and current selection as compact chat context", async () => {
  const context = vi.fn();
  boardDisk.board.nodes[0] = { id: "n", type: "document", position: { x: 0, y: 0 }, data: { documentId: "rules" } };
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", name: "Sky", type: "asset-canvas" } as ProjectState} onContextChange={context} />));
  const board = "Current canvas board: canvas/boards/b.json\nSelected nodes: ";
  expect(context).toHaveBeenLastCalledWith({ kind: "canvas-board", label: "Sky", text: board + "none" });

  await act(async () => captured.props!.onNodesChange!([{ id: "n", type: "select", selected: true }]));
  const selected = context.mock.lastCall![0].text;
  expect(selected.startsWith(board)).toBe(true);
  expect(JSON.parse(selected.slice(board.length))).toEqual({
    total: 1, nodes: [{ id: "n", name: "Rules", type: "document", source: "canvas/documents/rules.md" }],
  });
  await act(async () => captured.props!.onNodesChange!([{ id: "n", type: "select", selected: false }]));
  expect(context).toHaveBeenLastCalledWith({ kind: "canvas-board", label: "Sky", text: board + "none" });
});

it("saves through the desktop handshake before the debounce and pauses Canvas polling", async () => {
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", type: "asset-canvas" } as ProjectState} />));
  expect(captured.props?.nodes[0]?.title).toBe("Original");
  await move("n");
  await act(async () => desktopSave.prepare());
  expect(boardDisk.board.nodes[0]!.position).toEqual({ x: 400, y: 400 });
  const reads = api.getBoard.mock.calls.length, workspaces = api.getWorkspace.mock.calls.length;
  await advance(6000);
  expect(api.getBoard).toHaveBeenCalledTimes(reads);
  expect(api.getWorkspace).toHaveBeenCalledTimes(workspaces);
  await act(async () => desktopSave.cancel("Try again"));
  await advance(3000);
  expect(api.getBoard.mock.calls.length).toBeGreaterThan(reads);
});

it("does not claim a successful flush when a document draft has lost its workspace file", async () => {
  await act(async () => root.render(<DocumentHarness />));
  await act(async () => currentDocs.update("rules", { markdown: "Unsaved rules" }));
  workspaceDisk.documents = [];
  await act(async () => currentDocs.refresh());
  await act(async () => { await expect(currentDocs.flush()).rejects.toThrow("Restore its workspace file"); });
  expect(api.saveDocument).not.toHaveBeenCalled();
  expect(localStorage.getItem("canvas-documents:p")).toContain("Unsaved rules");
});

it("shows failed sync retries once and lets Dismiss remove them", async () => {
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", type: "asset-canvas" } as ProjectState} />));
  await advance(400);
  api.getBoard.mockRejectedValue(new TypeError("Failed to fetch"));
  await advance(2500);
  expect(container.textContent).toContain("Sync paused");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Retry canvas sync"]')!.click());
  expect(container.querySelectorAll(".design-notice")).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
  await advance(3000);
  expect(container.querySelectorAll(".design-notice")).toHaveLength(0);
  expect(container.textContent).toContain("Sync paused");
});

it("lets the header restore a dismissed conflict so the user can choose a version", async () => {
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", type: "asset-canvas" } as ProjectState} />));
  boardDisk.board.nodes[0]!.title = "Agent title"; boardDisk.revision = "agent-edit";
  await act(async () => captured.props!.onNodesChange!([{ id: "n", type: "replace", item: { ...captured.props!.nodes[0]!, title: "My title" } }]));
  await advance(400);
  expect(container.textContent).toContain("choose a version");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
  expect(container.querySelector(".design-notice")).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Review canvas conflicts"]')!.click());
  expect(container.textContent).toContain("Keep my version");
  const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep my version")!;
  await act(async () => keep.click());
  expect(boardDisk.board.nodes[0]!.title).toBe("My title");
  expect(container.querySelector(".design-notice")).toBeNull();
});

it("still saves document drafts when the board cannot save during desktop close", async () => {
  boardDisk.board.nodes.push({ id: "doc", type: "document", position: { x: 600, y: 0 }, data: { documentId: "rules" } });
  boardDisk.board.editorLayout.nodes.doc = { x: 600, y: 0 };
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", type: "asset-canvas" } as ProjectState} />));
  const design = (captured.props!.nodes.find((node) => node.id === "doc")!.data.documentRuntime as { design: CanvasDocuments }).design;
  await act(async () => design.update("rules", { markdown: "Latest document draft" }));
  api.saveBoard.mockRejectedValueOnce(new Error("Board write failed"));
  await move("n");
  await act(async () => { await expect(desktopSave.prepare()).rejects.toThrow("Board write failed"); });
  expect(api.saveDocument).toHaveBeenCalledWith("p", expect.objectContaining({ document: expect.objectContaining({ markdown: "Latest document draft" }) }), "rules", "0");
  expect(localStorage.getItem("canvas-board:p:b")).toContain('"x":400');
});
it("protects document edits in memory when recovery storage and disk saving both fail", async () => {
  boardDisk.board.nodes.push({ id: "doc", type: "document", position: { x: 600, y: 0 }, data: { documentId: "rules" } });
  boardDisk.board.editorLayout.nodes.doc = { x: 600, y: 0 };
  await act(async () => root.render(<CanvasWorkspace project={{ id: "p", type: "asset-canvas" } as ProjectState} />));
  await advance(400);
  const design = (captured.props!.nodes.find((node) => node.id === "doc")!.data.documentRuntime as { design: CanvasDocuments }).design;
  const persisted = localStorage;
  vi.stubGlobal("localStorage", { get length() { return persisted.length; }, key: (index: number) => persisted.key(index),
    getItem: (key: string) => persisted.getItem(key), removeItem: (key: string) => persisted.removeItem(key),
    setItem: () => { throw new Error("Storage full"); } });
  try {
    api.saveDocument.mockRejectedValue(new Error("Disk unavailable"));
    await act(async () => design.update("rules", { markdown: "Memory-only rules" }));
    expect(localStorage.getItem("canvas-documents:p")).toBeNull();
    expect(readCanvasDraftStatus(localStorage, "p")).toBe("pending");
    expect(readCanvasDraftStatus(localStorage, "another-project")).toBe("clear");
    await act(async () => { await expect(desktopSave.prepare()).rejects.toThrow("Disk unavailable"); });
    expect(readCanvasDraftStatus(localStorage, "p")).toBe("pending");
  } finally { vi.stubGlobal("localStorage", persisted); }
});
const advance = (milliseconds: number) =>
  act(async () => vi.advanceTimersByTimeAsync(milliseconds));
it("loads moves only when a picker opens and retries errors using legacy native connection references", async () => {
  api.model3DOperations.mockResolvedValue([{ ...MODEL_3D_MODELS[0]!, id: MODEL3D_CONNECTION_ID, name: "Tripo", operations: ["animate"] }]);
  boardDisk.board.nodes = ["first", "second"].map((id) => ({ id, type: "animate-3d", title: "Original", position: { x: 0, y: 0 },
    data: { model: { provider: "tripo", id: "v3.1-20260211" }, actionIds: ["preset:idle"], heightMeters: 1.7 } }));
  api.animationActions.mockRejectedValueOnce(new Error("offline"));
  await openCanvas("asset-canvas");
  expect(api.animationActions).not.toHaveBeenCalled();
  await act(async () => captured.props!.onNodesChange!(["first", "second"].map((id) => ({ id, type: "select", selected: true }))));
  expect(api.animationActions).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[aria-label="Animation provider: Tripo"]')).toHaveLength(2);
  expect(api.balance).not.toHaveBeenCalled();
  const moves = [...container.querySelectorAll("button")].find((button) => button.textContent === "1 move")!;
  await act(async () => moves.click());
  expect(api.animationActions).toHaveBeenCalledTimes(1);
  expect(api.animationActions).toHaveBeenCalledWith({ provider: "tripo", id: MODEL3D_CONNECTION_ID }, undefined);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Could not load moves");
  const retry = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
  await act(async () => retry.click());
  expect(api.animationActions).toHaveBeenCalledTimes(2);
  expect(dialog.textContent).toContain("Idle");
  await act(async () => (dialog.querySelector('[aria-label="Close move picker"]') as HTMLButtonElement).click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each(["v2.5-20260210", "v3.0-20260909"] as const)("shows Tripo %s preset names and preserves selection order", async (rigModel) => {
  const tripo = MODEL_3D_MODELS.find((model) => model.provider === "tripo")!;
  const options = { rigModel, rigType: "biped" as const };
  api.model3DOperations.mockResolvedValue([{ ...tripo, id: MODEL3D_CONNECTION_ID, name: "Tripo", operations: ["animate"] }]);
  api.animationActions.mockResolvedValue(tripoActions(options.rigModel, options.rigType));
  boardDisk.board.nodes = [{ id: "tripo", type: "animate-3d", title: "Original", position: { x: 0, y: 0 },
    data: { model: { provider: "tripo", id: MODEL3D_CONNECTION_ID }, actionIds: [], heightMeters: 1.7, options } }];
  await openCanvas("asset-canvas");
  await act(async () => captured.props!.onNodesChange!([{ id: "tripo", type: "select", selected: true }]));
  const moves = [...container.querySelectorAll("button")].find((button) => button.textContent === "0 moves")!;
  await act(async () => moves.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(api.animationActions).toHaveBeenCalledWith({ provider: "tripo", id: MODEL3D_CONNECTION_ID }, options);
  expect(dialog.textContent).toContain("without visual previews");
  expect(dialog.querySelectorAll(".story-animation-picker-preview")).toHaveLength(0);
  const move = (name: string) => [...dialog.querySelectorAll<HTMLButtonElement>(".story-animation-picker-grid > button")].find((button) => button.textContent === name)!;
  await act(async () => move("Walk").click());
  await act(async () => move("Idle").click());
  expect([...dialog.querySelectorAll(".story-animation-picker-selected button")].map((button) => button.textContent)).toEqual(["Walk", "Idle"]);
  expect(captured.props!.nodes[0]!.data.actionIds).toEqual(["preset:walk", "preset:idle"]);
  expect(api.balance).not.toHaveBeenCalled();
  if (rigModel === "v2.5-20260210") {
    await act(async () => (dialog.querySelector('[aria-label="Close move picker"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="Rig version: v2.5-20260210"]') as HTMLButtonElement).click());
    const v3 = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent === "v3.0-20260909")!;
    expect(v3).toBeDefined();
    await act(async () => v3.click());
    expect(captured.props!.nodes[0]!.data).toMatchObject({ actionIds: [], model3DOptions: { rigModel: "v3.0-20260909", rigType: "biped" } });
    expect(container.querySelector('[aria-label="Rig version: v3.0-20260909"]')).not.toBeNull();
  }
});

it("keeps Tripo previews and selection stable without automatic cloud polling", async () => {
  api.model3DOperations.mockImplementation(async () => structuredClone([{ ...MODEL_3D_MODELS[0]!, id: MODEL3D_CONNECTION_ID, name: "Tripo", operations: ["animate"] }]));
  api.model3DCatalog.mockResolvedValue({ models: [], providers: [{ provider: "cloud-hyper3d", providerName: "Hyper3D", state: "ready", cloud: { availability: "ready", userId: "user" } }] });
  api.animationActions.mockResolvedValue([{ id: 0, name: "Idle", category: "Daily", subCategory: "Idle", previewUrl: "https://cdn.test/idle.gif" }]);
  boardDisk.board.nodes = [{ id: "meshy", type: "animate-3d", title: "Original", position: { x: 0, y: 0 }, data: { model: { provider: "tripo", id: MODEL3D_CONNECTION_ID }, actionIds: [], heightMeters: 1.7 } }];
  await openCanvas("asset-canvas");
  await act(async () => captured.props!.onNodesChange!([{ id: "meshy", type: "select", selected: true }]));
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "0 moves")!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector(".story-animation-picker-preview img")?.getAttribute("src")).toBe("https://cdn.test/idle.gif");
  expect(dialog.textContent).not.toContain("without visual previews");
  const preview = dialog.querySelector(".story-animation-picker-preview img");
  await act(async () => (dialog.querySelector(".story-animation-picker-grid > button") as HTMLButtonElement).click());
  expect(captured.props!.nodes[0]!.data.actionIds).toEqual([0]);
  await advance(30_000);
  expect(api.model3DCatalog).toHaveBeenCalledTimes(1);
  expect(api.model3DOperations).toHaveBeenCalledTimes(1);
  expect(api.animationActions).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
  expect(api.model3DOperations).toHaveBeenCalledTimes(2);
  expect(api.animationActions).toHaveBeenCalledTimes(1);
  expect(dialog.querySelector(".story-animation-picker-preview img")).toBe(preview);
  expect(captured.props!.nodes[0]!.data.actionIds).toEqual([0]);
});

async function openAnimationMoves(provider: "tripo", selectedIds: Model3DActionId[]) {
  const model = MODEL_3D_MODELS.find((candidate) => candidate.provider === provider)!;
  const options: Model3DOptions | undefined = provider === "tripo" ? { rigModel: "v3.0-20260909", rigType: "biped" } : undefined;
  const actions = provider === "tripo" ? tripoActions(options!.rigModel, options!.rigType)
    : Array.from({ length: 32 }, (_, id) => ({ id, name: `Move ${id}`, category: "Daily", subCategory: "Test" }));
  api.model3DOperations.mockResolvedValue([{ ...model, id: MODEL3D_CONNECTION_ID, name: provider, operations: ["animate"] }]);
  api.animationActions.mockResolvedValue(actions);
  boardDisk.board.nodes = [{ id: "animation", type: "animate-3d", title: "Original", position: { x: 0, y: 0 }, data: {
    source: { type: "library", assetId: "synthetic-model" }, model: { provider, id: MODEL3D_CONNECTION_ID },
    actionIds: [...selectedIds], heightMeters: 1.7, ...(options ? { options } : {}),
  } }];
  await openCanvas("asset-canvas");
  await act(async () => captured.props!.onNodesChange!([{ id: "animation", type: "select", selected: true }]));
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === t("assetCanvas.moveCount", { count: selectedIds.length }))!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const move = (id: Model3DActionId) => [...dialog.querySelectorAll<HTMLButtonElement>(".story-animation-picker-grid > button")].find(button => button.textContent === actions.find(action => action.id === id)!.name)!;
  const selected = () => captured.props!.nodes[0]!.data.actionIds as Model3DActionId[];
  const generate = () => container.querySelector<HTMLButtonElement>(`[aria-label="${t("assetCanvas.media.animation.generate")}"]`)!;
  return { dialog, move, selected, generate, actions };
}

it.each(["en", "zh-CN"] as const)("retains disabled Meshy selections in %s without a request or silent Tripo remap", async locale => {
  const previous = i18next.language;
  try {
    await i18next.changeLanguage(locale);
    const saved = Array.from({ length: 12 }, (_, index) => 11 - index);
    const legacy = model3DModel("meshy", "Meshy", MODEL_3D_PRESETS.meshy[0]!);
    const tripo = MODEL_3D_MODELS.find(model => model.provider === "tripo")!;
    api.model3DOperations.mockResolvedValue([{ ...legacy, id: MODEL3D_CONNECTION_ID, operations: ["animate"] }, { ...tripo, id: MODEL3D_CONNECTION_ID, operations: ["animate"] }]);
    boardDisk.board.nodes = [{ id: "animation", type: "animate-3d", title: "Original", position: { x: 0, y: 0 }, data: {
      source: { type: "library", assetId: "synthetic-model" }, model: { provider: "meshy", id: "meshy-7.1" }, actionIds: saved, heightMeters: 1.7,
    } }];
    await openCanvas("asset-canvas");
    await act(async () => captured.props!.onNodesChange!([{ id: "animation", type: "select", selected: true }]));
    expect(container.textContent).toContain(t("modelUsage.meshyUnavailable"));
    expect(captured.props!.nodes[0]!.data).toMatchObject({ animationModel: { provider: "meshy", id: "meshy-7.1" }, actionIds: saved });
    const generate = container.querySelector<HTMLButtonElement>(`[aria-label="${t("assetCanvas.media.animation.generate")}"]`)!;
    const moves = [...container.querySelectorAll("button")].find(button => button.textContent === t("assetCanvas.moveCount", { count: saved.length }))!;
    expect(generate.disabled).toBe(true); expect(moves.disabled).toBe(true);
    await act(async () => { generate.click(); moves.click(); });
    const runtime = captured.props!.nodes[0]!.data.animateRuntime as { onGenerate: () => void };
    await act(async () => runtime.onGenerate());
    expect(api.generateMedia).not.toHaveBeenCalled(); expect(api.animationActions).not.toHaveBeenCalled(); expect(api.balance).not.toHaveBeenCalled();
    await act(async () => canvasFlush!());
    expect(boardDisk.board.nodes[0]).toMatchObject({ data: { model: { provider: "meshy", id: "meshy-7.1" }, actionIds: saved } });
    const selector = container.querySelector<HTMLButtonElement>(`[aria-label="${t("assetCanvas.animationProvider")}: ${t("assetCanvas.selectAnimationProvider")}"]`)!;
    await act(async () => selector.click());
    expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes("Meshy"))).toBe(false);
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent?.includes(tripo.name))!;
    await act(async () => choice.click());
    expect(captured.props!.nodes[0]!.data).toMatchObject({ animationModel: { provider: "tripo", id: MODEL3D_CONNECTION_ID }, actionIds: [] });
  } finally { await i18next.changeLanguage(previous); }
});

it("blocks direct generation of a saved Meshy geometry node without replacing its reference", async () => {
  boardDisk.board.nodes = [{ id: "old-model", type: "model-3d", title: "Original", position: { x: 0, y: 0 }, data: {
    model: { provider: "meshy", id: "meshy-7.1" }, images: [], targetPolycount: 100000, texture: true, pbr: false,
  } }];
  await openCanvas("asset-canvas");
  const data = captured.props!.nodes[0]!.data;
  expect(data.model3DConfig).toMatchObject({ model: { provider: "meshy", id: "meshy-7.1" }, targetPolycount: 100000 });
  await act(async () => (data.model3DRuntime as { onGenerate: () => void }).onGenerate());
  expect(api.generateMedia).not.toHaveBeenCalled(); expect(api.balance).not.toHaveBeenCalled();
  await act(async () => canvasFlush!());
  expect(boardDisk.board.nodes[0]).toMatchObject({ data: { model: { provider: "meshy", id: "meshy-7.1" }, targetPolycount: 100000 } });
});

it("blocks a saved custom Meshy-protocol alias even when a stale catalog returns it", async () => {
  const alias = { ...MODEL_3D_MODELS[0]!, provider: "custom:old", id: MODEL3D_CONNECTION_ID, protocol: "meshy" as const, operations: ["animate"] };
  api.model3DOperations.mockResolvedValue([alias]);
  boardDisk.board.nodes = [{ id: "old", type: "animate-3d", title: "Original", position: { x: 0, y: 0 }, data: { model: { provider: alias.provider, id: alias.id }, actionIds: [4, 1, 0], heightMeters: 1.7 } }];
  await openCanvas("asset-canvas");
  await act(async () => captured.props!.onNodesChange!([{ id: "old", type: "select", selected: true }]));
  expect(container.textContent).toContain(t("modelUsage.meshyUnavailable"));
  const runtime = captured.props!.nodes[0]!.data.animateRuntime as { onGenerate: () => void };
  await act(async () => runtime.onGenerate());
  expect(api.generateMedia).not.toHaveBeenCalled(); expect(api.animationActions).not.toHaveBeenCalled();
  expect(captured.props!.nodes[0]!.data.actionIds).toEqual([4, 1, 0]);
});

it("keeps Tripo's five-move total limit and lets users correct an old six-move selection", async () => {
  const saved = tripoActions().slice(0, 6).map(action => action.id), f = await openAnimationMoves("tripo", saved);
  expect(f.selected()).toEqual(saved); expect(f.generate().disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(t("assetCanvas.animationTooManyMoves", { max: 5 }));
  expect(f.dialog.querySelector("footer")!.textContent).toContain(t("assetCanvas.animationSelection", { count: 6, max: 5 }));
  expect(f.dialog.querySelector("footer")!.textContent).not.toContain("per batch");
  expect(f.move(f.actions[6]!.id).disabled).toBe(true);
  await act(async () => f.move(saved[0]!).click());
  expect(f.selected()).toEqual(saved.slice(1)); expect(f.generate().disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(api.generateMedia).not.toHaveBeenCalled();
});

it("never resumes author Cloud polling from stale signed-in catalog metadata", async () => {
  const cloudCatalog = { models: [], providers: [{ provider: "cloud-hyper3d", providerName: "Hyper3D", state: "ready", cloud: { availability: "ready", userId: "user" } }] };
  api.model3DCatalog.mockResolvedValue(cloudCatalog);
  await openCanvas("asset-canvas");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    await advance(60_000);
    expect(api.model3DCatalog).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(api.model3DCatalog).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
    expect(api.model3DCatalog).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(api.model3DCatalog).toHaveBeenCalledTimes(2);
  } finally { visibility.mockRestore(); }
});

it("does not poll local 3D configuration without a signed-in cloud provider", async () => {
  await openCanvas("asset-canvas");
  await advance(60_000);
  expect(api.model3DCatalog).toHaveBeenCalledTimes(1);
  expect(api.model3DOperations).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
  expect(api.model3DCatalog).toHaveBeenCalledTimes(2);
  expect(api.model3DOperations).toHaveBeenCalledTimes(2);
});

it("reloads moves for connection and rig changes, ignores stale results and keeps playback options separate", async () => {
  const tripo = { provider: "tripo", id: MODEL3D_CONNECTION_ID };
  const meshy = { provider: "meshy", id: MODEL3D_CONNECTION_ID };
  api.model3DOperations.mockResolvedValue(["tripo", "meshy"].map((provider) => ({ ...MODEL_3D_MODELS.find((model) => model.provider === provider)!, id: MODEL3D_CONNECTION_ID, operations: ["animate"] })));
  boardDisk.board.nodes = [{ id: "animation", type: "animate-3d", title: "Original", position: { x: 0, y: 0 }, data: { model: tripo, actionIds: [], heightMeters: 1.7 } }];
  let finishOld!: (value: Array<{ id: number; name: string; category: string; subCategory: string }>) => void;
  api.animationActions.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await openCanvas("asset-canvas");
  await act(async () => captured.props!.onNodesChange!([{ id: "animation", type: "select", selected: true }]));
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "0 moves")!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const change = (model: ModelRef, options?: Model3DOptions) => act(async () => {
    const data = captured.props!.nodes[0]!.data;
    (data.animateRuntime as { onChange: (data: unknown) => void }).onChange({ ...data, animateRuntime: undefined, animationModel: model, model3DOptions: options });
  });
  const options: Model3DOptions = { rigModel: "v2.5-20260210", rigType: "quadruped" };
  await change(tripo, options);
  expect(api.animationActions).toHaveBeenCalledTimes(2);
  expect(api.animationActions).toHaveBeenLastCalledWith(tripo, options);
  await act(async () => finishOld([{ id: 99, name: "Stale move", category: "Old", subCategory: "Old" }]));
  expect(dialog.textContent).toContain("Idle");
  expect(dialog.textContent).not.toContain("Stale move");
  await change(tripo, { ...options, animateInPlace: true });
  expect(api.animationActions).toHaveBeenCalledTimes(2);
  await change(meshy);
  expect(api.animationActions).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(t("modelUsage.meshyUnavailable"));
});
async function openCanvas(type: "web-game" | "asset-canvas") {
  const storage = createCanvasBoardStorage({
    projectId: "p",
    boardId: "b",
    onConflict: vi.fn(),
    flushDocuments: async () => {},
  });
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "p", type } as ProjectState}
        storage={storage}
        documents={{ documents: [] } as unknown as CanvasDocuments}
        tables={{
          storage: new CanvasTableStorage("p"),
          open: vi.fn(),
          add: vi.fn(),
        }}
        assets={[]}
        onSaveReady={(save) => { canvasFlush = save; }}
        onSyncReady={(sync) => { canvasSync = sync; }}
        onStatusChange={canvasStatus}
      />,
    ),
  );
  expect(captured.props?.nodes[0]?.title).toBe("Original");
}
async function openStory(workspaceRevision = 0) {
  await act(async () =>
    root.render(
      <PlayableEditorWorkspace
        project={{ id: "p", type: "interactive-story" } as ProjectState}
        agentBusy={false}
        workspaceRevision={workspaceRevision}
      />,
    ),
  );
  expect(captured.props).toBeDefined();
}
async function move(id: string) {
  await act(async () =>
    captured.props!.onNodesChange!([
      { id, type: "position", position: { x: 400, y: 400 } },
    ]),
  );
}
async function undo(redo = false) {
  await act(async () =>
    container.querySelector(".interactive-story-canvas")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: redo,
        bubbles: true,
      }),
    ),
  );
}

it.each(["web-game", "asset-canvas"] as const)(
  "keeps an Agent rename when moving a stale %s board",
  async (type) => {
    await openCanvas(type);
    boardDisk.board.nodes[0]!.title = "Agent title";
    boardDisk.revision = "agent-edit";
    await move("n");
    await advance(400);
    expect(api.saveBoard).toHaveBeenCalledTimes(2);
    expect(boardDisk.board.nodes[0]).toMatchObject({
      title: "Agent title",
      position: { x: 400, y: 400 },
    });
    await undo();
    await advance(400);
    expect(boardDisk.board.nodes[0]!.title).toBe("Agent title");
  },
);

it.each(["web-game", "asset-canvas"] as const)(
  "does not undo an Agent edit synced to a %s board",
  async (type) => {
    await openCanvas(type);
    await move("n");
    await advance(400);
    boardDisk.board.nodes[0]!.title = "Agent title";
    boardDisk.revision = "agent-edit";
    await advance(2100);
    expect(captured.props!.nodes[0]!.title).toBe("Agent title");
    await advance(400);
    await undo();
    await advance(400);
    expect(boardDisk.board.nodes[0]!.title).toBe("Agent title");
  },
);

it("still undoes local canvas edits when no external content changed", async () => {
  await openCanvas("web-game");
  await move("n");
  await advance(500);
  await undo();
  await advance(400);
  expect(boardDisk.board.nodes[0]!.position).toEqual({ x: 0, y: 0 });
});

it("can flush an already saved canvas after a failed background sync without showing a toast", async () => {
  await openCanvas("asset-canvas");
  await advance(400);
  const writes = api.saveBoard.mock.calls.length;
  api.getBoard.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await advance(2100);
  expect(canvasStatus).toHaveBeenLastCalledWith("sync-error");
  expect(container.querySelector(".story-save-notice")).toBeNull();
  await act(async () => canvasFlush!());
  expect(api.saveBoard).toHaveBeenCalledTimes(writes);
  await act(async () => canvasSync!());
  expect(canvasStatus).toHaveBeenLastCalledWith("saved");
});

it("flushes an edit immediately before the autosave debounce", async () => {
  await openCanvas("asset-canvas");
  await move("n");
  await act(async () => canvasFlush!());
  expect(boardDisk.board.nodes[0]!.position).toEqual({ x: 400, y: 400 });
});

it("retries a failed save and keeps the save status after dismissing its notice", async () => {
  await openCanvas("asset-canvas");
  api.saveBoard.mockRejectedValueOnce(new Error("Disk unavailable"));
  await move("n"); await advance(400);
  expect(canvasStatus).toHaveBeenLastCalledWith("error");
  expect(container.textContent).toContain("Could not save canvas");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
  await advance(2100);
  expect(container.querySelector(".story-save-notice")).toBeNull();
  expect(canvasStatus).toHaveBeenLastCalledWith("error");
  await act(async () => canvasFlush!());
  expect(canvasStatus).toHaveBeenLastCalledWith("saved");
  expect(boardDisk.board.nodes[0]!.position).toEqual({ x: 400, y: 400 });
});

it("keeps the Agent graph and an independent move when a Story save conflicts", async () => {
  await openStory();
  storyDisk.graph.nodes[0]!.title = "Agent title";
  storyDisk.revision = "agent-edit";
  await move("start");
  await advance(400);
  expect(api.saveCodebase).toHaveBeenCalledTimes(2);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 400, y: 400 });
  await undo();
  await advance(400);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
});

it("keeps a remote viewport when a Story save only moves a Scene", async () => {
  await openStory();
  storyDisk.editorLayout.viewport = { x: -100, y: 20, zoom: 0.5 };
  storyDisk.revision = "agent-layout";
  await move("start");
  await advance(400);
  expect(storyDisk.editorLayout.viewport).toEqual({
    x: -100,
    y: 20,
    zoom: 0.5,
  });
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 400, y: 400 });
});

it("rejects concurrent graph edits and clears stale Story undo snapshots", async () => {
  await openStory();
  storyDisk.graph.nodes[0]!.title = "Agent title";
  storyDisk.revision = "agent-edit";
  await act(async () =>
    captured.props!.onNodesDelete!([captured.props!.nodes[0]!]),
  );
  await advance(400);
  expect(api.saveCodebase).toHaveBeenCalledTimes(1);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
  expect(container.textContent).toContain("Make your last change again");
  await undo();
  await advance(400);
  expect(storyDisk.graph.nodes).toHaveLength(1);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
});

it("preserves local undo history after a formatting-only Story conflict", async () => {
  await openStory();
  storyDisk.revision = "reformatted";
  await move("start");
  await advance(500);
  await undo();
  await advance(400);
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 120, y: 180 });
});

it("keeps a duplicated Scene and its sources when only the disk layout changed", async () => {
  await openStory();
  storyDisk.editorLayout.viewport = { x: -100, y: 20, zoom: 0.5 };
  storyDisk.revision = "agent-layout";
  await act(async () =>
    captured.props!.onOpenMenu({
      kind: "node",
      nodeId: "start",
      screenPosition: { x: 0, y: 0 },
      flowPosition: { x: 0, y: 0 },
    }),
  );
  const duplicate = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent === "Duplicate")!;
  await act(async () => duplicate.click());
  expect(api.saveCodebase).toHaveBeenCalledTimes(2);
  const retried = api.saveCodebase.mock.calls[1]![1];
  expect(retried.graph.nodes).toHaveLength(2);
  expect(Object.keys(retried.sources!)).toHaveLength(3);
  expect(storyDisk.editorLayout.viewport).toEqual({
    x: -100,
    y: 20,
    zoom: 0.5,
  });
});

it("keeps the Agent version when the canvas changes the same field during a save retry", async () => {
  await openCanvas("web-game");
  boardDisk.board.nodes[0]!.title = "Agent title";
  boardDisk.revision = "agent-edit";
  let rejectSave!: (cause: Error) => void;
  api.saveBoard.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  await move("n");
  await advance(400);
  expect(api.saveBoard).toHaveBeenCalledTimes(1);
  await act(async () =>
    captured.props!.onNodesChange!([
      {
        id: "n",
        type: "replace",
        item: { ...captured.props!.nodes[0]!, title: "Local title" },
      },
    ]),
  );
  await act(async () => rejectSave(new ApiError("The board changed", 409)));
  await advance(400);
  expect(boardDisk.board.nodes[0]!.title).toBe("Agent title");
  expect(
    JSON.parse(localStorage.getItem("canvas-board:p:b")!).local.nodes[0].title,
  ).toBe("Local title");
});
