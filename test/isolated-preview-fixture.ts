import { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import type { IsolatedProjectExecution } from "../src/daemon/isolated-project-execution.js";
import type { ProjectState } from "../src/shared/contracts.js";

/** Fixed loopback HTTP bytes stand in for the guest transport; no project program runs. */
export async function isolatedPreviewFixture(content = "ready") {
  const server = createServer((_request, response) =>
    response.writeHead(200, { "content-type": "text/plain" }).end(content),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const children: ChildProcess[] = [];
  const childProjects = new Map<ChildProcess, string>();
  const retiring = new Set<string>();
  let admission: ((projectId: string) => void) | undefined;
  let closed = false;
  const assertAvailable = (projectId: string) => {
    if (closed) throw new Error("Fixture execution is closing");
    if (retiring.has(projectId))
      throw new Error("Fixture project is being deleted");
    admission?.(projectId);
  };
  const setAdmission = vi.fn((callback: (projectId: string) => void) => {
    admission = callback;
  });
  const start = vi.fn(
    async (
      _project: ProjectState,
      mode: string,
      _cwd: string,
      _args?: string[],
      _port?: number,
    ) => {
      assertAvailable(_project.id);
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      childProjects.set(child, _project.id);
      child.once("close", () => childProjects.delete(child));
      if (mode !== "preview") setImmediate(() => child.emit("close", 0));
      return child;
    },
  );
  const ready = vi.fn(async (_child: ChildProcess) => {});
  const previewSourceMatches = vi.fn(async () => true);
  const settled = vi.fn(async (_child: ChildProcess) => {});
  const stop = vi.fn(async (child: ChildProcess) => {
    child.emit("close", 0);
  });
  const quiesceProject = vi.fn(async (projectId: string) => {
    retiring.add(projectId);
    await Promise.all(
      [...childProjects]
        .filter(([, id]) => id === projectId)
        .map(([child]) => stop(child)),
    );
  });
  const resumeProject = vi.fn((projectId: string) => {
    retiring.delete(projectId);
  });
  // This transport fixture creates no guest volumes or retained source.
  const inventory = vi.fn(async () => ({
    protocolVersion: 2 as const,
    projects: [],
  }));
  const inventoryProject = vi.fn(async (_project: ProjectState) => undefined);
  const retireProject = vi.fn(async (project: ProjectState) => {
    if (!retiring.has(project.id))
      throw new Error("Quiesce the fixture project first");
    return { deleted: true as const, absent: true };
  });
  const recoverSource = vi.fn(async () => {
    throw new Error("The fixture has no retained source to recover");
  });
  const connection = vi.fn(() => createConnection({ host: "127.0.0.1", port }));
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      for (const child of children) child.emit("close", 0);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  const execution = {
    dependenciesInGuest: true,
    setAdmission,
    start,
    ready,
    previewSourceMatches,
    settled,
    stop,
    owns: (child: ChildProcess) => children.includes(child),
    quiesceProject,
    resumeProject,
    inventory,
    inventoryProject,
    retireProject,
    recoverSource,
    connection,
    close,
  } as unknown as IsolatedProjectExecution;
  return {
    execution,
    start,
    ready,
    previewSourceMatches,
    settled,
    stop,
    setAdmission,
    quiesceProject,
    resumeProject,
    inventory,
    inventoryProject,
    retireProject,
    recoverSource,
    connection,
    children,
    close,
  };
}
