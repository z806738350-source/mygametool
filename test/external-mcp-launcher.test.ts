import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalMcpService } from "../src/daemon/external-mcp.js";
import { installExternalMcpLauncher, markExternalMcpApp } from "../src/desktop/external-mcp-install.js";
import { ExternalMcpLauncher, type Message } from "../src/desktop/external-mcp-launcher.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-launcher-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture() {
  const root = await temporaryDirectory();
  const execute = vi.fn();
  const service = new ExternalMcpService({ dataDirectory: root, projects: () => [], tools: () => { execute(); return []; }, catalog: () => [] });
  cleanup.push(() => service.close());
  await service.load();
  const request = vi.fn<typeof fetch>(async () => { throw new Error("Retired MCP must not contact a daemon"); });
  const startApp = vi.fn();
  const written: Message[] = [];
  const create = () => new ExternalMcpLauncher({ dataDirectory: root, write: (message) => written.push(message), fetch: request, startApp, environment: {}, cwd: root, isAlive: () => false });
  let id = 0;
  const ask = async (launcher: ExternalMcpLauncher, method: string, params: Record<string, unknown> = {}) => {
    const current = ++id;
    await launcher.receive({ jsonrpc: "2.0", id: current, method, params });
    return written.find((message) => message.id === current);
  };
  return { root, service, execute, request, startApp, create, ask };
}

it("keeps the legacy protocol handshake and empty catalog local without starting the app", async () => {
  const { create, ask, request, startApp } = await fixture();
  const launcher = create();
  expect((await ask(launcher, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }))?.result).toMatchObject({ serverInfo: { name: "ohmygame-studio", version: "1" } });
  expect((await ask(launcher, "tools/list"))?.result).toEqual({ tools: [] });
  expect((await ask(launcher, "ping"))?.result).toEqual({});
  expect(request).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
  await launcher.close();
});

it.each(["generate_image", "generate_video", "generate_music", "generate_speech", "canvas_initialize", "game_use", "open_project", "wait_job"])("refuses legacy %s calls without app startup, forwarding, execution or retries", async (name) => {
  const { create, ask, request, startApp, execute } = await fixture();
  const launcher = create();
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await ask(launcher, "tools/call", { name, arguments: {} });
    expect(answer?.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("not accepting other agents") }] });
  }
  expect(request).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  await launcher.close();
});

it("denies enabling the server and never publishes a daemon credential", async () => {
  const { root, service, execute } = await fixture();
  await expect(service.setEnabled(true)).rejects.toThrow("temporarily unavailable in the local secure edition pending isolated execution");
  await service.listening("http://127.0.0.1:1/external-mcp");
  expect(service.enabled).toBe(false);
  expect((await service.handle({ authorization: "Bearer fake-only", sessionId: undefined, roots: undefined, body: { id: 1, method: "tools/call", params: { name: "generate_image" } } })).status).toBe(403);
  await expect(stat(path.join(root, "external-mcp", "endpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(execute).not.toHaveBeenCalled();
});

it("ignores a stale enabled setting and revokes its old endpoint before use", async () => {
  const { root, service } = await fixture();
  await mkdir(path.join(root, "external-mcp"), { recursive: true });
  await writeFile(path.join(root, "external-mcp", "settings.json"), JSON.stringify({ version: 1, enabled: true }));
  await writeFile(path.join(root, "external-mcp", "endpoint.json"), JSON.stringify({ token: "fake-old-token", url: "http://127.0.0.1:1/external-mcp" }));
  await service.load();
  expect(service.enabled).toBe(false);
  await expect(stat(path.join(root, "external-mcp", "endpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("forgets the app's record only when it is still the app's own", async () => {
  const { root } = await fixture();
  const first = await markExternalMcpApp(root, 1);
  await markExternalMcpApp(root, 2);
  await first();
  expect(
    JSON.parse(
      await readFile(path.join(root, "external-mcp", "app.json"), "utf8"),
    ),
  ).toEqual({ version: 1, pid: 2 });
});


it("writes a launcher script that keeps arguments with spaces and quotes intact", async () => {
  if (process.platform === "win32") return;
  const root = await temporaryDirectory();
  const entry = path.join(root, "it's an entry.mjs");
  await writeFile(
    entry,
    "console.log(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));\n",
  );
  const launcher = await installExternalMcpLauncher({
    binDirectory: path.join(root, "bin"),
    executable: process.execPath,
    entry,
    dataDirectory: path.join(root, "Application Support", "data"),
  });
  expect(launcher).toEqual({
    command: path.join(root, "bin", "ohmygame-mcp"),
    args: [],
    env: {},
  });
  expect((await stat(launcher.command)).mode & 0o111).toBeTruthy();
  const { stdout } = await promisify(execFile)(launcher.command, ["--extra"]);
  expect(JSON.parse(stdout)).toEqual({
    args: [
      "--data-dir",
      path.join(root, "Application Support", "data"),
      "--extra",
    ],
    node: "1",
  });

  expect(
    await installExternalMcpLauncher({
      binDirectory: "unused",
      executable: "C:\\OhMyGame\\OhMyGame.exe",
      entry: "main.js",
      dataDirectory: "C:\\data",
      platform: "win32",
    }),
  ).toEqual({
    command: "C:\\OhMyGame\\OhMyGame.exe",
    args: ["main.js", "--data-dir", "C:\\data"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});
