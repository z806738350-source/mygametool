// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StorageCleanupPlan,
  StorageCleanupResult,
  StorageCleanupScan,
} from "../src/shared/desktop-storage.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { t } from "../src/renderer/i18n.js";

const available = vi.fn(),
  scanStorage = vi.fn(),
  planStorage = vi.fn(),
  executeStorage = vi.fn(),
  getResult = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<object>()),
  storageCleanupAvailable: available,
  scanStorageCleanup: scanStorage,
  planStorageCleanup: planStorage,
  executeStorageCleanup: executeStorage,
  getStorageCleanupResult: getResult,
}));
const { StorageSettingsPanel } =
  await import("../src/renderer/storage-settings.js");
const { SettingsPage } = await import("../src/renderer/settings-page.js");

const cachePath = ".runtime/local-execution/cache/archive",
  archivePath = ".runtime/downloads/node.zip";
function scanFixture(): StorageCleanupScan {
  return {
    supported: true,
    rootPath: "/fixture/OhMyGame",
    scanId: "scan-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    logicalBytes: 1024 ** 3 + 4096,
    allocatedBytes: 1024 ** 3 + 24_576,
    measurementComplete: true,
    items: [
      {
        id: "cache",
        category: "tool-cache",
        relativePath: cachePath,
        fileCount: 2,
        logicalBytes: 1024,
        allocatedBytes: 8192,
        state: "eligible",
        impact: "regenerable",
        measurementComplete: true,
      },
      {
        id: "archive",
        category: "install-archives",
        relativePath: archivePath,
        fileCount: 1,
        logicalBytes: 1024,
        allocatedBytes: 4096,
        state: "eligible",
        impact: "installer-copy",
        measurementComplete: true,
      },
      {
        id: "browser",
        category: "browser-cache",
        relativePath: ".runtime/local-launch/Cache",
        fileCount: 1,
        logicalBytes: 1024,
        allocatedBytes: 8192,
        state: "blocked",
        reason: "running",
        impact: "preserved",
        measurementComplete: true,
      },
      {
        id: "project",
        category: "protected-data",
        relativePath: ".runtime/local-execution/manual-data/projects",
        fileCount: 20,
        logicalBytes: 1024 ** 3,
        allocatedBytes: 1024 ** 3,
        state: "blocked",
        reason: "protected",
        impact: "preserved",
        measurementComplete: true,
      },
      {
        id: "residue",
        category: "library-residue",
        relativePath:
          ".runtime/local-execution/manual-data/library/files/unverified.glb",
        fileCount: 1,
        logicalBytes: 1024,
        allocatedBytes: 4096,
        state: "blocked",
        reason: "unknown",
        impact: "preserved",
        measurementComplete: true,
      },
    ],
    errors: [],
  };
}
function planFixture(): StorageCleanupPlan {
  return {
    scanId: "scan-1",
    planId: "plan-1",
    confirmationToken: "confirmation-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    permanent: true,
    logicalBytes: 1024,
    allocatedBytes: 8192,
    entries: [0, 1].map((index) => ({
      id: `leaf-${index}`,
      itemId: "cache",
      category: "tool-cache",
      relativePath: `${cachePath}/part-${index}.tar`,
      logicalBytes: 512,
      allocatedBytes: 4096,
    })),
  };
}
function resultFixture(): StorageCleanupResult {
  return {
    planId: "plan-1",
    completedAt: new Date().toISOString(),
    deletedLogicalBytes: 512,
    deletedAllocatedBytes: 4096,
    entries: planFixture().entries.map((entry, index) => ({
      ...entry,
      status: index ? "failed" : "deleted",
      ...(index ? { reason: "permission" as const } : {}),
    })),
  };
}

let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  scan: StorageCleanupScan,
  plan: StorageCleanupPlan;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  scan = scanFixture();
  plan = planFixture();
  available.mockReset().mockReturnValue(true);
  scanStorage.mockReset().mockImplementation(async () => structuredClone(scan));
  planStorage.mockReset().mockImplementation(async () => structuredClone(plan));
  executeStorage.mockReset().mockResolvedValue(resultFixture());
  getResult.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  // Resolve any intentionally uncertain fixture receipt without touching a filesystem.
  getResult.mockResolvedValue(resultFixture());
  const check = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent === t("storage.checkResult"));
  if (check && !check.disabled) await act(async () => check.click());
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function renderPanel(): Promise<void> {
  await act(async () => root.render(<StorageSettingsPanel />));
}
function button(
  label: string,
  within: ParentNode = document.body,
): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string, within?: ParentNode): Promise<void> {
  await act(async () => button(label, within).click());
}
function itemCheckbox(itemPath: string): HTMLInputElement {
  return [
    ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find(
    (input) =>
      input.getAttribute("aria-label") ===
      t("storage.selectItem", { path: itemPath }),
  )!;
}
async function selectCache(): Promise<void> {
  await act(async () => itemCheckbox(cachePath).click());
}
function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}
async function openPlan(): Promise<void> {
  await selectCache();
  await click(t("storage.review"));
}
async function acknowledge(): Promise<void> {
  await act(async () =>
    dialog()!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
}
function dirtyBoard(): void {
  const base = createAssetCanvasDocument(),
    local = structuredClone(base);
  local.viewport.width++;
  localStorage.setItem(
    "canvas-board:other-project:board:old-version",
    JSON.stringify({ base, local }),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("storage settings preview and confirmation", () => {
  it("explains unsupported browser mode without scanning or offering deletion", async () => {
    available.mockReturnValue(false);
    await renderPanel();
    expect(container.textContent).toContain(t("storage.unsupported"));
    expect(button(t("storage.refresh")).disabled).toBe(true);
    expect(scanStorage).not.toHaveBeenCalled();
    expect(planStorage).not.toHaveBeenCalled();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("adds the settings navigation entry and renders the storage panel", async () => {
    const choose = vi.fn();
    await act(async () =>
      root.render(
        <SettingsPage
          section="storage"
          onBack={() => {}}
          onSectionChange={choose}
        />,
      ),
    );
    const navigation = container.querySelector(".settings-page-nav")!;
    expect(
      button(t("settings.nav.storage"), navigation).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
    await click(t("settings.nav.storage"), navigation);
    expect(choose).toHaveBeenCalledWith("storage");
    expect(scanStorage).toHaveBeenCalledOnce();
  });

  it("shows allocated and logical sizes in IEC units with protected and active paths disabled", async () => {
    await renderPanel();
    expect(
      container.querySelector(".settings-storage-summary")?.textContent,
    ).toContain("1.0 GiB");
    expect(container.textContent).toContain("8.0 KiB");
    expect(container.textContent).toContain(
      t("storage.logicalSize", { size: "1.0 KiB" }),
    );
    expect(container.textContent).toContain("/fixture/OhMyGame");
    for (const item of scan.items)
      expect(itemCheckbox(item.relativePath).disabled).toBe(
        item.state === "blocked",
      );
    expect(container.textContent).toContain(t("storage.reasons.running"));
    expect(container.querySelectorAll("input:checked")).toHaveLength(0);
    expect(planStorage).not.toHaveBeenCalled();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("marks incomplete zero-byte measurements as unknown rather than empty cleanup candidates", async () => {
    scan.measurementComplete = false;
    scan.items[0] = {
      ...scan.items[0]!,
      allocatedBytes: 0,
      logicalBytes: 0,
      measurementComplete: false,
    };
    scan.errors = [{ relativePath: cachePath, reason: "permission" }];
    await renderPanel();
    expect(container.textContent).toContain(t("storage.incomplete"));
    expect(container.textContent).toContain(t("storage.measuredPartial"));
    expect(container.textContent).toContain(
      t("storage.partialSize", { size: "0 B" }),
    );
    expect(itemCheckbox(cachePath).disabled).toBe(true);
    await click(t("storage.selectAll"));
    await click(t("storage.review"));
    expect(planStorage).toHaveBeenCalledWith({
      scanId: "scan-1",
      itemIds: ["archive"],
    });
    // The fixture backend intentionally returns another item; the mismatched plan is rejected.
    expect(dialog()).toBeNull();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("selects only eligible candidate IDs and requires an exact-list review plus explicit acknowledgement", async () => {
    await renderPanel();
    await click(t("storage.selectAll"));
    expect(container.querySelectorAll("input:checked")).toHaveLength(2);
    await click(t("storage.deselectAll"));
    await selectCache();
    await click(t("storage.review"));
    expect(planStorage).toHaveBeenCalledWith({
      scanId: "scan-1",
      itemIds: ["cache"],
    });
    const modal = dialog()!;
    expect(modal.textContent).toContain(t("storage.permanentWarning"));
    expect(modal.textContent).toContain("/fixture/OhMyGame");
    for (const entry of plan.entries)
      expect(modal.textContent).toContain(entry.relativePath);
    expect(modal.textContent).toContain(
      t("storage.exactBytes", { bytes: "8,192" }),
    );
    expect(
      button(t("storage.confirmDelete", { count: 2 }), modal).disabled,
    ).toBe(true);
    expect(executeStorage).not.toHaveBeenCalled();
    await acknowledge();
    expect(
      button(t("storage.confirmDelete", { count: 2 }), modal).disabled,
    ).toBe(false);
    await click(t("common.cancel"), modal);
    expect(dialog()).toBeNull();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("keeps the full long deletion manifest keyboard reachable and does not truncate it", async () => {
    plan.entries = Array.from({ length: 1787 }, (_, index) => ({
      ...plan.entries[0]!,
      id: `leaf-${index}`,
      relativePath: `${cachePath}/exact-${index}.tar`,
    }));
    await renderPanel();
    await openPlan();
    const list = dialog()!.querySelector<HTMLUListElement>(
      ".settings-storage-plan",
    )!;
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute("aria-label")).toBe(t("storage.exactList"));
    expect(list.children).toHaveLength(1787);
    expect(list.textContent).toContain("exact-1786.tar");
    expect(document.activeElement).toBe(button(t("common.cancel"), dialog()!));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(list);
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
    expect(document.activeElement).toBe(button(t("common.cancel"), dialog()!));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dialog()).toBeNull();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("locks duplicate plan requests while the backend revalidates the selection", async () => {
    const pending = deferred<StorageCleanupPlan>();
    planStorage.mockReturnValue(pending.promise);
    await renderPanel();
    await selectCache();
    await act(async () => {
      button(t("storage.review")).click();
      button(t("storage.review")).click();
    });
    expect(planStorage).toHaveBeenCalledOnce();
    expect(itemCheckbox(cachePath).disabled).toBe(true);
    await act(async () => pending.resolve(plan));
    expect(dialog()).not.toBeNull();
  });

  it("permanently deletes only the reviewed opaque plan once and renders per-file failures", async () => {
    const pending = deferred<StorageCleanupResult>();
    executeStorage.mockReturnValue(pending.promise);
    await renderPanel();
    await openPlan();
    await acknowledge();
    const confirm = button(t("storage.confirmDelete", { count: 2 }), dialog()!);
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(executeStorage).toHaveBeenCalledOnce();
    expect(executeStorage).toHaveBeenCalledWith({
      planId: "plan-1",
      confirmationToken: "confirmation-token",
      confirmation: "PERMANENT_DELETE",
    });
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(dialog()).not.toBeNull();
    expect(button(t("common.cancel"), dialog()!).disabled).toBe(true);
    await act(async () => pending.resolve(resultFixture()));
    expect(dialog()).toBeNull();
    expect(scanStorage).toHaveBeenCalledTimes(2);
    const receipt = container.querySelector(".settings-storage-result")!;
    expect(receipt.textContent).toContain(t("storage.status.deleted"));
    expect(receipt.textContent).toContain(t("storage.status.failed"));
    expect(receipt.textContent).toContain(t("storage.reasons.permission"));
    expect(receipt.textContent).toContain(t("storage.resultSizeHint"));
    expect(container.querySelectorAll("input:checked")).toHaveLength(0);
  });

  it("explains scan errors and can retry the read-only preview", async () => {
    scanStorage.mockRejectedValueOnce(new Error("permission"));
    await renderPanel();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.reasons.permission"),
    );
    await click(t("storage.refresh"));
    expect(
      container.querySelector(".settings-storage-categories"),
    ).not.toBeNull();
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("rejects stale or nonpermanent plans before presenting a destructive confirmation", async () => {
    planStorage.mockResolvedValue({ ...plan, permanent: false });
    await renderPanel();
    await openPlan();
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.reasons.invalid"),
    );
    expect(executeStorage).not.toHaveBeenCalled();
  });
});

describe("storage cleanup draft and execution guards", () => {
  it.each(["pending", "unknown"] as const)(
    "blocks plans and deletion for %s cross-project recovery drafts",
    async (status) => {
      if (status === "pending") dirtyBoard();
      else localStorage.setItem("canvas-tables:other:old-version", "bad JSON");
      await renderPanel();
      await selectCache();
      expect(container.textContent).toContain(t(`storage.drafts.${status}`));
      expect(button(t("storage.review")).disabled).toBe(true);
      expect(planStorage).not.toHaveBeenCalled();
      expect(executeStorage).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(1);
    },
  );

  it("rechecks drafts after planning and immediately before permanent deletion even without a storage event", async () => {
    const pending = deferred<StorageCleanupPlan>();
    planStorage.mockReturnValueOnce(pending.promise);
    await renderPanel();
    await selectCache();
    await click(t("storage.review"));
    dirtyBoard();
    await act(async () => pending.resolve(plan));
    expect(dialog()).toBeNull();
    expect(executeStorage).not.toHaveBeenCalled();
    localStorage.clear();
    await click(t("storage.refresh"));
    await openPlan();
    await acknowledge();
    dirtyBoard();
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.drafts.pending"),
    );
  });

  it("invalidates the open plan on cross-window draft changes, focus, and refresh", async () => {
    await renderPanel();
    await openPlan();
    await act(async () => {
      dirtyBoard();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "canvas-board:other-project:board:old-version",
        }),
      );
    });
    expect(dialog()).toBeNull();
    expect(button(t("storage.review")).disabled).toBe(true);
    await act(async () => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    await click(t("storage.review"));
    expect(dialog()).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog()).toBeNull();
    await click(t("storage.review"));
    await click(t("storage.refresh"), container);
    expect(dialog()).toBeNull();
    expect(container.querySelectorAll("input:checked")).toHaveLength(0);
    expect(executeStorage).not.toHaveBeenCalled();
  });

  it("blocks execution if recovery storage becomes unreadable after review", async () => {
    await renderPanel();
    await openPlan();
    await acknowledge();
    vi.stubGlobal("localStorage", {
      get length() {
        throw new DOMException("Denied", "SecurityError");
      },
      key: vi.fn(),
      getItem: vi.fn(),
    });
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.drafts.unknown"),
    );
  });

  it("rejects an expired plan at final confirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await renderPanel();
    await openPlan();
    await acknowledge();
    vi.setSystemTime(Date.now() + 120_000);
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.reasons.expired"),
    );
  });

  it("discards a definitely rejected preflight without retrying execution", async () => {
    executeStorage.mockRejectedValueOnce(
      new Error("Error invoking remote method: changed"),
    );
    await renderPanel();
    await openPlan();
    await acknowledge();
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).toHaveBeenCalledOnce();
    expect(getResult).toHaveBeenCalledWith("plan-1");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.reasons.changed"),
    );
    expect(container.textContent).not.toContain(t("storage.pendingResult"));
    await click(t("storage.refresh"));
    expect(executeStorage).toHaveBeenCalledOnce();
  });

  it("recovers a completed receipt after an IPC error without repeating the delete request", async () => {
    executeStorage.mockRejectedValueOnce(new Error("IPC channel closed"));
    getResult.mockResolvedValueOnce(resultFixture());
    await renderPanel();
    await openPlan();
    await acknowledge();
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(
      container.querySelector(".settings-storage-result")?.textContent,
    ).toContain(t("storage.status.deleted"));
    expect(container.textContent).not.toContain(t("storage.pendingResult"));
  });

  it("keeps an uncertain IPC outcome query-only across navigation until its receipt is known", async () => {
    executeStorage.mockRejectedValueOnce(new Error("IPC channel closed"));
    await renderPanel();
    await openPlan();
    await acknowledge();
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    expect(executeStorage).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(t("storage.resultUnconfirmed"));
    await click(t("storage.refresh"));
    await selectCache();
    expect(button(t("storage.review")).disabled).toBe(true);
    await act(async () => root.render(<div>Other settings</div>));
    await renderPanel();
    expect(container.textContent).toContain(t("storage.pendingResult"));
    await click(t("storage.checkResult"));
    expect(executeStorage).toHaveBeenCalledOnce();
    getResult.mockResolvedValue(resultFixture());
    await click(t("storage.checkResult"));
    expect(container.textContent).not.toContain(t("storage.pendingResult"));
    expect(
      container.querySelector(".settings-storage-result")?.textContent,
    ).toContain(t("storage.status.deleted"));
  });

  it("unblocks a remounted panel after the old instance receives a definite preflight rejection", async () => {
    const pending = deferred<StorageCleanupResult>();
    executeStorage.mockReturnValueOnce(pending.promise);
    await renderPanel();
    await openPlan();
    await acknowledge();
    await click(t("storage.confirmDelete", { count: 2 }), dialog()!);
    await act(async () => root.render(<div>Other settings</div>));
    await renderPanel();
    expect(container.textContent).toContain(t("storage.pendingResult"));
    await act(async () => pending.reject(new Error("changed")));
    await click(t("storage.checkResult"));
    expect(container.textContent).not.toContain(t("storage.pendingResult"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t("storage.reasons.changed"),
    );
    expect(executeStorage).toHaveBeenCalledOnce();
  });
});
