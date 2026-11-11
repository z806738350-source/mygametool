import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/desktop/daemon-supervisor.js";
import { startDaemon } from "../src/desktop/daemon-process.js";
import type { DesktopRuntimeState } from "../src/shared/desktop-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: { maxAutomaticRestarts?: number; projectChild?: boolean; localEnv?: boolean; start?: boolean; failFirst?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-supervisor-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "daemon.mjs");
  const envFile = path.join(directory, "fake.env");
  if (options.localEnv) await writeFile(envFile, "KUNPO_API_KEY=sk-FIRST_FAKE\n", { mode: 0o600 });
  await writeFile(
    entry,
    `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { createServer } from 'node:http';
    import { createHash } from 'node:crypto';
    const count = existsSync(${JSON.stringify(path.join(directory, "count"))}) ? Number(readFileSync(${JSON.stringify(path.join(directory, "count"))}, 'utf8')) + 1 : 1;
    writeFileSync(${JSON.stringify(path.join(directory, "count"))}, String(count));
    writeFileSync(${JSON.stringify(path.join(directory, "pid"))}, String(process.pid));
    const args = process.argv.slice(2), importIndex = args.indexOf('--local-env');
    const snapshot = ${JSON.stringify(path.join(directory, "snapshot"))}, reads = ${JSON.stringify(path.join(directory, "env-reads"))};
    if (importIndex >= 0) {
      writeFileSync(snapshot, readFileSync(args[importIndex + 1]), { mode: 0o600 });
      writeFileSync(reads, String(existsSync(reads) ? Number(readFileSync(reads, 'utf8')) + 1 : 1));
    }
    writeFileSync(${JSON.stringify(path.join(directory, "generation-"))} + count + '.json', JSON.stringify({ args, configuration: existsSync(snapshot) ? createHash('sha256').update(readFileSync(snapshot)).digest('hex') : null }));
    if (${options.failFirst ?? false} && count === 1) process.exit(8);
    const server = createServer((request, response) => {
      response.end('ready');
      if (request.url === '/crash') setImmediate(() => process.exit(9));
    });
    server.listen(Number(process.env.DAEMON_PORT), '127.0.0.1', () => {
      if (${options.projectChild ?? false}) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        child.once('spawn', () => {
          writeFileSync(${JSON.stringify(path.join(directory, "project-pid"))}, String(child.pid));
          process.send({ channel: 'ohmygame:project-process', action: 'started', pid: child.pid });
        });
        child.unref();
      }
    });
    process.once('SIGTERM', () => server.close(() => process.exit(0)));
    // Windows has no SIGTERM to catch: the supervisor asks over IPC, as the real daemon expects.
    process.on('message', (message) => {
      if (message?.channel === 'ohmygame:shutdown') server.close(() => process.exit(0));
    });
  `,
  );
  const states: DesktopRuntimeState[] = [];
  const launchOptions = {
    daemonEntry: entry,
    dataDirectory: directory,
    token: "test-token",
    allowedOrigins: [],
    executable: process.execPath,
    environment: {},
    healthTimeoutMs: 2_000,
    maxAutomaticRestarts: options.maxAutomaticRestarts,
    ...(options.localEnv ? { localEnvFile: envFile } : {}),
    onState: (state: DesktopRuntimeState) => states.push(state),
  };
  const supervisor = new DaemonSupervisor(launchOptions);
  cleanups.push(() => supervisor.stop());
  if (options.start !== false) await supervisor.start();
  return { supervisor, directory, states, envFile, launchOptions };
}

describe("background service recovery", () => {
  it("imports once per desktop lifetime and reuses the snapshot on automatic and manual daemon restarts", async () => {
    const { supervisor, directory, envFile, launchOptions } = await fixture({ localEnv: true });
    const generation = async (number: number) => JSON.parse(await readFile(path.join(directory, `generation-${number}.json`), "utf8"));
    const first = await generation(1);
    expect(first.args).toEqual(["--local-env", envFile]);
    await writeFile(envFile, "KUNPO_API_KEY=sk-EDITED_FAKE\n");
    await fetch(`${supervisor.runtime.url}/crash`);
    await vi.waitFor(() => expect(supervisor.state()).toMatchObject({ status: "ready", generation: 2 }));
    expect(await generation(2)).toEqual({ args: ["--reuse-local-env"], configuration: first.configuration });
    await supervisor.restart();
    expect(await generation(3)).toEqual({ args: ["--reuse-local-env"], configuration: first.configuration });
    expect(await readFile(path.join(directory, "env-reads"), "utf8")).toBe("1");
    await supervisor.stop();
    const newDesktop = new DaemonSupervisor(launchOptions);
    cleanups.push(() => newDesktop.stop());
    await newDesktop.start();
    expect((await generation(4)).args).toEqual(["--local-env", envFile]);
    expect((await generation(4)).configuration).not.toBe(first.configuration);
    expect(await readFile(path.join(directory, "env-reads"), "utf8")).toBe("2");
  });

  it("does not accept a failed initial startup as a successful credential import", async () => {
    const { supervisor, directory, envFile } = await fixture({ localEnv: true, start: false, failFirst: true });
    await expect(supervisor.start()).rejects.toThrow("Daemon exited before becoming ready (8)");
    await writeFile(envFile, "KUNPO_API_KEY=sk-RETRY_FAKE\n");
    await supervisor.restart();
    const next = JSON.parse(await readFile(path.join(directory, "generation-2.json"), "utf8"));
    expect(next.args).toEqual(["--local-env", envFile]);
    expect(await readFile(path.join(directory, "env-reads"), "utf8")).toBe("2");
  });
  it("contains failed daemon spawns without hanging cleanup", async () => {
    const before = Date.now();
    await expect(
      startDaemon({
        daemonEntry: "/missing/daemon.js",
        executable: "/missing/ohmygame-node",
        dataDirectory: tmpdir(),
        token: "test",
        allowedOrigins: [],
        healthTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("ENOENT");
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it("reconnects to a new generation and stops after its automatic restart budget", async () => {
    const { supervisor, directory, states } = await fixture();
    for (let generation = 1; generation <= 3; generation++) {
      expect(supervisor.state()).toMatchObject({ status: "ready", generation });
      await fetch(`${supervisor.runtime.url}/crash`);
      await vi.waitFor(() =>
        expect(supervisor.state()).toMatchObject(
          generation < 3
            ? { status: "ready", generation: generation + 1, recovered: true }
            : { status: "error", generation: 3 },
        ),
      );
    }
    expect(await readFile(path.join(directory, "count"), "utf8")).toBe("3");
    expect(supervisor.state().error).toContain("exited (9)");
    expect(states.some((state) => state.status === "recovering")).toBe(true);
    const [first, second] = await Promise.all([
      supervisor.restart(),
      supervisor.restart(),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "ready",
      generation: 4,
      recovered: true,
    });
    expect((await fetch(`${supervisor.runtime.url}/health`)).status).toBe(200);
  });

  it.skipIf(process.platform === "win32")(
    "cleans registered detached previews after a daemon crash and does not restart on shutdown",
    async () => {
      const { supervisor, directory } = await fixture({
        maxAutomaticRestarts: 0,
        projectChild: true,
      });
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number(
          await readFile(path.join(directory, "project-pid"), "utf8"),
        );
        expect(pid).toBeGreaterThan(0);
      });
      await fetch(`${supervisor.runtime.url}/crash`);
      await vi.waitFor(() => expect(supervisor.state().status).toBe("error"));
      await vi.waitFor(() => expect(running(pid)).toBe(false));
      await supervisor.restart();
      await supervisor.stop();
      expect(supervisor.state().status).toBe("stopped");
      expect(await readFile(path.join(directory, "count"), "utf8")).toBe("2");
    },
  );
});

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
