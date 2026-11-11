// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { t } from "../src/renderer/i18n.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { runtimeConnection, updateRuntimeConnection } from "../src/renderer/runtime-connection.js";

const listLibraryAssets = vi.fn(),
  getLibraryAsset = vi.fn(),
  saveLibraryAsset = vi.fn();
const getNativeMediaUrl = vi.fn();
const deleteLibraryAsset = vi.fn(),
  forceDeleteLibraryAsset = vi.fn(),
  listLibraryAssetReferences = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listLibraryAssets,
  getLibraryAsset,
  getNativeMediaUrl,
  saveLibraryAsset,
  deleteLibraryAsset,
  forceDeleteLibraryAsset,
  listLibraryAssetReferences,
  waitForRuntime: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/app-sidebar.tsx"), () => ({
  AppSidebar: () => null,
}));
const { LibraryPage } = await import("../src/renderer/library.js");

const fixture: LibraryAsset[] = [
  {
    id: "hero",
    assetId: "hero",
    name: "hero.webp",
    path: "hero.webp",
    size: 10,
    mediaType: "image",
    contentType: "image/webp",
    createdAt: "2026-08-24T12:00:00Z",
    saved: true,
  },
  {
    id: "theme",
    assetId: "theme",
    name: "theme.mp3",
    path: "theme.mp3",
    size: 20,
    mediaType: "audio",
    contentType: "audio/mpeg",
    createdAt: "2026-08-24T12:00:00Z",
    saved: true,
  },
  {
    id: "forest",
    assetId: "forest",
    name: "forest.png",
    path: "forest.png",
    size: 30,
    mediaType: "image",
    contentType: "image/png",
    createdAt: "2026-08-24T12:00:00Z",
    saved: true,
  },
];
let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  assets: LibraryAsset[],
  downloads: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  localStorage.clear();
  assets = structuredClone(fixture);
  downloads = [];
  listLibraryAssets.mockReset().mockImplementation(async () => assets);
  getLibraryAsset
    .mockReset()
    .mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  getNativeMediaUrl.mockReset();
  listLibraryAssetReferences.mockReset().mockResolvedValue([]);
  saveLibraryAsset.mockReset().mockResolvedValue(undefined);
  deleteLibraryAsset.mockReset().mockImplementation(async (id: string) => {
    assets = assets.filter((asset) => asset.id !== id);
  });
  forceDeleteLibraryAsset.mockReset();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:library-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderPage(): Promise<void> {
  await act(async () => root.render(<LibraryPage onNavigate={() => {}} />));
}
function button(
  label: string,
  within: ParentNode = container,
): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
async function click(
  label: string,
  within: ParentNode = container,
): Promise<void> {
  await act(async () => button(label, within).click());
}
function checkbox(id: string): HTMLInputElement {
  const asset = fixture.find((item) => item.id === id)!;
  return container.querySelector<HTMLInputElement>(
    `input[aria-label="${t("library.bulk.selectAsset", { name: asset.name })}"]`,
  )!;
}
async function select(id: string): Promise<void> {
  await act(async () => checkbox(id).click());
}

function dirtyBoard(): void {
  const base = createAssetCanvasDocument();
  const local = structuredClone(base);
  local.viewport.width += 1;
  localStorage.setItem(
    "canvas-board:another-project:board:older-version",
    JSON.stringify({ base, local }),
  );
}

async function searchFor(query: string): Promise<void> {
  const search = container.querySelector<HTMLInputElement>(
    ".library-search input",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, query);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function requestSingleDelete(id: string): Promise<void> {
  const card = checkbox(id).closest("article")!;
  await click(
    t("assets.actions", {
      name: fixture.find((asset) => asset.id === id)!.name,
    }),
    card,
  );
  await click(t("common.delete"), card);
}

describe("Library batch actions", () => {
  it("shows saved historical references by default and restores them when filters reset", async () => {
    assets.push({
      ...fixture[0]!,
      id: "reference",
      assetId: "reference",
      name: "old-reference.webp",
      path: "old-reference.webp",
      purpose: "reference",
      referenceOnly: true,
    });
    await renderPage();
    const referenceSelector = `input[aria-label="${t("library.bulk.selectAsset", { name: "old-reference.webp" })}"]`;
    const reference =
      container.querySelector<HTMLInputElement>(referenceSelector)!;
    expect(reference).not.toBeNull();
    await act(async () => reference.click());
    expect(reference.checked).toBe(true);
    await click(t("libraryFilters.filter"));
    const includeReferences = document.querySelector<HTMLInputElement>(
      ".library-reference-toggle input",
    )!;
    expect(includeReferences.checked).toBe(true);
    await act(async () => includeReferences.click());
    expect(container.querySelector(referenceSelector)).toBeNull();
    await click(t("libraryFilters.reset"), document);
    expect(
      container.querySelector<HTMLInputElement>(referenceSelector)?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>(
        ".library-reference-toggle input",
      )?.checked,
    ).toBe(true);
    await click(t("libraryFilters.close"), document);
  });

  it("selects individual cards without opening the preview, and selects or deselects only the filtered results", async () => {
    await renderPage();
    await select("hero");
    expect(checkbox("hero").checked).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(t("library.bulk.selectAll"));
    expect(
      [
        ...container.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ].every((input) => input.checked),
    ).toBe(true);
    await click(t("library.bulk.deselectAll"));
    expect(
      [
        ...container.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ].some((input) => input.checked),
    ).toBe(false);
    await select("theme");
    await click(t("assets.filter.image"));
    expect(
      container.querySelectorAll(".library-asset-select input:checked"),
    ).toHaveLength(0);
    await click(t("library.bulk.selectAll"));
    getLibraryAsset.mockClear();
    await click(t("library.bulk.download"));
    expect(getLibraryAsset.mock.calls).toEqual([["hero"], ["forest"]]);
    expect(downloads).toEqual(["hero.webp", "forest.png"]);
    await click(t("assets.filter.all"));
    expect(checkbox("theme").checked).toBe(false);
    await click(t("library.bulk.clear"));
    expect(
      container.querySelectorAll(".library-asset-select input:checked"),
    ).toHaveLength(0);
  });

  it("keeps the audio placeholder visible without downloading audio for a thumbnail", async () => {
    await renderPage();
    expect(getLibraryAsset.mock.calls.map(([id]) => id)).not.toContain("theme");
    const card = checkbox("theme").closest("article")!;
    expect(card.querySelector(".library-asset-thumbnail svg")).not.toBeNull();
    expect(card.querySelector(".library-asset-thumbnail audio")).toBeNull();
  });

  it("loads a visible card and releases its preview when it leaves the viewport", async () => {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    class Observer {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { callbacks.set(element, (visible) => this.callback([{ target: element, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    await renderPage();
    const card = checkbox("hero").closest("article")!;
    expect(getLibraryAsset).not.toHaveBeenCalled();
    await act(async () => callbacks.get(card)!(true));
    expect(getLibraryAsset).toHaveBeenCalledOnce();
    expect(card.querySelector("img")).not.toBeNull();
    await act(async () => callbacks.get(card)!(false));
    expect(card.querySelector("img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:library-test");
  });

  it("stops a video card's media element when the card leaves the viewport", async () => {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    class Observer {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { callbacks.set(element, (visible) => this.callback([{ target: element, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    assets.push({ id: "clip", assetId: "clip", name: "clip.mp4", path: "clip.mp4", size: 10, mediaType: "video", contentType: "video/mp4", createdAt: "2026-08-24T12:00:00Z", saved: true });
    await renderPage();
    const card = container.querySelector<HTMLInputElement>(`input[aria-label="${t("library.bulk.selectAsset", { name: "clip.mp4" })}"]`)!.closest("article")!;
    await act(async () => callbacks.get(card)!(true));
    const video = card.querySelector("video")!;
    await act(async () => callbacks.get(card)!(false));
    expect(video.getAttribute("src")).toBeNull();
    expect(pause).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledOnce();
  });

  it("forwards the native video digest to the Library trim read", async () => {
    const sha256 = "b".repeat(64);
    vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
    getNativeMediaUrl.mockResolvedValue(`http://127.0.0.1:43110/library/assets/clip/content?preview=true&sha256=${sha256}`);
    assets.push({ id: "clip", assetId: "clip", name: "clip.mp4", path: "clip.mp4", size: 10, mediaType: "video", contentType: "video/mp4", createdAt: "2026-08-24T12:00:00Z", saved: true });
    await renderPage();
    const card = container.querySelector<HTMLInputElement>(`input[aria-label="${t("library.bulk.selectAsset", { name: "clip.mp4" })}"]`)!.closest("article")!;
    await act(async () => card.querySelector<HTMLButtonElement>(".library-asset-card-open")!.click());
    getLibraryAsset.mockClear();
    await click(t("videoTrim.edit"));
    expect(getLibraryAsset).toHaveBeenCalledWith("clip", false, expect.any(AbortSignal), sha256);
  });

  it("recovers a failed video thumbnail on a new runtime URL and ignores its old element", async () => {
    vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
    const oldUrl = `http://127.0.0.1:43110/library/assets/clip/content?sha256=${"a".repeat(64)}`;
    const newUrl = `http://127.0.0.1:43111/library/assets/clip/content?sha256=${"a".repeat(64)}`;
    getNativeMediaUrl.mockResolvedValueOnce(oldUrl).mockResolvedValueOnce(newUrl);
    assets.push({ id: "clip", assetId: "clip", name: "clip.mp4", path: "clip.mp4", size: 10, mediaType: "video", contentType: "video/mp4", createdAt: "2026-08-24T12:00:00Z", saved: true });
    await renderPage();
    const card = container.querySelector<HTMLInputElement>(`input[aria-label="${t("library.bulk.selectAsset", { name: "clip.mp4" })}"]`)!.closest("article")!;
    const oldVideo = card.querySelector("video")!;
    expect(oldVideo.getAttribute("src")).toBe(oldUrl);
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(1);
    await act(async () => updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: true }));
    const newVideo = card.querySelector("video")!;
    expect(newVideo.getAttribute("src")).toBe(newUrl);
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBe(newVideo);
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(2);
    await act(async () => newVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(2);
  });

  it("rechecks a failed native thumbnail when recovery keeps the same URL", async () => {
    vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
    const url = `http://127.0.0.1:43110/library/assets/clip/content?sha256=${"a".repeat(64)}`;
    getNativeMediaUrl.mockResolvedValue(url);
    assets.push({ id: "clip", assetId: "clip", name: "clip.mp4", path: "clip.mp4", size: 10, mediaType: "video", contentType: "video/mp4", createdAt: "2026-08-24T12:00:00Z", saved: true });
    await renderPage();
    const card = container.querySelector<HTMLInputElement>(`input[aria-label="${t("library.bulk.selectAsset", { name: "clip.mp4" })}"]`)!.closest("article")!;
    const oldVideo = card.querySelector("video")!;
    expect(oldVideo.getAttribute("src")).toBe(url);
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(1);
    await act(async () => updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: true }));
    const recovered = card.querySelector("video")!;
    expect(recovered.getAttribute("src")).toBe(url);
    expect(recovered).not.toBe(oldVideo);
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBe(recovered);
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(2);
    await act(async () => recovered.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    await act(async () => oldVideo.dispatchEvent(new Event("error")));
    expect(card.querySelector("video")).toBeNull();
    expect(getNativeMediaUrl).toHaveBeenCalledTimes(2);
  });

  it("removes hidden selections when the search changes", async () => {
    await renderPage();
    await click(t("library.bulk.selectAll"));
    const search = container.querySelector<HTMLInputElement>(
      ".library-search input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "theme");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(1);
    getLibraryAsset.mockClear();
    await click(t("library.bulk.download"));
    expect(getLibraryAsset.mock.calls).toEqual([["theme"]]);
    expect(downloads).toEqual(["theme.mp3"]);
  });

  it("disables selection and repeated actions while processing", async () => {
    await renderPage();
    await select("hero");
    let release!: (blob: Blob) => void;
    getLibraryAsset.mockClear().mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve;
        }),
    );
    const download = button(t("library.bulk.download"));
    await act(async () => {
      download.click();
      download.click();
    });
    expect(getLibraryAsset.mock.calls).toEqual([["hero"]]);
    expect(download.disabled).toBe(true);
    expect(checkbox("theme").disabled).toBe(true);
    await act(async () => release(new Blob(["image"])));
    expect(downloads).toEqual(["hero.webp"]);
    expect(download.disabled).toBe(false);
  });

  it("continues downloads after a per-file failure and reports the failed file", async () => {
    await renderPage();
    await click(t("library.bulk.selectAll"));
    getLibraryAsset.mockClear().mockImplementation(async (id: string) => {
      if (id === "theme") throw new Error("File unavailable");
      return new Blob([id]);
    });
    await click(t("library.bulk.download"));
    expect(downloads).toEqual(["hero.webp", "forest.png"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "theme.mp3: File unavailable",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      t("library.bulk.downloadResult", { count: 2, total: 3 }),
    );
    expect(
      container.querySelectorAll(".library-asset-select input:checked"),
    ).toHaveLength(3);
  });

  it("saves only the selected unsaved assets", async () => {
    assets[0] = { ...assets[0]!, saved: false, origin: "workspace" };
    await renderPage();
    await click(t("libraryFilters.filter"));
    const source = document.querySelector<HTMLSelectElement>(
      ".library-filter-popover select",
    )!;
    await act(async () => {
      source.value = "all";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(t("libraryFilters.close"), document);
    await click(t("library.bulk.selectAll"));
    await click(t("library.bulk.save"));
    expect(saveLibraryAsset.mock.calls).toEqual([["hero"]]);
    expect(checkbox("hero").checked).toBe(false);
    expect(checkbox("theme").checked).toBe(true);
  });

  it("requires confirmation, preserves referenced assets, and keeps failed deletions selected", async () => {
    await renderPage();
    listLibraryAssetReferences.mockImplementation(async (id: string) =>
      id === "hero"
        ? [{ id: "project", name: "My Canvas", type: "asset-canvas" }]
        : [],
    );
    deleteLibraryAsset.mockImplementation(async (id: string) => {
      if (id === "forest") throw new Error("Asset is used by 1 project");
      assets = assets.filter((asset) => asset.id !== id);
    });
    await click(t("library.bulk.selectAll"));
    await click(t("library.bulk.delete"));
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain(
      t("library.bulk.protected", { count: 1 }),
    );
    expect(dialog.textContent).toContain("My Canvas");
    expect(document.activeElement).toBe(button(t("common.cancel"), dialog));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(
      button(t("library.bulk.confirmDelete", { count: 2 }), dialog),
    );
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button(t("common.cancel"), dialog));
    await click(t("common.cancel"), dialog);
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    await click(t("library.bulk.delete"));
    await click(
      t("library.bulk.confirmDelete", { count: 2 }),
      container.querySelector('[role="alertdialog"]')!,
    );
    expect(deleteLibraryAsset.mock.calls).toEqual([["theme"], ["forest"]]);
    expect(forceDeleteLibraryAsset).not.toHaveBeenCalled();
    expect(checkbox("hero").checked).toBe(true);
    expect(checkbox("forest").checked).toBe(true);
    expect(checkbox("theme")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "forest.png: Asset is used by 1 project",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      t("library.bulk.deleteResult", { count: 1, total: 2 }),
    );
  });

  it("aborts bulk deletion when reference inspection fails", async () => {
    await renderPage();
    listLibraryAssetReferences.mockRejectedValue(
      new Error("Could not check references"),
    );
    await click(t("library.bulk.selectAll"));
    await click(t("library.bulk.delete"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not check references",
    );
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(forceDeleteLibraryAsset).not.toHaveBeenCalled();
  });

  it("offers no destructive confirmation when every selected asset is referenced", async () => {
    await renderPage();
    listLibraryAssetReferences.mockResolvedValue([
      { id: "project", name: "My Canvas", type: "asset-canvas" },
    ]);
    await select("hero");
    await click(t("library.bulk.delete"));
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelectorAll("button")).toHaveLength(1);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
  });
});

describe("Library unreferenced category", () => {
  it("adds a peer category and shows only confirmed empty references, regardless of historical project links", async () => {
    assets[2]!.projects = [
      { id: "old-project", name: "Old project", type: "asset-canvas" },
    ];
    listLibraryAssetReferences.mockImplementation(async (id: string) => {
      if (id === "hero")
        return [
          { id: "live-project", name: "Another canvas", type: "asset-canvas" },
        ];
      if (id === "theme") throw new Error("Project workspace is unavailable");
      return [];
    });
    await renderPage();
    const categories = container.querySelector(".library-filters")!;
    expect(categories.lastElementChild?.textContent).toBe(
      t("library.unreferenced.title"),
    );
    await click(t("library.unreferenced.title"));
    expect(button(t("assets.filter.all")).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      button(t("library.unreferenced.title")).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(checkbox("hero")).toBeNull();
    expect(checkbox("theme")).toBeNull();
    expect(checkbox("forest")).not.toBeNull();
    expect(
      container.querySelector(".library-reference-status")?.textContent,
    ).toContain(t("library.unreferenced.failed", { count: 1 }));
    await click(t("library.bulk.selectAll"));
    getLibraryAsset.mockClear();
    await click(t("library.bulk.download"));
    expect(getLibraryAsset.mock.calls).toEqual([["forest"]]);
    expect(forceDeleteLibraryAsset).not.toHaveBeenCalled();
  });

  it("keeps search and selection scoped to confirmed results and resets the category on a media filter", async () => {
    listLibraryAssetReferences.mockImplementation(async (id: string) =>
      id === "theme"
        ? [{ id: "project", name: "Audio project", type: "web-game" }]
        : [],
    );
    await renderPage();
    await click(t("library.unreferenced.title"));
    await click(t("library.bulk.selectAll"));
    await searchFor("forest");
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(1);
    getLibraryAsset.mockClear();
    await click(t("library.bulk.download"));
    expect(getLibraryAsset.mock.calls).toEqual([["forest"]]);
    await searchFor("");
    expect(checkbox("hero").checked).toBe(false);
    await click(t("assets.filter.audio"));
    expect(
      button(t("library.unreferenced.title")).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(checkbox("theme")).not.toBeNull();
    expect(checkbox("forest")).toBeNull();
  });

  it.each([undefined, null, { length: 0 }, { error: "Unknown project" }])(
    "treats malformed successful reference response %j as unknown",
    async (response) => {
      listLibraryAssetReferences.mockResolvedValue(response);
      await renderPage();
      await click(t("library.unreferenced.title"));
      expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
      expect(
        container.querySelector(".library-reference-status")?.textContent,
      ).toContain(t("library.unreferenced.failed", { count: 3 }));
      expect(
        container.querySelector(".library-reference-status")?.textContent,
      ).toContain(t("library.unreferenced.invalidResponse"));
    },
  );

  it("bounds checks at four workers and aborts obsolete checks when switching categories", async () => {
    assets = Array.from({ length: 9 }, (_, index) => ({
      ...fixture[0]!,
      id: `asset-${index}`,
      assetId: `asset-${index}`,
      name: `asset-${index}.png`,
    }));
    const pending: (() => void)[] = [];
    let active = 0,
      maximum = 0,
      aborted = 0;
    listLibraryAssetReferences.mockImplementation(
      (_id: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          active++;
          maximum = Math.max(maximum, active);
          const abort = () => {
            active--;
            aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          pending.push(() => {
            signal?.removeEventListener("abort", abort);
            active--;
            resolve([]);
          });
        }),
    );
    await renderPage();
    await click(t("library.unreferenced.title"));
    expect(listLibraryAssetReferences).toHaveBeenCalledTimes(4);
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
    expect(
      container.querySelector(".library-reference-status")?.textContent,
    ).toContain(t("library.unreferenced.checking"));
    await act(async () => pending.shift()!());
    expect(listLibraryAssetReferences).toHaveBeenCalledTimes(5);
    expect(maximum).toBe(4);
    await click(t("assets.filter.all"));
    expect(aborted).toBe(4);
    expect(active).toBe(0);
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(9);
    listLibraryAssetReferences.mockResolvedValue([]);
    await click(t("library.unreferenced.title"));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(9);
  });

  it("does not reuse obsolete results after refresh, refocus, or category re-entry", async () => {
    await renderPage();
    await click(t("library.unreferenced.title"));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(3);
    await click(t("library.bulk.selectAll"));
    listLibraryAssetReferences.mockResolvedValue([
      { id: "project", name: "Now referenced", type: "asset-canvas" },
    ]);
    await click(t("library.unreferenced.refresh"));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
    listLibraryAssetReferences.mockResolvedValue([]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(3);
    expect(
      container.querySelectorAll(".library-asset-select input:checked"),
    ).toHaveLength(0);
    await click(t("assets.filter.all"));
    listLibraryAssetReferences.mockResolvedValue([
      { id: "other", name: "Other project", type: "asset-canvas" },
    ]);
    await click(t("library.unreferenced.title"));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
  });

  it("ignores stale worker completions after a draft storage event, then rechecks after the draft is saved", async () => {
    await renderPage();
    const pending: (() => void)[] = [];
    listLibraryAssetReferences.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve([]))),
    );
    await click(t("library.unreferenced.title"));
    await act(async () => {
      dirtyBoard();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "canvas-board:another-project:board:older-version",
        }),
      );
    });
    await act(async () => pending.forEach((resolve) => resolve()));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
    expect(
      container.querySelector(".library-reference-status")?.textContent,
    ).toContain(t("library.unreferenced.pending"));
    listLibraryAssetReferences.mockResolvedValue([]);
    await act(async () => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(3);
  });

  it("refreshes classifications after an asset mutation", async () => {
    assets[0]!.referenceOnly = true;
    await renderPage();
    await click(t("library.unreferenced.title"));
    await select("hero");
    listLibraryAssetReferences
      .mockClear()
      .mockResolvedValue([
        { id: "project", name: "Saved elsewhere", type: "asset-canvas" },
      ]);
    await click(t("library.bulk.save"));
    expect(saveLibraryAsset.mock.calls).toEqual([["hero"]]);
    expect(listLibraryAssetReferences).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
  });

  it("combines source and reference filters with the unreferenced results", async () => {
    assets[0]!.referenceOnly = true;
    assets[0]!.origin = "uploaded";
    assets[2]!.origin = "generated";
    await renderPage();
    await click(t("library.unreferenced.title"));
    await click(t("libraryFilters.filter"));
    const source = document.querySelector<HTMLSelectElement>(
      ".library-filter-popover select",
    )!;
    await act(async () => {
      source.value = "uploaded";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(checkbox("hero")).not.toBeNull();
    expect(checkbox("theme")).toBeNull();
    expect(checkbox("forest")).toBeNull();
    const includeReferences = document.querySelector<HTMLInputElement>(
      ".library-reference-toggle input",
    )!;
    await act(async () => includeReferences.click());
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
    await act(async () => includeReferences.click());
    expect(checkbox("hero")).not.toBeNull();
  });

  it("keeps failed and missing assets unknown until an explicit retry confirms them", async () => {
    listLibraryAssetReferences.mockRejectedValue(
      Object.assign(new Error("Asset no longer exists"), { status: 404 }),
    );
    await renderPage();
    await click(t("library.unreferenced.title"));
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(0);
    expect(
      container.querySelector(".library-reference-status")?.textContent,
    ).toContain(t("library.unreferenced.failed", { count: 3 }));
    listLibraryAssetReferences.mockResolvedValue([]);
    await click(
      t("common.retry"),
      container.querySelector(".library-reference-status")!,
    );
    expect(container.querySelectorAll(".library-asset-card")).toHaveLength(3);
  });
});

describe("Library draft deletion protection", () => {
  it.each([
    "canvas-board:other:board:old",
    "canvas-documents:other:old",
    "canvas-tables:other:old",
  ])("blocks unknown %s recovery data in every category", async (key) => {
    localStorage.setItem(key, "broken JSON");
    await renderPage();
    await click(t("library.unreferenced.title"));
    expect(listLibraryAssetReferences).not.toHaveBeenCalled();
    expect(
      container.querySelector(".library-reference-status")?.textContent,
    ).toContain(t("library.unreferenced.unknown"));
    await click(t("assets.filter.all"));
    await requestSingleDelete("hero");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.unknown"),
    );
    await select("hero");
    await click(t("library.bulk.delete"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(forceDeleteLibraryAsset).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("broken JSON");
  });

  it("blocks deletion when storage cannot be read", async () => {
    await renderPage();
    vi.stubGlobal("localStorage", {
      get length() {
        throw new DOMException("Denied", "SecurityError");
      },
      key: vi.fn(),
      getItem: vi.fn(),
    });
    await requestSingleDelete("hero");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.unknown"),
    );
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
  });

  it("rechecks drafts after a single asset's reference request and confirmation", async () => {
    await renderPage();
    listLibraryAssetReferences.mockImplementationOnce(async () => {
      dirtyBoard();
      return [];
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await requestSingleDelete("hero");
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.pending"),
    );
    localStorage.clear();
    listLibraryAssetReferences.mockResolvedValue([]);
    confirm.mockImplementation(() => {
      dirtyBoard();
      return true;
    });
    await requestSingleDelete("hero");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
  });

  it("rechecks drafts at the force-delete confirmation instead of bypassing draft protection", async () => {
    await renderPage();
    listLibraryAssetReferences.mockResolvedValue([
      { id: "project", name: "My Canvas", type: "asset-canvas" },
    ]);
    await requestSingleDelete("hero");
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    dirtyBoard();
    await click(
      t("library.deleteEverywhere"),
      container.querySelector('[role="alertdialog"]')!,
    );
    expect(forceDeleteLibraryAsset).not.toHaveBeenCalled();
    expect(
      container.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain(t("library.unreferenced.pending"));
  });

  it("does not open bulk confirmation if a draft appears during reference inspection", async () => {
    await renderPage();
    await click(t("library.bulk.selectAll"));
    listLibraryAssetReferences.mockImplementationOnce(async () => {
      dirtyBoard();
      return [];
    });
    await click(t("library.bulk.delete"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.pending"),
    );
  });

  it("does not delete if a draft appears while bulk confirmation is open", async () => {
    await renderPage();
    await click(t("library.bulk.selectAll"));
    await click(t("library.bulk.delete"));
    dirtyBoard();
    await click(
      t("library.bulk.confirmDelete", { count: 3 }),
      container.querySelector('[role="alertdialog"]')!,
    );
    expect(deleteLibraryAsset).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.pending"),
    );
    expect(
      container.querySelectorAll(".library-asset-select input:checked"),
    ).toHaveLength(3);
  });

  it("stops remaining bulk deletes when another project's draft appears between files", async () => {
    await renderPage();
    await click(t("library.bulk.selectAll"));
    await click(t("library.bulk.delete"));
    deleteLibraryAsset.mockImplementationOnce(async (id: string) => {
      assets = assets.filter((asset) => asset.id !== id);
      dirtyBoard();
    });
    await click(
      t("library.bulk.confirmDelete", { count: 3 }),
      container.querySelector('[role="alertdialog"]')!,
    );
    expect(deleteLibraryAsset.mock.calls).toEqual([["hero"]]);
    expect(checkbox("theme").checked).toBe(true);
    expect(checkbox("forest").checked).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("library.unreferenced.pending"),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      t("library.bulk.deleteResult", { count: 1, total: 3 }),
    );
  });
});
