// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { LibraryAssetPicker } from "../src/renderer/node-workbench.js";
import { t } from "../src/renderer/i18n.js";

const project = { id: "forest", name: "Forest", type: "web-game" as const };
const otherProject = { id: "desert", name: "Desert", type: "web-game" as const };
const asset: LibraryAsset = {
  id: "hero", assetId: "", name: "hero.png", path: "hero.png", size: 1,
  mediaType: "image", contentType: "image/png", createdAt: "2026-10-15T00:00:00Z",
  origin: "generated", projects: [project],
};
const otherAsset: LibraryAsset = {
  ...asset, id: "villain", name: "villain.png", path: "villain.png", projects: [otherProject],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("defaults the Library picker to the current project", async () => {
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" projectId={project.id} project={project} assets={[asset, otherAsset]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  expect(document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")).toHaveLength(1);
  expect(document.querySelector<HTMLButtonElement>(".story-video-picker-list > button")?.title).toBe("hero.png");
  const trigger = document.querySelector<HTMLButtonElement>(".library-filter-trigger");
  expect(trigger).toBeTruthy();
  await act(async () => trigger!.click());
  const selects = document.querySelectorAll<HTMLSelectElement>(".library-filter-popover select");
  expect(selects).toHaveLength(2);
  expect([...selects].map((select) => ({ value: select.value, options: [...select.options].map((option) => option.value) }))).toEqual([
    { value: "saved", options: ["saved", "generated", "uploaded", "workspace", "all"] },
    { value: project.id, options: ["", "unassigned", otherProject.id, project.id] },
  ]);
});

it("keeps the current project in the filter when it has no Library assets", async () => {
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" projectId={project.id} project={project} assets={[otherAsset]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  expect(document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")).toHaveLength(0);
  const trigger = document.querySelector<HTMLButtonElement>(".library-filter-trigger");
  await act(async () => trigger!.click());
  const projectSelect = document.querySelectorAll<HTMLSelectElement>(".library-filter-popover select")[1]!;
  expect(projectSelect.value).toBe(project.id);
  expect([...projectSelect.options].map((option) => option.value)).toEqual(["", "unassigned", otherProject.id, project.id]);
});

it("waits for a fresh Library list before offering cached assets", async () => {
  let finish!: () => void;
  const onReload = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onUpload = vi.fn();
  const render = (assets: LibraryAsset[]) => <LibraryAssetPicker title="From Library" assets={assets} onReload={onReload} onUpload={onUpload} onClose={vi.fn()} onSelect={vi.fn()} />;
  await act(async () => root.render(render([asset])));
  expect(onReload).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="status"]')?.textContent).toContain(t("library.loading"));
  expect(document.querySelectorAll(".story-video-picker-list > button")).toHaveLength(0);
  const upload = document.querySelector<HTMLButtonElement>(".story-video-picker-upload")!;
  expect(upload.disabled).toBe(true);
  await act(async () => upload.click());
  expect(onUpload).not.toHaveBeenCalled();
  await act(async () => { root.render(render([otherAsset])); finish(); });
  expect(onReload).toHaveBeenCalledOnce();
  expect([...document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")].map(button => button.title)).toEqual(["villain.png"]);
  expect(upload.disabled).toBe(false);
  await act(async () => upload.click());
  expect(onUpload).toHaveBeenCalledOnce();
});

it("reports refresh errors and retries without exposing the stale list", async () => {
  const onReload = vi.fn().mockRejectedValueOnce(new Error("Synthetic Library refresh failed")).mockResolvedValue(undefined);
  const render = (assets: LibraryAsset[]) => <LibraryAssetPicker title="From Library" assets={assets} onReload={onReload} onClose={vi.fn()} onSelect={vi.fn()} />;
  await act(async () => root.render(render([asset])));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Synthetic Library refresh failed");
  expect(document.querySelectorAll(".story-video-picker-list > button")).toHaveLength(0);
  await act(async () => {
    root.render(render([]));
    document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  });
  expect(onReload).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector(".story-video-picker-list")?.textContent).toContain(t("nodeWorkbench.empty"));
});
