import { expect, it, vi } from "vitest";
import { DesktopUpdater } from "../src/desktop/updater.js";

it("does not close the application or save files for disabled remote installation", async () => {
  const close = vi.fn(() => { throw new Error("Disabled updates must not close the app"); });
  const desktop = new DesktopUpdater("1.0.0", close);
  await desktop.install();
  expect(close).not.toHaveBeenCalled();
  expect(desktop.state().status).toEqual({ type: "disabled" });
});
