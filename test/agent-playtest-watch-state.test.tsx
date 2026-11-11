// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import type { PlaytestWatchState } from "../src/shared/playtest.js";
import { CodingWorkspace } from "../src/renderer/coding-workspace.js";

const project: ProjectState = {
  id: "isolated-watch-fixture",
  name: "Isolated watch fixture",
  type: "web-game",
  updatedAt: new Date(0).toISOString(),
  workspacePath: "/unused/isolated-watch-fixture",
  preview: { status: "waiting" },
};
let root: Root | undefined;
let container: HTMLDivElement;
const fetch = vi.fn(() => {
  throw new Error(
    "No application or external requests are allowed in this isolated test",
  );
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetch);
  fetch.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  Reflect.deleteProperty(window, "ohMyGameDesktop");
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  let resolveInitial!: (state: PlaytestWatchState) => void;
  let publish!: (state: PlaytestWatchState) => void;
  const initial = new Promise<PlaytestWatchState>((resolve) => {
    resolveInitial = resolve;
  });
  const unsubscribe = vi.fn();
  const watch = {
    state: vi.fn(() => initial),
    setVisible: vi.fn(async (visible: boolean) => ({
      visible,
      activeSessions: 0,
    })),
    onState: vi.fn((listener: (state: PlaytestWatchState) => void) => {
      publish = listener;
      return unsubscribe;
    }),
  };
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: { agentPlaytests: watch },
  });
  await act(async () =>
    root!.render(
      <CodingWorkspace
        project={project}
        workspaceRevision={0}
        onRestart={() => {}}
      />,
    ),
  );
  const button = () => {
    const found = container.querySelector<HTMLButtonElement>(
      ".preview-agent-watch-button",
    );
    if (!found) throw new Error("Expected real CodingWorkspace camera button");
    return found;
  };
  expect(watch.state).toHaveBeenCalledOnce();
  expect(watch.onState).toHaveBeenCalledOnce();
  return { button, watch, publish, resolveInitial, unsubscribe };
}

describe("Agent camera state ordering in the real workspace", () => {
  it.each([true, false])(
    "keeps a newer visible=%s event when the initial IPC snapshot resolves later",
    async (visible) => {
      const { button, publish, resolveInitial, watch } = await mount();
      await act(async () => publish({ visible, activeSessions: 1 }));
      expect(button().getAttribute("aria-pressed")).toBe(String(visible));
      await act(async () =>
        resolveInitial({ visible: !visible, activeSessions: 0 }),
      );
      // The initial response describes an older moment than the event already shown.
      expect(button().getAttribute("aria-pressed")).toBe(String(visible));
      expect(watch.setVisible).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("uses the initial snapshot when no state event has superseded it", async () => {
    const { button, resolveInitial } = await mount();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await act(async () => resolveInitial({ visible: true, activeSessions: 0 }));
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("unsubscribes on workspace teardown and ignores a late initial response", async () => {
    const { resolveInitial, unsubscribe } = await mount();
    await act(async () => root!.unmount());
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => resolveInitial({ visible: true, activeSessions: 1 }));
    expect(container.querySelector(".preview-agent-watch-button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
