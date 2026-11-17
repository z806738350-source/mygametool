import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: any[]) => void>(),
  ipcEvents: new Map<string, (...args: any[]) => void>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  windowEvents: new Map<string, (...args: any[]) => void>(),
  sender: { id: 1, send: vi.fn(), on: vi.fn(), mainFrame: { url: "" } },
  thumbnails: [] as Array<{ webContents: { id: number; mainFrame: { url: string } }; destroy: ReturnType<typeof vi.fn> }>,
  stopped: vi.fn(async () => {}),
  openExternal: vi.fn(async (_url: string) => {}),
  quit: vi.fn(), relaunch: vi.fn(), close: vi.fn(),
  focusApp: vi.fn(), showWindow: vi.fn(), focusWindow: vi.fn(), restoreWindow: vi.fn(),
  isMinimized: vi.fn(() => false),
  onBlenderWindowClosed: undefined as (() => void) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  mediaClosed: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (name: string, fn: (...args: any[]) => void) => host.appEvents.set(name, fn),
    whenReady: async () => {}, getPath: () => "/tmp/ohmygame-close-test", getVersion: () => "0.0.0",
    isReady: () => true, quit: host.quit, relaunch: host.relaunch, exit: vi.fn(), focus: host.focusApp,
  },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => host.handlers.set(name, fn),
    on: (name: string, fn: (...args: any[]) => void) => host.ipcEvents.set(name, fn),
  },
  nativeTheme: {}, session: { fromPartition: () => ({ setProxy: async () => {} }), defaultSession: { setProxy: async () => {} } },
  BrowserWindow: { getAllWindows: () => [] }, clipboard: {}, dialog: { showErrorBox: vi.fn() }, Menu: {}, shell: { openExternal: host.openExternal },
}));
vi.mock("undici/index.js", () => ({ setGlobalDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/daemon/environment.ts"), () => ({ loadEnvironmentFiles: vi.fn() }));
vi.doMock(path.resolve("src/daemon/proxy.ts"), () => ({ createNetworkDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/desktop/network.ts"), () => ({
  prepareDesktopNetwork: async () => ({ active: {}, environment: {} }), electronProxyConfig: () => ({}), proxyCredentials: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/daemon-process.ts"), () => ({
  startDaemon: async (options: { onBlenderWindowClosed?: () => void }) => {
    host.onBlenderWindowClosed = options.onBlenderWindowClosed;
    return { runtime: { url: "http://127.0.0.1:12345", token: "test" }, stop: host.stopped };
  },
}));
vi.doMock(path.resolve("src/desktop/log-file.ts"), () => ({
  RotatingLogFile: class { line() {} write() {} flush() {} close() {} stream() { return { write() {}, flush() {} }; } },
}));
vi.doMock(path.resolve("src/desktop/console-log.ts"), async (importOriginal) => ({
  ...(await importOriginal<object>()), recordConsole: vi.fn(), recordUncaughtErrors: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/external-mcp-install.ts"), () => ({ installExternalMcpLauncher: vi.fn(async () => undefined), markExternalMcpApp: vi.fn(async () => async () => {}) }));
vi.doMock(path.resolve("src/desktop/oauth.ts"), () => ({
  isOAuthAuthorizationUrl: vi.fn(), OAuthCallbackFlow: class { cancel = async () => {}; },
}));
vi.doMock(path.resolve("src/desktop/playtest-driver.ts"), () => ({ ElectronPlaytestDriver: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/web-game-player.ts"), () => ({ WebGamePlayerWindows: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/updater.ts"), () => ({ DesktopUpdater: class {
  subscribe() {} check() {}
} }));
vi.doMock(path.resolve("src/desktop/native-media.ts"), () => ({ installNativeMediaGuard: () => ({ close: host.mediaClosed }) }));
vi.doMock(path.resolve("src/desktop/window.ts"), () => ({
  createDesktopWindow: async (options: { hidden?: boolean; rendererFile?: string; beforeLoad(window: unknown): void }) => {
    host.options = options as unknown as Record<string, unknown>;
    const mainFrame = { url: pathToFileURL(options.rendererFile!).href };
    if (options.hidden) {
      let destroyed = false;
      const events = new Map<string, () => void>();
      const window = {
        webContents: { id: host.thumbnails.length + 2, mainFrame }, isDestroyed: () => destroyed,
        once: (name: string, listener: () => void) => events.set(name, listener),
        destroy: vi.fn(() => { destroyed = true; events.get("closed")?.(); }),
      };
      host.thumbnails.push(window);
      options.beforeLoad(window);
      return window;
    }
    host.sender.mainFrame = mainFrame;
    const window = {
      webContents: host.sender, isDestroyed: () => false, close: host.close,
      isMinimized: host.isMinimized, restore: host.restoreWindow, show: host.showWindow, focus: host.focusWindow,
      on: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
      once: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
    };
    options.beforeLoad(window);
    return window;
  },
  waitForRenderer: async () => {}, fitPlaytestContentSize: vi.fn(), isValidPlaytestViewport: () => true, windowsTitleBarOverlay: vi.fn(),
  isRendererPage: (value: string, target: string) => value.split("#")[0] === target,
}));

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  host.appEvents.clear(); host.ipcEvents.clear(); host.handlers.clear(); host.windowEvents.clear();
  host.thumbnails.length = 0;
  process.argv.push("--built-renderer");
  host.quit.mockImplementation(() => host.appEvents.get("before-quit")!({ preventDefault() {} }));
  await import("../src/desktop/main.js");
  expect(host.options?.rendererFile).toMatch(/[\\/]renderer[\\/]index\.html$/);
});
afterEach(() => { process.argv.splice(process.argv.lastIndexOf("--built-renderer"), 1); vi.useRealTimers(); });

const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
const applicationEvent = (sender: { mainFrame: { url: string } } = host.sender) => ({ sender, senderFrame: sender.mainFrame });
it("rejects privileged IPC from a subframe or a navigated renderer", () => {
  const restart = host.handlers.get("ohmygame:restart-app")!;
  expect(() => restart({ sender: host.sender, senderFrame: { url: host.sender.mainFrame.url } })).toThrow("Invalid application IPC source");
  const original = host.sender.mainFrame.url;
  host.sender.mainFrame.url = "https://foreign.example/";
  try { expect(() => restart(applicationEvent())).toThrow("Invalid application IPC source"); }
  finally { host.sender.mainFrame.url = original; }
});
it("enables native media only on the main editor and releases its owner on close", () => {
  expect(host.options?.nativeMedia).toBe(true);
  host.windowEvents.get("closed")!();
  expect(host.mediaClosed).toHaveBeenCalledOnce();
});
it("refuses retired cloud OAuth entry points", () => {
  for (const channel of ["ohmygame:open-auth-url", "ohmygame:take-auth-callback", "ohmygame:auth-callback-url", "ohmygame:cancel-auth"]) expect(() => host.handlers.get(channel)!(applicationEvent())).toThrow("Cloud account authentication is disabled");
});
function acknowledge(error?: string, sender: { id: number; send: unknown } = host.sender, id?: number) {
  const sent = host.sender.send.mock.calls.findLast(([channel]) => channel === "ohmygame:prepare-close")!;
  host.ipcEvents.get("ohmygame:ready-to-close")!({ sender, senderFrame: host.sender.mainFrame }, id ?? sent[1], error);
}
function quit() { const event = { preventDefault: vi.fn() }; host.appEvents.get("before-quit")!(event); expect(event.preventDefault).toHaveBeenCalledOnce(); }

it.each([false, true])("returns to the existing editor when the Blender observer closes (minimized=%s)", (minimized) => {
  host.isMinimized.mockReturnValueOnce(minimized);
  host.onBlenderWindowClosed!();
  expect(host.restoreWindow).toHaveBeenCalledTimes(minimized ? 1 : 0);
  if (process.platform === "darwin") expect(host.focusApp).toHaveBeenCalledWith({ steal: true });
  expect(host.showWindow).toHaveBeenCalledOnce();
  expect(host.focusWindow).toHaveBeenCalledOnce();
});

it("keeps services running until Quit receives a save acknowledgement", async () => {
  quit(); quit();
  host.onBlenderWindowClosed!();
  expect(host.focusApp).not.toHaveBeenCalled();
  expect(host.showWindow).not.toHaveBeenCalled();
  expect(host.focusWindow).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
  expect(host.quit).toHaveBeenCalledOnce();
});
it("saves before closing a window and shares that save with a concurrent Quit", async () => {
  const event = { preventDefault: vi.fn() };
  host.windowEvents.get("close")!(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(host.close).not.toHaveBeenCalled();
  quit(); acknowledge(); await settle();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.close).not.toHaveBeenCalled();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("quits from the main red close button after saving, with repeated closes sharing cleanup", async () => {
  const close = host.windowEvents.get("close")!;
  const event = { preventDefault: vi.fn() };
  close(event); close(event); close(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
  expect(host.quit).toHaveBeenCalledOnce();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.close).not.toHaveBeenCalled();
  expect(host.stopped).toHaveBeenCalledOnce();
  expect(host.quit).toHaveBeenCalledTimes(2);
  const afterSave = { preventDefault: vi.fn() };
  close(afterSave);
  expect(afterSave.preventDefault).not.toHaveBeenCalled();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("keeps the main window and services alive after a failed red-close save, then permits retry", async () => {
  const close = host.windowEvents.get("close")!;
  close({ preventDefault() {} });
  acknowledge("Resolve the board conflict before saving."); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.close).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("conflict"));
  close({ preventDefault() {} });
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("cancels a failed Quit and permits a later retry", async () => {
  quit(); acknowledge("Resolve the board conflict before saving."); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.quit).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("conflict"));
  quit(); acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("rejects foreign and stale acknowledgements and resumes after a timeout", async () => {
  quit(); acknowledge(undefined, { id: 99, send: vi.fn() }); acknowledge(undefined, host.sender, 0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("too long"));
  quit(); acknowledge(undefined, host.sender, 1); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("does not schedule a restart until its save succeeds", async () => {
  host.handlers.get("ohmygame:restart-app")!(applicationEvent());
  expect(host.relaunch).not.toHaveBeenCalled();
  acknowledge("Disk unavailable"); await settle();
  expect(host.relaunch).not.toHaveBeenCalled();
  host.handlers.get("ohmygame:restart-app")!(applicationEvent());
  acknowledge(); await settle();
  expect(host.relaunch).toHaveBeenCalledOnce();
  expect(host.stopped).toHaveBeenCalledOnce();
});

it("cancels active and queued thumbnail captures and frees slots for the next batch", async () => {
  const capture = (id: string, batch: string) => host.handlers.get("ohmygame:capture-node-thumbnail")!(
    applicationEvent(), "p", id, { width: 1280, height: 720 }, batch,
  ) as Promise<boolean>;
  const previous = [capture("a", "old"), capture("b", "old"), capture("c", "old")];
  expect(host.thumbnails).toHaveLength(2);
  host.handlers.get("ohmygame:cancel-node-thumbnails")!(applicationEvent(), "old");
  await expect(Promise.all(previous)).resolves.toEqual([false, false, false]);
  expect(host.thumbnails.every(window => window.destroy.mock.calls.length === 1)).toBe(true);
  const next = capture("next", "new");
  expect(host.thumbnails).toHaveLength(3);
  host.handlers.get("ohmygame:finish-node-thumbnail")!(applicationEvent(host.thumbnails[2]!.webContents), true);
  await expect(next).resolves.toBe(true);
});


it("opens official Codex sign-in URLs through a separate privileged channel", async () => {
  const open = host.handlers.get("ohmygame:open-codex-login-url")!;
  for (const url of ["https://auth.openai.com/oauth/authorize?state=fixture", "https://chatgpt.com/auth/authorize?state=fixture"])
    await open(applicationEvent(), url);
  expect(host.openExternal.mock.calls).toEqual([["https://auth.openai.com/oauth/authorize?state=fixture"], ["https://chatgpt.com/auth/authorize?state=fixture"]]);
  expect(() => open({ sender: host.sender, senderFrame: { url: host.sender.mainFrame.url } }, "https://auth.openai.com/oauth/authorize")).toThrow("Invalid application IPC source");
});

it.each(["http://auth.openai.com/oauth/authorize", "https://auth.openai.com.evil.invalid/oauth/authorize", "https://auth.openai.com@evil.invalid/", "https://user:password@auth.openai.com/", "https://auth.openai.com:8443/", "file:///tmp/login.html", "javascript:alert(1)", "https://127.0.0.1/", null])("refuses an invalid Codex sign-in destination: %s", async (url) => {
  await expect(host.handlers.get("ohmygame:open-codex-login-url")!(applicationEvent(), url)).rejects.toThrow("Invalid Codex sign-in URL");
  expect(host.openExternal).not.toHaveBeenCalled();
});
