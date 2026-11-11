// @vitest-environment happy-dom
import path from "node:path";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { NodeCodebaseUpdate } from "../src/shared/playable-codebase.js";
import type { ReactFlowInstance } from "@xyflow/react";
import { desktopSave } from "../src/renderer/desktop-save.js";
import { readCanvasDraftStatus } from "../src/renderer/canvas-draft-safety.js";

const codebase = createStarterCodebaseWithScene("Close save", { width: 1280, height: 720 });
const update = vi.fn(async (_projectId: string, _next: NodeCodebaseUpdate) => ({ revision: "saved" }));
let move!: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
let viewport = { x: 32, y: 64, zoom: 1.2 };
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async original => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: { onMoveEnd: typeof move; onInit: (instance: ReactFlowInstance) => void }) => {
    move = props.onMoveEnd;
    useEffect(() => { props.onInit({ getViewport: () => viewport } as ReactFlowInstance); }, []);
    return <div />;
  },
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeCodebase: async () => ({ ...structuredClone(codebase), revision: "disk" }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  getStoryUpgrade: async () => ({ web: true }),
  updateNodeCodebase: update,
}));
const { PlayableEditorWorkspace } = await import("../src/renderer/playable-editor-workspace.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockReset().mockResolvedValue({ revision: "saved" });
  viewport = { x: 32, y: 64, zoom: 1.2 };
  desktopSave.cancel();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<PlayableEditorWorkspace
    project={{ id: "p", type: "interactive-story" } as ProjectState} agentBusy={false}
  />));
  await act(async () => move(null, { x: 32, y: 64, zoom: 1.2 }));
  expect(update).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); desktopSave.cancel();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("flushes pending playable layout and waits for persistence before allowing close", async () => {
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("pending");
  expect(readCanvasDraftStatus(localStorage, "another-project")).toBe("clear");
  let finish!: (result: { revision: string }) => void;
  update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let closing!: Promise<void>;
  let closed = false;
  await act(async () => {
    closing = desktopSave.prepare().then(() => { closed = true; });
  });
  expect(update).toHaveBeenCalledExactlyOnceWith("p", expect.objectContaining({
    revision: "disk", editorLayout: expect.objectContaining({ viewport: { x: 32, y: 64, zoom: 1.2 } }),
  }), "0");
  expect(closed).toBe(false);
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("pending");
  await act(async () => { finish({ revision: "saved" }); await closing; });
  expect(closed).toBe(true);
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("clear");
});

it("rejects close on a playable save failure and retries the pending edit", async () => {
  update.mockRejectedValueOnce(new Error("Disk unavailable"));
  await act(async () => { await expect(desktopSave.prepare()).rejects.toThrow("Disk unavailable"); });
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("pending");
  desktopSave.cancel();
  await act(async () => desktopSave.prepare());
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("clear");
  expect(update).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenLastCalledWith("p", expect.objectContaining({
    editorLayout: expect.objectContaining({ viewport: { x: 32, y: 64, zoom: 1.2 } }),
  }), "0");
});

it("saves the displayed viewport when close precedes the delayed move-end event", async () => {
  viewport = { x: 12, y: 24, zoom: 1.44 };
  await act(async () => desktopSave.prepare());
  expect(readCanvasDraftStatus(localStorage, "p")).toBe("clear");
  expect(update).toHaveBeenCalledExactlyOnceWith("p", expect.objectContaining({
    editorLayout: expect.objectContaining({ viewport }),
  }), "0");
});
