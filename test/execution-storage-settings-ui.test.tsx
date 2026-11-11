// @vitest-environment happy-dom
import path from "node:path";
import { readFileSync } from "node:fs";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionStorageOverview } from "../src/shared/execution-storage.js";
import { language, t } from "../src/renderer/i18n.js";
import { projectHash } from "../src/renderer/routes.js";
import {
  executionStorageOverview,
  executionStorageProject,
} from "./fixtures/execution-storage-overview.js";

const getOverview = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<object>()),
  getExecutionStorageOverview: getOverview,
}));
const { ExecutionStorageSettingsPanel } =
  await import("../src/renderer/execution-storage-settings.js");
const { SettingsPage } = await import("../src/renderer/settings-page.js");

let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  overview: ExecutionStorageOverview;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  overview = executionStorageOverview();
  getOverview
    .mockReset()
    .mockImplementation(async () => structuredClone(overview));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<ExecutionStorageSettingsPanel />));
}
function refresh() {
  return container.querySelector<HTMLButtonElement>(
    ".execution-storage-refresh",
  )!;
}
async function reload() {
  await act(async () => refresh().click());
}
function quota() {
  return container.querySelector(".execution-storage-quota")!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("execution volume settings", () => {
  it("adds a settings entry immediately after Storage & Cleanup and reuses project navigation", async () => {
    const choose = vi.fn();
    await act(async () =>
      root.render(
        <SettingsPage
          section="execution-storage"
          onBack={() => {}}
          onSectionChange={choose}
        />,
      ),
    );
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".settings-page-nav-item",
      ),
    ];
    const index = buttons.findIndex(
      (button) => button.textContent === t("settings.nav.storage"),
    );
    const execution = buttons[index + 1]!;
    expect(execution.textContent).toBe(t("settings.nav.executionStorage"));
    expect(execution.getAttribute("aria-current")).toBe("page");
    await act(async () => execution.click());
    expect(choose).toHaveBeenCalledWith("execution-storage");
    expect(
      container
        .querySelector<HTMLAnchorElement>(".execution-storage-identity a")
        ?.getAttribute("href"),
    ).toBe(projectHash(overview.snapshot!.projects[0]!.projectId));
  });

  it("shows shared occupancy including test and orphan records without inventing eight slot rows", async () => {
    await render();
    expect(quota().textContent).toContain("2 / 8");
    expect(
      [...quota().querySelectorAll("dd")].map((item) => item.textContent),
    ).toEqual(["6", "2"]);
    const rows = container.querySelectorAll(".execution-storage-row");
    expect(rows).toHaveLength(5);
    expect(rows[3]!.textContent).toContain("44444444");
    expect(rows[3]!.textContent).toContain(
      t("executionStorage.namespaces.test"),
    );
    expect(rows[3]!.querySelector("a")).toBeNull();
    expect(rows[4]!.textContent).toContain(
      t("executionStorage.locationState.unallocated"),
    );
    expect(container.textContent).toContain(
      t("executionStorage.pendingReturn"),
    );
    expect(refresh().dataset.state).toBe("success");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      overview.snapshot!.observedAt,
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps pending-return text readable with a separate warning icon in both appearance palettes", async () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = ["styles.css", "execution-storage-settings.css"]
      .map((file) => readFileSync(path.resolve("src/renderer", file), "utf8"))
      .join("\n");
    document.head.append(stylesheet);
    const appearance = document.documentElement.dataset.appearance;
    const luminance = (hex: string) => {
      const channels = hex
        .replace("#", "")
        .match(/../g)!
        .map((channel) => {
          const value = parseInt(channel, 16) / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    };
    const contrast = (foreground: string, background: string) => {
      const pair = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      );
      return (pair[0]! + 0.05) / (pair[1]! + 0.05);
    };
    try {
      await render();
      const pending = container.querySelector<HTMLElement>(".is-pending")!;
      const icon = pending.querySelector<SVGElement>(
        ".execution-storage-pending-icon",
      )!;
      expect(pending.textContent).toBe(t("executionStorage.pendingReturn"));
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(
        container.querySelectorAll(".execution-storage-pending-icon"),
      ).toHaveLength(1);
      for (const mode of ["light", "dark"]) {
        document.documentElement.dataset.appearance = mode;
        const palette = getComputedStyle(document.documentElement);
        for (const background of ["--canvas", "--surface"]) {
          const surface = palette.getPropertyValue(background).trim();
          expect(
            contrast(getComputedStyle(pending).color, surface),
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(getComputedStyle(icon).color, surface),
          ).toBeGreaterThanOrEqual(3);
        }
      }
    } finally {
      stylesheet.remove();
      if (appearance === undefined)
        delete document.documentElement.dataset.appearance;
      else document.documentElement.dataset.appearance = appearance;
    }
  });

  it("keeps restoring reservations visible and leaves free capacity unknown when review is required", async () => {
    overview.snapshot!.residentReserved = 3;
    overview.snapshot!.allocatedProjects = 5;
    overview.snapshot!.countsTrusted = false;
    overview.snapshot!.freeResidentSlots = null;
    overview.unallocatedProjects = null;
    overview.snapshot!.projects.push(
      executionStorageProject({
        projectId: "restoring",
        residency: "archived",
        transition: { from: "archived", to: "resident" },
        taskPhase: "idle",
        residentReserved: true,
      }),
    );
    await render();
    expect(quota().textContent).toContain("3 / 8");
    expect(quota().querySelector("dd")?.textContent).toBe("--");
    expect(container.textContent).toContain(
      t("executionStorage.verificationNeeded"),
    );
    const last = container.querySelector(".execution-storage-row:last-child")!;
    expect(last.textContent).toContain(
      t("executionStorage.locationState.processing"),
    );
    expect(last.textContent).toContain(t("executionStorage.phase.idle"));
    expect(container.textContent).toContain(t("executionStorage.current"));
    expect(container.textContent).not.toContain(t("executionStorage.stale"));
    const hint = [...container.querySelectorAll(".execution-storage-hint")].at(
      -1,
    )!;
    expect(hint.textContent).toBe(t("executionStorage.unallocatedUnknown"));
    expect(hint.textContent).not.toMatch(/unavailable|stale|不可用|已过期/i);
    expect(container.querySelector('[data-location="unallocated"]')).toBeNull();
  });

  it("shows VMStopped with unknown occupancy when there is no successful snapshot", async () => {
    overview = {
      ...overview,
      vmState: "stopped",
      dataStatus: "unavailable",
      snapshot: null,
      unallocatedProjects: null,
      reason: "vm-stopped",
    };
    await render();
    expect(container.textContent).toContain(t("executionStorage.vmStopped"));
    expect(quota().textContent).toContain("-- / 8");
    expect(
      [...quota().querySelectorAll("dd")].map((item) => item.textContent),
    ).toEqual(["--", "--"]);
    expect(container.textContent).toContain(
      t("executionStorage.unknownProjects"),
    );
    expect(container.textContent).not.toContain(t("executionStorage.empty"));
    expect(container.querySelectorAll(".execution-storage-row")).toHaveLength(
      0,
    );
  });

  it("labels a stopped VM's cached snapshot stale with its observed time and no inferred unallocated projects", async () => {
    overview = {
      ...overview,
      vmState: "stopped",
      dataStatus: "stale",
      unallocatedProjects: null,
    };
    await render();
    expect(container.textContent).toContain(t("executionStorage.vmStopped"));
    expect(container.textContent).toContain(t("executionStorage.stale"));
    expect(container.textContent).not.toContain(t("executionStorage.current"));
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      overview.snapshot!.observedAt,
    );
    expect(container.querySelectorAll(".execution-storage-row")).toHaveLength(
      4,
    );
    expect(quota().querySelector("dd")?.textContent).toBe("--");
  });

  it("retains only the prior successful snapshot as stale after a refresh fails, then recovers", async () => {
    await render();
    getOverview.mockRejectedValueOnce(new Error("transport failed"));
    await reload();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("executionStorage.error"),
    );
    expect(container.textContent).toContain(t("executionStorage.stale"));
    expect(container.textContent).toContain(t("executionStorage.vmUnknown"));
    expect(container.textContent).not.toContain(t("executionStorage.current"));
    expect(container.querySelectorAll(".execution-storage-row")).toHaveLength(
      4,
    );
    expect(quota().textContent).toContain("2 / 8");
    expect(refresh().dataset.state).toBe("error");
    await reload();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(refresh().dataset.state).toBe("success");
    expect(container.querySelectorAll(".execution-storage-row")).toHaveLength(
      5,
    );
  });

  it("fails closed for malformed response counts and for a current snapshot on a stopped VM", async () => {
    getOverview.mockResolvedValueOnce({
      ...overview,
      snapshot: { ...overview.snapshot, residentReserved: -1 },
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("executionStorage.invalid"),
    );
    expect(quota().textContent).toContain("-- / 8");
    getOverview.mockResolvedValueOnce({ ...overview, vmState: "stopped" });
    await reload();
    expect(container.textContent).not.toContain(t("executionStorage.current"));
    expect(container.querySelectorAll(".execution-storage-row")).toHaveLength(
      0,
    );
  });

  it("only shows an empty allocation state for a trusted current empty snapshot", async () => {
    overview.snapshot = {
      ...overview.snapshot!,
      projects: [],
      residentReserved: 0,
      resident: 0,
      sleeping: 0,
      allocatedProjects: 0,
      freeResidentSlots: 8,
    };
    overview.unallocatedProjects = [];
    await render();
    expect(container.textContent).toContain(t("executionStorage.empty"));
    overview = {
      ...overview,
      vmState: "stopped",
      dataStatus: "stale",
      unallocatedProjects: null,
    };
    await reload();
    expect(container.textContent).not.toContain(t("executionStorage.empty"));
    expect(container.textContent).toContain(
      t("executionStorage.unknownProjects"),
    );
  });

  it.each([
    ["prepared", "preparing"],
    ["running", "running"],
    ["finished-awaiting-ack", "awaiting"],
    ["cancel-requested", "stopping"],
    ["idle", "idle"],
    ["finished", "releasing"],
    ["expired-uncertain", "unknown"],
  ] as const)(
    "renders task %s as %s independently from residency and pending returns",
    async (taskPhase, phase) => {
      const expired = taskPhase === "expired-uncertain";
      overview.snapshot = {
        ...overview.snapshot!,
        projects: [
          executionStorageProject({
            taskPhase,
            dirty: taskPhase === "finished-awaiting-ack",
            expiredTask: expired,
          }),
        ],
        allocatedProjects: 1,
        resident: 1,
        residentReserved: 1,
        sleeping: 0,
        countsTrusted: !expired,
        freeResidentSlots: expired ? null : 7,
      };
      overview.unallocatedProjects = expired ? null : [];
      await render();
      const row = container.querySelector(".execution-storage-row")!;
      expect(
        container.querySelector(".execution-storage-projects > header > span")
          ?.textContent,
      ).toBe(
        language === "en"
          ? "Records: 1"
          : t("executionStorage.projectCount", { count: 1 }),
      );
      const fields = row.querySelectorAll("dd");
      expect(fields[0]!.textContent).toBe(
        t("executionStorage.locationState.resident"),
      );
      expect(fields[1]!.textContent).toBe(t(`executionStorage.phase.${phase}`));
      if (taskPhase === "finished")
        expect(fields[1]!.textContent).not.toBe(
          t("executionStorage.phase.idle"),
        );
      expect(fields[2]!.textContent).toBe(
        t(
          taskPhase === "finished-awaiting-ack"
            ? "executionStorage.pendingReturn"
            : "executionStorage.returned",
        ),
      );
    },
  );

  it.each([
    { allocatedProjects: Number.NaN },
    { allocatedProjects: 5 },
    { residentReserved: 9 },
    { freeResidentSlots: 9 },
    { freeResidentSlots: 5 },
  ])(
    "rejects inconsistent trusted counts %j and keeps the prior snapshot stale",
    async (patch) => {
      await render();
      getOverview.mockResolvedValueOnce({
        ...overview,
        snapshot: { ...overview.snapshot!, ...patch },
      });
      await reload();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        t("executionStorage.invalid"),
      );
      expect(container.textContent).toContain(t("executionStorage.stale"));
      expect(quota().textContent).toContain("2 / 8");
      expect(quota().querySelector("dd")?.textContent).toBe("--");
    },
  );

  it("never links a foreign store's matching project ID or uses its name as a current association", async () => {
    const project = overview.snapshot!.projects[0]!;
    overview.snapshot!.projects.push({
      ...project,
      namespace: "test",
      currentStore: false,
      projectName: "Wrong store name",
    });
    overview.snapshot!.allocatedProjects = overview.snapshot!.projects.length;
    overview.snapshot!.residentReserved = 3;
    overview.snapshot!.resident = 3;
    overview.snapshot!.freeResidentSlots = 5;
    await render();
    const rows = [...container.querySelectorAll(".execution-storage-row")];
    expect(rows[4]!.querySelector("a")).toBeNull();
    expect(rows[4]!.textContent).toContain(project.projectId.slice(0, 8));
    expect(container.textContent).not.toContain("Wrong store name");
    expect(
      container.querySelectorAll(`a[href="${projectHash(project.projectId)}"]`),
    ).toHaveLength(1);
  });

  it("keeps refresh single-flight across duplicate clicks, focus and polling", async () => {
    vi.useFakeTimers();
    const pending = deferred<ExecutionStorageOverview>();
    getOverview.mockReturnValueOnce(pending.promise);
    await render();
    expect(refresh().disabled).toBe(true);
    expect(refresh().getAttribute("aria-disabled")).toBe("true");
    expect(refresh().dataset.state).toBe("loading");
    expect(
      container.querySelector(".execution-storage-skeleton"),
    ).not.toBeNull();
    await act(async () => {
      refresh().click();
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(45_000);
    });
    expect(getOverview).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(overview));
    expect(refresh().disabled).toBe(false);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it("polls only while visible and refreshes when the document becomes visible", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    await render();
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(30_000);
    });
    expect(getOverview).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(getOverview).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(getOverview).toHaveBeenCalledTimes(3);
  });

  it("aborts on cleanup and ignores an old response after StrictMode starts a newer request", async () => {
    const old = deferred<ExecutionStorageOverview>();
    getOverview.mockReturnValueOnce(old.promise);
    await act(async () =>
      root.render(
        <StrictMode>
          <ExecutionStorageSettingsPanel />
        </StrictMode>,
      ),
    );
    const oldSignal = getOverview.mock.calls[0]![0] as AbortSignal;
    expect(oldSignal.aborted).toBe(true);
    expect(getOverview).toHaveBeenCalledTimes(2);
    const outdated = executionStorageOverview();
    outdated.snapshot!.residentReserved = 7;
    outdated.snapshot!.freeResidentSlots = 1;
    await act(async () => old.resolve(outdated));
    expect(quota().textContent).toContain("2 / 8");
    await act(async () => root.render(null));
    expect((getOverview.mock.calls[1]![0] as AbortSignal).aborted).toBe(false);
  });

  it("cancels a pending request and removes refresh triggers when the panel unmounts", async () => {
    vi.useFakeTimers();
    const pending = deferred<ExecutionStorageOverview>();
    getOverview.mockReturnValueOnce(pending.promise);
    await render();
    const signal = getOverview.mock.calls[0]![0] as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(30_000);
      pending.resolve(overview);
    });
    expect(getOverview).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
  });
});
