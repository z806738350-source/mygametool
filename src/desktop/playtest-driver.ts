import { randomUUID } from "node:crypto";
import { restrictLocalGameNetwork } from "./game-network.js";
import { BrowserWindow, type NativeImage, type WebFrameMain } from "electron";
import {
  WEB_GAME_USE_CAPABILITIES,
  playtestActionError,
  playtestOpenError,
  type GameRuntimeAdapter,
  type GameUseOpenTarget,
  type PlaytestAction,
  type PlaytestCapture,
  type PlaytestElement,
  type PlaytestFailedRequest,
  type PlaytestLog,
  type PlaytestRequest,
  type PlaytestResourceStatus,
  type PlaytestResult,
  type PlaytestSnapshot,
  type PlaytestTarget,
  type PlaytestViewport,
  type PlaytestWatchState,
} from "../shared/playtest.js";

interface PlaytestSession {
  id: string;
  origin: string;
  window: BrowserWindow;
  ready: boolean;
  logs: PlaytestLog[];
  failedRequests: PlaytestFailedRequest[];
  idleTimer?: ReturnType<typeof setTimeout>;
  activeRequests: number;
  activity: Promise<void>;
  running: boolean;
}

/** A frame of the page and how its coordinates map to the window's. */
interface PlaytestFrame {
  frame: WebFrameMain;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

type FrameElements = Pick<PlaytestSnapshot, "elements" | "media"> & { text: string };

const MAX_LOGS = 100;
const MAX_FAILED_REQUESTS = 100;
const MAX_SESSIONS = 4;
/** Hidden sessions the agent leaves open are closed after this long without a request. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_ELEMENTS = 100;
const MAX_MEDIA = 16;
const MAX_TEXT = 4_000;
/** Screenshots are resent with every later model request, so keep them small. */
const CAPTURE_JPEG_QUALITY = 80;

class TargetLookupError extends Error {}
class SessionUnavailableError extends Error {}

export class ElectronPlaytestDriver implements GameRuntimeAdapter {
  readonly available = true;
  readonly capabilities = WEB_GAME_USE_CAPABILITIES;
  readonly #sessions = new Map<string, PlaytestSession>();
  readonly #closingSessions = new Set<string>();
  readonly #closedSessions = new Set<string>();
  #visible = false;

  constructor(
    private readonly onWatchStateChange?: (state: PlaytestWatchState) => void,
    private readonly idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {}

  watchState(): PlaytestWatchState {
    return { visible: this.#visible, activeSessions: this.#sessions.size };
  }

  setVisible(visible: boolean): PlaytestWatchState {
    this.#visible = visible;
    for (const state of this.#sessions.values()) {
      if (state.window.isDestroyed() || !state.ready) continue;
      if (visible) {
        if (state.window.isMinimized()) state.window.restore();
        state.window.showInactive();
      } else {
        state.window.hide();
      }
      this.#visibilityChanged(state);
    }
    return this.#publishWatchState();
  }

  async request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    signal?.throwIfAborted();
    switch (request.operation) {
      case "open": return { operation: "open", snapshot: await this.#open(request.target, request.viewport, signal) };
      case "inspect": return this.#withSession(request.sessionId, async (state) => ({ operation: "inspect", snapshot: await this.#inspect(state, signal) }));
      case "act": return this.#actRequest(request.sessionId, request.actions, signal);
      case "capture": return this.#withSession(request.sessionId, async (state) => ({ operation: "capture", capture: await this.#capture(state, signal) }));
      case "sessionStatus": return { operation: "sessionStatus", sessionId: request.sessionId, resourceStatus: this.#resourceStatus(request.sessionId) };
      case "close":
        this.#close(request.sessionId);
        return { operation: "close", resourceStatus: this.#resourceStatus(request.sessionId) };
      case "closeAll":
        this.close();
        return { operation: "closeAll" };
    }
  }

  close(): void {
    for (const id of [...this.#sessions.keys()]) this.#close(id);
  }

  async #open(target: GameUseOpenTarget, viewport: PlaytestViewport, signal?: AbortSignal): Promise<PlaytestSnapshot> {
    if (target.runtime !== "web") throw new Error(`Electron game use does not support the ${target.runtime} runtime`);
    const url = validatedPlaytestUrl(target.url);
    validateViewport(viewport);
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw playtestOpenError(`Close an existing game session before opening more than ${MAX_SESSIONS}`, {
        version: 1, reason: "session_limit", limit: MAX_SESSIONS, windowCreated: false,
      });
    }
    url.searchParams.set("ohmygamePlaytest", "1");
    const id = randomUUID();
    const window = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      show: false,
      title: "Agent Playtest - View only",
      autoHideMenuBar: true,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      minWidth: 240,
      minHeight: 240,
      backgroundColor: "#000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `ohmygame-playtest-${id}`,
      },
    });
    const state: PlaytestSession = { id, origin: url.origin, window, ready: false, logs: [], failedRequests: [], activeRequests: 1, activity: Promise.resolve(), running: true };
    // Agent sessions are silent unless the user is watching their visible window.
    window.webContents.setAudioMuted(true);
    restrictLocalGameNetwork(window.webContents, () => state.origin);
    this.#sessions.set(id, state);
    this.#resetIdleTimer(state);
    this.#publishWatchState();
    window.on("close", (event) => {
      if (this.#closingSessions.has(id)) return;
      event.preventDefault();
      this.setVisible(false);
    });
    window.on("show", () => this.#visibilityChanged(state));
    window.on("hide", () => this.#visibilityChanged(state));
    window.on("minimize", () => this.#visibilityChanged(state));
    window.on("restore", () => this.#visibilityChanged(state));
    window.once("closed", () => {
      clearTimeout(state.idleTimer);
      this.#closingSessions.delete(id);
      this.#rememberClosed(id);
      if (this.#sessions.delete(id)) this.#publishWatchState();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const preventCrossOriginNavigation = (event: { preventDefault(): void }, destination: string) => {
      if (!sameOrigin(destination, state.origin)) event.preventDefault();
    };
    window.webContents.on("will-navigate", preventCrossOriginNavigation);
    window.webContents.on("will-redirect", preventCrossOriginNavigation);
    window.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.on("console-message", (details) => {
      state.logs.push({
        level: details.level,
        message: truncate(details.message, 4_000),
        ...(details.sourceId ? { source: details.sourceId } : {}),
        ...(details.lineNumber ? { line: details.lineNumber } : {}),
        timestamp: new Date().toISOString(),
      });
      if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    });
    // The session outlives the window, and reading `window.webContents` after the window is destroyed throws.
    const webContents = window.webContents;
    const webContentsId = webContents.id;
    webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const requestingUrl = details.requestingUrl ?? requestingOrigin;
      return contents === webContents && permission === "pointerLock" && details.isMainFrame &&
        sameOrigin(requestingUrl, state.origin);
    });
    webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === webContents && (permission === "pointerLock" || permission === "keyboardLock") &&
        details.isMainFrame && sameOrigin(details.requestingUrl, state.origin));
    });
    webContents.session.on("will-download", (event) => event.preventDefault());
    webContents.session.webRequest.onErrorOccurred((details) => {
      if (details.webContentsId !== undefined && details.webContentsId !== webContentsId) return;
      state.failedRequests.push({
        url: details.url,
        error: details.error,
        timestamp: new Date(details.timestamp).toISOString(),
      });
      if (state.failedRequests.length > MAX_FAILED_REQUESTS) {
        state.failedRequests.splice(0, state.failedRequests.length - MAX_FAILED_REQUESTS);
      }
    });

    try {
      window.webContents.debugger.attach("1.3");
      if (viewport.deviceScaleFactor !== undefined) {
        // Chromium needs a live renderer to acknowledge metrics before the game's first script runs.
        await abortableResult(window.loadURL("about:blank"), signal);
        await setPixelRatio(window, viewport.deviceScaleFactor);
      }
      await abortableResult(window.loadURL(url.href), signal);
      signal?.throwIfAborted();
      state.ready = true;
      if (this.#visible) window.showInactive();
      const snapshot = await this.#inspect(state, signal);
      state.activeRequests--;
      this.#resetIdleTimer(state);
      await this.#updateActivity(state);
      return snapshot;
    } catch (cause) {
      this.#close(id);
      throw cause;
    }
  }

  async #inspect(state: PlaytestSession, signal?: AbortSignal): Promise<PlaytestSnapshot> {
    signal?.throwIfAborted();
    this.#assertLive(state);
    const page = await abortableResult(state.window.webContents.executeJavaScript(PAGE_INSPECTION_SCRIPT, true), signal) as Omit<PlaytestSnapshot, "sessionId" | "logs" | "failedRequests">;
    // Content in child frames, such as the sandbox that runs Playable Nodes,
    // is listed in window coordinates after the page's own.
    const elements = [...page.elements];
    const media = [...(page.media ?? [])];
    const text = page.text ? [page.text] : [];
    for (const child of (await this.#frames(state, signal)).slice(1)) {
      const found = await abortableResult(child.frame.executeJavaScript(FRAME_INSPECTION_SCRIPT, true), signal).catch(() => undefined) as FrameElements | undefined;
      if (!found) continue;
      for (const element of found.elements) {
        if (elements.length >= MAX_ELEMENTS) break;
        elements.push({ ...element, index: elements.length, box: frameBox(child, element.box) });
      }
      if (found.text) text.push(found.text);
      if (found.media) media.push(...found.media.slice(0, MAX_MEDIA - media.length));
    }
    signal?.throwIfAborted();
    const visibleText = text.join("\n").slice(0, MAX_TEXT);
    return {
      ...page,
      elements,
      ...(media.length ? { media } : {}),
      ...(visibleText ? { text: visibleText } : {}),
      sessionId: state.id,
      runtime: this.capabilities.runtime,
      capabilities: { ...this.capabilities, deterministic: (page.bridgeCapabilities ?? []).flatMap(method =>
        method === "setSeed" ? ["seed" as const] : method === "snapshot" || method === "reset" || method === "step" ? [method] : []) },
      logs: [...state.logs],
      failedRequests: [...state.failedRequests],
    };
  }

  async #actRequest(sessionId: string, actions: PlaytestAction[], signal?: AbortSignal): Promise<PlaytestResult> {
    let started = false;
    try {
      return await this.#withSession(sessionId, async state => {
        started = true;
        return { operation: "act", snapshot: await this.#act(state, actions, signal) };
      });
    } catch (cause) {
      if (started || signal?.aborted || !actions[0]) throw cause;
      throw playtestActionError("Game session could not accept input", { version: 1, sessionId,
        completedActions: 0, failedAction: 1, actionType: actions[0].type, phase: "session_unavailable", inputDispatched: false });
    }
  }

  async #act(state: PlaytestSession, actions: PlaytestAction[], signal?: AbortSignal): Promise<PlaytestSnapshot> {
    if (actions.length < 1 || actions.length > 20) throw new Error("Provide 1 to 20 playtest actions");
    for (const [index, action] of actions.entries()) {
      signal?.throwIfAborted();
      try {
        this.#assertLive(state);
        await this.#runAction(state, action, signal);
      }
      catch (cause) {
        signal?.throwIfAborted();
        if (cause instanceof SessionUnavailableError) {
          throw playtestActionError(cause.message, { version: 1, sessionId: state.id,
            completedActions: index, failedAction: index + 1, actionType: action.type, phase: "session_unavailable", inputDispatched: false });
        }
        if (action.type === "click" && cause instanceof TargetLookupError) {
          throw playtestActionError(`Action ${index + 1} (click) failed: ${cause.message}`, {
            version: 1, sessionId: state.id, completedActions: index, failedAction: index + 1, actionType: "click",
            phase: "target_lookup", inputDispatched: false,
          });
        }
        throw playtestActionError(`Action ${index + 1} (${action.type}) failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
          version: 1, sessionId: state.id, completedActions: index, failedAction: index + 1, actionType: action.type,
          phase: "action", inputDispatched: "unknown",
        });
      }
    }
    return this.#inspect(state, signal);
  }

  async #runAction(state: PlaytestSession, action: PlaytestAction, signal?: AbortSignal): Promise<void> {
    const debuggerApi = state.window.webContents.debugger;
    switch (action.type) {
      case "click": {
        const point = await this.#targetPoint(state, action.target, signal).catch(cause => {
          this.#assertLive(state);
          throw cause;
        });
        this.#assertLive(state);
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await abortableDelay(50, signal);
        return;
      }
      case "type": {
        const target = JSON.stringify(action.target);
        let focused = false;
        for (const frame of await this.#frames(state, signal)) {
          focused = await abortableResult(frame.frame.executeJavaScript(`(${FOCUS_TARGET_SCRIPT})(${target})`, true), signal).catch(() => false) === true;
          if (focused) break;
        }
        this.#assertLive(state);
        if (!focused) throw new Error("Playtest target was not found or is not editable");
        await debuggerApi.sendCommand("Input.insertText", { text: action.text });
        await abortableDelay(50, signal);
        return;
      }
      case "press": {
        const event = keyboardEvent(action.key);
        const duration = action.duration ?? 0;
        if (!Number.isInteger(duration) || duration < 0 || duration > 5_000) {
          throw new Error("Playtest key holds must be between 0 and 5000ms");
        }
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...event });
        try {
          await abortableDelay(duration, signal);
        } finally {
          await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...event });
        }
        await abortableDelay(50, signal);
        return;
      }
      case "touch":
        await debuggerApi.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: action.x, y: action.y }] });
        await debuggerApi.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await abortableDelay(50, signal);
        return;
      case "wait":
        if (!Number.isInteger(action.milliseconds) || action.milliseconds < 0 || action.milliseconds > 5_000) {
          throw new Error("Playtest waits must be between 0 and 5000ms");
        }
        await abortableDelay(action.milliseconds, signal);
        return;
      case "resize": {
        validateViewport(action.viewport);
        const { width, height, deviceScaleFactor } = action.viewport;
        const [currentWidth, currentHeight] = state.window.getContentSize();
        if (width !== currentWidth || height !== currentHeight) state.window.setContentSize(width, height);
        if (deviceScaleFactor !== undefined) await setPixelRatio(state.window, deviceScaleFactor);
        await abortableDelay(100, signal);
        return;
      }
      case "bridge": {
        const value = "value" in action ? action.value : undefined;
        const result = await abortableResult(state.window.webContents.executeJavaScript(`(${BRIDGE_ACTION_SCRIPT})(${JSON.stringify(action.method)}, ${JSON.stringify(value)})`, true), signal);
        if (result !== true) throw new Error(`The game playtest bridge does not support ${action.method}`);
        await abortableDelay(50, signal);
      }
    }
  }

  async #targetPoint(state: PlaytestSession, target: PlaytestTarget, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    if ("x" in target) return checkedPoint(target);
    const points: { x: number; y: number }[] = [];
    for (const frame of await this.#frames(state, signal)) {
      const point = await abortableResult(frame.frame.executeJavaScript(`(${TARGET_POINT_SCRIPT})(${JSON.stringify(target)})`, true), signal).catch(() => undefined) as unknown;
      if (point && typeof point === "object") {
        if ("targetError" in point && ["ambiguous", "disabled"].includes(String(point.targetError))) throw new TargetLookupError(point.targetError === "ambiguous"
          ? "Multiple visible playtest targets match. Inspect the session and use a unique selector or testId."
          : "The playtest target is disabled. Inspect the session before continuing.");
        const { x, y } = point as { x: number; y: number };
        points.push(checkedPoint({ x: frame.x + x * frame.scaleX, y: frame.y + y * frame.scaleY }));
      }
    }
    if (points.length > 1) throw new TargetLookupError("Multiple visible playtest targets match across frames. Inspect the session and use a unique selector or testId.");
    if (points.length) return points[0]!;
    throw new TargetLookupError("Playtest target was not found or is not visible");
  }

  /**
   * The main frame and its direct child frames. Each child is matched to its
   * iframe element to find where, and at what scale, it is drawn.
   */
  async #frames(state: PlaytestSession, signal?: AbortSignal): Promise<PlaytestFrame[]> {
    const main = state.window.webContents.mainFrame;
    const frames: PlaytestFrame[] = [{ frame: main, x: 0, y: 0, scaleX: 1, scaleY: 1 }];
    const children = main.frames;
    if (!children.length) return frames;
    const boxes = await abortableResult(main.executeJavaScript(IFRAME_BOXES_SCRIPT, true), signal) as { url: string; x: number; y: number; scaleX: number; scaleY: number }[];
    const unmatched = new Set(boxes.keys());
    for (const frame of children) {
      const index = [...unmatched].find((candidate) => boxes[candidate]!.url === frame.url) ?? [...unmatched][0];
      if (index === undefined) break;
      unmatched.delete(index);
      const { x, y, scaleX, scaleY } = boxes[index]!;
      frames.push({ frame, x, y, scaleX, scaleY });
    }
    return frames;
  }

  async #capture(state: PlaytestSession, signal?: AbortSignal): Promise<PlaytestCapture> {
    signal?.throwIfAborted();
    this.#assertLive(state);
    const image = await abortableResult(state.window.webContents.capturePage(), signal);
    signal?.throwIfAborted();
    const screenshot = logicalSizeImage(image, state.window.getContentSize()[0]);
    const { width, height } = screenshot.getSize();
    return {
      sessionId: state.id,
      mediaType: "image/jpeg",
      data: screenshot.toJPEG(CAPTURE_JPEG_QUALITY).toString("base64"),
      width,
      height,
      analysis: analyzeNativeImage(image),
    };
  }

  #session(id: string): PlaytestSession {
    const state = this.#sessions.get(id);
    if (!state) throw new Error(`Game session not found: ${id}`);
    return state;
  }

  async #withSession<T>(id: string, operation: (state: PlaytestSession) => Promise<T>): Promise<T> {
    const state = this.#session(id);
    state.activeRequests++;
    this.#resetIdleTimer(state);
    try {
      await this.#updateActivity(state);
      return await operation(state);
    } finally {
      state.activeRequests--;
      if (this.#sessions.get(id) === state) {
        if (!state.activeRequests) this.#resetIdleTimer(state);
        await this.#updateActivity(state);
      }
    }
  }

  #visibilityChanged(state: PlaytestSession): void {
    this.#resetIdleTimer(state);
    void this.#updateActivity(state).catch((error) => {
      state.logs.push({ level: "error", message: `Could not update playtest activity: ${String(error)}`, timestamp: new Date().toISOString() });
      if (state.logs.length > MAX_LOGS) state.logs.shift();
    });
  }

  #updateActivity(state: PlaytestSession): Promise<void> {
    // Visibility events and concurrent tool requests must not freeze an active request.
    const next = state.activity.catch(() => {}).then(async () => {
      if (this.#sessions.get(state.id) !== state || state.window.isDestroyed()) return;
      const watched = this.#isWatched(state);
      const running = state.activeRequests > 0 || watched;
      const contents = state.window.webContents;
      contents.setAudioMuted(!watched);
      if (!running) {
        await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
        contents.setBackgroundThrottling(true);
      }
      if (running !== state.running) {
        await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: running ? "active" : "frozen" });
        state.running = running;
        // The bundled Chromium leaves thawed pages hidden; emulate visibility without focusing a native window.
        if (running) await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      }
      if (running) await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: state.activeRequests > 0 });
      contents.setBackgroundThrottling(state.activeRequests === 0);
    });
    state.activity = next;
    return next;
  }

  #resetIdleTimer(state: PlaytestSession): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (this.#sessions.get(state.id) !== state) return;
      if (state.activeRequests > 0 || this.#isWatched(state)) this.#resetIdleTimer(state);
      else this.#close(state.id);
    }, this.idleTimeoutMs);
  }

  #isWatched(state: PlaytestSession): boolean {
    return this.#visible && !state.window.isDestroyed() && state.window.isVisible() && !state.window.isMinimized();
  }

  #assertLive(state: PlaytestSession): void {
    if (state.window.isDestroyed() || state.window.webContents.isDestroyed()) {
      this.#sessions.delete(state.id);
      this.#rememberClosed(state.id);
      throw new SessionUnavailableError(`Game session is no longer available: ${state.id}`);
    }
    if (this.#closingSessions.has(state.id)) throw new SessionUnavailableError(`Game session is closing: ${state.id}`);
  }

  #close(id: string): void {
    const state = this.#sessions.get(id);
    if (!state) return;
    clearTimeout(state.idleTimer);
    const destroyed = state.window.isDestroyed();
    if (destroyed) this.#rememberClosed(id);
    else this.#closingSessions.add(id);
    this.#sessions.delete(id);
    this.#publishWatchState();
    if (!destroyed) {
      if (state.window.webContents.debugger.isAttached()) state.window.webContents.debugger.detach();
      state.window.destroy();
    }
  }

  #resourceStatus(id: string): PlaytestResourceStatus {
    if (this.#closingSessions.has(id)) return "closing";
    if (this.#closedSessions.has(id)) return "closed";
    const state = this.#sessions.get(id);
    if (!state) return "unknown";
    if (state.window.isDestroyed() || state.window.webContents.isDestroyed()) return "closed";
    return state.ready ? "live" : "unknown";
  }

  #rememberClosed(id: string): void {
    this.#closedSessions.add(id);
    if (this.#closedSessions.size > 64) this.#closedSessions.delete(this.#closedSessions.values().next().value!);
  }

  #publishWatchState(): PlaytestWatchState {
    const state = this.watchState();
    this.onWatchStateChange?.(state);
    return state;
  }
}

export function validatedPlaytestUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new Error("Game use only supports local HTTP preview URLs");
  }
  return url;
}

export function analyzeBitmap(bitmap: Uint8Array, width: number, height: number) {
  const pixels = Math.min(width * height, Math.floor(bitmap.length / 4));
  if (pixels < 1) return { sampledPixels: 0, opaqueRatio: 0, luminanceMean: 0, luminanceVariance: 0, likelyBlank: true };
  const stride = Math.max(1, Math.floor(pixels / 10_000));
  let sampledPixels = 0;
  let opaquePixels = 0;
  let luminanceSum = 0;
  let squaredSum = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const alpha = bitmap[offset + 3] ?? 0;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels++;
    if (alpha > 8) opaquePixels++;
    luminanceSum += luminance;
    squaredSum += luminance * luminance;
  }
  const luminanceMean = luminanceSum / sampledPixels;
  const luminanceVariance = Math.max(0, squaredSum / sampledPixels - luminanceMean * luminanceMean);
  const opaqueRatio = opaquePixels / sampledPixels;
  return {
    sampledPixels,
    opaqueRatio: rounded(opaqueRatio),
    luminanceMean: rounded(luminanceMean),
    luminanceVariance: rounded(luminanceVariance),
    likelyBlank: opaqueRatio < 0.01 || luminanceVariance < 1,
  };
}

/**
 * Scale a high-DPI capture down to the page's CSS pixels, so screenshot pixels match input
 * coordinates. The image's own aspect ratio is kept.
 */
function logicalSizeImage(image: NativeImage, contentWidth: number): NativeImage {
  const { width, height } = image.getSize();
  if (!(contentWidth > 0) || width <= contentWidth) return image;
  return image.resize({ width: contentWidth, height: Math.max(1, Math.round(height * contentWidth / width)), quality: "best" });
}

function analyzeNativeImage(image: NativeImage): PlaytestCapture["analysis"] {
  const { width, height } = image.getSize();
  return analyzeBitmap(image.toBitmap(), width, height);
}

function validateViewport(viewport: PlaytestViewport): void {
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 240 || viewport.width > 4096 || viewport.height < 240 || viewport.height > 4096) {
    throw new Error("Playtest viewport dimensions must be integers between 240 and 4096");
  }
  const ratio = viewport.deviceScaleFactor;
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < 1 || ratio > 2)) {
    throw new Error("Playtest deviceScaleFactor must be a number between 1 and 2");
  }
}

function setPixelRatio(window: BrowserWindow, deviceScaleFactor: number) {
  // Zero dimensions leave the CSS viewport under native window control, including manual watch-window resizes.
  return window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, mobile: false, deviceScaleFactor });
}

function sameOrigin(value: string, origin: string): boolean {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function frameBox(frame: PlaytestFrame, box: PlaytestElement["box"]): PlaytestElement["box"] {
  return {
    x: Math.round(frame.x + box.x * frame.scaleX),
    y: Math.round(frame.y + box.y * frame.scaleY),
    width: Math.round(box.width * frame.scaleX),
    height: Math.round(box.height * frame.scaleY),
  };
}

function checkedPoint(value: { x: number; y: number }): { x: number; y: number } {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x > 8192 || value.y > 8192) {
    throw new Error("Playtest coordinates must be between 0 and 8192");
  }
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function keyboardEvent(key: string): { key: string; code: string; text?: string } {
  if (!key || key.length > 40) throw new Error("Invalid playtest key");
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, text: key };
  const aliases: Record<string, string> = { " ": "Space", Escape: "Escape", Enter: "Enter", Tab: "Tab" };
  return { key, code: aliases[key] ?? key, ...(key.length === 1 ? { text: key } : {}) };
}

async function abortableResult<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  const abort = () => rejectAbort(signal.reason ?? new DOMException("Game use request aborted", "AbortError"));
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Game use request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done(new DOMException("Game use request aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    function done(error?: Error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const TARGET_HELPERS = String.raw`
const INTERACTIVE = "button, a, input, textarea, select, [role], [data-testid], [onclick], [tabindex]:not([tabindex=\"-1\"])";
const deepQueryAll = (selector) => {
  const found = [];
  const visit = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return found;
};
const roleFor = (element) => element.getAttribute("role") || ({
  A: "link", BUTTON: "button", INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox",
  SELECT: "combobox", TEXTAREA: "textbox",
}[element.tagName] || "");
const nameFor = (element) => element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.innerText || element.value || "";
const isVisible = (element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && (!element.checkVisibility || element.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
};
const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
const matches = (element, target) => {
  if (target.testId) return element.getAttribute("data-testid") === target.testId;
  if (target.text) { const text = normalizeText(target.text); return !!text && normalizeText(element.innerText || element.textContent).includes(text); }
  if (target.role) return roleFor(element) === target.role && (!target.name || normalizeText(nameFor(element)).includes(normalizeText(target.name)));
  return false;
};
const findTargets = (target) => {
  if (target.selector) { try { return deepQueryAll(target.selector).filter(isVisible); } catch { return []; } }
  return deepQueryAll(INTERACTIVE + ", canvas").filter((element) => isVisible(element) && matches(element, target));
};
const findTarget = (target) => { const candidates = findTargets(target); return candidates.length === 1 ? candidates[0] : null; };
const clean = (value, limit = 300) => normalizeText(value).slice(0, limit);
const listElements = () => deepQueryAll(INTERACTIVE)
  .filter(isVisible)
  .slice(0, 100)
  .map((element, index) => {
    const box = element.getBoundingClientRect();
    const role = roleFor(element);
    const name = clean(nameFor(element));
    const text = clean(element.innerText || element.textContent);
    const testId = element.getAttribute("data-testid") || "";
    return {
      index,
      tag: element.tagName.toLowerCase(),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(testId ? { testId } : {}),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
const visibleText = () => {
  const parts = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.shadowRoot) visit(node.shadowRoot);
        continue;
      }
      const parent = node.parentElement;
      const value = clean(node.textContent, 1000);
      if (value && parent && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName) && isVisible(parent)) parts.push(value);
    }
  };
  if (document.body) visit(document.body);
  return clean(parts.join(" "), 4000);
};`;

const TARGET_POINT_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const candidates = findTargets(target);
  if (candidates.length > 1) return { targetError: "ambiguous" };
  const element = candidates[0];
  if (!element) return null;
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { targetError: "disabled" };
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}`;

const FOCUS_TARGET_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const element = findTarget(target);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable)) return false;
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
  return true;
}`;

const BRIDGE_ACTION_SCRIPT = `async (method, value) => {
  const bridge = globalThis.__OHMYGAME_PLAYTEST__;
  if (!bridge || typeof bridge[method] !== "function") return false;
  await bridge[method](value);
  return true;
}`;

/** Where each iframe's content is drawn, including any CSS scale. */
const IFRAME_BOXES_SCRIPT = `(() => { ${TARGET_HELPERS}
  return deepQueryAll("iframe").map((frame) => {
    const box = frame.getBoundingClientRect();
    const scaleX = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? box.height / frame.offsetHeight : 1;
    return { url: frame.src, x: box.x + frame.clientLeft * scaleX, y: box.y + frame.clientTop * scaleY, scaleX, scaleY };
  });
})()`;

const MEDIA_INSPECTION = `const listMedia = () => deepQueryAll("video, audio").filter(element => element instanceof HTMLMediaElement).slice(0, ${MAX_MEDIA}).map(element => {
  const url = URL.parse(element.currentSrc || element.src);
  const quality = element.localName === "video" ? element.getVideoPlaybackQuality() : undefined;
  const buffered = element.buffered;
  return {
    tag: element.localName,
    source: url ? (url.protocol === "http:" || url.protocol === "https:" ? url.pathname.slice(0, 300) : url.protocol) : "",
    readyState: element.readyState, currentTime: element.currentTime,
    duration: Number.isFinite(element.duration) ? element.duration : null,
    paused: element.paused, ended: element.ended, errorCode: element.error?.code ?? null,
    networkState: element.networkState, elementId: element.id.slice(0, 200),
    buffered: Array.from({ length: Math.min(buffered.length, 16) }, (_, index) => ({ start: buffered.start(index), end: buffered.end(index) })),
    ...(quality ? { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames,
      videoWidth: element.videoWidth, videoHeight: element.videoHeight } : {}),
  };
});`;

const FRAME_INSPECTION_SCRIPT = `(() => { ${TARGET_HELPERS} ${MEDIA_INSPECTION}
  return { elements: listElements(), text: visibleText(), media: listMedia() };
})()`;

const PAGE_INSPECTION_SCRIPT = `(async () => { ${TARGET_HELPERS} ${MEDIA_INSPECTION}
  const elements = listElements();
  const canvases = Array.from(document.querySelectorAll("canvas")).map((canvas, index) => {
    const box = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    return {
      index,
      width: canvas.width,
      height: canvas.height,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0,
    };
  });
  const bridge = globalThis.__OHMYGAME_PLAYTEST__;
  const capabilities = bridge && typeof bridge === "object"
    ? ["snapshot", "reset", "setSeed", "step"].filter((name) => typeof bridge[name] === "function")
    : [];
  let gameState;
  if (capabilities.includes("snapshot")) {
    try { gameState = JSON.parse(JSON.stringify(await bridge.snapshot())); }
    catch (error) { gameState = { playtestBridgeError: error instanceof Error ? error.message : String(error) }; }
  }
  const text = visibleText();
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: window.devicePixelRatio },
    elements,
    canvases,
    media: listMedia(),
    ...(text ? { text } : {}),
    ...(gameState !== undefined ? { gameState } : {}),
    ...(capabilities.length ? { bridgeCapabilities: capabilities } : {}),
  };
})()`;
