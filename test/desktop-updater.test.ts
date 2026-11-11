import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdater } from "../src/desktop/updater.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps manual and automatic update checks local even when a feed is configured", async () => {
  const fetch = vi.fn(() => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DESKTOP_UPDATE_URL", "https://updates.example/desktop");
  const desktop = new DesktopUpdater("1.0.0");
  expect(desktop.state()).toEqual({ currentVersion: "1.0.0", status: { type: "disabled" } });
  expect(await desktop.check()).toBe("skipped");
  expect(await desktop.check(true)).toBe("skipped");
  expect(fetch).not.toHaveBeenCalled();
  expect(desktop.state().availableRelease).toBeUndefined();
});

it("never downloads, installs or starts shutdown through the legacy update bridge", async () => {
  const shutdown = vi.fn();
  const desktop = new DesktopUpdater("1.0.0", shutdown);
  const listener = vi.fn();
  const unsubscribe = desktop.subscribe(listener);
  await desktop.download();
  await desktop.install();
  await desktop.install();
  unsubscribe();
  expect(shutdown).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  expect(desktop.state().status).toEqual({ type: "disabled" });
});
