import { isPinnedNativeMediaUrl } from "../shared/native-media.js";
export { isPinnedNativeMediaUrl } from "../shared/native-media.js";
import type { Session, WebContents } from "electron";
import type { DaemonRuntime } from "../shared/desktop-runtime.js";

type BeforeHeaders = NonNullable<
  Parameters<Session["webRequest"]["onBeforeSendHeaders"]>[0]
>;
type ReceivedHeaders = NonNullable<
  Parameters<Session["webRequest"]["onHeadersReceived"]>[0]
>;
type Completed = NonNullable<
  Parameters<Session["webRequest"]["onCompleted"]>[0]
>;
type Errored = NonNullable<
  Parameters<Session["webRequest"]["onErrorOccurred"]>[0]
>;
interface NativeMediaOptions {
  getEditor(): WebContents | undefined;
  getRuntime(): DaemonRuntime | undefined;
  rendererTarget: string;
}
const owners = new WeakMap<Session, { close(): void }>();
export function createNativeMediaGuard(options: NativeMediaOptions): {
  beforeSendHeaders: BeforeHeaders;
  headersReceived: ReceivedHeaders;
  completed: Completed;
  errored: Errored;
  stop(): void;
} {
  const active = new Map<number, string>();
  let stopped = false;
  const finish = (details: { id: number }) => {
    active.delete(details.id);
  };
  return {
    beforeSendHeaders(details, callback) {
      if (active.has(details.id) && active.get(details.id) !== details.url) {
        callback({ cancel: true });
        return;
      }
      let runtime: DaemonRuntime | undefined;
      try {
        runtime = options.getRuntime();
      } catch {}
      // Existing authenticated API requests, including unpinned HEAD probes, pass unchanged.
      if (
        stopped ||
        !runtime ||
        !isPinnedNativeMediaUrl(details.url, runtime) ||
        !["GET", "HEAD"].includes(details.method)
      ) {
        callback(active.has(details.id) ? { cancel: true } : {});
        return;
      }
      let allowed = false;
      try {
        const editor = options.getEditor(),
          frame = details.frame;
        const current = frame && new URL(frame.url);
        if (current) current.hash = "";
        const prefetch = Object.entries(details.requestHeaders).some(
          ([name, value]) =>
            /^(?:sec-)?purpose$/i.test(name) &&
            /prefetch|prerender/i.test(value),
        );
        allowed =
          !!editor &&
          !editor.isDestroyed() &&
          details.webContentsId === editor.id &&
          frame === editor.mainFrame &&
          !frame.detached &&
          current?.href === options.rendererTarget &&
          ["media", "xhr"].includes(details.resourceType) &&
          !prefetch &&
          !!runtime.token &&
          !/[\x00-\x20\x7f]/.test(runtime.token);
      } catch {}
      if (!allowed) {
        callback({ cancel: true });
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(details.requestHeaders).filter(
          ([name]) => name.toLowerCase() !== "authorization",
        ),
      );
      headers.Authorization = `Bearer ${runtime.token}`;
      active.set(details.id, details.url);
      callback({ requestHeaders: headers });
    },
    headersReceived(details, callback) {
      if (
        active.has(details.id) &&
        (active.get(details.id) !== details.url ||
          (details.statusCode >= 300 && details.statusCode < 400))
      ) {
        callback({ cancel: true });
        return;
      }
      callback({});
    },
    completed: finish,
    errored: finish,
    stop() {
      stopped = true;
      active.clear();
    },
  };
}

/** The main-window integration exclusively owns these four Session events. */
export function installNativeMediaGuard(
  session: Session,
  options: NativeMediaOptions,
): { close(): void } {
  if (owners.has(session))
    throw new Error("The native media session already has an owner");
  const guard = createNativeMediaGuard(options),
    requests = session.webRequest;
  const owner = {
    close() {
      if (owners.get(session) !== owner) return;
      guard.stop();
      requests.onBeforeSendHeaders(null);
      requests.onHeadersReceived(null);
      requests.onCompleted(null);
      requests.onErrorOccurred(null);
      owners.delete(session);
    },
  };
  owners.set(session, owner);
  requests.onBeforeSendHeaders(guard.beforeSendHeaders);
  requests.onHeadersReceived(guard.headersReceived);
  requests.onCompleted(guard.completed);
  requests.onErrorOccurred(guard.errored);
  return owner;
}
