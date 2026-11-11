import Fastify, { LogController } from "fastify";
import { expect, it, vi } from "vitest";
import { registerSensitiveValue, sensitiveValueStream } from "../src/shared/sensitive-values.js";
import {
  daemonLoggerOptions,
  logFailedRequests,
} from "../src/daemon/request-log.js";

it("holds credentials split across arbitrary output frames", () => {
  const secret = "vm-output-canary+/long-value";
  registerSensitiveValue(secret);
  for (const value of [secret, encodeURIComponent(secret)]) {
    const input = `start ${value} end`;
    for (let size = 1; size <= input.length; size++) {
      const stream = sensitiveValueStream();
      let output = "";
      for (let i = 0; i < input.length; i += size) output += stream(input.slice(i, i + size));
      output += stream("", true);
      expect(output).toBe("start [redacted] end");
    }
  }
});

it("redacts unlabelled registered credentials before an injected log destination", async () => {
  const lines: string[] = [];
  const app = Fastify({ logger: daemonLoggerOptions({ write: (line) => lines.push(line) }) });
  const secret = 'request-log-canary+/quote"slash\\value';
  registerSensitiveValue(secret);
  app.log.error({ key: "generic-field-canary" }, `Provider replied ${secret} ${encodeURIComponent(secret)}`);
  await app.close();
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const entry = JSON.parse(line);
    expect(entry).not.toHaveProperty("hostname");
    expect(line).not.toContain("request-log-canary");
    expect(line).not.toContain("generic-field-canary");
    expect(line).toContain("[redacted]");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(false);
  }
});

it("redacts the default stdout destination as well", () => {
  const lines: string[] = [];
  const output = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
  try {
    const logger = daemonLoggerOptions();
    registerSensitiveValue("stdout-log-canary-private");
    logger.stream.write(`${JSON.stringify({ level: 50, msg: "failed stdout-log-canary-private" })}\n`);
    expect(JSON.parse(lines[0]!).msg).toBe("failed [redacted]");
    expect(lines.join("")).not.toContain("stdout-log-canary-private");
  } finally { output.mockRestore(); }
});

it("leaves the computer name out of daemon log lines", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: daemonLoggerOptions({ write: (line) => lines.push(line) }),
  });
  app.get("/health", async () => ({ status: "ok" }));

  await app.inject({ method: "GET", url: "/health" });
  await app.close();

  const entries = lines.map((line) => JSON.parse(line));
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).not.toHaveProperty("hostname");
    expect(entry.pid).toBe(process.pid);
  }
});

it("logs each failed request once, by route", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: daemonLoggerOptions({ write: (line) => lines.push(line) }),
    logController: new LogController({ disableRequestLogging: true }),
  });
  logFailedRequests(app);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/projects/:id", async (_request, reply) => reply.code(404).send());
  app.get("/broken", async () => {
    throw new Error("Could not read the project index");
  });

  await app.inject({ method: "GET", url: "/health" });
  await app.inject({
    method: "GET",
    url: "/projects/p-123?path=/Users/someone",
  });
  await app.inject({ method: "GET", url: "/broken" });
  await app.close();

  const entries = lines.map((line) => JSON.parse(line));
  expect(
    entries.map(({ level, msg, route, statusCode }) => ({
      level,
      msg,
      route,
      statusCode,
    })),
  ).toEqual([
    {
      level: 40,
      msg: "Request returned an error",
      route: "/projects/:id",
      statusCode: 404,
    },
    { level: 50, msg: "Request failed", route: "/broken", statusCode: 500 },
  ]);
  expect(entries[1].err.message).toBe("Could not read the project index");
  expect(entries[1].err.stack).toContain(
    "Error: Could not read the project index",
  );
  expect(lines.join("")).not.toContain("p-123");
});
