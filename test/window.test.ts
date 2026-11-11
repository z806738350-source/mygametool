import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  windows: [] as unknown[],
  dark: false,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  cursorPoint: { x: 480, y: 320 },
  getDisplayNearestPoint: vi.fn(),
  openExternal: vi.fn(async () => {}),
  themeOn: vi.fn(),
  themeOff: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: { openExternal: electron.openExternal },
  nativeTheme: { get shouldUseDarkColors() { return electron.dark; }, on: electron.themeOn, off: electron.themeOff },
  screen: {
    getCursorScreenPoint: () => electron.cursorPoint,
    getDisplayNearestPoint: electron.getDisplayNearestPoint,
  },
  BrowserWindow: class {
    readonly options: Record<string, unknown>;
    readonly webContents = {
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.onWindowOpen = handler;
      }),
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
        if (event === "will-navigate") this.onNavigate = handler;
      }),
      setAudioMuted: vi.fn(),
      mainFrame: { url: "http://127.0.0.1:43120/" },
      ipc: {
        on: vi.fn((channel: string, handler: (event: { senderFrame: unknown; returnValue?: unknown }) => void) => {
          this.ipcHandlers.set(channel, handler);
        }),
      },
    };
    readonly ipcHandlers = new Map<string, (event: { senderFrame: unknown; returnValue?: unknown }) => void>();
    readonly once = vi.fn();
    readonly loadURL = vi.fn(async () => {});
    readonly setAspectRatio = vi.fn();
    readonly setBackgroundColor = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    onWindowOpen?: (details: { url: string }) => { action: string };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      electron.windows.push(this);
    }
    show() {}
  },
}));

import { createDesktopWindow, fitPlaytestContentSize, isValidPlaytestViewport } from "../src/desktop/window.js";

beforeEach(() => {
  electron.windows.length = 0;
  electron.dark = false;
  electron.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  electron.cursorPoint = { x: 480, y: 320 };
  electron.getDisplayNearestPoint.mockReset().mockImplementation(() => ({ workArea: electron.workArea }));
  electron.openExternal.mockClear();
  electron.themeOn.mockClear();
  electron.themeOff.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop window", () => {
  it("uses a native title bar to keep Playtest window controls outside the game on macOS", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      contentSize: { width: 1280, height: 720 },
      nativeTitleBar: true,
      sidebarInset: true,
    });
    const window = electron.windows[0] as { options: Record<string, unknown> };
    expect(window.options.useContentSize).toBe(true);
    expect(window.options.titleBarStyle).toBeUndefined();
    expect(window.options.trafficLightPosition).toBeUndefined();
  });

  it("starts at a moderate size centered in the display work area", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as { options: Record<string, unknown> };
    expect(window.options).toMatchObject({ width: 1200, height: 780, minWidth: 960, minHeight: 640, x: 360, y: 150 });
  });

  it("updates the opaque sidebar backing with live theme changes and releases its listener", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      sidebarInset: true,
    });
    const window = electron.windows[0] as {
      once: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      setBackgroundColor: ReturnType<typeof vi.fn>;
    };
    const update = electron.themeOn.mock.calls.find(([event]) => event === "updated")![1] as () => void;
    electron.dark = true;
    update();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#171717");
    electron.dark = false;
    update();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    window.once.mock.calls.find(([event]) => event === "closed")![1]();
    expect(electron.themeOff).toHaveBeenCalledWith("updated", update);
    window.isDestroyed.mockReturnValue(true);
    update();
    expect(window.setBackgroundColor).toHaveBeenCalledTimes(2);
  });

  it.each([
    { x: 0, y: 24, width: 1280, height: 696 },
    { x: 0, y: 24, width: 800, height: 576 },
    { x: -1440, y: 48, width: 1440, height: 852 },
  ])("fits within the pointer display's work area %j", async (workArea) => {
    electron.workArea = workArea;
    electron.cursorPoint = { x: workArea.x + 100, y: workArea.y + 100 };
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as {
      options: { width: number; height: number; minWidth: number; minHeight: number; x: number; y: number };
    };
    const bounds = window.options;
    expect(electron.getDisplayNearestPoint).toHaveBeenCalledWith(electron.cursorPoint);
    expect(bounds.width).toBeLessThanOrEqual(Math.floor(workArea.width * 0.9));
    expect(bounds.height).toBeLessThanOrEqual(Math.floor(workArea.height * 0.88));
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width);
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height);
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    expect(Math.abs((bounds.x - workArea.x) - (workArea.x + workArea.width - bounds.x - bounds.width))).toBeLessThanOrEqual(1);
    expect(Math.abs((bounds.y - workArea.y) - (workArea.y + workArea.height - bounds.y - bounds.height))).toBeLessThanOrEqual(1);
  });

  it.each([false, true])("matches the native startup background to dark mode %s", async (dark) => {
    electron.dark = dark;
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as { options: Record<string, unknown> };
    expect(window.options.backgroundColor).toBe(dark ? "#171717" : "#ffffff");
  });

  it("blocks main-frame navigation away from the renderer", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as {
      loadURL: ReturnType<typeof vi.fn>;
      onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    };

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:43120/");
    const allowed = { preventDefault: vi.fn() };
    window.onNavigate?.(allowed, "http://127.0.0.1:43120/");
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    for (const url of ["https://untrusted.example/", "http://127.0.0.1:43120/other.html", ""]) {
      const rejected = { preventDefault: vi.fn() };
      window.onNavigate?.(rejected, url);
      expect(rejected.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["HTTP", { rendererUrl: "http://127.0.0.1:43120" }, "http://127.0.0.1:43120/"],
    ["file", { rendererFile: path.resolve("renderer index.html") }, pathToFileURL(path.resolve("renderer index.html")).href],
  ] as const)("gives the daemon runtime only to its own %s page, not its command line", async (_kind, renderer, pageUrl) => {
    let handlerBeforeLoad = false;
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "secret-token" },
      preloadPath: "/tmp/preload.cjs",
      ...renderer,
      beforeLoad: (created) => {
        handlerBeforeLoad = (created as unknown as { ipcHandlers: Map<string, unknown> }).ipcHandlers.has("ohmygame:desktop-runtime");
      },
    });
    const window = electron.windows[0] as {
      options: { webPreferences: Record<string, unknown> };
      webContents: { mainFrame: { url: string } };
      ipcHandlers: Map<string, (event: { senderFrame: unknown; returnValue?: unknown }) => void>;
    };

    expect(JSON.stringify(window.options)).not.toContain("secret-token");
    expect(window.options.webPreferences.additionalArguments).toBeUndefined();
    expect(handlerBeforeLoad).toBe(true);
    const answer = window.ipcHandlers.get("ohmygame:desktop-runtime")!;

    window.webContents.mainFrame.url = pageUrl;
    const page = { senderFrame: window.webContents.mainFrame, returnValue: undefined as unknown };
    answer(page);
    expect(page.returnValue).toEqual({ url: "http://127.0.0.1:43110", token: "secret-token", nativeMedia: false });

    window.webContents.mainFrame.url = `${pageUrl}#/playtest/project`;
    const route = { senderFrame: window.webContents.mainFrame, returnValue: undefined as unknown };
    answer(route);
    expect(route.returnValue).toEqual({ url: "http://127.0.0.1:43110", token: "secret-token", nativeMedia: false });

    for (const url of ["https://untrusted.example/", new URL("other.html", pageUrl).href, ""]) {
      window.webContents.mainFrame.url = url;
      const redirected = { senderFrame: window.webContents.mainFrame, returnValue: undefined as unknown };
      answer(redirected);
      expect(redirected.returnValue).toBeNull();
    }

    for (const senderFrame of [{ url: pageUrl }, null]) {
      const embedded = { senderFrame, returnValue: undefined as unknown };
      answer(embedded);
      expect(embedded.returnValue).toBeNull();
    }
  });

  it.each([undefined, false, true])("only explicitly enables native media for a trusted main window: %s", async nativeMedia => {
    const created = await createDesktopWindow({ runtime: { url: "http://127.0.0.1:43110", token: "synthetic" }, preloadPath: "/tmp/preload.cjs", rendererUrl: "http://127.0.0.1:43120", nativeMedia });
    const window = created as unknown as { webContents: { mainFrame: { url: string } }; ipcHandlers: Map<string, (event: { senderFrame: unknown; returnValue?: unknown }) => void> };
    const event = { senderFrame: window.webContents.mainFrame, returnValue: undefined as unknown };
    window.ipcHandlers.get("ohmygame:desktop-runtime")!(event);
    expect(event.returnValue).toMatchObject({ nativeMedia: nativeMedia === true });
    const child = { senderFrame: { url: event.senderFrame.url }, returnValue: undefined as unknown };
    window.ipcHandlers.get("ohmygame:desktop-runtime")!(child); expect(child.returnValue).toBeNull();
  });

  it("mutes a hidden window, such as a thumbnail capture", async () => {
    const options = {
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    };
    await createDesktopWindow({ ...options, hidden: true });
    await createDesktopWindow(options);
    const [hidden, shown] = electron.windows as { webContents: { setAudioMuted: ReturnType<typeof vi.fn> } }[];

    expect(hidden!.webContents.setAudioMuted).toHaveBeenCalledWith(true);
    expect(shown!.webContents.setAudioMuted).not.toHaveBeenCalled();
  });

  it("opens only HTTP links in the system browser", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as {
      onWindowOpen?: (details: { url: string }) => { action: string };
    };

    expect(window.onWindowOpen?.({ url: "https://example.com/game" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "http://127.0.0.1:43130/games/game-1" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "file:///tmp/private" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(electron.openExternal).toHaveBeenCalledTimes(2);
    expect(electron.openExternal).toHaveBeenNthCalledWith(1, "https://example.com/game");
    expect(electron.openExternal).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43130/games/game-1");
  });

  it("loads and permits a renderer hash route", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      rendererHash: "#/playtest/project",
    });
    const window = electron.windows[0] as {
      loadURL: ReturnType<typeof vi.fn>;
      onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    };

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:43120/#/playtest/project");
    const navigation = { preventDefault: vi.fn() };
    window.onNavigate?.(navigation, "http://127.0.0.1:43120/#/playtest/project");
    expect(navigation.preventDefault).not.toHaveBeenCalled();
  });

  it("supports a fixed content aspect ratio for playtest windows", async () => {
    electron.workArea = { x: 0, y: 24, width: 800, height: 576 };
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      contentSize: { width: 1280, height: 720 },
      aspectRatio: 16 / 9,
      minWidth: 640,
      minHeight: 360,
    });
    const window = electron.windows[0] as {
      options: Record<string, unknown>;
      setAspectRatio: ReturnType<typeof vi.fn>;
    };

    expect(window.options).toMatchObject({
      width: 1280,
      height: 720,
      minWidth: 640,
      minHeight: 360,
      useContentSize: true,
    });
    expect(window.setAspectRatio).toHaveBeenCalledWith(16 / 9);
    expect(electron.getDisplayNearestPoint).not.toHaveBeenCalled();
    expect(window.options.x).toBeUndefined();
    expect(window.options.y).toBeUndefined();
  });

  it.each([
    ["landscape", { width: 1280, height: 720 }, { width: 1280, height: 720 }],
    ["portrait", { width: 720, height: 1280 }, { width: 450, height: 800 }],
    ["square", { width: 1080, height: 1080 }, { width: 800, height: 800 }],
    ["custom", { width: 1000, height: 500 }, { width: 1280, height: 640 }],
  ])("fits a %s playtest viewport within the initial window bounds", (_label, viewport, expected) => {
    expect(fitPlaytestContentSize(viewport)).toEqual(expected);
  });

  it("validates playtest viewport dimensions", () => {
    expect(isValidPlaytestViewport({ width: 1280, height: 720 })).toBe(true);
    expect(isValidPlaytestViewport({ width: 239, height: 720 })).toBe(false);
    expect(isValidPlaytestViewport({ width: 1280.5, height: 720 })).toBe(false);
    expect(isValidPlaytestViewport({ width: 1280, height: 8193 })).toBe(false);
    expect(isValidPlaytestViewport(null)).toBe(false);
  });

  it.each([
    ["darwin", false], ["darwin", true],
    ["win32", false], ["win32", true],
    ["linux", false], ["linux", true],
  ] as const)("keeps sidebar windows opaque on %s with dark mode %s", async (platform, dark) => {
    vi.stubGlobal("process", { ...process, platform });
    electron.dark = dark;
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      sidebarInset: true,
    });

    const plain = electron.windows[0] as { options: Record<string, unknown> };
    const sidebar = electron.windows[1] as { options: Record<string, unknown> };
    for (const window of [plain, sidebar]) {
      expect(window.options.backgroundColor).toBe(dark ? "#171717" : "#ffffff");
      expect(window.options.transparent).toBeUndefined();
      expect(window.options.vibrancy).toBeUndefined();
      expect(window.options.visualEffectState).toBeUndefined();
    }
    if (platform === "darwin") {
      expect(plain.options.transparent).toBeUndefined();
      expect(plain.options.trafficLightPosition).toBeUndefined();
      expect(sidebar.options.trafficLightPosition).toEqual({ x: 24, y: 18 });
      expect(sidebar.options.titleBarStyle).toBe("hiddenInset");
    } else {
      expect(sidebar.options.trafficLightPosition).toBeUndefined();
    }
  });

  it.each([
    ["win32", false, "#00000000"],
    ["win32", true, "#00000000"],
    ["darwin", false, undefined],
    ["linux", false, undefined],
  ] as const)("configures %s window chrome with dark mode %s", async (platform, dark, color) => {
    vi.stubGlobal("process", { ...process, platform });
    electron.dark = dark;
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      integratedMenuBar: true,
    });

    const window = electron.windows[0] as { options: Record<string, unknown> };
    if (platform === "win32") {
      expect(window.options).toMatchObject({
        titleBarStyle: "hidden",
        titleBarOverlay: { color, symbolColor: dark ? "#ffffff" : "#202020", height: 32 },
      });
    } else if (platform === "darwin") {
      expect(window.options.titleBarStyle).toBe("hiddenInset");
      expect(window.options.titleBarOverlay).toBeUndefined();
    } else {
      expect(window.options.titleBarStyle).toBeUndefined();
      expect(window.options.titleBarOverlay).toBeUndefined();
    }
  });
});
