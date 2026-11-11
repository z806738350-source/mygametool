import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { forwardLocalDaemonRequest } from "../src/daemon/local-development-proxy.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}
it("pairs each dynamic daemon target with its token and streams the response without exposing credentials", async () => {
  const observed: Array<{ url?: string; token?: string; origin?: string; referer?: string }> = [];
  const target = await listen(createServer((request, response) => {
    observed.push({ url: request.url, token: request.headers.authorization, origin: request.headers.origin, referer: request.headers.referer });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"status":"ready"}\n\n'); response.end('data: [DONE]\n\n');
  }));
  let runtime = { url: target, token: "first-fake-daemon-token", pid: 1 };
  const proxy = await listen(createServer((request, response) => forwardLocalDaemonRequest(request, response, runtime)));
  const first = await fetch(`${proxy}/api/health?check=1`, { headers: { authorization: "Bearer untrusted-browser-value", origin: proxy, referer: `${proxy}/settings` } });
  expect(await first.text()).toBe('data: {"status":"ready"}\n\ndata: [DONE]\n\n');
  expect(first.headers.get("authorization")).toBeNull();
  runtime = { ...runtime, token: "rotated-fake-daemon-token" };
  await (await fetch(`${proxy}/api/health`)).text();
  expect(observed).toEqual([
    { url: "/health?check=1", token: "Bearer first-fake-daemon-token", origin: undefined, referer: undefined },
    { url: "/health", token: "Bearer rotated-fake-daemon-token", origin: undefined, referer: undefined },
  ]);
  const blocked = await fetch(`${proxy}/api//untrusted.invalid/steal`);
  expect(blocked.status).toBe(400);
  expect(observed).toHaveLength(2);
});
