import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewManager } from "../src/daemon/preview.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import { isolatedPreviewFixture } from "./isolated-preview-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(isolated = true) {
  const workspacePath = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-isolated-preview-")),
  );
  cleanups.push(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({ scripts: { dev: "node server.mjs" } }),
  );
  await mkdir(path.join(workspacePath, "node_modules"));
  const project: ProjectState = {
    id: "preview-test",
    name: "Game",
    type: "web-game",
    workspacePath,
    updatedAt: new Date(0).toISOString(),
    preview: { status: "stopped" },
  };
  const guest = await isolatedPreviewFixture();
  cleanups.push(guest.close);
  const events = new RuntimeEventBus();
  const manager = new PreviewManager(
    events,
    isolated ? { execution: guest.execution } : {},
  );
  cleanups.push(() => manager.stopAll());
  return { project, manager, guest, events, workspacePath };
}

describe("PreviewManager source-edition execution contracts", () => {
  it("refuses a capacity slot while a preview is live without stopping it or invoking the migration", async () => {
    const { manager, project, guest } = await fixture();
    await manager.start(project);
    const original = { ...project.preview }, task = vi.fn();
    await expect(manager.withExecutionSlot(project, task, false)).rejects.toThrow("Stop the preview yourself");
    expect(task).not.toHaveBeenCalled();
    expect(project.preview).toEqual(original);
    expect(guest.start).toHaveBeenCalledOnce();
    expect(await (await fetch(project.preview.url!)).text()).toBe("ready");
  });
  it("holds an idle capacity slot without launching a preview after completion", async () => {
    const { manager, project, guest } = await fixture();
    await manager.withExecutionSlot(project, async () => {
      await expect(manager.ensureStarted(project)).rejects.toMatchObject({ statusCode: 409 });
    }, false);
    expect(project.preview.status).toBe("stopped");
    expect(guest.start).not.toHaveBeenCalled();
  });
  it("lends the guest to a command or build and resumes an editor preview unless the user stopped it", async () => {
    const { manager, project, guest } = await fixture();
    manager.acquire(project, "editor:current");
    await manager.start(project);
    const borrow = (manualStop: boolean) => manager.withExecutionSlot(project, async () => {
      expect(project.preview).toMatchObject({ status: "stopped", stopReason: "execution" });
      await expect(manager.ensureStarted(project)).rejects.toMatchObject({ statusCode: 409 });
      await expect(manager.withExecutionSlot(project, async () => true)).rejects.toMatchObject({ statusCode: 409 });
      if (manualStop) await manager.stop(project);
      return 7;
    });
    expect(await borrow(false)).toBe(7);
    expect(await (await fetch(project.preview.url!)).text()).toBe("ready");
    expect(guest.start).toHaveBeenCalledTimes(2);
    await borrow(true);
    expect(project.preview).toMatchObject({ status: "stopped", stopReason: "manual" });
  });
  it("preserves static previews and does not turn a first command into a manual preview pause", async () => {
    const { manager, project, guest, workspacePath } = await fixture();
    await manager.withExecutionSlot(project, async () => {});
    expect(project.preview.stopReason).toBeUndefined();
    project.previewMode = "static";
    await writeFile(path.join(workspacePath, "index.html"), "static game");
    const url = await manager.withExecutionSlot(project, () => manager.ensureStarted(project));
    for (const stopPreview of [true, false]) {
      await manager.withExecutionSlot(project, async () => {
        expect(await manager.ensureStarted(project)).toBe(url);
        expect(await (await fetch(url)).text()).toContain("static game");
      }, stopPreview);
    }
    expect(guest.start).not.toHaveBeenCalled();
    expect(project.preview.url).toBe(url);
  });
  it("refuses package scripts without an isolated executor before executing project code", async () => {
    const { manager, project, guest, workspacePath } = await fixture(false);
    await expect(manager.start(project)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(guest.start).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(workspacePath, "server.pid")),
    ).rejects.toThrow();
  });
  it("serves a web story page without running its package scripts", async () => {
    const { manager, project, guest, workspacePath } = await fixture();
    project.type = "interactive-story";
    await writeFile(
      path.join(workspacePath, "index.html"),
      "<p>story page</p>",
    );
    expect(await (await fetch(await manager.start(project))).text()).toContain(
      "story page",
    );
    expect(guest.start).not.toHaveBeenCalled();
  });
  it("uses the isolated npm transport and never executes the project on the host", async () => {
    const { manager, project, guest, workspacePath } = await fixture();
    expect(await (await fetch(await manager.start(project))).text()).toBe(
      "ready",
    );
    expect(guest.start).toHaveBeenCalledWith(
      project,
      "preview",
      workspacePath,
      ["run", "dev"],
      expect.any(Number),
    );
    expect(guest.connection).toHaveBeenCalled();
    await expect(
      readFile(path.join(workspacePath, "server.pid")),
    ).rejects.toThrow();
  });
  it.each(["bun", "pnpm"])(
    "refuses %s projects before contacting the isolated executor",
    async (managerName) => {
      const { manager, project, guest } = await fixture();
      project.packageManager = managerName as "bun" | "pnpm";
      await expect(manager.start(project)).rejects.toThrow("npm projects only");
      expect(guest.start).not.toHaveBeenCalled();
    },
  );
  it("refuses arbitrary command previews even with an isolated executor", async () => {
    const { manager, project, guest } = await fixture();
    project.previewMode = "command";
    project.previewCommand = "unreviewed-command";
    await expect(manager.start(project)).rejects.toThrow(
      "configure an isolated npm script",
    );
    expect(guest.start).not.toHaveBeenCalled();
  });
  it("shares the running isolated preview across concurrent and later opens", async () => {
    const { manager, project, guest } = await fixture();
    const urls = await Promise.all([
      manager.ensureStarted(project),
      manager.ensureStarted(project),
    ]);
    expect(urls[0]).toBe(urls[1]);
    expect(await manager.ensureStarted(project)).toBe(urls[0]);
    expect(guest.start).toHaveBeenCalledOnce();
  });
  it("restarts the isolated job while preserving the saved preview origin", async () => {
    const { manager, project, guest } = await fixture();
    const first = await manager.start(project);
    expect(await manager.start(project)).toBe(first);
    expect(guest.start).toHaveBeenCalledTimes(2);
  });
  it("keeps the running copy and reports invalid replacement inputs on explicit reopen", async () => {
    const { manager, project, guest } = await fixture();
    const first = await manager.ensureStarted(project);
    guest.previewSourceMatches.mockRejectedValue(new Error("Invalid replacement media"));
    manager.acquire(project, "editor:reopened");
    await manager.automatic(project);
    await expect(manager.ensureStarted(project, false)).rejects.toThrow("Invalid replacement media");
    expect(project.preview).toMatchObject({ status: "ready", url: first });
    expect(await (await fetch(first)).text()).toBe("ready");
    expect(guest.stop).not.toHaveBeenCalled();
  });
  it("contains executor launch failure and permits a later launch", async () => {
    const { manager, project, guest, events } = await fixture();
    guest.start.mockRejectedValueOnce(new Error("Guest unavailable"));
    await expect(manager.start(project)).rejects.toThrow("Guest unavailable");
    expect(project.preview.status).toBe("error");
    expect(
      events
        .since(project.id)
        .filter(
          (event) =>
            event.type === "preview.updated" &&
            event.data.preview.status === "error",
        ),
    ).toHaveLength(1);
    expect(await (await fetch(await manager.start(project))).text()).toBe(
      "ready",
    );
  });
  it("reports a readiness failure instead of pretending a guest server is ready", async () => {
    const { manager, project, guest } = await fixture();
    guest.ready.mockRejectedValueOnce(new Error("Guest readiness failed"));
    await expect(manager.start(project)).rejects.toThrow(
      "Guest readiness failed",
    );
    expect(project.preview.status).toBe("error");
  });
  it("reports a guest process exit exactly once without automatically respawning it", async () => {
    const { manager, project, guest, events } = await fixture();
    await manager.start(project);
    guest.children[0]!.emit("exit", 2, null);
    guest.children[0]!.emit("exit", 2, null);
    await vi.waitFor(() => expect(project.preview.status).toBe("error"));
    expect(
      events
        .since(project.id)
        .filter(
          (event) =>
            event.type === "preview.updated" &&
            event.data.preview.status === "error",
        ),
    ).toHaveLength(1);
    expect(guest.start).toHaveBeenCalledOnce();
  });
  it("keeps an explicit manual stop across automatic inspection", async () => {
    const { manager, project, guest } = await fixture();
    manager.acquire(project, "editor");
    await manager.start(project);
    await manager.stop(project);
    await manager.automatic(project);
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "manual",
    });
    expect(guest.start).toHaveBeenCalledOnce();
  });
  it("refuses a disabled General preview even after a previous successful launch", async () => {
    const { manager, project, guest } = await fixture();
    project.type = "general";
    project.webPreviewEnabled = true;
    await manager.start(project);
    project.webPreviewEnabled = false;
    await expect(manager.ensureStarted(project)).rejects.toThrow();
    expect(guest.start).toHaveBeenCalledOnce();
  });
  it("sends only the configured project startup directory to the isolated executor", async () => {
    const { manager, project, guest, workspacePath } = await fixture();
    const nested = path.join(workspacePath, "game");
    await mkdir(nested);
    await writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ scripts: { dev: "node game.mjs" } }),
    );
    project.startupDirectory = "game";
    await manager.start(project);
    expect(guest.start.mock.calls.at(-1)![2]).toBe(nested);
  });
  it("does not launch after a stop during the launching phase", async () => {
    const { manager, project, guest, events } = await fixture();
    let stopping: Promise<void> | undefined;
    const unsubscribe = events.subscribe(project.id, (event) => {
      if (
        event.type === "preview.updated" &&
        event.data.preview.phase === "launching"
      )
        stopping = manager.stop(project);
    });
    try {
      await expect(manager.start(project)).rejects.toThrow("cancelled");
      await stopping;
      expect(guest.start).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it("discards readiness that arrives after a pending launch was stopped", async () => {
    const { manager, project, guest } = await fixture();
    let release!: () => void;
    guest.ready.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = manager.start(project);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(guest.ready).toHaveBeenCalled());
    const stopping = manager.stop(project);
    release();
    await rejected;
    await stopping;
    expect(project.preview.status).toBe("stopped");
    expect(project.preview.url).toBeUndefined();
  });
  it("keeps an empty automatically opened project waiting without launching a job", async () => {
    const { manager, project, guest, workspacePath } = await fixture();
    await rm(path.join(workspacePath, "package.json"));
    project.type = "general";
    project.webPreviewEnabled = true;
    manager.acquire(project, "editor");
    await manager.automatic(project);
    expect(project.preview.status).toBe("waiting");
    expect(guest.start).not.toHaveBeenCalled();
  });
  it("passes configured preview arguments without a host environment or shell command", async () => {
    const { manager, project, guest } = await fixture();
    project.previewArguments = ["--port", "{port}", "--host", "{host}"];
    await manager.start(project);
    expect(guest.start.mock.calls[0]).toEqual([
      project,
      "preview",
      project.workspacePath,
      ["run", "dev", "--", "--port", expect.any(String), "--host", "127.0.0.1"],
      expect.any(Number),
    ]);
  });
});
