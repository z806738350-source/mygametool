import { createServer } from "node:http";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { isAllowedLocalOrigin, isLoopbackHostHeader, localPreviewCsp } from "../shared/local-security.js";
import { SafeProjectFileError } from "./safe-project-file.js";
import { CheckedMediaSnapshotError, CheckedMediaSnapshotStore, type CheckedMediaSnapshot } from "./checked-media-snapshot.js";
import { mediaPreviewReadLimit, mediaSnapshotResponse } from "./media-snapshot-response.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
};

export async function startStaticPreview(
  directory: string,
  port: number,
  options: { mediaSnapshots?: CheckedMediaSnapshotStore } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const root = await realpath(directory);
  const ownDirectory = options.mediaSnapshots ? undefined : await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-static-media-")));
  const snapshots = options.mediaSnapshots ?? new CheckedMediaSnapshotStore(ownDirectory!);
  const scope = `static-preview:${randomUUID()}`;
  const active = new Set<{ controller: AbortController; body?: Readable }>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  const server = createServer((incoming, outgoing) => {
    const state: { controller: AbortController; body?: Readable } = { controller: new AbortController() };
    active.add(state);
    const cancel = () => { state.controller.abort(); state.body?.destroy(); };
    const disconnected = () => { if (!outgoing.writableFinished) cancel(); };
    incoming.once("aborted", cancel);
    outgoing.once("close", disconnected);
    const task = (async () => {
      if (closing) { outgoing.writeHead(503).end(); return; }
      if (!isLoopbackHostHeader(incoming.headers.host) || !isAllowedLocalOrigin(incoming.headers.origin, incoming.headers.host)) {
        outgoing.writeHead(403).end();
        return;
      }
      outgoing.setHeader("content-security-policy", localPreviewCsp(`http://${incoming.headers.host}`));
      outgoing.setHeader("referrer-policy", "no-referrer");
      outgoing.setHeader("x-content-type-options", "nosniff");
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        outgoing.writeHead(405).end();
        return;
      }
      const requestUrl = new URL(incoming.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const parts = pathname.split("/");
      if (
        parts.some((part) => part.startsWith(".") || part === "node_modules")
      ) {
        outgoing.writeHead(403).end();
        return;
      }
      let filename = path.join(root, pathname);
      let redirectDirectory = false;
      try {
        if ((await stat(filename)).isDirectory()) {
          redirectDirectory = !requestUrl.pathname.endsWith("/");
          filename = path.join(filename, "index.html");
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (
          !path.extname(pathname) &&
          incoming.headers.accept?.includes("text/html")
        )
          filename = path.join(root, "index.html");
      }
      filename = await realpath(filename);
      const relative = path.relative(root, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        outgoing.writeHead(403).end();
        return;
      }
      if (relative.split(path.sep).some((part) => part.startsWith(".") || part === "node_modules")) {
        outgoing.writeHead(403).end();
        return;
      }
      if (redirectDirectory) {
        outgoing
          .writeHead(301, {
            location: `${requestUrl.pathname}/${requestUrl.search}`,
            "cache-control": "no-store",
          })
          .end();
        return;
      }
      const contentType = MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
      let snapshot: CheckedMediaSnapshot | undefined;
      try {
        snapshot = await snapshots.acquire(root, filename, {
          maxBytes: mediaPreviewReadLimit(contentType), signal: state.controller.signal, scope,
        });
        const response = mediaSnapshotResponse(snapshot, {
          method: incoming.method, range: incoming.headers.range,
          ifRange: typeof incoming.headers["if-range"] === "string" ? incoming.headers["if-range"] : incoming.headers["if-range"] === undefined ? undefined : "",
          contentType, cacheControl: "no-store", signal: state.controller.signal,
        });
        if (!response.body) {
          await snapshot.release(); snapshot.assertCurrentPolicy(); snapshot = undefined;
          state.controller.signal.throwIfAborted();
          outgoing.writeHead(response.status, response.headers).end();
          return;
        }
        // The stream owns this lease from here, including errors and client cancellation.
        state.body = response.body; snapshot = undefined;
        outgoing.writeHead(response.status, response.headers);
        await pipeline(response.body, outgoing, { signal: state.controller.signal });
      } finally {
        if (state.body && !state.body.destroyed) state.body.destroy();
        await snapshot?.release();
      }
    })().catch((cause) => {
      if (outgoing.destroyed || state.controller.signal.aborted) return;
      const inspection = cause instanceof SafeProjectFileError || cause instanceof CheckedMediaSnapshotError;
      if (!outgoing.headersSent)
        outgoing.writeHead(inspection ? cause.statusCode : cause instanceof URIError ? 400 : 404);
      outgoing.end(inspection ? cause.message : "Preview file not found.");
    }).finally(() => {
      incoming.off("aborted", cancel); outgoing.off("close", disconnected);
      active.delete(state); pending.delete(task);
    });
    pending.add(task);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (cause) {
    await snapshots.evictScope(scope);
    if (ownDirectory) { await snapshots.close(); await rm(ownDirectory, { recursive: true, force: true }); }
    throw cause;
  }
  server.on("error", () => {});
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closingPromise ??= (async () => {
      closing = true;
      for (const state of active) { state.controller.abort(); state.body?.destroy(); }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
      await snapshots.evictScope(scope);
      if (ownDirectory) { await snapshots.close(); await rm(ownDirectory, { recursive: true, force: true }); }
    })(),
  };
}
