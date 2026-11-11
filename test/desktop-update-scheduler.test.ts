import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdateCheckScheduler } from "../src/desktop/update-check-scheduler.js";

afterEach(() => { vi.useRealTimers(); });

it("never schedules or invokes the legacy remote updater", async () => {
  vi.useFakeTimers();
  const check = vi.fn();
  const scheduler = new DesktopUpdateCheckScheduler({ check });
  scheduler.start();
  scheduler.onFocus();
  expect(await scheduler.manual()).toBe("skipped");
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  scheduler.onFocus();
  scheduler.stop();
  expect(check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
