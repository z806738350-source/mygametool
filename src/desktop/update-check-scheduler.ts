import type { DesktopUpdateCheckOutcome } from "./updater.js";

export interface ScheduledUpdateCheck {
  check(automatic?: boolean): Promise<DesktopUpdateCheckOutcome>;
}

/** Compatibility only: local builds never schedule remote update requests. */
export class DesktopUpdateCheckScheduler {
  constructor(_target: ScheduledUpdateCheck, _now: () => number = Date.now) {}
  start(): void {}
  onFocus(): void {}
  async manual(): Promise<DesktopUpdateCheckOutcome> { return "skipped"; }
  stop(): void {}
}
