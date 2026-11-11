import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { LocalDaemonRuntime } from "./runtime-descriptor.js";

/** Server-side only: pair this request's verified descriptor target and token atomically. */
export function forwardLocalDaemonRequest(incoming: IncomingMessage, outgoing: ServerResponse, runtime: LocalDaemonRuntime): void {
  const requestPath = (incoming.url ?? "/api").replace(/^\/api(?=\/|\?|$)/, "") || "/";
  if (!requestPath.startsWith("/") || requestPath.startsWith("//") || /[\\\x00-\x20]/.test(requestPath)) {
    outgoing.writeHead(400).end("Invalid local API path"); return;
  }
  const target = new URL(requestPath, runtime.url);
  if (target.origin !== new URL(runtime.url).origin) { outgoing.writeHead(400).end("Invalid local API target"); return; }
  const headers = { ...incoming.headers, host: target.host, authorization: `Bearer ${runtime.token}` };
  delete headers.origin;
  delete headers.referer;
  delete headers["proxy-authorization"];
  const upstream = httpRequest(target, { method: incoming.method, headers }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
    response.on("error", () => outgoing.destroy());
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
    outgoing.end("The authenticated local daemon is unavailable");
  });
  incoming.on("aborted", () => upstream.destroy());
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
}
