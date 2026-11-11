// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectState } from "../src/shared/contracts.js";
import { t } from "../src/renderer/i18n.js";
import { menuPlacement } from "../src/renderer/popover-placement.js";
import { ProjectCard, projectTime } from "../src/renderer/project-card.js";

const NOW = new Date("2026-08-31T12:00:00");

describe("project time", () => {
  it("uses relative time for recent edits", () => {
    expect(projectTime("2026-08-31T11:59:30", NOW)).toBe("Edited just now");
    expect(projectTime("2026-08-31T11:48:00", NOW)).toBe("Edited 12m ago");
    expect(projectTime("2026-08-31T09:00:00", NOW)).toBe("Edited 3h ago");
    expect(projectTime("2026-08-29T12:00:00", NOW)).toBe("Edited 2d ago");
  });

  it("uses a date for older edits and includes the year when needed", () => {
    expect(projectTime("2026-08-24T11:59:59", NOW)).toBe("Edited Aug 24");
    expect(projectTime("2025-08-24T12:00:00", NOW)).toBe("Edited Aug 24, 2025");
  });
});

describe("project card menu placement", () => {
  const popup = { width: 108, height: 112 };
  const viewport = { width: 1200, height: 800 };

  it("opens below the trigger, right-aligned", () => {
    expect(menuPlacement({ top: 100, bottom: 130, right: 600 }, popup, viewport)).toEqual({ top: 134, left: 492 });
  });

  it("flips above the trigger near the bottom of the window", () => {
    expect(menuPlacement({ top: 720, bottom: 750, right: 600 }, popup, viewport)).toEqual({ top: 604, left: 492 });
  });

  it("prefers above for composer menus and flips below near the top", () => {
    expect(menuPlacement({ top: 300, bottom: 330, right: 600 }, popup, viewport, "end", "above")).toEqual({ top: 184, left: 492 });
    expect(menuPlacement({ top: 40, bottom: 70, right: 600 }, popup, viewport, "end", "above")).toEqual({ top: 74, left: 492 });
  });

  it("can line up with the trigger's left edge", () => {
    expect(menuPlacement({ top: 100, bottom: 130, left: 300, right: 360 }, popup, viewport, "start")).toEqual({ top: 134, left: 300 });
  });

  it("stays inside the window when neither side fits", () => {
    expect(menuPlacement({ top: 40, bottom: 70, right: 60 }, popup, { width: 400, height: 150 })).toEqual({ top: 30, left: 8 });
  });
});

vi.mock("../src/renderer/api.js", async (original) => ({
  ...(await original<object>()),
  getProjectCover: vi.fn().mockResolvedValue(undefined),
}));

describe("project card deletion feedback", () => {
  let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
  const project: ProjectState = { id: "card-delete", name: "Game", type: "web-game", updatedAt: "2026-08-31T12:00:00Z", workspacePath: "/fixture/Game", preview: { status: "stopped" } };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(onDelete: () => void | Promise<void>) {
    await act(async () => root.render(createElement(ProjectCard, { project, onOpen: vi.fn(), actions: { onRename: vi.fn(), onDuplicate: vi.fn(), onDelete } })));
  }
  async function deleteButton(): Promise<HTMLButtonElement> {
    await act(async () => container.querySelector<HTMLButtonElement>(".project-card-menu")!.click());
    return document.querySelector<HTMLButtonElement>(".project-card-actions-delete")!;
  }

  it("announces deletion and blocks repeated clicks until the confirmed operation settles", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const remove = vi.fn(() => pending);
    await render(remove);
    const button = await deleteButton();
    await act(async () => { button.click(); button.click(); });
    expect(remove).toHaveBeenCalledOnce();
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(t("projectCard.deleting"));
    const trigger = container.querySelector<HTMLButtonElement>(".project-card-menu")!;
    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(remove).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(trigger.disabled).toBe(false);
  });

  it("clears the waiting state after cancellation without a second delete callback", async () => {
    const cancel = vi.fn();
    await render(cancel);
    const button = await deleteButton();
    await act(async () => button.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".project-card-menu")!.disabled).toBe(false);
  });

  it("clears waiting and reuses the menu error when a deletion callback rejects", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("Deletion was not continued"));
    await render(remove);
    const button = await deleteButton();
    await act(async () => button.click());
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Deletion was not continued");
    expect(remove).toHaveBeenCalledOnce();
  });
});
