import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeMediaGuard,
  installNativeMediaGuard,
  isPinnedNativeMediaUrl,
} from "../src/desktop/native-media.js";
import type { DaemonRuntime } from "../src/shared/desktop-runtime.js";

const pin = "a".repeat(64),
  rendererTarget = "file:///synthetic/editor.html";
const runtime = {
  url: "http://127.0.0.1:12345",
  token: "synthetic-credential",
};
const library = `${runtime.url}/library/assets/test-id/content?preview=true&sha256=${pin}`;
function fixture() {
  const frame = { url: `${rendererTarget}#/canvas`, detached: false };
  const editor = { id: 77, mainFrame: frame, isDestroyed: () => false };
  let current: DaemonRuntime | undefined = runtime,
    unavailable = false;
  const options = {
    getEditor: () => editor as unknown as WebContents,
    getRuntime: () => {
      if (unavailable) throw new Error("not ready");
      return current;
    },
    rendererTarget,
  };
  const guard = createNativeMediaGuard(options);
  const details = {
    id: 1,
    url: library,
    method: "GET",
    webContentsId: editor.id,
    frame,
    requestHeaders: { Range: "bytes=20-30", Origin: "null" },
    resourceType: "media",
  };
  const send = (patch: Record<string, unknown> = {}) => {
    const callback = vi.fn();
    guard.beforeSendHeaders(
      { ...details, ...patch } as unknown as Parameters<
        typeof guard.beforeSendHeaders
      >[0],
      callback,
    );
    expect(callback).toHaveBeenCalledOnce();
    return callback.mock.calls[0]![0];
  };
  return {
    guard,
    frame,
    editor,
    options,
    details,
    send,
    setRuntime: (value: DaemonRuntime | undefined) => {
      current = value;
    },
    notReady: () => {
      unavailable = true;
    },
  };
}

describe("native media authorization", () => {
  it("matches only pinned snapshot URLs on the current daemon origin", () => {
    expect(isPinnedNativeMediaUrl(library, runtime)).toBe(true);
    expect(
      isPinnedNativeMediaUrl(
        `${runtime.url}/projects/p/files/raw?path=public%2F%E9%9B%AA%20music.wav&sha256=${pin}`,
        runtime,
      ),
    ).toBe(true);
    for (const url of [
      library.replace("12345", "12346"),
      library.replace("127.0.0.1", "localhost"),
      library.replace("http:", "https:"),
      library.replace(`&sha256=${pin}`, ""),
      library + "&other=1",
      library + `&sha256=${pin}`,
      library.replace(pin, pin.toUpperCase()),
      library.replace("preview=true", "preview=false"),
      library + "&preview=true",
      library.replace("/test-id/", "/%74est-id/"),
      library.replace("/test-id/", "/test%2Fid/"),
      library + "#fragment",
      library.replace("/library/assets/test-id/content", "/models"),
      library.replace(
        "/library/assets/test-id/content",
        "/projects/p/canvas/assets/a/model-preview",
      ),
    ])
      expect(isPinnedNativeMediaUrl(url, runtime), url).toBe(false);
  });
  it.each([
    "../outside.wav",
    "/outside.wav",
    "public/../outside.wav",
    "public/.secret.wav",
    "node_modules/a.wav",
    "public\\a.wav",
    "public//a.wav",
    "public/\u0000.wav",
    "a".repeat(1001),
  ])("rejects unsafe workspace path %j", (file) => {
    expect(
      isPinnedNativeMediaUrl(
        `${runtime.url}/projects/p/files/raw?path=${encodeURIComponent(file)}&sha256=${pin}`,
        runtime,
      ),
    ).toBe(false);
  });
  it("rejects duplicate or missing workspace path parameters", () => {
    for (const query of [
      `sha256=${pin}`,
      `sha256=${pin}&path=public/a.wav&path=public/b.wav`,
    ])
      expect(
        isPinnedNativeMediaUrl(
          `${runtime.url}/projects/p/files/raw?${query}`,
          runtime,
        ),
      ).toBe(false);
  });
  it.each(["GET", "HEAD"])(
    "adds one current token to %s without changing Range, If-Range or Origin",
    (method) => {
      const f = fixture();
      expect(
        f.send({
          method,
          requestHeaders: {
            ...f.details.requestHeaders,
            "If-Range": `"${pin}"`,
            authorization: "old",
            AUTHORIZATION: "older",
          },
        }),
      ).toEqual({
        requestHeaders: {
          ...f.details.requestHeaders,
          "If-Range": `"${pin}"`,
          Authorization: `Bearer ${runtime.token}`,
        },
      });
    },
  );
  it("supports a main-frame model-loader XHR without granting other resource types", () => {
    expect(
      fixture().send({ resourceType: "xhr" }).requestHeaders.Authorization,
    ).toBe(`Bearer ${runtime.token}`);
    for (const resourceType of [
      "other",
      "image",
      "mainFrame",
      "subFrame",
      "script",
      "webSocket",
    ])
      expect(fixture().send({ resourceType })).toEqual({ cancel: true });
  });
  it.each(["Purpose", "Sec-Purpose"])(
    "rejects %s prefetch/prerender candidates",
    (header) => {
      for (const value of ["prefetch", "prefetch;prerender"])
        expect(fixture().send({ requestHeaders: { [header]: value } })).toEqual(
          { cancel: true },
        );
    },
  );
  it("requires the exact live editor main frame, not a same-URL iframe or other window", () => {
    const f = fixture();
    for (const patch of [
      { frame: undefined },
      { frame: null },
      { frame: { ...f.frame } },
      { webContentsId: 88 },
      { webContentsId: undefined },
    ])
      expect(f.send(patch)).toEqual({ cancel: true });
    f.frame.detached = true;
    expect(f.send()).toEqual({ cancel: true });
  });
  it("rejects a destroyed editor and a main frame navigated away from the renderer", () => {
    const f = fixture();
    f.editor.isDestroyed = () => true;
    expect(f.send()).toEqual({ cancel: true });
    f.editor.isDestroyed = () => false;
    f.frame.url = "https://foreign.example/";
    expect(f.send()).toEqual({ cancel: true });
  });
  it("does not alter existing API authentication or unpinned HEAD probes", () => {
    const f = fixture();
    for (const patch of [
      { url: runtime.url + "/models" },
      { url: library.replace(`&sha256=${pin}`, ""), method: "HEAD" },
      { method: "POST" },
    ])
      expect(
        f.send({
          ...patch,
          requestHeaders: { Authorization: "existing-app-auth" },
        }),
      ).toEqual({});
  });
  it("reads runtime credentials per request and never adds one to an old origin", () => {
    const f = fixture();
    f.setRuntime({ ...runtime, token: "rotated-synthetic" });
    expect(f.send().requestHeaders.Authorization).toBe(
      "Bearer rotated-synthetic",
    );
    f.setRuntime({ ...runtime, url: "http://127.0.0.1:12346" });
    expect(f.send({ id: 2 })).toEqual({});
    f.setRuntime(undefined);
    expect(f.send({ id: 3 })).toEqual({});
    f.notReady();
    expect(f.send({ id: 4 })).toEqual({});
  });
  it("cancels an already-injected request if its runtime becomes unavailable before another header stage", () => {
    const f = fixture();
    f.send();
    f.setRuntime(undefined);
    expect(
      f.send({ requestHeaders: { Authorization: `Bearer ${runtime.token}` } }),
    ).toEqual({ cancel: true });
  });
  it("rejects malformed credentials without exposing them in an error", () => {
    const f = fixture();
    f.setRuntime({ ...runtime, token: "invalid\r\nvalue" });
    expect(f.send()).toEqual({ cancel: true });
  });
  it("cancels every redirect for auto-authorized requests, and leaves other responses unchanged", () => {
    const f = fixture();
    f.send();
    for (const statusCode of [301, 302, 303, 307, 308]) {
      const callback = vi.fn();
      f.guard.headersReceived(
        { id: 1, url: library, statusCode } as Parameters<
          typeof f.guard.headersReceived
        >[0],
        callback,
      );
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const callback = vi.fn();
    f.guard.headersReceived(
      { id: 999, url: runtime.url + "/models", statusCode: 302 } as Parameters<
        typeof f.guard.headersReceived
      >[0],
      callback,
    );
    expect(callback).toHaveBeenCalledWith({});
    expect(f.send({ url: "https://outside.example/" })).toEqual({
      cancel: true,
    });
  });
  it.each(["completed", "errored"] as const)(
    "clears correlation on %s without authorizing the next unrelated URL",
    (event) => {
      const f = fixture();
      f.send();
      if (event === "completed")
        f.guard.completed({ id: 1 } as Parameters<typeof f.guard.completed>[0]);
      else f.guard.errored({ id: 1 } as Parameters<typeof f.guard.errored>[0]);
      expect(f.send({ url: "https://outside.example/" })).toEqual({});
    },
  );
  it("stops adding credentials after cleanup", () => {
    const f = fixture();
    f.guard.stop();
    expect(f.send()).toEqual({});
  });
  it("has one session owner; an old cleanup cannot unsubscribe its replacement", () => {
    const methods = [
      "onBeforeSendHeaders",
      "onHeadersReceived",
      "onCompleted",
      "onErrorOccurred",
    ] as const;
    const events = new Map<string, unknown>();
    const requests = Object.fromEntries(
      methods.map((name) => [
        name,
        vi.fn((listener) => events.set(name, listener)),
      ]),
    );
    const session = { webRequest: requests } as unknown as Session,
      f = fixture();
    const first = installNativeMediaGuard(session, f.options);
    expect(() => installNativeMediaGuard(session, f.options)).toThrow(
      "already has an owner",
    );
    first.close();
    const second = installNativeMediaGuard(session, f.options),
      current = events.get("onBeforeSendHeaders");
    first.close();
    expect(events.get("onBeforeSendHeaders")).toBe(current);
    second.close();
    expect([...events.values()].every((value) => value === null)).toBe(true);
    expect(Object.keys(requests)).toEqual(methods);
  });
});
