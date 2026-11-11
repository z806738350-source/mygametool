// @vitest-environment happy-dom
import path from "node:path";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
const inspectProjectPreview = vi.fn(async () => ({}));
const updateProjectRunSettings = vi.fn<() => Promise<ProjectState>>();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  inspectProjectPreview,
  updateProjectRunSettings,
}));
const { ProjectSettingsDialog } =
  await import("../src/renderer/project-settings-dialog.js");

describe("ProjectSettingsDialog", () => {
  it.each([false, true])(
    "shows the saved General Web preview switch: %s",
    (webPreviewEnabled) => {
      const html = renderToStaticMarkup(
        createElement(ProjectSettingsDialog, {
          project: {
            id: "general",
            name: "General",
            type: "general",
            updatedAt: new Date(0).toISOString(),
            workspacePath: "/tmp/general",
            webPreviewEnabled,
            preview: { status: "waiting" },
          },
          onClose: () => {},
          onSaved: () => {},
        }),
      );
      expect(html).toContain('role="switch" aria-label="Web preview"');
      expect(/aria-label="Web preview"[^>]*checked=""/.test(html)).toBe(
        webPreviewEnabled,
      );
      expect(
        html.includes('fieldset class="project-settings-section" disabled=""'),
      ).toBe(!webPreviewEnabled);
    },
  );

  it("keeps the project identity in the form and restores the browser-preview action", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsDialog, {
        project: {
          id: "project-1",
          name: "Nested game",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          startupDirectory: "apps/game",
          startupScript: "start",
          packageManager: "pnpm",
          previewPath: "/play",
          previewViewport: "mobile",
          preview: { status: "ready", url: "http://127.0.0.1:43121" },
        },
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    );

    expect(html).toContain("Project settings");
    expect(html).toContain("Nested game");
    expect(html).toContain('value="apps/game"');
    expect(html).toContain('value="start"');
    expect(html).toContain("Package manager");
    expect(html).toContain("Default route");
    expect(html).toContain("Device");
    expect(html).toContain("Open preview in browser");
    expect(html).not.toContain("Relative to the project root");
    expect(html).not.toContain("The selected folder must contain");
  });
});

describe("preview settings drafts", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  const project: ProjectState = {
    id: "general",
    name: "General",
    type: "general",
    webPreviewEnabled: true,
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/general",
    startupDirectory: "client",
    startupScript: "start",
    packageManager: "pnpm",
    previewMode: "script",
    previewArguments: ["--host", "{host}"],
    previewPort: 4200,
    previewCommand: "python3 -m http.server {port}",
    previewPath: "/play",
    previewViewport: "mobile",
    preview: { status: "waiting" },
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    vi.mocked(updateProjectRunSettings).mockResolvedValue(project);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          project={project}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function change(label: string, value: string) {
    const field = [...container.querySelectorAll("label")]
      .find(
        (labelElement) =>
          labelElement.querySelector("span")?.textContent === label,
      )!
      .querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
    await act(async () => {
      if (field instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        field.value = value;
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }
  async function save() {
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  }
  async function renderPreview(
    preview: ProjectState["preview"],
    previewActions?: ComponentProps<
      typeof ProjectSettingsDialog
    >["previewActions"],
    previewUrl?: string,
  ) {
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          project={{ ...project, preview }}
          previewActions={previewActions}
          previewUrl={previewUrl}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
  }

  it.each(["ready", "starting", "waiting", "stopped", "error"] as const)(
    "keeps the unique %s stop action after the browser shortcut and outside the collapsed preview actions",
    async (status) => {
      const previewActions = {
        onRestart: vi.fn(),
        onStop: vi.fn(),
        onLogs: vi.fn(),
      };
      await renderPreview({ status }, previewActions, "http://127.0.0.1:43121");
      const shortcuts = container.querySelector(
        ".project-settings-preview-shortcuts",
      )!;
      expect(shortcuts).not.toBeNull();
      const buttons = [
        ...shortcuts.querySelectorAll<HTMLButtonElement>("button"),
      ];
      const stopLabel =
        status === "starting" ? "Cancel startup" : "Stop preview";
      expect(buttons.map((button) => button.textContent)).toEqual([
        "Open preview in browser",
        stopLabel,
      ]);
      const stop = buttons[1]!;
      expect(
        [...container.querySelectorAll("button")].filter(
          (button) => button.textContent === stopLabel,
        ),
      ).toEqual([stop]);
      const foldedActions = [...container.querySelectorAll("details")].find(
        (details) =>
          details.querySelector("summary")?.textContent === "Preview actions",
      );
      expect(foldedActions).toBeDefined();
      expect(foldedActions!.open).toBe(false);
      expect(stop.closest("details")).toBeNull();
      expect(stop.disabled).toBe(!["ready", "starting"].includes(status));
      await act(async () => stop.click());
      expect(previewActions.onStop).toHaveBeenCalledTimes(
        ["ready", "starting"].includes(status) ? 1 : 0,
      );
      expect(previewActions.onRestart).not.toHaveBeenCalled();
      expect(previewActions.onLogs).not.toHaveBeenCalled();
      expect(updateProjectRunSettings).not.toHaveBeenCalled();
    },
  );

  it("can cancel startup from the shortcut row before a preview URL exists", async () => {
    const previewActions = {
      onRestart: vi.fn(),
      onStop: vi.fn(),
      onLogs: vi.fn(),
    };
    await renderPreview({ status: "starting" }, previewActions);
    const shortcuts = container.querySelector(
      ".project-settings-preview-shortcuts",
    )!;
    expect(shortcuts).not.toBeNull();
    const buttons = [
      ...shortcuts.querySelectorAll<HTMLButtonElement>("button"),
    ];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Cancel startup",
    ]);
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[0]!.closest("details")).toBeNull();
    await act(async () => buttons[0]!.click());
    expect(previewActions.onStop).toHaveBeenCalledOnce();
    expect(previewActions.onRestart).not.toHaveBeenCalled();
    expect(updateProjectRunSettings).not.toHaveBeenCalled();
  });

  it("disables the browser and stop shortcuts while settings are saving", async () => {
    const previewActions = {
      onRestart: vi.fn(),
      onStop: vi.fn(),
      onLogs: vi.fn(),
    };
    await renderPreview(
      { status: "ready" },
      previewActions,
      "http://127.0.0.1:43121",
    );
    let finish!: (saved: ProjectState) => void;
    updateProjectRunSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      await save();
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".project-settings-preview-shortcuts button",
        ),
      ];
      expect(buttons).toHaveLength(2);
      expect(buttons.every((button) => button.disabled)).toBe(true);
      await act(async () => {
        buttons.forEach((button) => button.click());
      });
      expect(open).not.toHaveBeenCalled();
      expect(previewActions.onStop).not.toHaveBeenCalled();
    } finally {
      await act(async () => finish(project));
      open.mockRestore();
    }
  });

  it("omits an empty shortcut row when there is neither a URL nor a stop callback", async () => {
    await renderPreview(
      { status: "stopped" },
      { onRestart: vi.fn(), onLogs: vi.fn() },
    );
    expect(
      container.querySelector(".project-settings-preview-shortcuts"),
    ).toBeNull();
    expect(container.textContent).not.toContain("Stop preview");
    expect(container.textContent).not.toContain("Cancel startup");
  });

  it("keeps the browser-only shortcut when no preview action callbacks are supplied", async () => {
    await renderPreview({ status: "ready", url: "http://127.0.0.1:43121" });
    const shortcuts = container.querySelector(
      ".project-settings-preview-shortcuts",
    )!;
    expect(shortcuts).not.toBeNull();
    expect(
      [...shortcuts.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Open preview in browser"]);
    expect(container.textContent).not.toContain("Stop preview");
    expect(container.textContent).not.toContain("Preview actions");
  });

  it.each(["static", "command"])(
    "ignores invalid script drafts for %s during inspection and save",
    async (mode) => {
      await change("Script arguments", "[");
      await change("Startup script", "invalid script name");
      await change("Preview mode", mode);
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(inspectProjectPreview).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          previewMode: mode,
          startupScript: "start",
          previewArguments: project.previewArguments,
        }),
      );
      await save();
      expect(updateProjectRunSettings).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          previewMode: mode,
          previewArguments: project.previewArguments,
          startupScript: "start",
        }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("reports invalid arguments while script mode is active", async () => {
    await change("Script arguments", "[");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Arguments must be a JSON array of strings.",
    );
    await save();
    expect(updateProjectRunSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Arguments must be a JSON array of strings.",
    );
  });

  it("disables preview without saving invalid disabled drafts or losing saved configuration", async () => {
    await change("Script arguments", "[");
    await change("Startup directory", "../outside");
    await change("Default route", "https://external.example");
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Web preview"]')!
        .click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).not.toHaveBeenCalled();
    await save();
    expect(updateProjectRunSettings).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        webPreviewEnabled: false,
        previewMode: "script",
        startupDirectory: "client",
        startupScript: "start",
        previewArguments: project.previewArguments,
        previewPort: 4200,
        previewPath: "/play",
        previewViewport: "mobile",
      }),
    );
  });

  it("does not reinspect startup configuration when route and device change", async () => {
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await change("Default route", "/new-route");
    await change("Device", "tablet");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await save();
    expect(updateProjectRunSettings).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        previewPath: "/new-route",
        previewViewport: "tablet",
      }),
    );
  });
});
