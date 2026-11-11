import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeAccessToken } from "../src/daemon/access-token.js";
import { createApp } from "../src/daemon/app.js";
import { LOCAL_DEBUG_ACCESS_TOKEN } from "../src/shared/local-debug.js";
import { isAllowedLocalOrigin, isLoopbackHostHeader } from "../src/shared/local-security.js";
import { DAEMON_RUNTIME_FILE, publishLocalDaemonRuntime, readLocalDaemonRuntime } from "../src/daemon/runtime-descriptor.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("desktop daemon access", () => {
  it("protects health and project routes with the process token", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer desktop-secret" },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/projects", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: "Bearer desktop-secret" },
      payload: {},
    })).statusCode).toBe(201);
  });

  it("rejects incorrect bearer tokens regardless of their length", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
    });
    apps.push(app);

    for (const token of ["desktop-secrex", "short", "desktop-secret-extra"]) {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("allows only the configured renderer origin", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
      allowedOrigins: ["http://127.0.0.1:43120"],
    });
    apps.push(app);

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "http://127.0.0.1:43120",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-workspace-version",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:43120");
    expect(String(allowed.headers["access-control-allow-headers"]).split(/\s*,\s*/)).toEqual(
      expect.arrayContaining(["authorization", "content-type", "x-workspace-version", "x-publish-access-token"]),
    );
    expect(allowed.headers["access-control-expose-headers"]).toBe("x-workspace-version");

    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "https://untrusted.example" },
    });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    expect(rejected.statusCode).toBe(403);
  });

  it("rejects rebinding hosts and foreign origins even with a valid bearer or configured foreign origin", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")), accessToken: "secret", allowedOrigins: ["https://foreign.example"] });
    apps.push(app);
    for (const headers of [{ host: "rebind.example:43110" }, { origin: "https://foreign.example" }]) {
      expect((await app.inject({ url: "/health", headers: { ...headers, authorization: "Bearer secret" } })).statusCode).toBe(403);
    }
  });

  it("requires explicit authentication before opening a network listener", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")) });
    apps.push(app);
    expect(() => app.listen({ host: "127.0.0.1", port: 0 })).toThrow("access token is required");
  });

  it("preserves renderer CORS headers on the event stream", async () => {
    const origin = "http://127.0.0.1:43120";
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
      allowedOrigins: [origin],
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: "Bearer desktop-secret" },
      payload: {},
    })).json();
    const controller = new AbortController();

    const response = await fetch(`${address}/projects/${project.id}/events`, {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer desktop-secret",
        origin,
      },
      signal: controller.signal,
    });

    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await response.body?.cancel();
      controller.abort();
    }
  });

  it.each(["http://127.0.0.1:43120", "null"])("rejects retired Community reads while preserving CORS and authentication for %s", async (origin) => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error("Retired Cloud transport called"); });
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-community-cors-")),
      accessToken: "desktop-secret",
      allowedOrigins: [origin],
      localDebug: true,
      publishFetch: transport,
      cloudFetch: transport,
    });
    apps.push(app);

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/community/games?metrics=true",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,x-publish-access-token",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
    expect(String(preflight.headers["access-control-allow-headers"]).split(/\s*,\s*/)).toEqual(
      expect.arrayContaining(["authorization", "x-publish-access-token"]),
    );

    const games = await app.inject({
      method: "GET",
      url: "/community/games?metrics=true",
      headers: { origin, authorization: "Bearer desktop-secret", "x-publish-access-token": LOCAL_DEBUG_ACCESS_TOKEN },
    });
    expect(games.statusCode).toBe(410);
    expect(games.headers["access-control-allow-origin"]).toBe(origin);
    expect(games.json()).toMatchObject({ error: expect.stringContaining("local secure edition") });
    expect((await app.inject({ method: "GET", url: "/community/me/games", headers: { origin, "x-publish-access-token": LOCAL_DEBUG_ACCESS_TOKEN } })).statusCode).toBe(401);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("daemon access token", () => {
  it("takes the token from stdin when the desktop app sends it there", async () => {
    const environment: NodeJS.ProcessEnv = { OHMYGAME_DAEMON_TOKEN_STDIN: "1", PATH: "/usr/bin" };
    expect(await takeAccessToken(environment, Readable.from(["desktop-", "secret"]))).toBe("desktop-secret");
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  it("refuses to start without the token the desktop app said it would send", async () => {
    const environment: NodeJS.ProcessEnv = { OHMYGAME_DAEMON_TOKEN_STDIN: "1", OHMYGAME_DAEMON_TOKEN: "stale" };
    await expect(takeAccessToken(environment, Readable.from([]))).rejects.toThrow("was not received");
    expect(environment).toEqual({});
  });

  it("takes a token given in the environment and removes it from there", async () => {
    const environment: NodeJS.ProcessEnv = { OHMYGAME_DAEMON_TOKEN: "standalone-secret", PATH: "/usr/bin" };
    expect(await takeAccessToken(environment, Readable.from(["ignored"]))).toBe("standalone-secret");
    expect(environment).toEqual({ PATH: "/usr/bin" });
    const token = await takeAccessToken({}, Readable.from([]));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await takeAccessToken({}, Readable.from([]))).not.toBe(token);
  });

  it("rejects oversized stdin tokens without falling back to the environment", async () => {
    const environment: NodeJS.ProcessEnv = { OHMYGAME_DAEMON_TOKEN_STDIN: "1", OHMYGAME_DAEMON_TOKEN: "stale" };
    await expect(takeAccessToken(environment, Readable.from(["a".repeat(4_096), "b"]))).rejects.toThrow("too long");
    expect(environment).toEqual({});
  });

  it("rejects a failed stdin stream without falling back to the environment", async () => {
    const environment: NodeJS.ProcessEnv = { OHMYGAME_DAEMON_TOKEN_STDIN: "1", OHMYGAME_DAEMON_TOKEN: "stale" };
    const input = Readable.from((async function* () {
      yield "partial-token";
      throw new Error("Token pipe failed");
    })());
    await expect(takeAccessToken(environment, input)).rejects.toThrow("Token pipe failed");
    expect(environment).toEqual({});
  });
});

describe("local HTTP boundaries", () => {
  it("only accepts loopback authorities and explicit local cross-origins", () => {
    for (const host of ["127.0.0.1:43110", "localhost:43110", "[::1]:43110"]) expect(isLoopbackHostHeader(host)).toBe(true);
    for (const host of ["remote.example", "127.0.0.1@remote.example", "user@127.0.0.1", "127.0.0.1/path", undefined]) expect(isLoopbackHostHeader(host)).toBe(false);
    expect(isAllowedLocalOrigin("https://remote.example", "localhost", new Set(["https://remote.example"]))).toBe(false);
    expect(isAllowedLocalOrigin("null", "localhost")).toBe(false);
    expect(isAllowedLocalOrigin("null", "localhost", new Set(["null"]))).toBe(true);
    expect(isAllowedLocalOrigin("http://127.0.0.1:43120", "127.0.0.1:43110", new Set(["http://127.0.0.1:43120"]))).toBe(true);
  });

  it("keeps standalone credentials in a private file and only removes its own runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-private-runtime-"));
    const file = path.join(directory, DAEMON_RUNTIME_FILE);
    try {
      const first = { url: "http://127.0.0.1:43110", token: "first-test-secret", pid: 100 };
      const cleanup = await publishLocalDaemonRuntime(directory, first);
      expect(readLocalDaemonRuntime(file)).toEqual(first);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
      const second = { ...first, token: "second-test-secret", pid: 200 };
      const secondCleanup = await publishLocalDaemonRuntime(directory, second);
      await cleanup();
      expect(readLocalDaemonRuntime(file)).toEqual(second);
      if (process.platform !== "win32") {
        await chmod(file, 0o644);
        expect(() => readLocalDaemonRuntime(file)).toThrow("Private daemon runtime");
        await chmod(file, 0o600);
      }
      await secondCleanup();
      expect(() => readLocalDaemonRuntime(file)).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
