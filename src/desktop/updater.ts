import type { DesktopUpdateState } from "../shared/desktop-update.js";

export type DesktopUpdateCheckOutcome = "checked" | "failed" | "skipped";

/** The local build keeps the desktop bridge contract without any remote updater. */
export class DesktopUpdater {
  readonly #state: DesktopUpdateState;

  constructor(currentVersion: string, _onInstall?: () => Promise<void> | void) {
    this.#state = { currentVersion, status: { type: "disabled" } };
  }

  state(): DesktopUpdateState { return this.#state; }
  subscribe(_listener: (state: DesktopUpdateState) => void): () => void { return () => {}; }
  async check(_automatic = false): Promise<DesktopUpdateCheckOutcome> { return "skipped"; }
  async download(): Promise<void> {}
  async install(): Promise<void> {}
}
