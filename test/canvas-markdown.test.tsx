// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasMarkdown } from "../src/renderer/canvas-document-node.js";
import { MarkdownContent } from "../src/renderer/markdown-content.js";
import * as api from "../src/renderer/api.js";
import type { CanvasMarkdownDocument } from "../src/shared/canvas-document.js";
import { CanvasAssetProvider, useWorkspaceAssetUrl } from "../src/renderer/use-workspace-asset-url.js";
import { runtimeConnection, updateRuntimeConnection } from "../src/renderer/runtime-connection.js";

const canvasDocument: CanvasMarkdownDocument = {
  id: "rules",
  title: "Rules",
  markdown: "# Rules\n\n![Concept](../assets/concept.png)",
};
let container: HTMLDivElement;
let root: Root;
let sequence: number;
const createObjectURL = vi.fn((_blob: Blob) => `blob:preview-${++sequence}`);
const revokeObjectURL = vi.fn((_url: string) => {});

beforeEach(() => {
  sequence = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Happy DOM does not calculate intersections; exercise the documented fallback here.
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.spyOn(api, "getWorkspaceAsset").mockResolvedValue(
    new Blob([], { type: "image/png" }),
  );
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderCanvas(next = canvasDocument, projectId = "project-1") {
  await act(async () =>
    root.render(<CanvasMarkdown projectId={projectId} document={next} />),
  );
}

function AssetUrlProbe({ source, kind }: { source: string; kind: string }) {
  const preview = useWorkspaceAssetUrl(kind === "workspace" ? "project-1" : undefined, kind === "workspace" ? source : "", 0, kind === "workspace" ? undefined : source);
  return <output data-loading={preview.loading}>{preview.url ?? preview.error ?? ""}</output>;
}

it("uses pinned native media without a full Blob and cancels stale probes and runtime URLs", async () => {
  const previous = window.ohMyGameDesktop;
  window.ohMyGameDesktop = { nativeMedia: true } as NonNullable<Window["ohMyGameDesktop"]>;
  const reads: { signal: AbortSignal; resolve(url: string): void }[] = [];
  const native = vi.spyOn(api, "getNativeMediaUrl").mockImplementation((_source, signal) => new Promise(resolve => { reads.push({ signal: signal!, resolve }); }));
  try {
    await act(async () => root.render(<AssetUrlProbe source="public/first.mp4" kind="workspace" />));
    expect(reads).toHaveLength(1);
    await act(async () => root.render(<AssetUrlProbe source="public/second.mp4" kind="workspace" />));
    expect(reads[0].signal.aborted).toBe(true);
    const url = `http://127.0.0.1:43210/projects/project-1/files/raw?path=public%2Fsecond.mp4&sha256=${"a".repeat(64)}`;
    await act(async () => { reads[0].resolve("http://127.0.0.1:43210/stale"); reads[1].resolve(url); });
    expect(container.textContent).toBe(url);
    expect(api.getWorkspaceAsset).not.toHaveBeenCalled(); expect(createObjectURL).not.toHaveBeenCalled();
    await act(async () => updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: true }));
    expect(reads[1].signal.aborted).toBe(true); expect(reads).toHaveLength(3);
    expect(container.textContent).toBe("");
    await act(async () => reads[2].resolve(url.replace("43210", "43211")));
    expect(container.textContent).toContain("43211");
    await act(async () => root.render(null));
    expect(reads[2].signal.aborted).toBe(true); expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith({ projectId: "project-1", filePath: "public/second.mp4" }, reads[2].signal);
  } finally { window.ohMyGameDesktop = previous; }
});

it("keeps unstreamed Canvas FBX previews on their existing bounded Blob path", async () => {
  const previous = window.ohMyGameDesktop;
  window.ohMyGameDesktop = { nativeMedia: true } as NonNullable<Window["ohMyGameDesktop"]>;
  const native = vi.spyOn(api, "getNativeMediaUrl").mockResolvedValue("http://127.0.0.1:43210/unused");
  const preview = vi.spyOn(api, "getCanvasModelPreview").mockResolvedValue(new Blob(["synthetic preview"]));
  try {
    const assets = new Map([["model", { projectId: "project-1", path: "assets/canvas/model.fbx", name: "model.fbx", revision: 1 }]]);
    await act(async () => root.render(<CanvasAssetProvider assets={assets}><AssetUrlProbe source="model" kind="model-preview" /></CanvasAssetProvider>));
    expect(native).not.toHaveBeenCalled(); expect(preview).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("blob:preview-1");
  } finally { window.ohMyGameDesktop = previous; }
});

it.each(["workspace", "library", "model-preview"])("aborts stale and unmounted %s asset reads while keeping Blob URLs scoped to the current source", async kind => {
  const reads: { signal: AbortSignal; resolve(blob: Blob): void; reject(cause: unknown): void }[] = [];
  const read = kind === "library" ? vi.spyOn(api, "getLibraryAsset") : kind === "model-preview" ? vi.spyOn(api, "getCanvasModelPreview") : vi.mocked(api.getWorkspaceAsset);
  read.mockImplementation((...args: unknown[]) => new Promise<Blob>((resolve, reject) => reads.push({ signal: args.at(-1) as AbortSignal, resolve, reject })));
  const renderProbe = (source: string) => act(async () => {
    const assets = new Map(kind === "model-preview" ? [[source, { projectId: "project-1", path: `assets/imported/${source}.fbx`, name: `${source}.fbx`, revision: 1 }]] : []);
    root.render(<CanvasAssetProvider assets={assets}><AssetUrlProbe source={source} kind={kind} /></CanvasAssetProvider>);
  });
  await renderProbe("first"); expect(reads).toHaveLength(1); expect(reads[0].signal.aborted).toBe(false);
  if (kind === "library") expect(read).toHaveBeenCalledWith("first", true, reads[0].signal);
  else expect(read).toHaveBeenCalledWith("project-1", "first", reads[0].signal);
  await renderProbe("second"); expect(reads).toHaveLength(2); expect(reads[0].signal.aborted).toBe(true);
  await act(async () => { reads[0].reject(new DOMException("Stale request aborted", "AbortError")); reads[1].resolve(new Blob(["current asset"])); });
  expect(container.textContent).toBe("blob:preview-1"); expect(createObjectURL).toHaveBeenCalledOnce();
  expect(reads[1].signal.aborted).toBe(false);
  await renderProbe("third"); expect(reads[1].signal.aborted).toBe(true); expect(reads[2].signal.aborted).toBe(false);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  expect(container.querySelector("output")?.dataset.loading).toBe("true");
  await act(async () => root.render(null)); expect(reads[2].signal.aborted).toBe(true);
  await act(async () => reads[2].resolve(new Blob(["late unmounted asset"])));
  expect(createObjectURL).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledOnce();
});

describe("canvas Markdown media lifecycle", () => {
  it("keeps the loaded image mounted through canvas and document metadata updates", async () => {
    await renderCanvas();
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:preview-1");
    for (let revision = 0; revision < 4; revision++) {
      await renderCanvas({ ...canvasDocument, title: `Rules ${revision}` });
      expect(container.querySelector("img")).toBe(image);
    }
    expect(api.getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      "canvas/assets/concept.png",
      expect.any(AbortSignal),
    );
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("updates the surrounding Markdown without reloading an unchanged image", async () => {
    await renderCanvas();
    const image = container.querySelector("img");
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("# Rules", "# Revised rules"),
    });
    expect(container.querySelector("h1")?.textContent).toBe("Revised rules");
    expect(container.querySelector("img")).toBe(image);
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("loads a changed image source and releases its previous URL", async () => {
    await renderCanvas();
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("concept.png", "revised.png"),
    });
    expect(api.getWorkspaceAsset).toHaveBeenLastCalledWith(
      "project-1",
      "canvas/assets/revised.png",
      expect.any(AbortSignal),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-2",
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });

  it("resolves images against the current project and document location", async () => {
    await renderCanvas({
      ...canvasDocument,
      markdown: "![Concept](rules/concept.png)",
    });
    await renderCanvas(
      {
        ...canvasDocument,
        id: "revised",
        markdown: "![Concept](revised/concept.png)",
      },
      "project-2",
    );
    expect(api.getWorkspaceAsset).toHaveBeenNthCalledWith(
      1,
      "project-1",
      "canvas/documents/rules/concept.png",
      expect.any(AbortSignal),
    );
    expect(api.getWorkspaceAsset).toHaveBeenNthCalledWith(
      2,
      "project-2",
      "canvas/documents/revised/concept.png",
      expect.any(AbortSignal),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-2",
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });

  it("keeps an unavailable image's error until an explicit retry", async () => {
    vi.mocked(api.getWorkspaceAsset).mockRejectedValueOnce(
      new Error("File missing"),
    );
    await renderCanvas();
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("# Rules", "# Revised rules"),
    });
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".design-image-placeholder")?.textContent,
    ).toContain("Image unavailable");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".design-image-placeholder button")!
        .click(),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-1",
    );
  });
});

describe("Markdown component updates", () => {
  it("keeps copy feedback for unchanged code and clears it when the code changes", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const markdown = "# Rules\n\n```ts\nconst value = 1;\n```";
    await act(async () => root.render(<MarkdownContent text={markdown} />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")?.textContent).toBe("Copied");
    await act(async () =>
      root.render(
        <MarkdownContent
          text={markdown.replace("# Rules", "# Revised rules")}
        />,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Copied");
    await act(async () =>
      root.render(
        <MarkdownContent text={markdown.replace("value = 1", "value = 2")} />,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Copy");
  });

  it("uses the latest workspace link callback and path", async () => {
    const original = vi.fn();
    const updated = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/one"
          onOpenWorkspaceFile={original}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/one"
          onOpenWorkspaceFile={updated}
        />,
      ),
    );
    await act(async () => container.querySelector("a")!.click());
    expect(original).not.toHaveBeenCalled();
    expect(updated).toHaveBeenCalledExactlyOnceWith("rules.md");
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/two"
          onOpenWorkspaceFile={updated}
        />,
      ),
    );
    expect(container.querySelector(".workspace-file-link")).toBeNull();
  });

  it("loads images from the correct project for each Markdown document", async () => {
    await act(async () =>
      root.render(
        <>
          <CanvasMarkdown projectId="project-1" document={canvasDocument} />
          <CanvasMarkdown projectId="project-2" document={canvasDocument} />
        </>,
      ),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project-1",
      "canvas/assets/concept.png",
      expect.any(AbortSignal),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project-2",
      "canvas/assets/concept.png",
      expect.any(AbortSignal),
    );
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });
});
