// Native execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import { QoderDriver, qoderHelperError, type QoderHostConnection } from "../src/daemon/agent-runtimes/qoder.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import type { NativeTurnSink } from "../src/daemon/agent-runtimes/native-session.js";
import type { NativeCodingSession } from "../src/daemon/agent-runtimes/native-session.js";
import type { ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  setAgentProcessSpawner(undefined);
});

function qoderFixture(execute: (signal: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>) {
  let receive!: (message: Record<string, unknown>) => void;
  let turnId = "";
  let calls = 0;
  let stops = 0;
  const replies: Array<{ id: unknown; result: unknown }> = [];
  const results: unknown[] = [];
  const bridge = new ToolBridge([defineTool({ name: "generate_image", label: "Image", description: "Existing controlled media handler",
    parameters: Type.Object({ prompt: Type.String() }),
    execute: async (_id, _args, signal) => { calls++; const result = await execute(signal ?? new AbortController().signal); return { ...result, details: result.details }; },
  })], true);
  const connection: QoderHostConnection = {
    async start() {},
    async request(method, params) {
      if (method === "turn/start") {
        turnId = String(params?.turnId);
        receive({ method: "sdk/message", params: { turnId, message: { type: "system", subtype: "init", session_id: "qoder-session" } } });
      }
      return {};
    },
    respond(id, result) { replies.push({ id, result }); },
    async stop() { stops++; },
  };
  const driver = new QoderDriver({ binaryPath: "/unused/native", workspacePath: "/unused/project", privateDirectory: "/unused/private", env: {},
    instructions: "Use only controlled project tools", bridge, policy: { workspacePath: "/unused/project", neverTouch: [] }, skillDirectories: [], model: "auto" },
  (handler) => { receive = handler; return connection; });
  cleanup.push(() => driver.dispose());
  const sink: NativeTurnSink = {
    text() {}, textDone() {}, thinking() {}, thinkingDone() {}, toolCall() {}, toolStarted() {}, toolUpdate() {},
    toolResult: (id, result, error) => results.push({ id, result, error }), usage() {}, compaction() {}, nativeSession() {},
    async requestApproval() { return "deny"; },
  };
  return { driver, bridge, sink, connection, replies, results, calls: () => calls, stops: () => stops,
    send: (callId: string, options: Record<string, unknown> = {}) => receive({ id: randomRequestId(), method: "tool/call",
      params: { turnId, sessionId: "qoder-session", callId, name: "generate_image", arguments: { prompt: "fixture" }, ...options } }),
    finish: () => receive({ method: "sdk/message", params: { turnId, message: { type: "result", subtype: "success", is_error: false } } }),
    fail: (code: string, message: string) => receive({ method: "sdk/error", params: { turnId, code, message } }),
  };
}

let qoderRequestId = 0;
function randomRequestId() { return `fixture:${++qoderRequestId}`; }
async function qoderStarted() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

it("Qoder reuses a pending/completed call once and retains host artifact details", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const artifact = { content: [{ type: "text" as const, text: "saved once" }], details: { path: "artifact.png", taskId: "original-job" } };
  const f = qoderFixture(async () => { await wait; return artifact; });
  const run = f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, new AbortController().signal);
  await qoderStarted();
  f.send("call-1"); f.send("call-1");
  expect(f.calls()).toBe(1);
  release(); await qoderStarted();
  f.send("call-1"); await qoderStarted();
  expect(f.calls()).toBe(1);
  expect(f.results).toEqual([{ id: "call-1", result: artifact, error: false }]);
  expect(f.replies).toHaveLength(3);
  f.finish(); expect(await run).toEqual({ status: "completed", resultSubtype: "success" });
});

it("Qoder preserves safe initialization failure categories without misreporting a sign-in failure", async () => {
  const f = qoderFixture(async () => ({ content: [] }));
  const run = f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, new AbortController().signal);
  await qoderStarted();
  f.fail("QODER_INVENTORY", "PRIVATE_SDK_ACCOUNT_ERROR_CANARY");
  const result = await run;
  expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("Local CLI compatibility:") });
  expect(result).toMatchObject({ error: expect.stringContaining("tool inventory") });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|sign-in/);
  expect(f.calls()).toBe(0);
});

it("Qoder projects only finite host error codes and discards arbitrary SDK error details", async () => {
  expect(qoderHelperError({ code: "QODER_MCP", message: "PRIVATE_TOKEN_CANARY" }).message).toContain("project tool bridge");
  expect(qoderHelperError({ code: "QODER_POLICY", message: "PRIVATE_TOKEN_CANARY" }).message).toContain("session permissions");
  const protocol = qoderHelperError({ code: "QODER_SDK_DAEMON_PROTOCOL", phase: "session-initialize", message: "PRIVATE_TOKEN_CANARY", details: { auth: "PRIVATE_AUTH_CANARY" } });
  expect(protocol.message).toContain("daemon protocol frame");
  expect(protocol.message).toContain("Stage: session initialization");
  expect(protocol.message).not.toContain("PRIVATE_");
  expect(qoderHelperError({ code: "QODER_INVENTORY", boundary: "skills", message: "PRIVATE_TOKEN_CANARY" }).message).toContain("Mismatched boundary: registered skills");
  expect(qoderHelperError({ code: "QODER_INVENTORY", boundary: "PRIVATE_BOUNDARY_CANARY" }).message).not.toContain("PRIVATE_");
  const refreshed = qoderHelperError({ code: "QODER_RUNTIME_INVENTORY", boundary: "active-tools", phase: "response-stream" }).message;
  expect(refreshed).toContain("existing tool results are retained");
  expect(refreshed).toContain("active tools");
  expect(refreshed).not.toMatch(/no prompt|not sent/i);
  expect(qoderHelperError({ code: "QODER_PROTOCOL", message: "Qoder returned an initialization snapshot for another session" }).message).toContain("initialization snapshot for another session");
  expect(qoderHelperError({ code: "QODER_PROTOCOL", message: "PRIVATE_PROTOCOL_CANARY" }).message).not.toContain("PRIVATE_");
  const arbitrary = qoderHelperError({ code: "PRIVATE_CODE_CANARY", phase: "PRIVATE_PHASE_CANARY", message: "PRIVATE_MESSAGE_CANARY" });
  expect(arbitrary.message).not.toContain("PRIVATE_");
  expect(qoderHelperError({ code: "QODER_SDK_TIMEOUT", phase: "mcp-status" }).message).toContain("timed out. Stage: controlled tool bridge verification");
  for (const value of [undefined, "PRIVATE_TOKEN_CANARY", { code: "PRIVATE_TOKEN_CANARY", message: "PRIVATE_TOKEN_CANARY" }])
    expect(qoderHelperError(value).message).not.toMatch(/PRIVATE_|sign-in/);
  const f = qoderFixture(async () => ({ content: [] }));
  f.connection.request = async () => { throw qoderHelperError({ code: "QODER_POLICY", message: "PRIVATE_TOKEN_CANARY" }); };
  const result = await f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("session permissions") });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN_CANARY");
});

it("Qoder rejects reused IDs with changed arguments and unrelated sessions/turns", async () => {
  const f = qoderFixture(async () => ({ content: [{ type: "text", text: "saved" }] }));
  const run = f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, new AbortController().signal);
  await qoderStarted();
  f.send("call-1"); await qoderStarted();
  f.send("call-1", { arguments: { prompt: "different billable request" } });
  f.send("call-2", { sessionId: "another-project" });
  f.send("call-3", { turnId: "finished-turn" });
  f.send("", {});
  await qoderStarted();
  expect(f.calls()).toBe(1);
  expect(f.replies.slice(1)).toHaveLength(4);
  for (const reply of f.replies.slice(1)) expect(reply.result).toMatchObject({ isError: true });
  f.finish(); await run;
});

it("Qoder planning and argument validation still run inside the host bridge", async () => {
  const f = qoderFixture(async () => ({ content: [{ type: "text", text: "should not execute" }] }));
  f.bridge.setActive([]);
  const run = f.driver.runTurn({ text: "plan", images: [], readOnly: true }, f.sink, new AbortController().signal);
  await qoderStarted(); f.send("blocked"); await qoderStarted();
  expect(f.calls()).toBe(0);
  expect(f.replies[0]?.result).toMatchObject({ isError: true });
  f.bridge.setActive(["generate_image"]);
  f.send("bad-input", { arguments: { prompt: 42 } }); await qoderStarted();
  expect(f.calls()).toBe(0);
  expect(f.replies[1]?.result).toMatchObject({ isError: true });
  f.finish(); await run;
});

it("Qoder disposal can stop the owned helper while its interrupt acknowledgement is stuck", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const f = qoderFixture(async () => ({ content: [] }));
  const request = f.connection.request;
  f.connection.request = async (method, params) => {
    if (method === "turn/interrupt") { await waiting; return {}; }
    return request(method, params);
  };
  const controller = new AbortController();
  const run = f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, controller.signal);
  await qoderStarted();
  controller.abort();
  expect(await run).toEqual({ status: "aborted" });
  expect(f.stops()).toBe(0);
  await f.driver.dispose();
  expect(f.stops()).toBe(1);
  release();
});

it("Qoder cancellation revokes later calls and discards a pending artifact without resubmitting", async () => {
  let release!: () => void;
  let toolSignal: AbortSignal | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const f = qoderFixture(async (signal) => { toolSignal = signal; await wait; return { content: [{ type: "text", text: "late asset" }] }; });
  const controller = new AbortController();
  const run = f.driver.runTurn({ text: "fixture", images: [], readOnly: false }, f.sink, controller.signal);
  await qoderStarted(); f.send("submitted-once");
  controller.abort();
  expect(await run).toEqual({ status: "aborted" });
  expect(toolSignal?.aborted).toBe(true);
  f.send("new-after-cancel"); release(); await qoderStarted();
  expect(f.calls()).toBe(1);
  expect(f.results).toHaveLength(0);
  expect(f.stops()).toBeGreaterThan(0);
});

async function fixture(nestedWorkspace = false, holdConnection = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-bridge-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "opencode");
  await writeFile(
    executable,
    `#!${process.execPath}
console.log("opencode v2.1.0");
`,
    { mode: 0o700 },
  );
  let events: ServerResponse | undefined;
  const tokens: string[] = [];
  const asked: ApprovalRequestDetails[] = [];
  const replies: unknown[] = [];
  let prompts = 0;
  let running = false;
  let pendingConnection: ServerResponse | undefined;
  const emit = (type: string, properties: Record<string, unknown> = {}) =>
    events?.write(
      `data: ${JSON.stringify({ type, data: { sessionID: "session-1", ...properties } })}\n\n`,
    );
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const route = new URL(request.url!, "http://localhost").pathname;
    if (route === "/api/event") {
      events = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (route === "/api/info")
      return response.end(JSON.stringify({ version: "2.1.0" }));
    if (route === "/api/location")
      return response.end(
        JSON.stringify({
          directory: root,
          project: { id: "project", directory: root },
        }),
      );
    if (route === "/api/agent")
      return response.end(
        JSON.stringify({
          data: ["build", "plan"].map((id) => ({
            id,
            permissions: [{ action: "*", resource: "*", effect: "ask" }],
          })),
        }),
      );
    if (route === "/api/permission/saved")
      return response.end(JSON.stringify({ data: [] }));
    if (route === "/api/model")
      return response.end(
        JSON.stringify({
          data: [
            {
              providerID: "test",
              id: "model",
              enabled: true,
              capabilities: { tools: true },
            },
          ],
        }),
      );
    if (route === "/api/session/child-1")
      return response.end(
        JSON.stringify({
          id: "child-1",
          parentID: "session-1",
          location: { directory: workspace },
        }),
      );
    if (route === "/api/session/moved-child")
      return response.end(
        JSON.stringify({
          id: "moved-child",
          parentID: "session-1",
          location: { directory: path.join(root, "another-workspace") },
        }),
      );
    if (route === "/api/session/unrelated")
      return response.end(JSON.stringify({ id: "unrelated" }));
    if (route.includes("/permission/")) {
      replies.push(body);
      response.end("{}");
      return;
    }
    if (route === "/api/experimental/mcp/ohmygame") {
      expect(body.config.codemode).toBe(false);
      tokens.push(body.config.headers.Authorization);
      response.end(JSON.stringify({ ohmygame: { status: "connected" } }));
      return;
    }
    if (route === "/api/experimental/mcp/ohmygame/connect") {
      if (holdConnection) {
        pendingConnection = response;
        return;
      }
      return response.writeHead(204).end();
    }
    if (route === "/api/mcp")
      return response.end(
        JSON.stringify({
          data: [{ name: "ohmygame", status: { status: "connected" } }],
        }),
      );
    if (route?.endsWith("/prompt")) {
      prompts++;
      response.end("{}");
      emit("session.execution.started");
      return;
    }
    if (route?.endsWith("/interrupt")) {
      response.end("{}");
      emit("session.execution.succeeded");
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          id: "session-1",
          location: { directory: workspace },
          permissions: [{ action: "*", resource: "*", effect: "ask" }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    events?.end();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  setAgentProcessSpawner((() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    running = true;
    stdin.on("finish", () => {
      if (!running) return;
      running = false;
      child.exitCode = 0;
      stdout.end();
      child.emit("close", 0, null);
    });
    queueMicrotask(() =>
      stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`),
    );
    return child;
  }) as never);
  const service = new AgentRuntimeService(
    path.join(root, "data"),
    () => "http://127.0.0.1:12345",
  );
  await service.load();
  await service.settings.update("opencode-cli", {
    enabled: true,
    binaryPath: executable,
  });
  cleanup.push(() => service.close());
  let toolSignal: AbortSignal | undefined;
  const echo = defineTool({
    name: "echo_tool",
    label: "Echo",
    description: "Fixture",
    parameters: Type.Object({ wait: Type.Optional(Type.Boolean()) }),
    execute: async (_id, input, signal) => {
      if (!signal)
        throw new Error("The bridge must supply a cancellation signal");
      toolSignal = signal;
      if (input.wait)
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      return {
        content: [{ type: "text", text: "ok" }],
        details: { path: "artifact.png" },
      };
    },
  });
  const workspace = nestedWorkspace ? path.join(root, "workspace") : root;
  const session: NativeCodingSession = await service.createSession({
    runtime: "opencode-cli",
    model: "test/model",
    workspacePath: workspace,
    sessionManager: SessionManager.inMemory(workspace),
    tools: [echo],
    skillDirectories: [],
    instructions: "Fixture",
    policy: { workspacePath: workspace, neverTouch: [] },
    requestApproval: async (details) => {
      asked.push(details);
      return "deny";
    },
  });
  cleanup.push(() => session.dispose());
  const call = (token: string, wait = false) =>
    service.handleBridgeRequest(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo_tool", arguments: { wait } },
    });
  return {
    service,
    session,
    tokens,
    emit,
    call,
    root,
    asked,
    replies,
    prompts: () => prompts,
    signal: () => toolSignal,
    closeEvents: () => events?.end(),
    running: () => running,
    connect: () => pendingConnection?.writeHead(204).end(),
  };
}

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(true || process.platform === "win32")(
  "resolves native read patterns relative to the v2 session location inside a Git worktree",
  async () => {
    const f = await fixture(true);
    const run = f.session.prompt("read sibling");
    await expect.poll(f.prompts).toBe(1);
    f.emit("permission.asked", {
      id: "read-1",
      action: "read",
      resources: ["../outside.txt"],
      metadata: {},
      save: ["*"],
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.asked).toEqual([
      expect.objectContaining({ path: path.join(f.root, "outside.txt") }),
    ]);
    expect(f.replies).toEqual([
      {
        decision: "reject",
        message: expect.stringContaining("OhMyGame denied"),
      },
    ]);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(true || process.platform === "win32")(
  "mediates child-session approvals without admitting unrelated native sessions",
  async () => {
    const f = await fixture(true);
    const run = f.session.prompt("task reading reference");
    await expect.poll(f.prompts).toBe(1);
    f.emit("permission.asked", {
      sessionID: "child-1",
      id: "child-read",
      action: "read",
      resources: ["../reference.txt"],
      metadata: {},
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.asked).toEqual([
      expect.objectContaining({ path: path.join(f.root, "reference.txt") }),
    ]);
    f.emit("permission.asked", {
      sessionID: "unrelated",
      id: "foreign-read",
      action: "read",
      resources: ["../reference.txt"],
      metadata: {},
    });
    await expect.poll(() => f.replies.length).toBe(2);
    f.emit("permission.asked", {
      sessionID: "moved-child",
      id: "moved-read",
      action: "read",
      resources: ["reference.txt"],
    });
    await expect.poll(() => f.replies.length).toBe(3);
    expect(f.asked).toHaveLength(1);
    expect(f.replies).toEqual([
      {
        decision: "reject",
        message: expect.stringContaining("OhMyGame denied"),
      },
      { decision: "reject" },
      { decision: "reject" },
    ]);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(true || process.platform === "win32")(
  "rotates bridge capabilities each turn and permanently rejects a previous turn's token",
  async () => {
    const f = await fixture();
    const first = f.session.prompt("first");
    await expect.poll(f.prompts).toBe(1);
    const oldToken = f.tokens[0]!;
    expect((await f.call(oldToken)).status).toBe(200);
    f.emit("session.execution.succeeded");
    await first;
    expect((await f.call(oldToken)).status).toBe(401);
    const second = f.session.prompt("second");
    await expect.poll(f.prompts).toBe(2);
    expect(f.tokens[1]).not.toBe(oldToken);
    expect((await f.call(oldToken)).status).toBe(401);
    expect((await f.call(f.tokens[1]!)).status).toBe(200);
    f.emit("session.execution.succeeded");
    await second;
    expect((await f.call(f.tokens[1]!)).status).toBe(401);
  },
);

it.skipIf(true || process.platform === "win32")(
  "aborts running bridge tools and revokes their capability when a native turn is cancelled",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("wait for tool");
    await expect.poll(f.prompts).toBe(1);
    const token = f.tokens[0]!;
    const tool = f.call(token, true);
    await expect.poll(f.signal).toBeDefined();
    await f.session.abort();
    await run;
    expect(f.signal()!.aborted).toBe(true);
    expect((await tool).body).toMatchObject({ result: { isError: true } });
    expect((await f.call(token)).status).toBe(401);
    expect(f.running()).toBe(false);
  },
);

it.skipIf(true || process.platform === "win32")(
  "settles a turn and stops the native process if its event stream disconnects",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("event stream disconnect");
    await expect.poll(f.prompts).toBe(1);
    f.closeEvents();
    await run;
    expect(f.running()).toBe(false);
    expect(f.session.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        stopReason: "error",
        errorMessage: "OpenCode event stream disconnected",
      }),
    );
    expect((await f.call(f.tokens[0]!)).status).toBe(401);
  },
);

it.skipIf(true || process.platform === "win32")(
  "waits for the native MCP connection before the model receives its tool catalog",
  async () => {
    const f = await fixture(false, true);
    const run = f.session.prompt("tools");
    await expect.poll(() => f.tokens.length).toBe(1);
    expect(f.prompts()).toBe(0);
    await expect.poll(() => Boolean(f.connect())).toBe(true);
    await expect.poll(f.prompts).toBe(1);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(true || process.platform === "win32")(
  "preserves app tool names and structured results without asking for a second approval",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("tool result");
    await expect.poll(f.prompts).toBe(1);
    f.emit("session.tool.input.started", {
      id: "native-tool",
      name: "ohmygame_echo_tool",
      assistantMessageID: "assistant",
    });
    f.emit("session.tool.called", {
      id: "native-tool",
      input: { wait: false },
      executed: true,
    });
    f.emit("permission.asked", {
      id: "tool-permission",
      action: "ohmygame_echo_tool",
      resources: ["*"],
      source: { type: "tool", id: "native-tool", messageID: "assistant" },
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.replies).toEqual([{ decision: "once" }]);
    expect(f.asked).toEqual([]);
    await f.call(f.tokens[0]!);
    f.emit("session.tool.success", {
      id: "native-tool",
      content: [{ type: "text", text: "native text" }],
      executed: true,
    });
    f.emit("session.execution.succeeded");
    await run;
    expect(f.session.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "echo_tool",
        details: { path: "artifact.png" },
      }),
    );
  },
);
