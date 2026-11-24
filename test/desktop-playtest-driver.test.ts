import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlaytestActionFailure, getPlaytestOpenFailure, type PlaytestSnapshot } from "../src/shared/playtest.js";
import { Window } from "happy-dom";

const electron = vi.hoisted(() => {
  class FakeImage {
    constructor(readonly width = 2, readonly height = 1) {}
    getSize() { return { width: this.width, height: this.height }; }
    resize = vi.fn((options: { width: number; height: number }) => new FakeImage(options.width, options.height));
    toJPEG = vi.fn((quality: number) => Buffer.from(`jpeg:${this.width}x${this.height}:${quality}`));
    toBitmap = vi.fn(() => Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]));
  }

  class FakeDebugger {
    attached = false;
    readonly commands: Array<{ method: string; parameters?: unknown }> = [];
    attach = vi.fn(() => { this.attached = true; });
    detach = vi.fn(() => { this.attached = false; });
    isAttached = vi.fn(() => this.attached);
    sendCommand = vi.fn(async (method: string, parameters?: unknown) => {
      this.commands.push({ method, parameters });
      return {};
    });
  }

  class FakeSession {
    permissionCheckHandler?: (contents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame: boolean }) => boolean;
    permissionHandler?: (contents: unknown, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string; isMainFrame: boolean }) => void;
    downloadHandler?: (event: { preventDefault(): void }) => void;
    requestErrorHandler?: (details: Record<string, unknown>) => void;
    setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    setPermissionRequestHandler = vi.fn((handler) => { this.permissionHandler = handler; });
    on = vi.fn((event: string, handler) => { if (event === "will-download") this.downloadHandler = handler; });
    readonly webRequest = { onBeforeRequest: vi.fn(), onErrorOccurred: vi.fn((handler) => { this.requestErrorHandler = handler; }) };
  }

  const windows: FakeWindow[] = [];
  class FakeWindow {
    readonly options: Record<string, any>;
    readonly debugger = new FakeDebugger();
    readonly session = new FakeSession();
    destroyed = false;
    visible = false;
    minimized = false;
    handlers = new Map<string, (() => void)[]>();
    loadedUrl = "";
    navigateHandler?: (event: { preventDefault(): void }, url: string) => void;
    redirectHandler?: (event: { preventDefault(): void }, url: string) => void;
    consoleHandler?: (details: { level: "error"; message: string; sourceId: string; lineNumber: number }) => void;
    closeHandler?: (event: { preventDefault(): void }) => void;
    closedHandler?: () => void;
    readonly setContentSize = vi.fn();
    readonly getContentSize = vi.fn(() => [this.options.width, this.options.height]);
    emit(event: string) { for (const handler of this.handlers.get(event) ?? []) handler(); }
    readonly showInactive = vi.fn(() => { this.visible = true; this.emit("show"); });
    readonly hide = vi.fn(() => { this.visible = false; this.emit("hide"); });
    readonly restore = vi.fn(() => { this.minimized = false; this.emit("restore"); });
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    readonly loadURL = vi.fn(async (url: string) => { this.loadedUrl = url; });
    /** Child frames of the page, such as a Playable Nodes sandbox. */
    readonly childFrames: { url: string; executeJavaScript: (script: string) => Promise<unknown> }[] = [];
    frameBoxes: { url: string; x: number; y: number; scaleX: number; scaleY: number }[] = [];
    // Electron throws when a destroyed window's webContents is read.
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.contents;
    }
    readonly contents = {
      id: windows.length + 1,
      debugger: this.debugger,
      session: this.session,
      setWindowOpenHandler: vi.fn(),
      setAudioMuted: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "will-navigate") this.navigateHandler = handler;
        if (event === "will-redirect") this.redirectHandler = handler;
        if (event === "console-message") this.consoleHandler = handler;
      }),
      executeJavaScript: vi.fn(async (script: string): Promise<unknown> => {
        if (script.includes('deepQueryAll("iframe")')) return this.frameBoxes;
        if (script.includes("box.x + box.width / 2")) return this.childFrames.length ? null : { x: 20, y: 30 };
        if (script.includes("isContentEditable")) return true;
        if (script.includes("bridge[method]")) return true;
        return {
          url: this.loadedUrl,
          title: "Test Game",
          readyState: "complete",
          viewport: { width: this.options.width, height: this.options.height },
          elements: [],
          canvases: [{ index: 0, width: 320, height: 180, box: { x: 0, y: 0, width: 320, height: 180 }, visible: true }],
        };
      }),
      capturePage: vi.fn(async () => new FakeImage()),
      isDestroyed: vi.fn(() => this.destroyed),
      mainFrame: {
        frames: this.childFrames,
        executeJavaScript: (script: string) => this.contents.executeJavaScript(script),
      },
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
    }

    on(event: string, handler: any) {
      if (event === "close") this.closeHandler = handler;
      else this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]);
    }
    once(event: string, handler: () => void) { if (event === "closed") this.closedHandler = handler; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.closedHandler?.(); }
  }
  return { windows, FakeWindow, FakeImage };
});

vi.mock("electron", () => ({ BrowserWindow: electron.FakeWindow }));

import { analyzeBitmap, ElectronPlaytestDriver, validatedPlaytestUrl } from "../src/desktop/playtest-driver.js";

async function domPlaytest(html: string, texts: string[] = []) {
  const dom = new Window({ url: "http://127.0.0.1:43123/" });
  dom.document.body.innerHTML = html;
  for (const [index, element] of [...dom.document.querySelectorAll("button")].entries()) {
    Object.defineProperty(element, "innerText", { value: texts[index] ?? element.textContent });
    Object.defineProperty(element, "checkVisibility", { value: () => !element.hidden });
    element.getBoundingClientRect = () => new dom.DOMRect(77, 493, 250, 66);
  }
  const driver = new ElectronPlaytestDriver();
  const opening = driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
  const window = electron.windows[0]!, original = window.webContents.executeJavaScript.getMockImplementation()!;
  window.webContents.executeJavaScript.mockImplementation(async script => script.includes('deepQueryAll("iframe")') ? window.frameBoxes
    : script.includes("const INTERACTIVE") ? dom.eval(script) : original(script));
  const opened = await opening;
  if (opened.operation !== "open") throw Error("Expected open");
  return { driver, dom, window, snapshot: opened.snapshot as PlaytestSnapshot,
    close: async () => { driver.close(); await dom.happyDOM.close(); } };
}

describe("playtest DOM target consistency", () => {
  beforeEach(() => { electron.windows.length = 0; });
  it.each(["text", "role"])("matches reported multiline %s after normalizing whitespace on both sides", async kind => {
    const fixture = await domPlaytest('<button id="start"><span>踏入暮林</span><em>ENTER / 点击开始</em></button>', ["\t踏入暮林 \n ENTER\u00a0/\t 点击开始  "]);
    try {
      expect(fixture.snapshot.elements[0]?.text).toBe("踏入暮林 ENTER / 点击开始");
      const name = " 踏入暮林\tENTER / 点击开始\n";
      const target = kind === "text" ? { text: name } : { role: "button", name };
      await fixture.driver.request({ operation: "act", sessionId: fixture.snapshot.sessionId, actions: [{ type: "click", target }] });
      expect(fixture.window.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent")).toHaveLength(3);
    } finally { await fixture.close(); }
  });
  it.each(["duplicate", "hidden", "disabled", "blank"])("does not dispatch input for a %s target", async kind => {
    const html = kind === "duplicate" ? '<button>Start</button><button>Start</button>' : `<button ${kind === "hidden" ? "hidden" : kind === "disabled" ? "disabled" : ""}>Start</button>`;
    const fixture = await domPlaytest(html);
    try {
      const cause = await fixture.driver.request({ operation: "act", sessionId: fixture.snapshot.sessionId, actions: [{ type: "click", target: { text: kind === "blank" ? " \n\t" : "Start" } }] }).catch(error => error);
      expect(getPlaytestActionFailure(cause)).toMatchObject({ completedActions: 0, failedAction: 1, phase: "target_lookup", inputDispatched: false });
      expect(fixture.window.debugger.commands.filter(command => command.method.startsWith("Input."))).toHaveLength(0);
      if (kind === "duplicate") expect(cause.message).toContain("Multiple visible");
    } finally { await fixture.close(); }
  });
  it("ignores a hidden duplicate and preserves completed input when a later target is missing", async () => {
    const fixture = await domPlaytest('<button hidden>Start</button><button id="start">Start</button>');
    try {
      const cause = await fixture.driver.request({ operation: "act", sessionId: fixture.snapshot.sessionId, actions: [{ type: "click", target: { text: "Start" } }, { type: "click", target: { text: "Missing" } }] }).catch(error => error);
      expect(getPlaytestActionFailure(cause)).toMatchObject({ completedActions: 1, failedAction: 2, phase: "target_lookup", inputDispatched: false });
      expect(fixture.window.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent")).toHaveLength(3);
    } finally { await fixture.close(); }
  });
  it("keeps delivery uncertain when a mouse dispatch fails", async () => {
    const fixture = await domPlaytest('<button>Start</button>');
    try {
      const dispatch = fixture.window.debugger.sendCommand.getMockImplementation()!;
      fixture.window.debugger.sendCommand.mockImplementation(async (method, parameters) => {
        if (method === "Input.dispatchMouseEvent") throw new Error("Dispatch interrupted");
        return dispatch(method, parameters);
      });
      const cause = await fixture.driver.request({ operation: "act", sessionId: fixture.snapshot.sessionId, actions: [{ type: "click", target: { text: "Start" } }] }).catch(error => error);
      expect(getPlaytestActionFailure(cause)).toMatchObject({ completedActions: 0, phase: "action", inputDispatched: "unknown" });
    } finally { await fixture.close(); }
  });
  it("reports no input if the owned window closes during target lookup", async () => {
    const fixture = await domPlaytest('<button>Start</button>');
    const { driver, window, snapshot: { sessionId } } = fixture;
    try {
      await expect(driver.request({ operation: "sessionStatus", sessionId })).resolves.toMatchObject({ resourceStatus: "live" });
      const evaluate = window.webContents.executeJavaScript.getMockImplementation()!;
      window.webContents.executeJavaScript.mockImplementationOnce(async script => {
        const observation = await evaluate(script);
        await driver.request({ operation: "close", sessionId });
        return observation;
      });
      const error = await driver.request({ operation: "act", sessionId, actions: [{ type: "click", target: { text: "Start" } }] }).catch(cause => cause);
      expect(getPlaytestActionFailure(error)).toMatchObject({ sessionId, completedActions: 0, phase: "session_unavailable", inputDispatched: false });
      expect(window.debugger.commands.filter(command => command.method.startsWith("Input."))).toHaveLength(0);
      await expect(driver.request({ operation: "sessionStatus", sessionId })).resolves.toMatchObject({ resourceStatus: "closed" });
    } finally { await fixture.close(); }
  });
  it("refuses ambiguous matches across frames before any mouse input", async () => {
    const fixture = await domPlaytest('<button>Start</button>');
    try {
      fixture.window.frameBoxes = [{ url: "about:srcdoc", x: 0, y: 0, scaleX: 1, scaleY: 1 }];
      fixture.window.childFrames.push({ url: "about:srcdoc", executeJavaScript: async () => ({ x: 20, y: 30 }) });
      const cause = await fixture.driver.request({ operation: "act", sessionId: fixture.snapshot.sessionId, actions: [{ type: "click", target: { text: "Start" } }] }).catch(error => error);
      expect(cause.message).toContain("across frames");
      expect(getPlaytestActionFailure(cause)).toMatchObject({ completedActions: 0, inputDispatched: false });
      expect(fixture.window.debugger.commands.filter(command => command.method.startsWith("Input."))).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});

beforeEach(() => { electron.windows.length = 0; });

describe("electron playtest driver", () => {
  it("opens only isolated local preview windows", async () => {
    const driver = new ElectronPlaytestDriver();
    const result = await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/game" },
      viewport: { width: 1280, height: 720 },
    });

    expect(result.operation).toBe("open");
    expect(electron.windows[0]?.options).toMatchObject({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(electron.windows[0]?.loadedUrl).toBe("http://127.0.0.1:43123/game?ohmygamePlaytest=1");
    expect(electron.windows[0]?.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(electron.windows[0]?.options.resizable).toBe(true);
    driver.close();
  });

  it("shows a new Agent actual bridge capabilities and media progress without interpreting historical failures as decoder failure", async () => {
    const dom = new Window({ url: "http://127.0.0.1:43123/" });
    dom.document.body.innerHTML = '<video id="intro" src="/media/intro.mp4?private=query"></video>';
    const video = dom.document.querySelector("video")!;
    Object.defineProperties(video, {
      readyState: { value: 4 }, currentTime: { value: 1.2 }, duration: { value: 5 }, paused: { value: false },
      networkState: { value: 1 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 },
      buffered: { value: { length: 1, start: () => 0, end: () => 5 } },
      getVideoPlaybackQuality: { value: () => ({ totalVideoFrames: 29, droppedVideoFrames: 2 }) },
    });
    Object.assign(dom, { __OHMYGAME_PLAYTEST__: { snapshot: () => ({ level: 1 }), reset: () => {}, setSeed: () => {}, step: () => {}, customProbe: () => {} } });
    const driver = new ElectronPlaytestDriver();
    const opening = driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const original = window.webContents.executeJavaScript.getMockImplementation()!;
    window.webContents.executeJavaScript.mockImplementation(async script => script.includes('const listMedia') ? dom.eval(script) : original(script));
    try {
      const opened = await opening;
      if (opened.operation !== "open") throw Error("Expected open");
      expect(opened.snapshot.capabilities.deterministic).toEqual(["snapshot", "reset", "seed", "step"]);
      expect(opened.snapshot.bridgeCapabilities).not.toContain("customProbe");
      const observed = opened.snapshot as PlaytestSnapshot;
      expect(observed.media).toMatchObject([{ elementId: "intro", source: "/media/intro.mp4", currentTime: 1.2, errorCode: null,
        networkState: 1, videoWidth: 1280, videoHeight: 720, totalVideoFrames: 29, droppedVideoFrames: 2, buffered: [{ start: 0, end: 5 }] }]);
      expect(JSON.stringify(observed.media)).not.toContain("private=query");
      expect(driver.capabilities.deterministic).toEqual([]); // Other sessions do not inherit this page's bridge.
    } finally { driver.close(); await dom.happyDOM.close(); }
  });

  it("keeps watched sessions independent and resizable", async () => {
    const driver = new ElectronPlaytestDriver();
    driver.setVisible(true);
    await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/" },
      viewport: { width: 800, height: 600 },
    });

    expect(electron.windows[0]?.options.parent).toBeUndefined();
    expect(electron.windows[0]?.options).toMatchObject({
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      minWidth: 240,
      minHeight: 240,
    });
    driver.close();
  });

  it("reveals loaded sessions without focusing and hides them without closing", async () => {
    const states: Array<{ visible: boolean; activeSessions: number }> = [];
    const driver = new ElectronPlaytestDriver((state) => states.push(state));
    driver.setVisible(true);
    const opened = await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/" },
      viewport: { width: 800, height: 600 },
    });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(driver.watchState()).toEqual({ visible: true, activeSessions: 1 });

    const closeEvent = { preventDefault: vi.fn() };
    window.closeHandler?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(false);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 1 });

    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(window.destroyed).toBe(true);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 0 });
    expect(states).toContainEqual({ visible: true, activeSessions: 1 });
    expect(states.at(-1)).toEqual({ visible: false, activeSessions: 0 });
  });

  it("closes sessions the agent leaves idle", async () => {
    vi.useFakeTimers();
    try {
      const driver = new ElectronPlaytestDriver(undefined, 1_000);
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw new Error("Expected open result");
      const window = electron.windows[0]!;

      vi.advanceTimersByTime(900);
      await driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId });
      vi.advanceTimersByTime(900);
      expect(window.destroyed).toBe(false);
      expect(driver.watchState().activeSessions).toBe(1);
      const executed = window.webContents.executeJavaScript.mock.calls.length;
      await expect(driver.request({ operation: "sessionStatus", sessionId: opened.snapshot.sessionId })).resolves.toMatchObject({ resourceStatus: "live" });
      expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(executed);

      vi.advanceTimersByTime(100);
      expect(window.destroyed).toBe(true);
      expect(driver.watchState().activeSessions).toBe(0);
      await expect(driver.request({ operation: "sessionStatus", sessionId: opened.snapshot.sessionId })).resolves.toMatchObject({ resourceStatus: "closed" });
      await expect(driver.request({ operation: "sessionStatus", sessionId: "unrecognized" })).resolves.toMatchObject({ resourceStatus: "unknown" });
      await expect(driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId })).rejects.toThrow("Game session not found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves watched sessions across idle deadlines and reclaims them after hiding", async () => {
    vi.useFakeTimers();
    const driver = new ElectronPlaytestDriver(undefined, 1_000);
    try {
      await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      const window = electron.windows[0]!;
      driver.setVisible(true);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.destroyed).toBe(false); expect(driver.watchState().activeSessions).toBe(1);
      driver.setVisible(false);
      await vi.advanceTimersByTimeAsync(999); expect(window.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(window.destroyed).toBe(true);
    } finally { driver.close(); vi.useRealTimers(); }
  });

  it("does not expire an active tool request, then reclaims the hidden session", async () => {
    vi.useFakeTimers();
    const driver = new ElectronPlaytestDriver(undefined, 1_000);
    try {
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw Error("Expected open result");
      const pending = driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "wait", milliseconds: 1_500 }] });
      await vi.advanceTimersByTimeAsync(1_100); expect(electron.windows[0]!.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(400); await pending;
      await vi.advanceTimersByTimeAsync(999); expect(electron.windows[0]!.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(electron.windows[0]!.destroyed).toBe(true);
    } finally { driver.close(); vi.useRealTimers(); }
  });

  it("stops the idle timer when a session is closed", async () => {
    vi.useFakeTimers();
    try {
      const driver = new ElectronPlaytestDriver(undefined, 1_000);
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw new Error("Expected open result");
      await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes hidden sessions between requests, including errors and cancellation", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const lifecycle = () => window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState");
    expect(lifecycle().at(-1)?.parameters).toEqual({ state: "frozen" });
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);

    await driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId });
    expect(lifecycle().slice(-2).map(({ parameters }) => parameters)).toEqual([{ state: "active" }, { state: "frozen" }]);
    await expect(driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "wait", milliseconds: -1 }] })).rejects.toThrow("waits must");
    expect(lifecycle().at(-1)?.parameters).toEqual({ state: "frozen" });

    const controller = new AbortController();
    const pending = driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "wait", milliseconds: 5_000 }] }, controller.signal);
    controller.abort(new Error("Cancelled test"));
    await expect(pending).rejects.toThrow("Cancelled test");
    expect(lifecycle().at(-1)?.parameters).toEqual({ state: "frozen" });
    expect(window.loadURL).toHaveBeenCalledOnce();
    driver.close();
  });

  it("keeps overlapping requests running until the last request completes", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    let finish!: (value: InstanceType<typeof electron.FakeImage>) => void;
    window.webContents.capturePage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const capture = driver.request({ operation: "capture", sessionId: opened.snapshot.sessionId });
    await vi.waitFor(() => expect(window.webContents.capturePage).toHaveBeenCalledOnce());
    await driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId });
    expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "active" });
    expect(window.debugger.commands.at(-1)).toEqual({ method: "Emulation.setFocusEmulationEnabled", parameters: { enabled: true } });
    expect(window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    finish(new electron.FakeImage());
    await capture;
    expect(window.debugger.commands.at(-1)?.parameters).toEqual({ state: "frozen" });
    driver.close();
  });

  it.each(["snapshot", "bridge", "capture"] as const)("suspends a cancelled pending %s without waiting for game code", async (kind) => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const unresolved = new Promise<never>(() => {});
    const called = vi.fn(() => unresolved);
    if (kind === "capture") window.webContents.capturePage.mockImplementationOnce(called);
    else window.webContents.executeJavaScript.mockImplementationOnce(called);
    const controller = new AbortController();
    const sessionId = opened.snapshot.sessionId;
    const pending = driver.request(kind === "bridge"
      ? { operation: "act", sessionId, actions: [{ type: "bridge", method: "reset" }] }
      : { operation: kind === "snapshot" ? "inspect" : "capture", sessionId }, controller.signal);
    await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
    controller.abort(new Error("Cancel stalled request"));
    await expect(pending).rejects.toThrow("Cancel stalled request");
    expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "frozen" });
    expect(window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    await expect(driver.request({ operation: "inspect", sessionId })).resolves.toMatchObject({ operation: "inspect" });
    driver.close();
  });

  it("resumes watched windows and suspends hidden or minimized windows without reloading", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    driver.setVisible(true);
    await vi.waitFor(() => expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "active" }));
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(window.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    window.minimized = true;
    window.emit("minimize");
    await vi.waitFor(() => expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "frozen" }));
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    driver.setVisible(true);
    await vi.waitFor(() => expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "active" }));
    expect(window.restore).toHaveBeenCalledOnce();
    driver.setVisible(false);
    await vi.waitFor(() => expect(window.debugger.commands.filter(({ method }) => method === "Page.setWebLifecycleState").at(-1)?.parameters).toEqual({ state: "frozen" }));
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(window.loadURL).toHaveBeenCalledOnce();
    driver.close();
  });

  it("blocks navigation and redirects away from the preview origin", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const sameOrigin = { preventDefault: vi.fn() };
    const external = { preventDefault: vi.fn() };

    window.navigateHandler?.(sameOrigin, "http://127.0.0.1:43123/level-2");
    window.navigateHandler?.(external, "https://example.com/");
    const externalRedirect = { preventDefault: vi.fn() };
    window.redirectHandler?.(externalRedirect, "https://example.com/redirected");

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    expect(external.preventDefault).toHaveBeenCalledOnce();
    expect(externalRedirect.preventDefault).toHaveBeenCalledOnce();
    driver.close();
  });

  it("allows only same-origin main-frame game input permissions", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const check = window.session.permissionCheckHandler!;
    const request = window.session.permissionHandler!;
    const localMainFrame = { requestingUrl: "http://127.0.0.1:43123/game", isMainFrame: true };

    expect(check(window.webContents, "pointerLock", "http://127.0.0.1:43123", localMainFrame)).toBe(true);
    expect(check(window.webContents, "pointerLock", "https://example.com", { requestingUrl: "https://example.com", isMainFrame: true })).toBe(false);
    expect(check(window.webContents, "fullscreen", "http://127.0.0.1:43123", localMainFrame)).toBe(false);

    const pointerLock = vi.fn();
    const keyboardLock = vi.fn();
    const crossOrigin = vi.fn();
    request(window.webContents, "pointerLock", pointerLock, localMainFrame);
    request(window.webContents, "keyboardLock", keyboardLock, localMainFrame);
    request(window.webContents, "pointerLock", crossOrigin, { requestingUrl: "https://example.com", isMainFrame: true });
    expect(pointerLock).toHaveBeenCalledWith(true);
    expect(keyboardLock).toHaveBeenCalledWith(true);
    expect(crossOrigin).toHaveBeenCalledWith(false);
    driver.close();
  });

  it("keeps session callbacks safe after the window is destroyed", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const contents = window.webContents;
    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(window.destroyed).toBe(true);

    const mainFrame = { requestingUrl: "http://127.0.0.1:43123/", isMainFrame: true };
    expect(window.session.permissionCheckHandler!(contents, "pointerLock", "http://127.0.0.1:43123", mainFrame)).toBe(true);
    const callback = vi.fn();
    window.session.permissionHandler!(contents, "pointerLock", callback, mainFrame);
    expect(callback).toHaveBeenCalledWith(true);
    expect(() => window.session.requestErrorHandler!({ webContentsId: contents.id, url: "http://127.0.0.1:43123/a.png", error: "net::ERR_FAILED", timestamp: Date.now() })).not.toThrow();
  });

  it("closes a session whose window is destroyed before the closed event", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    // Keep the session registered until Electron delivers the closed event.
    window.destroyed = true;
    expect(driver.watchState().activeSessions).toBe(1);

    await expect(driver.request({ operation: "close", sessionId: opened.snapshot.sessionId })).resolves.toEqual({ operation: "close", resourceStatus: "closed" });
    expect(driver.watchState().activeSessions).toBe(0);
    expect(window.debugger.isAttached).not.toHaveBeenCalled();
    expect(window.debugger.detach).not.toHaveBeenCalled();
    window.closedHandler?.();
    expect(driver.watchState().activeSessions).toBe(0);
  });

  it("bounds retained browser sessions", async () => {
    const driver = new ElectronPlaytestDriver();
    const sessionIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await driver.request({ operation: "open", target: { runtime: "web", url: `http://127.0.0.1:43123/${index}` }, viewport: { width: 800, height: 600 } });
      if (result.operation !== "open") throw new Error("Expected open result");
      sessionIds.push(result.snapshot.sessionId);
    }

    const failure = await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/overflow" },
      viewport: { width: 800, height: 600 },
    }).catch(error => error);
    expect(failure.message).toContain("Close an existing game session");
    expect(getPlaytestOpenFailure(failure)).toEqual({ version: 1, reason: "session_limit", limit: 4, windowCreated: false });
    expect(electron.windows).toHaveLength(4);
    expect(electron.windows.every(window => !window.destroyed)).toBe(true);
    await driver.request({ operation: "close", sessionId: sessionIds[0]! });
    await expect(driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/recovered" }, viewport: { width: 800, height: 600 } })).resolves.toMatchObject({ operation: "open" });
    expect(driver.watchState().activeSessions).toBe(4);
    expect(electron.windows.slice(1).every(window => !window.destroyed)).toBe(true);
    driver.close();
  });

  it("dispatches semantic actions through CDP and returns fresh state", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://localhost:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const result = await driver.request({
      operation: "act",
      sessionId: opened.snapshot.sessionId,
      actions: [
        { type: "click", target: { role: "button", name: "Start" } },
        { type: "type", target: { testId: "player-name" }, text: "Ada" },
        { type: "press", key: "Enter", duration: 1 },
        { type: "touch", x: 40, y: 60 },
        { type: "resize", viewport: { width: 390, height: 844 } },
        { type: "bridge", method: "setSeed", value: 7 },
      ],
    });

    expect(result.operation).toBe("act");
    expect(electron.windows[0]?.debugger.commands.filter(({ method }) => method.startsWith("Input.")).map(({ method }) => method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchTouchEvent", "Input.dispatchTouchEvent",
    ]);
    expect(electron.windows[0]?.setContentSize).toHaveBeenCalledWith(390, 844);
    driver.close();
  });

  it("changes only pixel density in the running game and rejects invalid ratios before applying them", async () => {
    const driver = new ElectronPlaytestDriver();
    const viewport = { width: 800, height: 600 };
    const opened = await driver.request({
      operation: "open", target: { runtime: "web", url: "http://localhost:43123/" }, viewport: { ...viewport, deviceScaleFactor: 1 },
    });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const resize = (deviceScaleFactor: number) => driver.request({
      operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "resize", viewport: { ...viewport, deviceScaleFactor } }],
    });
    await resize(2);
    await resize(1);
    await expect(resize(NaN)).rejects.toThrow("deviceScaleFactor");
    const window = electron.windows[0]!;
    expect(window.debugger.commands.filter(({ method }) => method === "Emulation.setDeviceMetricsOverride")).toEqual([1, 2, 1].map(deviceScaleFactor => ({
      method: "Emulation.setDeviceMetricsOverride", parameters: { width: 0, height: 0, mobile: false, deviceScaleFactor },
    })));
    expect(window.setContentSize).not.toHaveBeenCalled();
    expect(window.loadURL.mock.calls.map(([url]) => url)).toEqual(["about:blank", "http://localhost:43123/?ohmygamePlaytest=1"]);
    driver.close();
  });

  it("sends physical codes for letter and digit keys and releases a cancelled hold", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    await driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "press", key: "w" }, { type: "press", key: "2" }] });
    const window = electron.windows[0]!;
    const keys = () => window.debugger.commands.filter(({ method }) => method === "Input.dispatchKeyEvent").map(({ parameters }) => parameters);
    expect(keys()).toEqual([
      { type: "keyDown", key: "w", code: "KeyW", text: "w" }, { type: "keyUp", key: "w", code: "KeyW", text: "w" },
      { type: "keyDown", key: "2", code: "Digit2", text: "2" }, { type: "keyUp", key: "2", code: "Digit2", text: "2" },
    ]);
    const controller = new AbortController();
    const held = driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "press", key: "d", duration: 5_000 }] }, controller.signal);
    await vi.waitFor(() => expect(keys().at(-1)).toMatchObject({ type: "keyDown", code: "KeyD" }));
    controller.abort();
    await expect(held).rejects.toThrow("aborted");
    expect(keys().at(-1)).toMatchObject({ type: "keyUp", code: "KeyD" });
    expect(window.debugger.commands.at(-1)?.parameters).toEqual({ state: "frozen" });
    driver.close();
  });

  it("reads and clicks content inside scaled child frames", async () => {
    const driver = new ElectronPlaytestDriver();
    const opening = driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    window.frameBoxes = [{ url: "about:srcdoc", x: 100, y: 50, scaleX: 0.5, scaleY: 0.5 }];
    const video = { tag: "video", source: "/media/opening.mp4", readyState: 4, currentTime: 1.2, duration: 4, paused: false, ended: false, errorCode: null, totalVideoFrames: 33 };
    window.session.requestErrorHandler!({ webContentsId: window.webContents.id, url: "http://127.0.0.1:43123/media/opening.mp4", error: "net::ERR_FAILED", timestamp: Date.now() });
    window.childFrames.push({
      url: "about:srcdoc",
      executeJavaScript: async (script: string) => script.includes("box.x + box.width / 2")
        ? { x: 30, y: 30 }
        : {
            elements: [{ index: 0, tag: "button", role: "button", name: "Take the train", text: "Take the train", enabled: true, box: { x: 10, y: 20, width: 40, height: 20 } }],
            text: "Platform 9 Take the train",
            media: [video],
          },
    });
    const opened = await opening;
    if (opened.operation !== "open") throw new Error("Expected open result");
    const snapshot = opened.snapshot as PlaytestSnapshot;

    expect(snapshot.elements).toEqual([
      expect.objectContaining({ index: 0, name: "Take the train", box: { x: 105, y: 60, width: 20, height: 10 } }),
    ]);
    expect(snapshot.text).toBe("Platform 9 Take the train");
    expect(snapshot.media).toEqual([video]);
    expect(snapshot.failedRequests[0]?.error).toBe("net::ERR_FAILED");

    await driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "click", target: { text: "Take the train" } }] });
    expect(window.debugger.commands.find(({ method }) => method === "Input.dispatchMouseEvent")).toMatchObject({ method: "Input.dispatchMouseEvent", parameters: { type: "mouseMoved", x: 115, y: 65 } });
    driver.close();
  });

  it("returns screenshots with bounded pixel analysis", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const result = await driver.request({ operation: "capture", sessionId: opened.snapshot.sessionId });

    expect(result).toMatchObject({
      operation: "capture",
      capture: {
        mediaType: "image/jpeg",
        data: Buffer.from("jpeg:2x1:80").toString("base64"),
        width: 2,
        height: 1,
        analysis: { sampledPixels: 2, opaqueRatio: 1, likelyBlank: false },
      },
    });
    driver.close();
  });

  it("scales high-DPI screenshots to CSS pixels and keeps their aspect ratio", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 1200, height: 800 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0];
    const retina = new electron.FakeImage(2400, 1601);
    window.webContents.capturePage.mockResolvedValueOnce(retina);
    const result = await driver.request({ operation: "capture", sessionId: opened.snapshot.sessionId });

    expect(retina.resize).toHaveBeenCalledWith({ width: 1200, height: 801, quality: "best" });
    expect(retina.toBitmap).toHaveBeenCalled();
    expect(result).toMatchObject({
      operation: "capture",
      capture: { mediaType: "image/jpeg", data: Buffer.from("jpeg:1200x801:80").toString("base64"), width: 1200, height: 801 },
    });
    driver.close();
  });
});

describe("playtest validation", () => {
  it("rejects non-local and credentialed URLs", () => {
    expect(() => validatedPlaytestUrl("https://127.0.0.1/game")).toThrow("local HTTP");
    expect(() => validatedPlaytestUrl("http://example.com/game")).toThrow("local HTTP");
    expect(() => validatedPlaytestUrl("http://user:pass@localhost/game")).toThrow("local HTTP");
  });

  it("detects flat frames while retaining useful metrics", () => {
    expect(analyzeBitmap(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1)).toEqual({
      sampledPixels: 2,
      opaqueRatio: 1,
      luminanceMean: 0,
      luminanceVariance: 0,
      likelyBlank: true,
    });
  });
});
