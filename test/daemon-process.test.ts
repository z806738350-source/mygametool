import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/desktop/daemon-process.js";
import { playtestActionError, playtestOpenError } from "../src/shared/playtest.js";
import { localDesktopLaunch } from "../src/desktop/local-launch.js";
import { bindDesktopDaemonOwner } from "../src/daemon/desktop-owner.js";
import { resolveBlenderWindowBounds } from "../src/daemon/blender-window-bounds.js";
import { blenderWindowGeometry, placeBlenderWindow } from "../src/shared/blender-window-bounds.js";

describe("Blender observer window placement", () => {
  const content = { x: 100, y: 100, width: 1200, height: 800 };
  const workArea = { x: 0, y: 25, width: 1920, height: 1055 };
  it.each(["left", "right"])("fits the visible canvas when chat is on the %s", (chatSide) => {
    const canvas = { x: chatSide === "left" ? 431 : 0, y: 0, width: 769, height: 800 };
    const bounds = placeBlenderWindow(content, workArea, { canvas, chatSide });
    expect(bounds).toEqual({ x: chatSide === "left" ? 543 : 112, y: 185, width: 745, height: 650 });
  });
  it("converts page zoom to DIP without applying a second Retina scale", () => {
    const canvas = { x: 344.8, y: 0, width: 615.2, height: 640 };
    expect(placeBlenderWindow(content, workArea, { canvas, devicePixelRatio: 2 }, 1.25))
      .toEqual({ x: 543, y: 185, width: 745, height: 650 });
  });
  it("retains negative secondary-display coordinates and uses the primary display for Blender's bottom origin", () => {
    const bounds = placeBlenderWindow({ x: -1800, y: -900, width: 1400, height: 800 }, { x: -1920, y: -1080, width: 1920, height: 1080 }, { canvas: { x: 431, y: 0, width: 969, height: 800 } });
    expect(bounds).toEqual({ x: -1334, y: -815, width: 900, height: 650 });
    expect(blenderWindowGeometry({ bounds, screenHeight: 1080 })).toEqual({ x: -1334, y: 1245, width: 900, height: 650 });
  });
  it("uses free screen space beside a widened chat when the canvas is narrower than Blender's minimum", () => {
    const bounds = placeBlenderWindow(content, workArea, { canvas: { x: 1001, y: 0, width: 199, height: 800 }, chat: { x: 0, y: 0, width: 1000, height: 800 } })!;
    expect(bounds.x).toBeGreaterThanOrEqual(1100);
    expect(bounds.width).toBeGreaterThanOrEqual(500);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
  });
  it("defaults to the opposite side and keeps a collapsed-canvas fallback small", () => {
    expect(placeBlenderWindow(content, workArea, undefined)!.x).toBeGreaterThanOrEqual(530);
    const bounds = placeBlenderWindow(workArea, workArea, { chat: { x: 0, y: 0, width: 1920, height: 1055 }, chatSide: "right" });
    expect(bounds).toEqual({ x: 12, y: 57, width: 500, height: 360 });
    expect(placeBlenderWindow(content, { ...workArea, width: 450 }, undefined)).toBeUndefined();
  });
  it.each([undefined, {}, { bounds: { x: 0, y: 0, width: 901, height: 650 }, screenHeight: 1080 }, { bounds: { x: NaN, y: 0, width: 500, height: 360 }, screenHeight: 1080 }])("ignores invalid desktop geometry (%j)", (value) => {
    expect(blenderWindowGeometry(value)).toBeUndefined();
  });
  it.each(["en", "zh-CN", "zh-TW", "__proto__"])("carries only supported observer languages (%s)", (language) => {
    const placement = { bounds: { x: 600, y: 100, width: 700, height: 650 }, screenHeight: 1080, language };
    expect(blenderWindowGeometry(placement)).toEqual({
      x: 600, y: 330, width: 700, height: 650,
      ...(language === "en" || language === "zh-CN" ? { language } : {}),
    });
  });
  it.each(["result", "malformed", "disconnect", "timeout", "send-error", "send-throw"])("cleans optional placement IPC after %s", async (mode) => {
    vi.useFakeTimers();
    const send = vi.fn((_message: unknown, callback: (error?: Error) => void) => {
      if (mode === "send-throw") throw new Error("disconnected");
      callback(mode === "send-error" ? new Error("disconnected") : undefined);
    });
    const ipc = Object.assign(new EventEmitter(), { platform: "darwin", env: { OHMYGAME_BLENDER_WINDOW_IPC: "1" }, connected: true, send });
    vi.stubGlobal("process", ipc);
    try {
      const promise = resolveBlenderWindowBounds();
      const request = send.mock.calls[0]![0] as { id: string };
      const result = { bounds: { x: 600, y: 100, width: 700, height: 650 }, screenHeight: 1080 };
      ipc.emit("message", { channel: "ohmygame:blender-window:result", id: "another-call", result });
      if (mode === "result" || mode === "malformed") ipc.emit("message", { channel: "ohmygame:blender-window:result", id: request.id, result: mode === "result" ? result : {} });
      if (mode === "disconnect") ipc.emit("disconnect");
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(1500);
      expect(await promise).toEqual(mode === "result" ? { x: 600, y: 330, width: 700, height: 650 } : undefined);
      expect(ipc.listenerCount("message")).toBe(0);
      expect(ipc.listenerCount("disconnect")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("source desktop launcher arguments and ownership", () => {
  const envFile = path.resolve(tmpdir(), "fake.env"), profile = path.resolve(tmpdir(), "fake-profile");
  const launchId = "46dbd610-c6de-4a40-8ec0-5a28b9374079";
  const required = ["--local-profile", profile, "--local-launch-id", launchId];
  it("passes explicit paths and a non-secret ownership ID without discovering or reading a credential file", () => {
    expect(localDesktopLaunch(["electron", "main.js"])).toBeUndefined();
    expect(localDesktopLaunch(["--local-env", envFile, ...required])).toEqual({ envFile, profileDirectory: profile, launchId, reuseLocalEnv: false });
    expect(localDesktopLaunch([`--local-env=${envFile}`, `--local-profile=${profile}`, `--local-launch-id=${launchId}`]))
      .toEqual({ envFile, profileDirectory: profile, launchId, reuseLocalEnv: false });
    expect(localDesktopLaunch(["--reuse-local-env", ...required])).toEqual({ profileDirectory: profile, launchId, reuseLocalEnv: true });
  });
  it.each([
    ["--local-env", envFile], ["--local-env", "relative.env", ...required],
    ["--local-env", envFile, "--local-profile", "relative", "--local-launch-id", launchId],
    ["--local-env", envFile, "--local-profile", profile, "--local-launch-id", "not-an-ownership-id"],
    ["--local-env", envFile, `--local-env=${envFile}`, ...required],
    ["--local-env=", ...required], ["--local-env", `${envFile}\n`, ...required],
    ["--reuse-local-env", "--local-env", envFile, ...required],
    ["--reuse-local-env=true", ...required], ["--reuse-local-env", "--reuse-local-env", ...required],
  ])("rejects malformed or ambiguous local launcher arguments (%j)", (...argv) => {
    expect(() => localDesktopLaunch(argv)).toThrow();
  });
  it("closes a desktop-owned daemon once when private parent IPC disconnects", async () => {
    const owner = Object.assign(new EventEmitter(), { connected: true }), shutdown = vi.fn(async () => {});
    bindDesktopDaemonOwner(owner, shutdown);
    owner.connected = false;
    owner.emit("disconnect"); owner.emit("disconnect");
    expect(shutdown).toHaveBeenCalledOnce();
  });
  it("refuses ownership if the parent disconnected before authentication finished", () => {
    const owner = Object.assign(new EventEmitter(), { connected: false }), shutdown = vi.fn(async () => {});
    expect(() => bindDesktopDaemonOwner(owner, shutdown)).toThrow("private parent IPC");
    expect(owner.listenerCount("disconnect")).toBe(0); expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("desktop daemon process", () => {
  it("rejects conflicting or relative credential-file options before spawning a child", async () => {
    const options = { daemonEntry: "/missing/fake-daemon.mjs", dataDirectory: tmpdir(), token: "test-token", allowedOrigins: [] };
    await expect(startDaemon({ ...options, localEnvFile: "relative.env" })).rejects.toThrow("absolute local credential");
    await expect(startDaemon({ ...options, localEnvFile: path.resolve(tmpdir(), "fake.env"), reuseLocalEnv: true })).rejects.toThrow("never both");
  });
  it.each([false, true])("passes only credential file or reuse arguments and strips ambient keys (reuse=%s)", async (reuseLocalEnv) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-env-")), entry = path.join(directory, "daemon.mjs");
    const envFile = path.join(directory, "intentionally-absent.env"), resultFile = path.join(directory, "result.json");
    await writeFile(entry, `
      import { writeFileSync } from 'node:fs';
      import { createServer } from 'node:http';
      const names = ['KUNPO_API_KEY','kunpo_api_key','OPENAI_API_KEY','AZURE_CLIENT_SECRET','AWS_SECRET_ACCESS_KEY','SSH_AUTH_SOCK','NODE_OPTIONS','DYLD_INSERT_LIBRARIES'];
      let token = ''; for await (const chunk of process.stdin) token += chunk;
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ args: process.argv.slice(2), inheritedNames: names.filter(name => process.env[name] !== undefined), tokenInEnvironment: process.env.OHMYGAME_DAEMON_TOKEN !== undefined, tokenInArguments: process.argv.includes(token), launchId: process.env.OHMYGAME_LOCAL_LAUNCH_ID }));
      const server = createServer((request, response) => { response.statusCode = request.headers.authorization === 'Bearer ' + token ? 200 : 401; response.end(); });
      server.listen(Number(process.env.DAEMON_PORT), '127.0.0.1');
      process.on('message', message => { if (message?.channel === 'ohmygame:shutdown') server.close(() => process.exit(0)); });
      process.once('SIGTERM', () => server.close(() => process.exit(0)));
    `);
    const launchId = "46dbd610-c6de-4a40-8ec0-5a28b9374079";
    const timers = vi.spyOn(globalThis, "setTimeout");
    const lines: string[] = [];
    const daemon = await startDaemon({ daemonEntry: entry, dataDirectory: directory, token: "test-token", allowedOrigins: [], executable: process.execPath,
      ...(reuseLocalEnv ? { reuseLocalEnv: true } : { localEnvFile: envFile }), localLaunchId: launchId, development: true,
      log: { line: (line) => lines.push(line), stream: () => ({ write() {}, flush() {} }) },
      environment: { HOME: directory, TMPDIR: directory, KUNPO_API_KEY: "FAKE_KUNPO_CANARY", kunpo_api_key: "FAKE_LOWER_CANARY", OPENAI_API_KEY: "FAKE_OPENAI_CANARY", AZURE_CLIENT_SECRET: "FAKE_AZURE_CANARY", AWS_SECRET_ACCESS_KEY: "FAKE_AWS_CANARY", SSH_AUTH_SOCK: "/fake/agent", NODE_OPTIONS: "--require=/missing/must-not-execute", DYLD_INSERT_LIBRARIES: "/missing/must-not-load" }, healthTimeoutMs: 2_000 });
    try {
      expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({ args: ["--dev", ...(reuseLocalEnv ? ["--reuse-local-env"] : ["--local-env", envFile])], inheritedNames: [], tokenInEnvironment: false, tokenInArguments: false, launchId });
    } finally {
      await daemon.stop();
      expect(lines.at(-1)).toBe("OhMyGame service exited (0)");
      expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 150_000)).toBe(true);
      timers.mockRestore(); await rm(directory, { recursive: true, force: true });
    }
  });
  it("handles system proxy, Blender placement and observer closure over private child IPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-proxy-ipc-"));
    const entry = path.join(directory, "daemon.mjs");
    const resultFile = path.join(directory, "result.json");
    const windowFile = path.join(directory, "window.json");
    const shutdownFile = path.join(directory, "shutdown");
    await writeFile(
      entry,
      `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end());
      process.on("message", (message) => {
        if (message.channel === "ohmygame:system-proxy:result") writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(message));
        if (message.channel === "ohmygame:blender-window:result") {
          writeFileSync(${JSON.stringify(windowFile)}, JSON.stringify({ ...message, enabled: process.env.OHMYGAME_BLENDER_WINDOW_IPC }));
          process.send({ channel: "ohmygame:blender-window:closed" });
        }
        if (message.channel === "ohmygame:shutdown") server.close(() => {
          writeFileSync(${JSON.stringify(shutdownFile)}, "closed");
          process.exit(0);
        });
      });
      process.send({ channel: "ohmygame:system-proxy:resolve", id: "test-proxy" });
      process.send({ channel: "ohmygame:blender-window:resolve", id: "test-window" });
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      // This fixture can only close gracefully through IPC, as on Windows.
      process.once("SIGTERM", () => {});
    `);
    const placement = { bounds: { x: 600, y: 100, width: 700, height: 650 }, screenHeight: 1080, language: "zh-CN" as const };
    const onBlenderWindowClosed = vi.fn();
    const daemon = await startDaemon({ daemonEntry: entry, dataDirectory: directory, token: "test-token", allowedOrigins: [], executable: process.execPath, environment: {}, resolveSystemProxy: async () => "PROXY 127.0.0.1:7890", resolveBlenderWindowBounds: async () => placement, onBlenderWindowClosed });
    try {
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
          channel: "ohmygame:system-proxy:result",
          id: "test-proxy",
          result: "PROXY 127.0.0.1:7890",
        }),
      );
      await vi.waitFor(async () => expect(JSON.parse(await readFile(windowFile, "utf8"))).toEqual({ channel: "ohmygame:blender-window:result", id: "test-window", result: placement, enabled: "1" }));
      await vi.waitFor(() => expect(onBlenderWindowClosed.mock.calls).toEqual([[]]));
    } finally {
      await Promise.all([daemon.stop(), daemon.stop()]);
      expect(await readFile(shutdownFile, "utf8")).toBe("closed");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "stops a nonresponsive daemon's process tree on Windows",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-daemon-tree-"),
      );
      const entry = path.join(directory, "daemon.mjs");
      const descendantFile = path.join(directory, "descendant.pid");
      await writeFile(
        entry,
        `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));
      createServer((_request, response) => response.end()).listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
    `,
      );
      const daemon = await startDaemon({
        daemonEntry: entry,
        dataDirectory: directory,
        token: "test-token",
        allowedOrigins: [],
        executable: process.execPath,
        environment: {},
      });
      const descendantPid = Number(await readFile(descendantFile, "utf8"));
      try {
        expect(isRunning(descendantPid)).toBe(true);
        await daemon.stop();
        await vi.waitFor(() => expect(isRunning(descendantPid)).toBe(false));
      } finally {
        if (isRunning(descendantPid)) process.kill(descendantPid);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("includes daemon output when the child exits before becoming healthy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-error-"));
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      process.stderr.write("\\u001b[31mCould not read project metadata\\u001b[0m\\n");
      process.exit(1);
    `);

    await expect(startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
    })).rejects.toThrow(
      "Daemon exited before becoming ready (1)\n\nDaemon output:\nCould not read project metadata",
    );
  });

  it("writes the daemon's output to its log line by line", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-log-"));
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      process.stdout.write("listening ");
      process.stderr.write("could not read settings\\n");
      process.stdout.write("on 127.0.0.1\\n");
      process.exit(1);
    `);
    const lines: string[] = [];
    const log = {
      line: (text: string) => lines.push(text),
      stream: () => {
        let pending = "";
        return {
          write: (chunk: string | Uint8Array) => {
            pending += String(chunk);
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            lines.push(...parts);
          },
          flush: () => { if (pending) lines.push(pending); pending = ""; },
        };
      },
    };

    await expect(startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
      log,
    })).rejects.toThrow("Daemon exited before becoming ready");
    await vi.waitFor(() => expect(lines.at(-1)).toBe("OhMyGame service exited (1)"));
    expect(lines[0]).toMatch(/^OhMyGame service starting \(pid \d+\)$/);
    expect(lines).toContain("listening on 127.0.0.1");
    expect(lines).toContain("could not read settings");
    await rm(directory, { recursive: true, force: true });
  });

  it.each([false, true])("waits for health and stops the managed child (development=%s)", async (development) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-"));
    const pidFile = path.join(directory, "pid");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      let token = "";
      for await (const chunk of process.stdin) token += chunk;
      const server = createServer((request, response) => {
        response.statusCode = request.url === "/health" && request.headers.authorization === "Bearer " + token ? 200 : 401;
        response.end(JSON.stringify({ development: process.argv.includes("--dev"), tokenInEnvironment: Object.keys(process.env).some((name) => name.toUpperCase() === "OHMYGAME_DAEMON_TOKEN") }));
      });
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: { OHMYGAME_DAEMON_TOKEN: "stale-desktop-token", ohmygame_daemon_token: "stale-desktop-token" },
      development,
      healthTimeoutMs: 2_000,
    });
    const pid = Number(await readFile(pidFile, "utf8"));

    try {
      expect((await fetch(`${daemon.runtime.url}/health`)).status).toBe(401);
      expect((await fetch(`${daemon.runtime.url}/health`, {
        headers: { authorization: "Bearer test-token" },
      })).status).toBe(200);
      expect(daemon.runtime.token).toBe("test-token");
      expect(await (await fetch(`${daemon.runtime.url}/health`, {
        headers: { authorization: "Bearer test-token" },
      })).json()).toEqual({ development, tokenInEnvironment: false });
    } finally {
      await daemon.stop();
    }
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
  });

  it("prepends the packaged runtime to the daemon path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-runtime-"));
    const runtimeBin = path.join(directory, "runtime", "node", "bin");
    const pathFile = path.join(directory, "path");
    const entry = path.join(directory, "daemon.mjs");
    await mkdir(runtimeBin, { recursive: true });
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pathFile)}, process.env.Path ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: { Path: "/system/bin" },
      runtimeBin,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(pathFile, "utf8")).toBe(`${runtimeBin}${path.delimiter}/system/bin`);
    await daemon.stop();
  });

  it("passes the OhMyGame Pi agent directory to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    const piAgentDirectory = path.join(directory, "pi-agent");
    const piAgentFile = path.join(directory, "pi-agent-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(piAgentFile)}, process.env.PI_CODING_AGENT_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      piAgentDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(piAgentFile, "utf8")).toBe(piAgentDirectory);
    await daemon.stop();
  });

  it("passes the log folder to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-log-dir-"));
    const logDirectory = path.join(directory, "logs");
    const logDirectoryFile = path.join(directory, "log-dir-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(logDirectoryFile)}, process.env.OHMYGAME_LOG_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      logDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(logDirectoryFile, "utf8")).toBe(logDirectory);
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("passes the packaged player directory to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-path-"));
    const playerDirectory = path.join(directory, "app.asar.unpacked", "dist", "player");
    const playerPathFile = path.join(directory, "player-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(playerPathFile)}, process.env.OHMYGAME_PLAYER_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      playerDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(playerPathFile, "utf8")).toBe(playerDirectory);
    await daemon.stop();
  });

  it.each(["success", "known-failure", "untrusted-fields", "open-failure", "untrusted-open-fields"])("routes playtest requests over the private child-process channel (%s)", async kind => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-playtest-ipc-"));
    const resultFile = path.join(directory, "playtest-result");
    const entry = path.join(directory, "daemon.mjs");
    const request = kind.includes("open") ? { operation: "open", target: { runtime: "web", url: "http://127.0.0.1:1234/" }, viewport: { width: 800, height: 600 } }
      : kind === "success" ? { operation: "close", sessionId: "session-1" }
      : { operation: "act", sessionId: "session-1", actions: [{ type: "click", target: { text: "Start" } }] };
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1", () => {
        process.send({
          channel: "ohmygame:playtest-request",
          id: "request-1",
          request: ${JSON.stringify(request)},
        });
      });
      process.on("message", (message) => {
        if (message?.channel === "ohmygame:playtest-response") writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(message));
        if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0));
      });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const failure = { version: 1 as const, sessionId: "session-1", completedActions: 0, failedAction: 1, actionType: "click" as const, phase: "target_lookup" as const, inputDispatched: false as const };
    const openFailure = { version: 1 as const, reason: "session_limit" as const, limit: 4, windowCreated: false as const };
    const handler = vi.fn(async () => {
      if (kind === "open-failure") throw playtestOpenError("Session limit", openFailure);
      if (kind === "untrusted-open-fields") throw Object.assign(new Error("Session limit"), { openFailure });
      if (kind === "known-failure") throw playtestActionError("Target missing", failure);
      if (kind === "untrusted-fields") throw Object.assign(new Error("Target missing"), { actionFailure: failure });
      return { operation: "close" as const };
    });
    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
      handlePlaytestRequest: handler,
    });

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({
        channel: "ohmygame:playtest-response",
        id: "request-1",
        ...(kind === "success" ? { result: { operation: "close" } } : { error: kind.includes("open") ? "Session limit" : "Target missing" }),
      });
    });
    const response = JSON.parse(await readFile(resultFile, "utf8"));
    if (kind === "known-failure") expect(response.actionFailure).toEqual(failure);
    else expect(response.actionFailure).toBeUndefined();
    if (kind === "open-failure") expect(response.openFailure).toEqual(openFailure);
    else expect(response.openFailure).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
    );
    await daemon.stop();
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
