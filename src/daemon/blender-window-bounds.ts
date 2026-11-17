import { randomUUID } from "node:crypto";
import {
  blenderWindowGeometry,
  type BlenderWindowBounds,
} from "../shared/blender-window-bounds.js";

export function notifyBlenderWindowClosed(): void {
  if (process.env.OHMYGAME_BLENDER_WINDOW_IPC === "1" && process.connected) {
    // The desktop may already have disconnected during shutdown.
    process.send?.({ channel: "ohmygame:blender-window:closed" }, () => {});
  }
}

/** Optional placement only: an unavailable desktop must never block a Blender job. */
export function resolveBlenderWindowBounds(): Promise<
  BlenderWindowBounds | undefined
> {
  if (
    process.platform !== "darwin" ||
    process.env.OHMYGAME_BLENDER_WINDOW_IPC !== "1" ||
    !process.connected ||
    !process.send
  )
    return Promise.resolve(undefined);
  const id = randomUUID();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (bounds?: BlenderWindowBounds) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve(bounds);
    };
    const onMessage = (value: unknown) => {
      const message = value as {
        channel?: unknown;
        id?: unknown;
        result?: unknown;
      } | null;
      if (
        message?.channel === "ohmygame:blender-window:result" &&
        message.id === id
      )
        finish(blenderWindowGeometry(message.result));
    };
    const onDisconnect = () => finish();
    const timeout = setTimeout(() => finish(), 1_500);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    try {
      process.send!(
        { channel: "ohmygame:blender-window:resolve", id },
        (error) => {
          if (error) finish();
        },
      );
    } catch {
      finish();
    }
  });
}
