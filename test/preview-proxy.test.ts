import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createConnection, type AddressInfo } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { createServer as createViteServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewProxy } from "../src/daemon/preview-proxy.js";
import type { PreviewDiagnostic } from "../src/shared/preview-diagnostics.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("preview content isolation", () => {
  it("does not retain a load error when the browser cancels a buffered HTML response", async () => {
    let started!: () => void, disconnected!: () => void;
    const receiving = new Promise<void>(resolve => { started = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const server = createServer((_incoming, outgoing) => {
      outgoing.once("close", disconnected);
      outgoing.writeHead(200, { "content-type": "text/html" }); outgoing.write("<head></head><body>"); started();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const diagnostic = vi.fn();
    const proxy = await createPreviewProxy(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, diagnostic);
    cleanups.push(() => proxy.close());
    const client = httpRequest(proxy.url); client.on("error", () => {}); client.end();
    await receiving; client.destroy(); await closed;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it.each(["client-cancel", "upstream-error"] as const)("distinguishes %s while opening a VM preview transport", async (failure) => {
    const diagnostic = vi.fn();
    let connected!: (transport: Duplex) => void;
    const connection = new Promise<Duplex>(resolve => { connected = resolve; });
    const proxy = await createPreviewProxy("http://127.0.0.1:9", diagnostic, { createConnection: () => {
      const transport = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); },
        destroy(_error, callback) { callback(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" })); } });
      transport.on("error", () => {}); connected(transport); return transport;
    } });
    cleanups.push(() => proxy.close());
    const response = new Promise<number>(resolve => {
      const client = httpRequest(proxy.url, incoming => { incoming.resume(); resolve(incoming.statusCode!); });
      client.on("error", () => {}); client.end();
      void connection.then(transport => {
        if (failure === "client-cancel") client.destroy();
        else transport.destroy(new Error("VM connection failed"));
      });
      if (failure === "client-cancel") client.once("close", () => resolve(0));
    });
    const transport = await connection;
    const closed = new Promise<void>(resolve => transport.once("close", resolve));
    expect(await response).toBe(failure === "client-cancel" ? 0 : 502);
    await closed;
    if (failure === "client-cancel") expect(diagnostic).not.toHaveBeenCalled();
    else expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "load", message: expect.stringContaining("could not be reached") }));
  });
  it("releases completed pipe-backed transports before the next asset burst", async () => {
    const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end("asset"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const connections = new Set<Duplex>();
    const proxy = await createPreviewProxy("http://127.0.0.1:9", () => {}, {
      createConnection: () => {
        if (connections.size >= 8) throw new Error("connection budget exhausted");
        const socket = createConnection({ host: "127.0.0.1", port });
        const input = new PassThrough(), output = new PassThrough();
        input.pipe(socket);
        socket.pipe(output);
        const pipe = Duplex.from({ readable: output, writable: input });
        pipe.on("error", () => {});
        pipe.once("close", () => socket.destroy());
        connections.add(pipe);
        pipe.once("close", () => connections.delete(pipe));
        return pipe;
      },
    });
    cleanups.push(() => proxy.close());
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${proxy.url}/asset-${i}`, { headers: { connection: "keep-alive" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("asset");
      await vi.waitFor(() => expect(connections.size).toBe(0));
    }
  });

  it("uses a custom VM transport and strips credentials before forwarding", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer((incoming, outgoing) => {
      requests.push(incoming.headers);
      outgoing.writeHead(200, { "content-type": "text/plain" }).end("isolated-stream");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const proxy = await createPreviewProxy("http://127.0.0.1:9", () => {}, {
      createConnection: () => createConnection({ host: "127.0.0.1", port }),
    });
    cleanups.push(() => proxy.close());
    const canary = "preview-vm-key-7a48c922f0be4e5cafed";
    registerSensitiveValue(canary);
    expect(await (await fetch(proxy.url, { headers: { authorization: `Bearer ${canary}`, "x-api-key": canary } })).text()).toBe("isolated-stream");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBeUndefined();
    expect(requests[0]?.["x-api-key"]).toBeUndefined();
    expect((await fetch(`${proxy.url}/?key=${canary}`)).status).toBe(403);
    expect(requests).toHaveLength(1);
  });

  it("moves a live document between editor and player without replacing its client or losing diagnostics", async () => {
    const server = createServer((_incoming, outgoing) => outgoing.writeHead(200, { "content-type": "text/html" }).end("<head></head>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const diagnostic = vi.fn(), navigation = vi.fn();
    const proxy = await createPreviewProxy(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, diagnostic, { onNavigation: navigation });
    cleanups.push(() => proxy.close());
    const html = await (await fetch(`${proxy.url}/scene?__ohmygame_client=shared&__ohmygame_view=editor`)).text();
    const bridge = new URL(html.match(/src="([^"]+bridge[^"]+)"/)![1], proxy.url).href;
    const report = (value: unknown) => fetch(bridge, { method: "POST", headers: { origin: proxy.url }, body: JSON.stringify(value) });
    await report({ type: "diagnostic", path: "/scene?level=2#boss", diagnostic: { kind: "runtime", message: "Game error" } });
    await report({ type: "source", source: "player", path: "/scene?level=2#boss" });
    expect(navigation).toHaveBeenLastCalledWith("shared", "player", "/scene?level=2#boss");
    expect(diagnostic.mock.calls.at(-1)?.[1]).toEqual([expect.objectContaining({ client: "shared", source: "player", message: "Game error" })]);
    expect((await report({ type: "source", source: "playtest" })).status).toBe(400);
    await report({ type: "source", source: "editor", path: "/scene?level=2#boss" });
    expect(diagnostic.mock.calls.at(-1)?.[1]).toEqual([expect.objectContaining({ client: "shared", source: "editor", message: "Game error" })]);
  });
  it("preserves same-origin framework requests and redirects while rejecting foreign origins", async () => {
    let target = "";
    const server = createServer((incoming, outgoing) => {
      if (incoming.url === "/redirect") {
        outgoing
          .writeHead(302, { location: `${target}/scene?level=2#boss` })
          .end();
        return;
      }
      if (incoming.url === "/external") {
        outgoing
          .writeHead(302, { location: "https://example.com/scene" })
          .end();
        return;
      }
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify(incoming.headers));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const proxy = await createPreviewProxy(target, () => {});
    cleanups.push(() => proxy.close());
    const headers = await (
      await fetch(`${proxy.url}/action`, {
        method: "POST",
        headers: {
          origin: proxy.url,
          referer: `${proxy.url}/scene?level=2&__ohmygame_client=editor&__ohmygame_view=editor`,
        },
      })
    ).json();
    expect(headers).toMatchObject({
      host: new URL(target).host,
      origin: target,
      referer: `${target}/scene?level=2`,
    });
    const foreign = await fetch(`${proxy.url}/action`, {
      method: "POST",
      headers: {
        origin: "https://foreign.example",
        referer: "https://foreign.example/scene",
      },
    });
    expect(foreign.status).toBe(403);
    const redirect = await fetch(
      `${proxy.url}/redirect?__ohmygame_client=editor&__ohmygame_view=editor`,
      { redirect: "manual" },
    );
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin).toBe(proxy.url);
    expect(location.pathname).toBe("/scene");
    expect(location.searchParams.get("level")).toBe("2");
    expect(location.searchParams.get("__ohmygame_client")).toBe("editor");
    expect(location.searchParams.get("__ohmygame_view")).toBe("editor");
    expect(location.hash).toBe("#boss");
    expect(
      (
        await fetch(`${proxy.url}/external`, { redirect: "manual" })
      ).headers.get("location"),
    ).toBe("https://example.com/scene");
  });

  it("pushes static reloads immediately and replaces or closes document streams", async () => {
    const server = createServer((_incoming, outgoing) =>
      outgoing
        .writeHead(200, { "content-type": "text/html" })
        .end("<head></head>"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const proxy = await createPreviewProxy(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      () => {},
    );
    cleanups.push(() => proxy.close());
    const html = await (
      await fetch(`${proxy.url}/?__ohmygame_client=editor`)
    ).text();
    const bridge = new URL(
      html.match(/src="([^"]+bridge[^"]+)"/)![1],
      proxy.url,
    ).toString();
    const first = (await fetch(`${bridge}&events=1`)).body!.getReader();
    expect(new TextDecoder().decode((await first.read()).value)).toContain(
      '"reload":0',
    );
    const second = (await fetch(`${bridge}&events=1`)).body!.getReader();
    await second.read();
    expect((await first.read()).done).toBe(true);
    proxy.reload();
    expect(new TextDecoder().decode((await second.read()).value)).toContain(
      '"reload":1',
    );
    await fetch(bridge, {
      method: "POST",
      headers: { origin: proxy.url },
      body: JSON.stringify({ type: "close" }),
    });
    expect((await second.read()).done).toBe(true);
    expect(
      (
        await fetch(
          `${proxy.url}/__ohmygame_preview_bridge__.js?document=999&events=1`,
        )
      ).status,
    ).toBe(404);
    const script = await (await fetch(bridge)).text();
    expect(script).toContain("(() => {");
    expect(script).toContain("send({ type: 'resume' }).then(connectReload)");
  });

  it("forwards pages, binary assets, methods and module errors without changing project files", async () => {
    let broken = true;
    const image = Buffer.from([0, 255, 31, 99]);
    const compressedError = JSON.stringify({
      message: "Compressed module error",
    });
    const server = createServer((request, response) => {
      if (request.url === "/compressed.js") {
        response.writeHead(500, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync(compressedError));
        return;
      }
      if (request.url === "/image") {
        response.end(image);
        return;
      }
      if (request.url === "/entry.js") {
        response.writeHead(broken ? 500 : 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ message: "Missing style.css" }));
        return;
      }
      if (request.method === "POST") {
        request.pipe(response);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "content-length": "13",
      });
      response.end("<head></head>");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const diagnostic = vi.fn();
    const proxy = await createPreviewProxy(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      diagnostic,
    );
    cleanups.push(() => proxy.close());
    const page = await fetch(proxy.url);
    expect(page.headers.get("content-length")).toBeNull();
    expect(await page.text()).toContain("/__ohmygame_preview_bridge__.js");
    expect(
      Buffer.from(await (await fetch(`${proxy.url}/image`)).arrayBuffer()),
    ).toEqual(image);
    expect(
      await (
        await fetch(proxy.url, { method: "POST", body: "request data" })
      ).text(),
    ).toBe("request data");
    expect((await fetch(`${proxy.url}/entry.js`)).status).toBe(500);
    await vi.waitFor(() =>
      expect(diagnostic).toHaveBeenLastCalledWith({
        kind: "compile",
        message: "Missing style.css",
      }),
    );
    broken = false;
    expect((await fetch(`${proxy.url}/entry.js`)).status).toBe(200);
    await vi.waitFor(() =>
      expect(diagnostic).toHaveBeenLastCalledWith(undefined),
    );
    expect(
      await (await fetch(`${proxy.url}/__ohmygame_preview_bridge__.js`)).text(),
    ).toContain("unhandledrejection");
    expect(await (await fetch(`${proxy.url}/compressed.js`)).text()).toBe(
      compressedError,
    );
  });

  it("preserves Vite compilation diagnostics, recovery, and its HMR WebSocket", async () => {
    // Windows runners name the temporary folder with a short 8.3 name, and Vite only serves files below the real path.
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "ohmygame-vite-isolation-")),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "src"));
    await writeFile(
      path.join(directory, "index.html"),
      '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
    );
    await writeFile(
      path.join(directory, "src/main.ts"),
      'import "./style.css"; document.body.dataset.ready = "true";',
    );
    const vite = await createViteServer({
      configFile: false,
      root: directory,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    cleanups.push(() => vite.close());
    const diagnostics: (PreviewDiagnostic | undefined)[] = [];
    const proxy = await createPreviewProxy(
      `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    cleanups.push(() => proxy.close());
    const page = await fetch(proxy.url);
    expect(page.status, await page.text()).toBe(200);
    expect((await fetch(`${proxy.url}/src/main.ts`)).status).toBe(500);
    expect(diagnostics.at(-1)?.message).toContain(
      'Failed to resolve import "./style.css"',
    );
    const client = await (await fetch(`${proxy.url}/@vite/client`)).text();
    const token = client.match(
      /(?:wsToken|webSocketToken)\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(token).toBeTruthy();
    const socket = new WebSocket(
      `${proxy.url.replace("http:", "ws:")}/?token=${token}`,
      "vite-hmr",
    );
    cleanups.push(async () => socket.close());
    const messages: string[] = [];
    socket.addEventListener("message", (event) =>
      messages.push(String(event.data)),
    );
    await vi.waitFor(() =>
      expect(
        messages.some((message) => message.includes('"type":"connected"')),
      ).toBe(true),
    );
    await writeFile(
      path.join(directory, "src/style.css"),
      "body { color: red; }",
    );
    await vi.waitFor(async () =>
      expect((await fetch(`${proxy.url}/src/main.ts`)).status).toBe(200),
    );
    expect(diagnostics.at(-1)).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        messages.some((message) => /full-reload|update/.test(message)),
      ).toBe(true),
    );
  });

  it("clears removed-module errors on navigation and HMR and rejects late or foreign browser reports", async () => {
    let finishOldRequest!: () => void;
    const oldRequestStarted = new Promise<void>((resolve) => {
      finishOldRequest = resolve;
    });
    let respondToOldRequest!: () => void;
    const server = createServer((incoming, outgoing) => {
      if (incoming.url === "/slow.js") {
        finishOldRequest();
        respondToOldRequest = () => {
          outgoing.writeHead(500, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ message: "Late old-page error" }));
        };
      } else if (incoming.url === "/removed.js") {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ message: "Removed entry failed" }));
      } else {
        outgoing.writeHead(200, { "content-type": "text/html" });
        outgoing.end("<head></head><p>New document</p>");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const diagnostic = vi.fn();
    const proxy = await createPreviewProxy(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      diagnostic,
    );
    cleanups.push(() => proxy.close());
    const page = async () => {
      const html = await (await fetch(proxy.url)).text();
      return new URL(
        html.match(/src="([^"]+bridge[^"]+)"/)![1],
        proxy.url,
      ).toString();
    };
    const report = (bridge: string, value: unknown, origin = proxy.url) =>
      fetch(bridge, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const oldBridge = await page();
    await (await fetch(`${proxy.url}/removed.js`)).text();
    expect(diagnostic).toHaveBeenLastCalledWith({
      kind: "compile",
      message: "Removed entry failed",
    });
    const oldResponse = fetch(`${proxy.url}/slow.js`);
    await oldRequestStarted;
    const bridge = await page();
    expect(diagnostic).toHaveBeenLastCalledWith(undefined);
    respondToOldRequest();
    await (await oldResponse).text();
    await report(oldBridge, {
      type: "diagnostic",
      diagnostic: { kind: "runtime", message: "Old document error" },
    });
    expect(diagnostic).toHaveBeenLastCalledWith(undefined);
    const runtimeError = { kind: "runtime", message: "Current document error" };
    expect(
      (
        await report(
          bridge,
          { type: "diagnostic", diagnostic: runtimeError },
          "https://unrelated.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await report(bridge, {
          type: "diagnostic",
          diagnostic: { kind: "unknown", message: "Invalid" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await report(bridge, { type: "diagnostic", diagnostic: runtimeError }))
        .status,
    ).toBe(200);
    expect(diagnostic).toHaveBeenLastCalledWith(runtimeError);
    await (await fetch(`${proxy.url}/removed.js`)).text();
    await report(bridge, { type: "diagnostic", diagnostic: null }); // Clear after a successful HMR update.
    expect(diagnostic).toHaveBeenLastCalledWith(undefined);
  });
});
