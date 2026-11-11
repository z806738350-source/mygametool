interface DesktopOwner {
  connected?: boolean;
  once(event: "disconnect", listener: () => void): unknown;
}

/** Check after stdin authentication too: the desktop can exit while it is being read. */
export function bindDesktopDaemonOwner(owner: DesktopOwner, shutdown: () => Promise<void>): void {
  if (!owner.connected) throw new Error("The desktop-owned daemon requires its private parent IPC connection");
  owner.once("disconnect", () => { void shutdown(); });
}
