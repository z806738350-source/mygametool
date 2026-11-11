import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { isLocalDebugEnabled, isLoopbackHostname, LOCAL_DEBUG_ACCESS_TOKEN, LOCAL_DEBUG_USER } from "../src/shared/local-debug.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local debug mode", () => {
  it.each([
    [false, "", "", false],
    [false, "https://auth.example", "", false],
    [true, "https://auth.example", "key", false],
    [true, "", "", true],
    [true, "https://auth.example", "", true],
    [true, "", "key", true],
    [true, "  ", "  ", true],
  ] as const)("enables debug only in development with missing auth (%s, %s, %s)", (development, url, key, expected) => {
    expect(isLocalDebugEnabled(development, url, key)).toBe(expected);
  });

  it("restricts the debug fallback to loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) expect(isLoopbackHostname(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.10", "ohmygame.ai", "localhost.example"]) expect(isLoopbackHostname(host)).toBe(false);
  });

  it.each([true, false])("does not restore publishing or Community through localDebug=%s", async (localDebug) => {
    const { app, project, cloudFetch } = await runtime(localDebug);
    const file = path.join(project.workspacePath, "index.html");
    await writeFile(file, "Local game stays editable");
    for (const [method, url, payload] of [
      ["POST", `/projects/${project.id}/publish`, { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, title: "Blocked publish" }],
      ["GET", "/community/games", undefined],
      ["GET", "/community/me/games", undefined],
      ["PUT", "/community/games/old-game/like", { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, liked: true }],
      ["DELETE", "/community/games/old-game", { accessToken: LOCAL_DEBUG_ACCESS_TOKEN }],
      ["PUT", "/cloud/session", { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, userId: LOCAL_DEBUG_USER.id }],
    ] as const) {
      const result = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(result.statusCode, result.body).toBe(410);
      expect(result.json().error).toContain("not provided by the local secure edition");
    }
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).json().publication).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("Local game stays editable");
    expect(cloudFetch).not.toHaveBeenCalled();
  });

});

async function runtime(localDebug = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-debug-test-"));
  directories.push(directory);
  const cloudFetch = vi.fn<typeof fetch>(async () => { throw new Error("Debug mode must not call the cloud"); });
  const app = createApp({ dataDirectory: directory, localDebug, publishFetch: cloudFetch });
  apps.push(app);
  const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Debug game", type: "web-game" } });
  expect(created.statusCode).toBe(201);
  return { app, project: created.json<ProjectState>(), cloudFetch };
}
