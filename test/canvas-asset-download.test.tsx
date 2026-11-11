// @vitest-environment happy-dom
import path from "node:path";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { CanvasAssetCatalogEntry } from "../src/shared/canvas-assets.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
} from "../src/shared/asset-canvas.js";
import { t } from "../src/renderer/i18n.js";

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
let props: CanvasProps;
const getWorkspaceAsset = vi.fn(
  async (_projectId: string, filePath: string, _signal?: AbortSignal, _sha256?: string) =>
    new Blob(["media"], {
      type: assets.find((asset) => asset.path === filePath)!.contentType,
    }),
);
const getLibraryAsset = vi.fn(
  async () => new Blob(["library image"], { type: "image/png" }),
);
const rebuildModelPreview = vi.fn(async () => ({}));
const rebuildProjectModelPreview = vi.fn(async () => ({}));
const getNativeMediaUrl = vi.fn();
const listWorkspaceFiles = vi.fn(async (_projectId: string, _assets?: boolean): Promise<import("../src/shared/contracts.js").WorkspaceFile[]> => []);
vi.doMock(path.resolve("src/renderer/model-preview.tsx"), () => ({ ModelPreview: ({ source, label, autoRotate, animate, rotationPerSecond }: { source: string; label: string; autoRotate?: boolean; animate?: boolean; rotationPerSecond?: string }) => <img src={source} alt={label} data-auto-rotate={autoRotate ? "true" : undefined} data-animate={animate ? "true" : undefined} data-rotation-rate={rotationPerSecond} /> }));
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (value: CanvasProps) => {
    props = value;
    return <div />;
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
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listModel3DOperations: async () => [],
  getWorkspaceAsset,
  getLibraryAsset,
  getNativeMediaUrl,
  rebuildModelPreview,
  rebuildProjectModelPreview,
  listWorkspaceFiles,
  getCanvasModelPreview: async () => new Blob(["preview"], { type: "model/gltf-binary" }),
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [
    {
      id: "library-image",
      assetId: "library-image",
      name: "output.png",
      path: "output.png",
      mediaType: "image",
      contentType: "image/png",
      size: 5,
      createdAt: "2026-10-23T00:00:00Z",
    },
  ],
}));
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const { FbxAssetActions } = await import("../src/renderer/fbx-asset-actions.js");
const { WorkspaceAssetDialog } = await import("../src/renderer/asset-browser.js");
const { AssetsView } = await import("../src/renderer/coding-workspace.js");
const { CanvasAssetProvider, canvasAssetSources } =
  await import("../src/renderer/use-workspace-asset-url.js");
let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  downloads: string[];
const assets: CanvasAssetCatalogEntry[] = [
  { id: "fbx-output", name: "quad.fbx", path: "assets/imported/quad.fbx", mediaType: "model", contentType: "application/vnd.autodesk.fbx", size: 5, createdAt: "2026-10-23T00:00:00Z" },
  {
    id: "image-output",
    name: "output.webp",
    path: "assets/imported/output.webp",
    mediaType: "image",
    contentType: "image/webp",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "model-output",
    name: "model.glb",
    path: "assets/imported/model.glb",
    mediaType: "model",
    contentType: "model/gltf-binary",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "video-output",
    name: "output.mp4",
    path: "assets/imported/output.mp4",
    mediaType: "video",
    contentType: "video/mp4",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "audio-output",
    name: "output.wav",
    path: "assets/imported/output.wav",
    mediaType: "audio",
    contentType: "audio/wav",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  getWorkspaceAsset.mockClear();
  getLibraryAsset.mockClear();
  getNativeMediaUrl.mockReset();
  rebuildModelPreview.mockClear();
  rebuildProjectModelPreview.mockClear();
  listWorkspaceFiles.mockReset();
  listWorkspaceFiles.mockResolvedValue([]);
  downloads = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canvas-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  const board = createAssetCanvasDocument(),
    position = { x: 0, y: 0 };
  const model = createAssetGenerationNode("model-3d", position);
  if (model.type !== "model-3d") throw new Error("Expected a model node");
  const video = createAssetGenerationNode("video", position);
  if (video.type !== "video") throw new Error("Expected a video node");
  board.nodes = [
    ...["小猫照片", "另一只猫", undefined].map((title, index) => {
      const node = createAssetGenerationNode("image", position);
      if (node.type !== "image") throw new Error("Expected an image node");
      return {
        ...node,
        id: `image-${index}`,
        title,
        data: { ...node.data, assetId: "image-output" },
      };
    }),
    {
      ...model,
      id: "model",
      title: "骑士 v1.2.glb",
      data: { ...model.data, assetId: "model-output" },
    },
    { ...model, id: "model-fbx", title: "四边面角色", data: { ...model.data, assetId: "fbx-output" } },
    {
      ...video,
      id: "video",
      title: "片头",
      data: {
        ...video.data,
        assetId: "video-output",
      },
    },
    {
      id: "audio",
      type: "asset",
      position,
      title: "脚步声",
      data: { assetId: "audio-output", mediaType: "audio" },
    },
    {
      id: "library",
      type: "asset",
      position,
      title: "猫咪/正面",
      data: {
        assetId: "library-image",
        mediaType: "image",
      },
    },
  ];
  board.editorLayout.nodes = Object.fromEntries(
    board.nodes.map((node) => [node.id, position]),
  );
  const storage: CanvasBoardStorage = {
    key: "download:b",
    boardId: "b",
    load: async () => structuredClone(board),
    save: async (value) => value,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
    recoverImage: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CanvasAssetProvider assets={canvasAssetSources("download", assets)}>
        <CanvasBoardEditor
          project={{ id: "download", type: "web-game" } as ProjectState}
          storage={storage}
          documents={{ documents: [] } as unknown as CanvasDocuments}
          tables={{
            storage: new CanvasTableStorage("download"),
            open: vi.fn(),
            add: vi.fn(),
          }}
          assets={assets}
        />
      </CanvasAssetProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["asset", "model-3d", "animate-3d"])("opts the visible %s canvas result into slow model motion without changing the thumbnail default", async kind => {
  const View = props.nodeTypes![kind] as ComponentType<{ data: Record<string, unknown>; selected: boolean }>;
  const data = kind === "asset" ? { assetId: "model-output", mediaType: "model" } : { ...props.nodes.find(node => node.id === "model")!.data, assetId: "model-output", actionIds: ["preset:walk"] };
  await act(async () => root.render(<ReactFlowProvider><CanvasAssetProvider assets={canvasAssetSources("download", assets)}><View data={data} selected /></CanvasAssetProvider></ReactFlowProvider>));
  const preview = container.querySelector<HTMLImageElement>('img[data-auto-rotate="true"]')!;
  expect(preview).not.toBeNull(); expect(preview.getAttribute("data-animate")).toBe("true");
  expect(preview.getAttribute("data-rotation-rate")).toBe("10deg");
});

it.each(["image", "video"] as const)("loads an actual %s node only near the viewport and keeps its layout stable", async (kind) => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  let notify!: (visible: boolean) => void, observed!: Element;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = (visible) => callback([{ isIntersecting: visible, target: observed } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe(element: Element) { observed = element; }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const Asset = props.nodeTypes!.asset as ComponentType<{ data: { assetId: string; mediaType: string }; selected: boolean }>;
  const assetId = kind === "image" ? "image-output" : "video-output";
  getWorkspaceAsset.mockClear();
  await act(async () => root.render(<ReactFlowProvider><CanvasAssetProvider assets={canvasAssetSources("download", assets)}><Asset data={{ assetId, mediaType: kind }} selected={false} /></CanvasAssetProvider></ReactFlowProvider>));
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
  await act(async () => notify(true));
  expect(getWorkspaceAsset).toHaveBeenCalledTimes(1);
  const node = container.querySelector<HTMLElement>(".story-library-asset-node")!;
  const media = container.querySelector<HTMLImageElement | HTMLVideoElement>(kind === "image" ? "img" : "video")!;
  if (kind === "image") {
    Object.defineProperties(media, { naturalWidth: { value: 1200 }, naturalHeight: { value: 600 } });
    await act(async () => media.dispatchEvent(new Event("load")));
  } else {
    Object.defineProperties(media, { videoWidth: { value: 1200 }, videoHeight: { value: 600 }, duration: { value: 10 } });
    await act(async () => media.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => media.dispatchEvent(new Event("play")));
  }
  const width = node.style.getPropertyValue("--story-media-width"), height = node.style.getPropertyValue("--story-media-height");
  await act(async () => notify(false));
  expect(container.querySelector(".story-library-asset-node")).toBe(node);
  expect(node.style.getPropertyValue("--story-media-width")).toBe(width);
  expect(node.style.getPropertyValue("--story-media-height")).toBe(height);
  if (kind === "video") {
    expect(container.querySelector("video")).toBe(media);
    await act(async () => media.dispatchEvent(new Event("pause")));
  }
  expect(container.querySelector(kind === "image" ? "img" : "video")).toBeNull();
  expect(media.getAttribute("src")).toBeNull();
  if (kind === "video") { expect(pause).toHaveBeenCalled(); expect(load).toHaveBeenCalled(); }
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:canvas-test");
});

it("aborts an offscreen node's pending read and pins an explicitly selected node", async () => {
  let notify!: (visible: boolean) => void, observed!: Element;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = (visible) => callback([{ isIntersecting: visible, target: observed } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe(element: Element) { observed = element; }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const Asset = props.nodeTypes!.asset as ComponentType<{ data: { assetId: string; mediaType: string }; selected: boolean }>;
  const signals: AbortSignal[] = [];
  const pending = (_projectId: string, _filePath: string, signal?: AbortSignal) => new Promise<Blob>((_resolve, reject) => {
    signals.push(signal!); signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  });
  getWorkspaceAsset.mockImplementationOnce(pending).mockImplementationOnce(pending);
  const render = (selected: boolean) => <ReactFlowProvider><CanvasAssetProvider assets={canvasAssetSources("download", assets)}><Asset data={{ assetId: "image-output", mediaType: "image" }} selected={selected} /></CanvasAssetProvider></ReactFlowProvider>;
  await act(async () => root.render(render(false)));
  await act(async () => notify(true));
  expect(signals).toHaveLength(1);
  await act(async () => notify(false));
  expect(signals[0]!.aborted).toBe(true);
  await act(async () => root.render(render(true)));
  expect(signals).toHaveLength(2); expect(signals[1]!.aborted).toBe(false);
  await act(async () => root.render(render(false)));
  expect(signals[1]!.aborted).toBe(true);
});

async function clickNodeAction(nodeId: string, label: string): Promise<void> {
  await act(async () =>
    props.onOpenMenu({
      kind: "node",
      nodeId,
      screenPosition: { x: 0, y: 0 },
      flowPosition: { x: 0, y: 0 },
    }),
  );
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label)!;
  await act(async () => button.click());
}

it.each(assets)("downloads the project original for $mediaType ($name) instead of its preview or a global copy", async asset => {
  await act(async () => root.render(<WorkspaceAssetDialog asset={{ ...asset, projectId: "game", assetId: undefined, previewPath: asset.name.endsWith(".fbx") ? "assets/imported/model.glb" : undefined }} onClose={() => {}} />));
  const label = t("assetCanvas.downloadName", { name: asset.name });
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(downloads).toEqual([asset.name]);
  expect(getWorkspaceAsset).toHaveBeenLastCalledWith("game", asset.path);
  expect(getLibraryAsset).not.toHaveBeenCalled();
  getWorkspaceAsset.mockRejectedValueOnce(new Error("Original unavailable"));
  await act(async () => button.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Original unavailable");
  expect(downloads).toHaveLength(1);
});

it("recovers a project FBX through the project-scoped resolver", async () => {
  await act(async () => root.render(<FbxAssetActions assetId="quad" projectId="game" name="quad.fbx" failed />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(rebuildProjectModelPreview).toHaveBeenCalledWith("game", "quad");
  expect(rebuildModelPreview).not.toHaveBeenCalled();
});

it("loads registered models in Assets, refreshes a recovered pair, and ignores a late catalog from another project", async () => {
  let previous!: (files: import("../src/shared/contracts.js").WorkspaceFile[]) => void;
  listWorkspaceFiles.mockImplementationOnce(() => new Promise(resolve => { previous = resolve; }));
  const files: import("../src/shared/contracts.js").WorkspaceFile[] = [], model = { path: ".data/model-assets/quad/original.fbx", size: 10, mediaType: "model" as const, libraryAssetId: "quad" };
  const view = (projectId: string) => <AssetsView projectId={projectId} files={files} loading={false} revision={0} onShowInCode={() => {}} />;
  await act(async () => root.render(view("old")));
  listWorkspaceFiles.mockResolvedValue([model]);
  await act(async () => root.render(view("game")));
  expect(container.textContent).toContain("original.fbx");
  expect(listWorkspaceFiles).toHaveBeenLastCalledWith("game", true);
  await act(async () => previous([{ path: "foreign.png", size: 2, mediaType: "image" }]));
  expect(container.textContent).not.toContain("foreign.png");
  listWorkspaceFiles.mockResolvedValue([{ ...model, previewPath: "paired.glb" }]);
  await act(async () => window.dispatchEvent(new CustomEvent("ohmygame:model-preview-changed", { detail: "quad" })));
  expect(listWorkspaceFiles).toHaveBeenCalledTimes(3);
});

it("hides normal FBX footer actions and exposes only local recovery after a preview failure", async () => {
  await act(async () => root.render(<FbxAssetActions assetId="quad" name="quad.fbx" />));
  expect(container.querySelector("button")).toBeNull();
  const onRebuilt = vi.fn();
  await act(async () => root.render(<FbxAssetActions assetId="quad" name="quad.fbx" failed onRebuilt={onRebuilt} />));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(button => button.textContent)).toEqual([t("kunpoModels.rebuildPreview")]);
  expect(container.querySelector("p")).toBeNull();
  rebuildModelPreview.mockRejectedValueOnce(new Error("preview unavailable"));
  await act(async () => buttons[0]!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(t("kunpoModels.previewFailed"));
  await act(async () => buttons[0]!.click());
  expect(rebuildModelPreview).toHaveBeenCalledWith("quad", undefined);
  expect(onRebuilt).toHaveBeenCalledOnce();
  expect(downloads).toEqual([]);
  expect(getLibraryAsset).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

async function openViewer(nodeId: string): Promise<void> {
  const target = document.createElement("button");
  target.className = "story-media-view-button";
  await act(async () =>
    props.onNodeClick!(
      { target } as never,
      props.nodes.find((node) => node.id === nodeId)!,
    ),
  );
}

it("forwards the native video digest to the workspace trim read", async () => {
  const sha256 = "a".repeat(64);
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  getNativeMediaUrl.mockResolvedValue(`http://127.0.0.1:43110/projects/download/files/raw?path=assets%2Fimported%2Foutput.mp4&sha256=${sha256}`);
  await openViewer("video");
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
  const trim = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("videoTrim.edit"))!;
  await act(async () => trim.click());
  expect(getWorkspaceAsset).toHaveBeenCalledWith("download", "assets/imported/output.mp4", expect.any(AbortSignal), sha256);
});

it.each([
  ["image-0", "小猫照片.webp", "assets/imported/output.webp"],
  ["image-1", "另一只猫.webp", "assets/imported/output.webp"],
  ["image-2", "output.webp", "assets/imported/output.webp"],
  ["model", "骑士 v1.2.glb", "assets/imported/model.glb"],
  ["model-fbx", "四边面角色.fbx", "assets/imported/quad.fbx"],
  ["video", "片头.mp4", "assets/imported/output.mp4"],
  ["library", "猫咪正面.png", undefined],
])(
  "uses the same filename from the context menu and viewer for %s",
  async (nodeId, filename, source) => {
    await clickNodeAction(nodeId, t("assetCanvas.download"));
    expect(downloads).toEqual([filename]);

    await openViewer(nodeId);
    expect(
      document.getElementById("canvas-asset-viewer-title")?.textContent,
    ).toBe(filename);
    const viewerDownload = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("assetCanvas.downloadName", { name: filename })}"]`,
    )!;
    await act(async () => viewerDownload.click());
    expect(downloads).toEqual([filename, filename]);
    if (source)
      expect(getWorkspaceAsset).toHaveBeenLastCalledWith("download", source);
    else expect(getLibraryAsset).toHaveBeenLastCalledWith("library-image");
    expect(assets.map((asset) => asset.name)).toEqual([
      "quad.fbx",
      "output.webp",
      "model.glb",
      "output.mp4",
      "output.wav",
    ]);
  },
);

it("uses the audio node title when downloading from its context menu", async () => {
  await clickNodeAction("audio", t("assetCanvas.download"));
  expect(downloads).toEqual(["脚步声.wav"]);
  expect(getWorkspaceAsset).toHaveBeenLastCalledWith(
    "download",
    "assets/imported/output.wav",
  );
});

it("keeps the viewed output extension when a node receives a new asset", async () => {
  await openViewer("image-0");
  const node = props.nodes.find((item) => item.id === "image-0")!;
  await act(async () =>
    props.onNodesChange!([
      {
        type: "replace",
        id: node.id,
        item: { ...node, data: { ...node.data, assetId: "library-image" } },
      },
    ]),
  );
  const filename = "小猫照片.webp";
  expect(
    document.getElementById("canvas-asset-viewer-title")?.textContent,
  ).toBe(filename);
  const download = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t("assetCanvas.downloadName", { name: filename })}"]`,
  )!;
  await act(async () => download.click());
  expect(downloads).toEqual([filename]);
  expect(getWorkspaceAsset).toHaveBeenLastCalledWith(
    "download",
    "assets/imported/output.webp",
  );
});

it("downloads the current title after renaming a node and falls back when cleared", async () => {
  for (const [title, filename] of [
    ["更新后的猫咪", "更新后的猫咪.webp"],
    ["FooBar-Cat_01", "FooBar-Cat_01.webp"],
    ["", "output.webp"],
  ]) {
    await clickNodeAction("image-0", t("assetCanvas.nodeDetails"));
    const input = document.querySelector<HTMLInputElement>(
      ".design-modal input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, title);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await openViewer("image-0");
    expect(
      document.getElementById("canvas-asset-viewer-title")?.textContent,
    ).toBe(filename);
    const download = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("assetCanvas.downloadName", { name: filename! })}"]`,
    )!;
    await act(async () => download.click());
    expect(downloads.at(-1)).toBe(filename);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${t("assets.closePreview")}"]`,
        )!
        .click(),
    );
  }
});
