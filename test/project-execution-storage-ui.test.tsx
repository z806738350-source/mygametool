// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/renderer/i18n.js";
import { registerCanvasDraftReader } from "../src/renderer/canvas-draft-safety.js";
import type { ProjectExecutionStorage } from "../src/renderer/api.js";
import type { ProjectState } from "../src/shared/contracts.js";

const getStorage = vi.fn(),
  restore = vi.fn(), openStorage = vi.fn(), getCover = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<object>()),
  getProjectExecutionStorage: getStorage,
  recoverProjectExecutionStorage: restore,
  openProjectExecutionStorage: openStorage,
  getProjectCover: getCover,
}));
const { ProjectExecutionStorageDialog } =
  await import("../src/renderer/project-execution-storage.js");
const { ProjectCard } = await import("../src/renderer/project-card.js");
const { ApiError } = await import("../src/renderer/api.js");

let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  project: ProjectState,
  state: ProjectExecutionStorage,
  focus: HTMLButtonElement;
let sequence = 0;
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  project = {
    id: `recovery-ui-${++sequence}`,
    name: "Game",
    type: "web-game",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/fixture/Game",
    preview: { status: "stopped" },
  };
  state = {
    supported: true,
    projectId: project.id,
    state: "recovery-pending",
    dirty: true,
    recoverable: true,
    generation: "1",
  };
  getStorage.mockReset().mockImplementation(async () => ({ ...state }));
  openStorage.mockReset().mockResolvedValue(undefined);
  getCover.mockReset().mockResolvedValue(undefined);
  restore.mockReset().mockImplementation(async () => {
    state = { ...state, dirty: false, recoverable: false };
    return { changed: ["src/game.ts"] };
  });
  close.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  focus = document.createElement("button");
  document.body.append(focus);
  focus.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  focus.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ProjectExecutionStorageDialog
        project={project}
        returnFocus={focus}
        onClose={close}
      />,
    ),
  );
}
type ActionKey =
  | "projects.executionStorage.menu"
  | "projects.executionStorage.recover"
  | "projects.executionStorage.refresh"
  | "projects.executionStorage.open"
  | "common.close";
function button(key: ActionKey): HTMLButtonElement {
  const label = t(key);
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(key: ActionKey): Promise<void> {
  await act(async () => button(key).click());
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("project execution storage recovery", () => {
  it("opens a stopped execution store only on an explicit click and never starts recovery", async () => {
    getStorage.mockRejectedValueOnce(new Error("VM is stopped"));
    await render();
    expect(openStorage).not.toHaveBeenCalled();
    await click("projects.executionStorage.refresh");
    expect(openStorage).not.toHaveBeenCalled();
    await click("projects.executionStorage.open");
    expect(openStorage).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(restore).not.toHaveBeenCalled();
  });

  it("allows an explicit resume only after status identifies the saved exact approval, with no automatic resend", async () => {
    restore.mockRejectedValueOnce(new ApiError("Unknown result", 409, "execution_recovery_required"));
    await render(); await click("projects.executionStorage.recover");
    expect(restore).toHaveBeenCalledOnce();
    expect(button("projects.executionStorage.recover").disabled).toBe(true);
    state = { ...state, approvedReviewId: "a".repeat(64) };
    await click("projects.executionStorage.refresh");
    expect(restore).toHaveBeenCalledOnce();
    expect(button("projects.executionStorage.recover").disabled).toBe(false);
    await click("projects.executionStorage.recover");
    expect(restore).toHaveBeenCalledTimes(2);
  });
  it("is reachable from a managed project card and absent from external-folder cards", async () => {
    const actions = {
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    };
    await act(async () =>
      root.render(
        <ProjectCard project={project} onOpen={vi.fn()} actions={actions} />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".project-card-menu")!.click(),
    );
    await click("projects.executionStorage.menu");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(getStorage).toHaveBeenCalledWith(project.id);
    await act(async () =>
      root.render(
        <ProjectCard
          key="external"
          project={{ ...project, workspaceLocation: "external" }}
          onOpen={vi.fn()}
          actions={actions}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".project-card-menu")!.click(),
    );
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
      t("projects.executionStorage.menu"),
    );
  });

  it("shows exact component errors and refuses unsupported, busy or invalid state", async () => {
    getStorage.mockRejectedValueOnce(
      new Error("The execution component needs a separate update."),
    );
    await render();
    expect(container.textContent).toContain(
      "The execution component needs a separate update.",
    );
    expect(button("projects.executionStorage.recover").disabled).toBe(true);
    for (const patch of [
      { supported: false },
      { state: "busy" },
      { projectId: "another-project" },
      { generation: undefined },
    ]) {
      getStorage.mockResolvedValueOnce({ ...state, ...patch });
      await click("projects.executionStorage.refresh");
      expect(button("projects.executionStorage.recover").disabled).toBe(true);
    }
    expect(restore).not.toHaveBeenCalled();
  });

  it("recovers only the rechecked generation, keeps unsent messages and reports the result", async () => {
    const key = `ohmygame:composer-draft:v1:${project.id}:chat`,
      draft = JSON.stringify({
        version: 1,
        prompt: "keep unsent text",
        mentions: [],
        planning: false,
      });
    localStorage.setItem(key, draft);
    localStorage.setItem("canvas-board:another-project:board", "corrupt");
    await render();
    await click("projects.executionStorage.recover");
    expect(getStorage).toHaveBeenCalledTimes(3);
    expect(restore).toHaveBeenCalledExactlyOnceWith(project.id, "1");
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      t("projects.executionStorage.success", { count: 1 }),
    );
    expect(localStorage.getItem(key)).toBe(draft);
    expect(button("projects.executionStorage.recover").disabled).toBe(true);
  });

  it("stops before the write when the retained source changes or confirmation is cancelled", async () => {
    await render();
    state.generation = "2";
    await click("projects.executionStorage.recover");
    expect(restore).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      t("projects.executionStorage.changed"),
    );
    vi.mocked(window.confirm).mockReturnValue(false);
    await click("projects.executionStorage.recover");
    expect(restore).not.toHaveBeenCalled();
  });

  it("checks memory and persisted canvas drafts again after confirmation", async () => {
    await render();
    const unregister = registerCanvasDraftReader(project.id, () => "pending");
    await click("projects.executionStorage.recover");
    unregister();
    expect(window.confirm).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockImplementation(() => {
      localStorage.setItem(`canvas-documents:${project.id}`, "unreadable");
      return true;
    });
    await click("projects.executionStorage.recover");
    expect(restore).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t("projects.canvasDrafts.unknown"));
  });

  it("allows only one pending write and keeps the dialog open until it settles", async () => {
    const operation = deferred<{ changed: string[] }>();
    restore.mockReturnValue(operation.promise);
    await render();
    await act(async () => {
      button("projects.executionStorage.recover").click();
      button("projects.executionStorage.recover").click();
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(button("common.close").disabled).toBe(true);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      container
        .querySelector(".project-create-backdrop")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(close).not.toHaveBeenCalled();
    state.dirty = false;
    state.recoverable = false;
    await act(async () => operation.resolve({ changed: [] }));
    expect(button("common.close").disabled).toBe(false);
  });

  it("inspects an uncertain result without sending the same write twice, including after reopening", async () => {
    restore.mockRejectedValue(new Error("Response lost"));
    await render();
    await click("projects.executionStorage.recover");
    expect(container.textContent).toContain("Response lost");
    expect(container.textContent).toContain(
      t("projects.executionStorage.uncertain"),
    );
    await click("projects.executionStorage.refresh");
    expect(button("projects.executionStorage.recover").disabled).toBe(true);
    await act(async () => root.render(null));
    await render();
    expect(button("projects.executionStorage.recover").disabled).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
    state.dirty = false;
    state.recoverable = false;
    await click("projects.executionStorage.refresh");
    expect(container.textContent).not.toContain(
      t("projects.executionStorage.uncertain"),
    );
  });

  it("allows a new inspected attempt only when the server confirms recovery never started", async () => {
    restore.mockRejectedValueOnce(new ApiError("Checkpoint requires review", 409, "execution_recovery_not_started"));
    await render();
    await click("projects.executionStorage.recover");
    expect(container.textContent).toContain("Checkpoint requires review");
    expect(container.textContent).not.toContain(t("projects.executionStorage.uncertain"));
    expect(restore).toHaveBeenCalledOnce();
    await click("projects.executionStorage.refresh");
    await click("projects.executionStorage.recover");
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("traps keyboard focus and restores it on close", async () => {
    await render();
    expect(document.activeElement).toBe(button("common.close"));
    focus.focus();
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button("common.close"));
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
      button("projects.executionStorage.recover"),
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
    expect(document.activeElement).toBe(button("common.close"));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(close).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(focus);
  });
});
