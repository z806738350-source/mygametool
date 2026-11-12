import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { blenderLiveViewLabels } from "../src/shared/blender-live-view-labels.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startBlenderLiveView,
  type BlenderLiveView,
} from "../src/daemon/blender-live-view.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  register: vi.fn(),
  terminate: vi.fn(),
  bounds: vi.fn(),
  conflicts: new Map<string, number>(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../src/daemon/process-lifecycle.js", () => ({
  registerProjectProcess: mocks.register,
  terminateProjectProcess: mocks.terminate,
}));
vi.mock("../src/daemon/blender-window-bounds.js", () => ({
  resolveBlenderWindowBounds: mocks.bounds,
}));
vi.mock("../src/daemon/safe-project-file.js", async (original) => {
  const actual =
    await original<typeof import("../src/daemon/safe-project-file.js")>();
  return {
    ...actual,
    readSafeProjectFile: async (
      ...args: Parameters<typeof actual.readSafeProjectFile>
    ) => {
      const remaining = mocks.conflicts.get(args[1]) ?? 0;
      if (remaining) {
        mocks.conflicts.set(args[1], remaining - 1);
        throw new actual.SafeProjectFileError(
          "Project file changed during secure inspection; retry the request",
          409,
        );
      }
      return actual.readSafeProjectFile(...args);
    },
  };
});

let directory: string, job: string, relay: string;
let view: BlenderLiveView | undefined, child: ChildProcess | undefined;
let observerTimer: ReturnType<typeof setInterval> | undefined;
let acknowledge = true;

function closeObserver() {
  clearInterval(observerTimer);
  if (!child || child.exitCode !== null) return;
  Object.assign(child, { exitCode: 0 });
  child.emit("close", 0);
}

function ready(sequence: number) {
  const pending = path.join(relay, "home", "ready.pending.json");
  writeFileSync(pending, JSON.stringify({ sequence, windows: 1 }));
  renameSync(pending, path.join(relay, "home", "ready.json"));
}

async function checkpoint(sequence = 1, bytes = "BLENDER-v500-scene-fixture") {
  await writeFile(path.join(job, "tmp/live/scene.blend"), bytes);
  await writeFile(
    path.join(job, "tmp/live/status.json"),
    JSON.stringify({
      sequence,
      label: `Operation ${sequence}`,
      updatedAt: "2026-11-12T00:00:00Z",
    }),
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.conflicts.clear();
  acknowledge = true;
  view = undefined;
  child = undefined;
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-live-view-")),
  );
  job = path.join(directory, "jobs", "377225bb-26e0-4b84-a19a-2d75caa927d7");
  relay = path.join(path.dirname(job), ".live-view", path.basename(job));
  await mkdir(path.join(job, "tmp/live"), { recursive: true });
  await writeFile(path.join(job, "original.txt"), "unchanged production data");
  mocks.bounds.mockResolvedValue({ x: 800, y: 150, width: 700, height: 600 });
  mocks.terminate.mockImplementation(async () => closeObserver());
  mocks.spawn.mockImplementation(
    (_executable: string, _args: string[], options: SpawnOptions) => {
      expect(options.cwd).toBe(relay);
      child = Object.assign(new EventEmitter(), {
        pid: 34567,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      ready(0);
      let received = 0;
      // A local mock of the bundled observer: no application or OS process is launched.
      observerTimer = setInterval(() => {
        if (existsSync(path.join(relay, "stop.json"))) {
          closeObserver();
          return;
        }
        if (!acknowledge || !existsSync(path.join(relay, "status.json")))
          return;
        const status = JSON.parse(
          readFileSync(path.join(relay, "status.json"), "utf8"),
        );
        if (status.sequence !== received) {
          received = status.sequence;
          ready(received);
        }
      }, 10);
      queueMicrotask(() => child?.emit("spawn"));
      return child;
    },
  );
});

afterEach(async () => {
  await view?.finish();
  closeObserver();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("per-job Blender work window", () => {
  it.each([undefined, "en", "zh-CN"] as const)(
    "launches only the bundled observer with isolated preferences, owned lifecycle, desktop geometry and language %s",
    async (language) => {
      vi.stubEnv("OHMYGAME_TEST_SECRET", "FAKE_SECRET_MUST_NOT_BE_INHERITED");
      mocks.bounds.mockResolvedValue({
        x: 800,
        y: 150,
        width: 700,
        height: 600,
        language,
      });
      view = await startBlenderLiveView(
        job,
        vi.fn(async () => {}),
      );
      const [executable, args, options] = mocks.spawn.mock.calls[0] as [
        string,
        string[],
        SpawnOptions,
      ];
      expect(executable).toBe("/usr/bin/sandbox-exec");
      expect(args).toEqual(
        expect.arrayContaining([
          "--factory-startup",
          "--disable-autoexec",
          "--python",
          path.join(relay, "observer.py"),
        ]),
      );
      expect(
        args.slice(
          args.indexOf("--window-geometry") + 1,
          args.indexOf("--window-geometry") + 5,
        ),
      ).toEqual(["800", "150", "700", "600"]);
      expect(args[1]).toContain("(deny default)");
      expect(args[1]).not.toMatch(/\(allow (network|process-fork)/);
      expect(args[1]).not.toContain(path.join(job, "output"));
      expect(options.detached).toBe(true);
      expect(options.env?.HOME).toBe(path.join(relay, "home"));
      expect(options.env).not.toHaveProperty("OHMYGAME_TEST_SECRET");
      expect(mocks.register).toHaveBeenCalledWith(child);
      expect(
        JSON.parse(
          await readFile(path.join(relay, "view-config.json"), "utf8"),
        ),
      ).toEqual({ labels: blenderLiveViewLabels[language ?? "en"] });
      const first = view.finish(),
        second = view.finish();
      expect(first).toBe(second);
      expect(await first).toEqual({ shown: true, updates: 0 });
      expect(mocks.terminate).toHaveBeenCalledTimes(1);
      expect(existsSync(relay)).toBe(false);
      expect(await readFile(path.join(job, "original.txt"), "utf8")).toBe(
        "unchanged production data",
      );
    },
  );

  it("waits for the final scene to be acknowledged before closing even when production finishes before the first poll", async () => {
    acknowledge = false;
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
    );
    await checkpoint();
    const finished = view.finish();
    await vi.waitFor(() =>
      expect(existsSync(path.join(relay, "status.json"))).toBe(true),
    );
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(existsSync(path.join(relay, "stop.json"))).toBe(false);
    acknowledge = true;
    expect(await finished).toEqual({ shown: true, updates: 1 });
    expect(
      JSON.parse(await readFile(path.join(job, "live-view.json"), "utf8")),
    ).toEqual({ shown: true, updates: 1 });
  });

  it("does not claim an unacknowledged scene was displayed", async () => {
    acknowledge = false;
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
    );
    await checkpoint();
    expect(await view.finish()).toMatchObject({
      shown: true,
      updates: 0,
      warning: expect.stringContaining("not confirmed"),
    });
    expect(existsSync(relay)).toBe(false);
  });

  it("retries a changed snapshot on the next poll without closing the window", async () => {
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
    );
    await checkpoint();
    mocks.conflicts.set(path.join(job, "tmp/live/scene.blend"), 1);
    await vi.waitFor(
      () => expect(existsSync(path.join(relay, "status.json"))).toBe(true),
      { timeout: 1800 },
    );
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(await view.finish()).toEqual({ shown: true, updates: 1 });
  });

  it.each(["linked", "invalid"])(
    "stops a %s scene without changing production files",
    async (kind) => {
      view = await startBlenderLiveView(
        job,
        vi.fn(async () => {}),
      );
      await checkpoint(
        1,
        kind === "invalid" ? "not a Blender scene" : undefined,
      );
      if (kind === "linked") {
        const outside = path.join(directory, "outside.blend");
        await writeFile(outside, "BLENDER-v500-outside");
        await rm(path.join(job, "tmp/live/scene.blend"));
        await symlink(outside, path.join(job, "tmp/live/scene.blend"));
      }
      await vi.waitFor(() => expect(mocks.terminate).toHaveBeenCalled(), {
        timeout: 1200,
      });
      expect(await view.finish()).toMatchObject({
        shown: true,
        updates: 0,
        warning: expect.any(String),
      });
      expect(await readFile(path.join(job, "original.txt"), "utf8")).toBe(
        "unchanged production data",
      );
      expect(existsSync(relay)).toBe(false);
    },
  );

  it("cancels only its owned window without waiting for a scene acknowledgement", async () => {
    acknowledge = false;
    const abort = new AbortController();
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
      abort.signal,
    );
    await checkpoint();
    abort.abort();
    const result = await view.finish();
    expect(result.updates).toBe(0);
    expect(mocks.terminate).toHaveBeenCalledWith(child);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(existsSync(relay)).toBe(false);
  });

  it("checks observer resources before accepting readiness and closes only the observer when its limit is exceeded", async () => {
    const resources = vi.fn(async () => {
      throw new Error("observer memory limit");
    });
    view = await startBlenderLiveView(job, resources);
    expect(resources).toHaveBeenCalledWith(child, relay);
    expect(await view.finish()).toMatchObject({
      shown: false,
      updates: 0,
      warning: "observer memory limit",
    });
    expect(mocks.terminate).toHaveBeenCalledWith(child);
    expect(existsSync(relay)).toBe(false);
    expect(await readFile(path.join(job, "original.txt"), "utf8")).toBe(
      "unchanged production data",
    );
  });

  it("never launches a window if cancelled while resolving its initial placement", async () => {
    let resolveBounds!: (value: undefined) => void;
    mocks.bounds.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBounds = resolve;
        }),
    );
    const abort = new AbortController();
    const started = startBlenderLiveView(
      job,
      vi.fn(async () => {}),
      abort.signal,
    );
    await vi.waitFor(() => expect(mocks.bounds).toHaveBeenCalledOnce());
    abort.abort();
    resolveBounds(undefined);
    view = await started;
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await view.finish()).toMatchObject({
      shown: false,
      updates: 0,
      warning: expect.any(String),
    });
    expect(existsSync(relay)).toBe(false);
  });

  it("retains a pre-existing relay directory instead of deleting unrelated files on setup failure", async () => {
    await mkdir(relay, { recursive: true });
    await writeFile(path.join(relay, "observer.py"), "prior contents");
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await readFile(path.join(relay, "observer.py"), "utf8")).toBe(
      "prior contents",
    );
  });

  it("rejects a linked relay parent before creating or deleting files outside private storage", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, path.dirname(relay));
    view = await startBlenderLiveView(
      job,
      vi.fn(async () => {}),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(existsSync(path.join(outside, path.basename(job)))).toBe(false);
    expect(existsSync(path.dirname(relay))).toBe(true);
  });
});
