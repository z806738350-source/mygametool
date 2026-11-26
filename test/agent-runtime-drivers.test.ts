import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn as spawnFixtureProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";
import { ClaudeCodeDriver } from "../src/daemon/agent-runtimes/claude-code.js";
import * as controlledCodex from "../src/daemon/agent-runtimes/controlled-codex.js";
import * as codexIsolation from "../src/daemon/agent-runtimes/codex-isolation-check.js";
import { CODEX_CONTROLLED_CONFIG, CODEX_TOOL_NAMESPACE, controlledCodexEnvironment } from "../src/daemon/agent-runtimes/controlled-codex.js";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.js";
import { createGameUseTool } from "../src/daemon/playtest-tools.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter } from "../src/shared/playtest.js";
import { controlledQoderEnvironment } from "../src/daemon/agent-runtimes/controlled-qoder.js";
import { createIsolatedRecoveryTool } from "../src/daemon/isolated-shell-tool.js";
import { CodexDriver } from "../src/daemon/agent-runtimes/codex.js";
import * as discovery from "../src/daemon/agent-runtimes/discovery.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import { OpenCodeDriver } from "../src/daemon/agent-runtimes/opencode.js";
import { QoderDriver, qoderHelperError, type QoderHostConnection } from "../src/daemon/agent-runtimes/qoder.js";
import {
  QoderSdkHost,
  runQoderSdkHost,
  type QoderSdkHostDependencies,
} from "../src/daemon/agent-runtimes/qoder-sdk-host.js";
import { createServer, type ServerResponse } from "node:http";
import type { DriverContext } from "../src/daemon/agent-runtimes/driver-context.js";
import type {
  NativeToolResult,
  NativeTurnSink,
} from "../src/daemon/agent-runtimes/native-session.js";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import {
  canonicalPath,
  neverTouchPaths,
} from "../src/daemon/agent-runtimes/policy.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";
import { toolPreflightError } from "../src/daemon/agent-tool-errors.js";
import { conversationItems } from "../src/daemon/agent.js";
import { handoffSummary } from "../src/daemon/agent-runtimes/handoff.js";
import { replayNativeMessages } from "../src/daemon/agent-runtimes/replay.js";
import {
  NativeCodingSession,
  NativeSessionExpiredError,
} from "../src/daemon/agent-runtimes/native-session.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  setAgentProcessSpawner(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface FakeCli {
  exited?: boolean;
  args: string[];
  env: Record<string, string>;
  send(message: unknown): void;
  line(text: string): void;
  exit(code: number): void;
}

/** Replaces the spawner with an in-process CLI that sees what the adapter writes and answers it. */
function fakeCli(
  handle: (
    message: Record<string, unknown>,
    cli: FakeCli,
  ) => void | Promise<void>,
): FakeCli[] {
  const started: FakeCli[] = [];
  setAgentProcessSpawner(((
    _binary: string,
    args: string[],
    options: { env: Record<string, string> },
  ) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: () => true,
    });
    const cli: FakeCli = {
      args,
      env: options.env,
      send: (message) => stdout.write(`${JSON.stringify(message)}\n`),
      line: (text) => stdout.write(`${text}\n`),
      exit: (code) => {
        cli.exited = true;
        child.exitCode = code;
        stdout.end();
        child.emit("close", code, null);
      },
    };
    stdin.on("finish", () => {
      if (child.exitCode === null) cli.exit(0);
    });
    readline
      .createInterface({ input: stdin })
      .on(
        "line",
        (line) => void handle(JSON.parse(line) as Record<string, unknown>, cli),
      );
    started.push(cli);
    void handle({ type: "spawned" }, cli);
    return child;
  }) as never);
  return started;
}

function recordingSink(
  decide: (
    details: ApprovalRequestDetails,
  ) => "allow" | "allow-session" | "deny" = () => "deny",
) {
  const calls: string[] = [];
  const results = new Map<
    string,
    { result: NativeToolResult; isError: boolean }
  >();
  const asked: ApprovalRequestDetails[] = [];
  let sessionId: string | undefined;
  const sink: NativeTurnSink = {
    text: (key, delta) => calls.push(`text:${key}:${delta}`),
    textDone: (key, text) =>
      calls.push(`textDone:${key}${text !== undefined ? `:${text}` : ""}`),
    thinking: (key, delta) => calls.push(`thinking:${key}:${delta}`),
    thinkingDone: (key) => calls.push(`thinkingDone:${key}`),
    toolCall: (callId, name, args) =>
      calls.push(`toolCall:${callId}:${name}:${JSON.stringify(args)}`),
    toolStarted: (callId) => calls.push(`toolStarted:${callId}`),
    toolUpdate: () => {},
    toolResult: (callId, result, isError) => {
      calls.push(`toolResult:${callId}:${isError}`);
      results.set(callId, { result, isError });
    },
    limits: (limits) => calls.push(`limits:${JSON.stringify(limits)}`),
    usage: (usage, contextWindow, tokens) =>
      calls.push(
        `usage:${usage.input}:${usage.output}:${contextWindow ?? ""}:${tokens ?? ""}`,
      ),
    compaction: (phase) => calls.push(`compaction:${phase}`),
    nativeSession: (id) => {
      sessionId = id;
    },
    requestApproval: async (details) => {
      asked.push(details);
      return decide(details);
    },
  };
  return { sink, calls, results, asked, sessionId: () => sessionId };
}

async function context(
  overrides: Partial<DriverContext> = {},
  toolName = "echo_tool",
): Promise<DriverContext> {
  const privateDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-agent-"),
  );
  cleanup.push(() => rm(privateDirectory, { recursive: true, force: true }));
  const echo = defineTool({
    name: toolName,
    label: "Echo",
    description: "Echo a value",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, input) => ({
      content: [{ type: "text", text: `echo ${input.value}` }],
      details: {
        artifact: { type: "image", path: "art.png", mediaType: "image/png" },
      },
    }),
  });
  return {
    binaryPath: "/usr/local/bin/fake",
    workspacePath: "/tmp/workspace",
    env: {},
    privateDirectory,
    instructions: "Project instructions",
    bridge: new ToolBridge([echo] as never),
    policy: { workspacePath: "/tmp/workspace", neverTouch: ["/tmp/secrets"] },
    skillDirectories: [],
    model: "sonnet",
    reasoningLevel: "high",
    ...overrides,
  };
}

// Legacy execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
describe.skip("Claude Code adapter", () => {
  it("reports a missing resumed session returned as a terminal CLI error", async () => {
    fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user")
        cli.send({
          type: "result",
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: expired"],
        });
    });
    const driver = new ClaudeCodeDriver(await context({ resume: "expired" }));
    cleanup.push(() => driver.dispose());
    await expect(
      driver.runTurn(
        { text: "continue", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
  });

  it("checks every tool through the policy hook, including reads that need no native approval", async () => {
    let decision: unknown;
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user")
        cli.send({
          type: "control_request",
          request_id: "hook",
          request: {
            subtype: "hook_callback",
            callback_id: "ohmygame-policy",
            tool_use_id: "read-1",
            input: {
              hook_event_name: "PreToolUse",
              tool_name: "Read",
              tool_input: { file_path: "/tmp/secrets/auth.json" },
            },
          },
        });
      if (
        message.type === "control_response" &&
        (message.response as Record<string, unknown>).request_id === "hook"
      ) {
        decision = (
          (message.response as Record<string, unknown>).response as Record<
            string,
            unknown
          >
        ).hookSpecificOutput;
        cli.send({ type: "result", subtype: "success" });
      }
    });
    const driver = new ClaudeCodeDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "read protected file", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(clis).toHaveLength(1);
    expect(decision).toMatchObject({ permissionDecision: "deny" });
    expect(recorded.asked).toEqual([]);
  });

  it("lets Claude Code's own bookkeeping tools run without asking and points planning at update_plan", async () => {
    const hook = async (
      tool: string,
      readOnly: boolean,
      toolInput: Record<string, unknown> = tool === "Write"
        ? { file_path: "/tmp/workspace/a.txt" }
        : {},
    ) => {
      let output: Record<string, unknown> | undefined;
      fakeCli((message, cli) => {
        if (message.type === "control_request")
          cli.send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          });
        if (message.type === "user")
          cli.send({
            type: "control_request",
            request_id: "hook",
            request: {
              subtype: "hook_callback",
              callback_id: "ohmygame-policy",
              tool_use_id: `${tool}-1`,
              input: {
                hook_event_name: "PreToolUse",
                tool_name: tool,
                tool_input: toolInput,
              },
            },
          });
        if (
          message.type === "control_response" &&
          (message.response as Record<string, unknown>).request_id === "hook"
        ) {
          output = (
            (message.response as Record<string, unknown>).response as Record<
              string,
              Record<string, unknown>
            >
          ).hookSpecificOutput;
          cli.send({ type: "result", subtype: "success" });
        }
      });
      const driverContext = await context();
      // Claude Code runs commands in its sandbox; planning still may not change anything.
      driverContext.policy = {
        ...driverContext.policy,
        sandboxedCommands: true,
      };
      const driver = new ClaudeCodeDriver(driverContext);
      cleanup.push(() => driver.dispose());
      const recorded = recordingSink(() => "allow");
      await driver.runTurn(
        { text: "work", images: [], readOnly },
        recorded.sink,
        new AbortController().signal,
      );
      return { output, asked: recorded.asked.length };
    };
    for (const tool of ["TodoWrite", "Skill", "Task", "WebSearch"])
      for (const readOnly of [false, true])
        expect(await hook(tool, readOnly)).toEqual({
          output: expect.objectContaining({ permissionDecision: "allow" }),
          asked: 0,
        });
    expect(await hook("ExitPlanMode", true)).toEqual({
      output: expect.objectContaining({
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("update_plan"),
      }),
      asked: 0,
    });
    expect(await hook("Write", true)).toEqual({
      output: expect.objectContaining({ permissionDecision: "deny" }),
      asked: 0,
    });
    // Current CLIs have no Glob/Grep: planning may run read commands the policy allows, and nothing else.
    for (const [command, decision] of [
      ["grep -rn player src", "allow"],
      ["ls -la", "allow"],
      ["touch a.txt", "deny"],
      ["cat a.txt > b.txt", "deny"],
    ] as const)
      expect(await hook("Bash", true, { command })).toEqual({
        output: expect.objectContaining({ permissionDecision: decision }),
        asked: 0,
      });
    expect(await hook("Bash", true, { command: "npm install" })).toEqual({
      output: expect.objectContaining({ permissionDecision: "deny" }),
      asked: 0,
    });
    expect(await hook("Bash", false, { command: "npm install" })).toEqual({
      output: expect.objectContaining({ permissionDecision: "allow" }),
      asked: 0,
    });
    expect(await hook("Write", false)).toEqual({
      output: expect.objectContaining({ permissionDecision: "allow" }),
      asked: 0,
    });
  });

  it("reports Claude's subscription windows, keeping each until it is reported again", async () => {
    fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type !== "user") return;
      cli.send({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.13, resetsAt: 100 },
            seven_day: { utilization: 0.33, resetsAt: 200 },
          },
        },
      });
      // An older CLI reports only the window that limits it now.
      cli.send({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 1.2,
          resetsAt: 100,
        },
      });
      cli.send({ type: "result", subtype: "success" });
    });
    const driver = new ClaudeCodeDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    await driver.runTurn(
      { text: "work", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    const reports = recorded.calls
      .filter((call) => call.startsWith("limits:"))
      .map((call) => JSON.parse(call.slice("limits:".length)));
    expect(reports.at(-1)).toEqual([
      {
        id: "claude/five_hour",
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: 100,
      },
      {
        id: "claude/seven_day",
        usedPercent: 33,
        windowMinutes: 10080,
        resetsAt: 200,
      },
    ]);
  });

  it("runs without its sandbox or session caches in full access", async () => {
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user")
        cli.send({ type: "result", subtype: "success" });
    });
    const full = await context();
    full.policy = { ...full.policy, fullAccess: true };
    const driver = new ClaudeCodeDriver(full);
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "work", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(clis[0]!.args).not.toContain("--settings");
    expect(clis[0]!.env).not.toHaveProperty("npm_config_cache");
  });

  it("shows an allowed Claude tool as running until its result, whichever is reported first", async () => {
    for (const hookFirst of [false, true]) {
      const toolUse = {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      };
      fakeCli((message, cli) => {
        if (message.type === "control_request")
          cli.send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          });
        if (message.type === "user") {
          if (!hookFirst) cli.send(toolUse);
          cli.send({
            type: "control_request",
            request_id: "hook",
            request: {
              subtype: "hook_callback",
              callback_id: "ohmygame-policy",
              tool_use_id: "t1",
              input: {
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "ls" },
              },
            },
          });
        }
        if (
          message.type === "control_response" &&
          (message.response as Record<string, unknown>).request_id === "hook"
        ) {
          if (hookFirst) cli.send(toolUse);
          cli.send({
            type: "user",
            parent_tool_use_id: null,
            message: {
              content: [
                { type: "tool_result", tool_use_id: "t1", content: "a.txt" },
              ],
            },
          });
          cli.send({ type: "result", subtype: "success" });
        }
      });
      const driver = new ClaudeCodeDriver(await context());
      cleanup.push(() => driver.dispose());
      const recorded = recordingSink();
      await driver.runTurn(
        { text: "list", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      );
      const tool = recorded.calls.filter((call) => call.includes(":t1"));
      expect(tool.at(-1)).toBe("toolResult:t1:false");
      // An early start for a call not yet reported is ignored by the recorder; the replay counts.
      expect(tool.lastIndexOf("toolStarted:t1")).toBeGreaterThan(
        tool.findIndex((call) => call.startsWith("toolCall:t1")),
      );
    }
  });

  it("stops a native process when interrupt is acknowledged without a terminal result", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user") started();
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new ClaudeCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("wait");
    await ready;
    await session.abort();
    await run;
    expect(clis[0]!.exited).toBe(true);
  });

  it("does not send input after cancellation during initialize", async () => {
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const users: unknown[] = [];
    fakeCli((message) => {
      if (message.type === "spawned") spawned();
      if (message.type === "user") users.push(message);
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new ClaudeCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("cancel during startup");
    await ready;
    await session.abort();
    await run;
    expect(users).toEqual([]);
  });

  it("forwards a native effort without filtering it through a hard-coded Pi enum", async () => {
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user")
        cli.send({ type: "result", subtype: "success" });
    });
    const driver = new ClaudeCodeDriver(
      await context({ reasoningLevel: "custom-effort" }),
    );
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "go", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining(["--effort", "custom-effort"]),
    );
  });

  it("does not launch any CLI for an already aborted turn", async () => {
    const clis = fakeCli(() => {});
    const ctx = await context();
    const controller = new AbortController();
    controller.abort();
    for (const Driver of [ClaudeCodeDriver, CodexDriver, OpenCodeDriver]) {
      const driver = new Driver(ctx);
      expect(
        await driver.runTurn(
          { text: "cancelled", images: [], readOnly: false },
          recordingSink().sink,
          controller.signal,
        ),
      ).toEqual({ status: "aborted" });
      await driver.dispose();
    }
    expect(clis).toEqual([]);
  });
  it("streams a turn, answers OhMyGame's tools over its pipe and asks before risky commands", async () => {
    const pending = new Map<
      string,
      (response: Record<string, unknown>) => void
    >();
    let next = 0;
    const ask = (cli: FakeCli, request: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = `cli-${++next}`;
        pending.set(id, resolve);
        cli.send({ type: "control_request", request_id: id, request });
      });
    const clis = fakeCli(async (message, cli) => {
      if (message.type === "control_response") {
        const response = message.response as {
          request_id: string;
          response?: Record<string, unknown>;
        };
        pending.get(response.request_id)?.(response.response ?? {});
        return;
      }
      if (message.type === "control_request") {
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
        return;
      }
      if (message.type !== "user") return;
      cli.send({
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "m1" } },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Checking" },
        },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_stop", index: 0 },
      });
      cli.send({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__ohmygame__echo_tool",
              input: { value: "x" },
            },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "Bash",
              input: { command: "git push" },
            },
            {
              type: "tool_use",
              id: "toolu_3",
              name: "ToolSearch",
              input: { query: "select:x" },
            },
          ],
        },
      });
      // OhMyGame's own tool needs no permission and runs in the daemon.
      expect(
        await ask(cli, {
          subtype: "can_use_tool",
          tool_name: "mcp__ohmygame__echo_tool",
          mcp_server: { name: "ohmygame" },
          input: { value: "x" },
          tool_use_id: "toolu_1",
        }),
      ).toMatchObject({ behavior: "allow" });
      const mcp = await ask(cli, {
        subtype: "mcp_message",
        server_name: "ohmygame",
        message: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "echo_tool",
            arguments: { value: "x" },
            _meta: { "claudecode/toolUseId": "toolu_1" },
          },
        },
      });
      expect(mcp).toEqual({
        mcp_response: {
          jsonrpc: "2.0",
          id: 7,
          result: { content: [{ type: "text", text: "echo x" }] },
        },
      });
      cli.send({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "echo x" }],
            },
          ],
        },
      });
      expect(
        await ask(cli, {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "git push" },
          tool_use_id: "toolu_2",
        }),
      ).toMatchObject({ behavior: "deny" });
      cli.send({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: "The user did not allow this.",
              is_error: true,
            },
          ],
        },
      });
      cli.send({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m2",
          content: [{ type: "text", text: "Done" }],
          // The last request; the result below adds up both of the turn's requests.
          usage: {
            input_tokens: 4,
            output_tokens: 5,
            cache_read_input_tokens: 96,
            cache_creation_input_tokens: 0,
          },
        },
      });
      cli.send({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 14,
          output_tokens: 9,
          cache_read_input_tokens: 186,
          cache_creation_input_tokens: 0,
        },
        modelUsage: { sonnet: { contextWindow: 200_000 } },
      });
    });
    const driverContext = await context();
    const driver = new ClaudeCodeDriver(driverContext);
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const outcome = await driver.runTurn(
      { text: "go", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "completed" });
    const args = clis[0]!.args;
    expect(args).toEqual(
      expect.arrayContaining([
        "--permission-prompt-tool",
        "stdio",
        "--model",
        "sonnet",
        "--effort",
        "high",
        "--disallowedTools",
        "mcp__ohmygame-studio",
        "--append-system-prompt",
        "Project instructions",
      ]),
    );
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).toContain("--session-id");
    // Commands run in Claude's OS sandbox: protected roots unreadable, no opting out.
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    const commandTemporary = canonicalPath(
      path.join(driverContext.privateDirectory, "tmp"),
    );
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: [canonicalPath("/tmp/secrets")],
        allowRead: [canonicalPath("/tmp/workspace"), commandTemporary],
        allowWrite: [commandTemporary],
      },
    });
    // Work that reports after the turn's result would have no turn to land in.
    // Installs fill session caches, the home folder's being unwritable there.
    expect(clis[0]!.env).toMatchObject({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_CRON: "1",
      npm_config_cache: path.join(
        driverContext.privateDirectory,
        "tmp",
        "npm-cache",
      ),
    });
    expect(recorded.sessionId()).toBe("claude-session-1");
    expect(recorded.calls).toEqual([
      "text:m1:0:Checking",
      "textDone:m1:0",
      'toolCall:toolu_1:echo_tool:{"value":"x"}',
      'toolCall:toolu_2:bash:{"command":"git push"}',
      "toolResult:toolu_1:false",
      "toolResult:toolu_2:true",
      "textDone:m2:0:Done",
      "usage:4:5:200000:100",
    ]);
    // The record keeps the tool's own result, with its artifact, rather than MCP's text.
    expect(recorded.results.get("toolu_1")?.result.details).toEqual({
      artifact: { type: "image", path: "art.png", mediaType: "image/png" },
    });
    expect(recorded.asked).toEqual([
      expect.objectContaining({
        kind: "command",
        tool: "Bash",
        command: "git push",
      }),
    ]);
  });

  it("resumes the session it was given and reports a CLI that exits mid-turn", async () => {
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user") setTimeout(() => cli.exit(1), 5);
    });
    const driver = new ClaudeCodeDriver(
      await context({ resume: "earlier-session" }),
    );
    cleanup.push(() => driver.dispose());
    const outcome = await driver.runTurn(
      { text: "go", images: [], readOnly: true },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Claude Code exited with code 1"),
    });
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining([
        "--resume",
        "earlier-session",
        "--permission-mode",
        "default",
      ]),
    );
    expect(clis[0]!.args).not.toContain("--strict-mcp-config");
    // The person's own configuration may connect Claude Code to OhMyGame from outside.
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining(["--disallowedTools", "mcp__ohmygame-studio"]),
    );
  });
});

/** The filesystem of each permission profile Codex is started with. */
async function codexProfiles(
  overrides: Partial<DriverContext> = {},
): Promise<Array<Record<string, unknown>>> {
  let config: Record<string, unknown> = {};
  fakeCli((message, cli) => {
    if (typeof message.method !== "string" || message.id === undefined)
      return;
    const params = message.params as Record<string, unknown>;
    if (message.method === "thread/start")
      config = params.config as Record<string, unknown>;
    cli.send({
      id: message.id,
      result:
        message.method === "thread/start"
          ? {
              thread: { id: "thread-1" },
              activePermissionProfile: { id: params.permissions },
            }
          : {},
    });
    if (message.method === "turn/start")
      setTimeout(() =>
        cli.send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        }),
      );
  });
  const driver = new CodexDriver(await context(overrides));
  cleanup.push(() => driver.dispose());
  await driver.runTurn(
    { text: "hi", images: [], readOnly: false },
    recordingSink().sink,
    new AbortController().signal,
  );
  const profiles = config.permissions as Record<
    string,
    { filesystem: Record<string, unknown> }
  >;
  expect(Object.keys(profiles)).toHaveLength(2);
  return Object.values(profiles).map(({ filesystem }) => filesystem);
}

// Legacy execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
describe.skip("Codex adapter", () => {
  const generatedPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

  function imageCli(item: Record<string, unknown>, options: { started?: boolean; duplicate?: boolean } = {}) {
    return fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined) return;
      const params = message.params as Record<string, unknown>;
      cli.send({ id: message.id, result: message.method === "thread/start"
        ? { thread: { id: "image-thread" }, activePermissionProfile: { id: params.permissions } }
        : {} });
      if (message.method !== "turn/start") return;
      setTimeout(() => {
        if (options.started) cli.send({ method: "item/started", params: { item: { ...item, status: "inProgress", result: "" } } });
        cli.send({ method: "item/completed", params: { item } });
        if (options.duplicate) cli.send({ method: "item/completed", params: { item } });
        cli.send({ method: "item/completed", params: { item: { type: "agentMessage", id: "final", text: "Here is your cat." } } });
        cli.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      });
    });
  }

  it.each([true, false])("delivers native images once and waits for project import (started=%s)", async (started) => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", revisedPrompt: "Orange cat", result: generatedPng }, { started, duplicate: true });
    let finish!: (path: string) => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const saveGeneratedImage = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; markImportStarted(); }));
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    let completed = false;
    const run = driver.runTurn({ text: "cat", images: [], readOnly: false }, recorded.sink, new AbortController().signal)
      .then((outcome) => { completed = true; return outcome; });
    await importStarted;
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    expect(saveGeneratedImage).toHaveBeenCalledWith(expect.stringMatching(/^codex-[a-f0-9]{24}\.png$/), Buffer.from(generatedPng, "base64"), "Orange cat");
    finish("assets/generated/cat.png");
    expect(await run).toEqual({ status: "completed" });
    expect(recorded.results.get("cat")).toMatchObject({ isError: false, result: {
      details: { artifact: { type: "image", path: "assets/generated/cat.png", mediaType: "image/png" } },
    } });
    expect(recorded.calls.filter((call) => call.startsWith("toolResult:cat:"))).toHaveLength(1);
  });

  it.each(["failed", "invalid", "save", "planning"])("surfaces %s native image delivery failures", async (failure) => {
    imageCli({ type: "imageGeneration", id: "cat", status: failure === "failed" ? "failed" : "completed", result: failure === "invalid" ? "not-an-image" : generatedPng });
    const saveGeneratedImage = vi.fn(async () => {
      if (failure === "save") throw new Error("disk full");
      return "assets/generated/cat.png";
    });
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    expect(await driver.runTurn({ text: "cat", images: [], readOnly: failure === "planning" }, recorded.sink, new AbortController().signal))
      .toMatchObject({ status: "failed", error: expect.stringContaining("Codex image could not be delivered") });
    expect(recorded.results.get("cat")?.isError).toBe(true);
    if (failure !== "save") expect(saveGeneratedImage).not.toHaveBeenCalled();
  });

  it("does not publish a late image result after cancellation", async () => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", result: generatedPng });
    let finish!: (path: string) => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const saveGeneratedImage = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; markImportStarted(); }));
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const abort = new AbortController();
    const run = driver.runTurn({ text: "cat", images: [], readOnly: false }, recorded.sink, abort.signal);
    await importStarted;
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    abort.abort();
    finish("assets/generated/cat.png");
    expect(await run).toEqual({ status: "aborted" });
    expect(recorded.results.size).toBe(0);
  });

  it("retains the project artifact across a transcript reopen without storing image Base64", async () => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", result: generatedPng });
    const ctx = await context();
    const savedPath = path.join(ctx.privateDirectory, "cat.png");
    ctx.saveGeneratedImage = async (_name, bytes) => {
      await writeFile(savedPath, bytes);
      return "assets/generated/cat.png";
    };
    const manager = SessionManager.create(ctx.workspacePath, ctx.privateDirectory);
    const session = new NativeCodingSession({
      runtime: "codex-cli", model: "gpt-test", sessionManager: manager, toolNames: [],
      createDriver: () => new CodexDriver(ctx), requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Generate a cat");
    expect(await readFile(savedPath)).toEqual(Buffer.from(generatedPng, "base64"));
    const transcript = await readFile(manager.getSessionFile()!, "utf8");
    expect(transcript).not.toContain(generatedPng);
    const reopened = SessionManager.open(manager.getSessionFile()!);
    expect(conversationItems(reopened.getBranch())).toContainEqual(expect.objectContaining({
      type: "dynamicToolCall", tool: "generate_image", status: "completed",
      artifact: { type: "image", path: "assets/generated/cat.png", mediaType: "image/png" },
    }));
  });

  it.each([false, true])(
    "checks the probe permission profile before offering models (sandbox error=%s)",
    async (failure) => {
      const messages: Array<Record<string, any>> = [];
      fakeCli((message, cli) => {
        if (typeof message.method !== "string" || message.id === undefined)
          return;
        messages.push(message);
        const params = message.params as Record<string, any>;
        if (failure && message.method === "thread/start") {
          cli.send({
            id: message.id,
            error: {
              message:
                "elevated Windows sandbox requires effective :root read access",
            },
          });
          return;
        }
        cli.send({
          id: message.id,
          result:
            message.method === "thread/start"
              ? {
                  thread: { id: "probe" },
                  activePermissionProfile: { id: params.permissions },
                }
              : message.method === "model/list"
                ? { data: [{ id: "fixture-model" }] }
                : {},
        });
      });
      // Version and sign-in do not use the app-server transport under test.
      vi.spyOn(discovery, "probeVersion").mockResolvedValue("0.164.0");
      vi.spyOn(discovery, "probeAuth").mockResolvedValue({
        status: "signed-in",
        billing: "subscription",
      });
      const ctx = await context();
      const service = new AgentRuntimeService(
        ctx.privateDirectory,
        () => undefined,
      );
      cleanup.push(() => service.close());
      await service.load();
      const status = await service.update("codex-cli", {
        enabled: true,
        binaryPath: process.execPath,
      });
      const start = messages.find(
        (message) => message.method === "thread/start",
      )!;
      expect(start.params).toMatchObject({
        ephemeral: true,
        config: {
          permissions: {
            [start.params.permissions]: {
              filesystem: {
                [process.platform === "win32" ? ":root" : ":minimal"]: "read",
                ":workspace_roots": { ".": "read" },
              },
            },
          },
        },
      });
      if (failure) {
        expect(status.diagnostics).toEqual([
          expect.objectContaining({
            code: "runtime-incompatible",
            capability: "Windows sandbox filesystem read restrictions",
            message: expect.stringContaining("effective :root read access"),
          }),
        ]);
        expect((await service.models()).models).toEqual([]);
        expect(messages.map((message) => message.method)).not.toContain(
          "model/list",
        );
      } else {
        expect(status.diagnostics).toEqual([]);
        expect(await service.model("codex-cli", "fixture-model")).toBeDefined();
        expect(messages.map((message) => message.method)).toContain(
          "model/list",
        );
      }
      expect(messages.map((message) => message.method)).not.toContain(
        "turn/start",
      );
    },
  );

  it("reports the exact elevated Windows sandbox error before sending conversation input", async () => {
    const methods: string[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      methods.push(message.method);
      cli.send(
        message.method === "thread/start"
          ? {
              id: message.id,
              error: {
                message:
                  "elevated Windows sandbox requires effective :root read access",
              },
            }
          : { id: message.id, result: {} },
      );
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    expect(
      await driver.runTurn(
        { text: "must not send", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "Local CLI compatibility: Codex's elevated Windows sandbox requires effective :root read access",
      ),
    });
    expect(methods).not.toContain("turn/start");
  });

  it("fails before sending input when the CLI ignores named filesystem permissions", async () => {
    const methods: string[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      methods.push(message.method);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? { thread: { id: "old-thread" } }
            : {},
      });
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    expect(
      await driver.runTurn(
        { text: "must not send", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("filesystem permissions"),
    });
    expect(methods).not.toContain("turn/start");
  });

  it("registers every OhMyGame tool when a thread starts in planning, so later turns can use them", async () => {
    const threads: Array<Record<string, unknown>> = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start") threads.push(params);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start" ||
          message.method === "thread/resume"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const driverContext = await context();
    // A planning turn offers only the read-only tools; echo_tool stands for a media tool here.
    driverContext.bridge.setActive([]);
    const driver = new CodexDriver(driverContext);
    cleanup.push(() => driver.dispose());
    for (const readOnly of [true, false])
      expect(
        await driver.runTurn(
          { text: "plan, then build", images: [], readOnly },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).toEqual({ status: "completed" });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.dynamicTools).toEqual([
      expect.objectContaining({ name: "ohmygame_echo_tool" }),
    ]);
  });

  it("uses Codex's own full-access profile for work and keeps planning read-only", async () => {
    const profiles: unknown[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (
        ["thread/start", "thread/resume", "turn/start"].includes(message.method)
      )
        profiles.push(params.permissions);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start" ||
          message.method === "thread/resume"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const full = await context();
    full.policy = { ...full.policy, fullAccess: true };
    const driver = new CodexDriver(full);
    cleanup.push(() => driver.dispose());
    for (const readOnly of [false, true])
      expect(
        await driver.runTurn(
          { text: "go", images: [], readOnly },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).toEqual({ status: "completed" });
    // Work runs unsandboxed; the planning turn names the read-only profile.
    expect(profiles.slice(0, 2)).toEqual([
      ":danger-full-access",
      ":danger-full-access",
    ]);
    expect(profiles.at(-1)).toMatch(/^ohmygame-.*-read$/);
  });

  it("leaves out an external OhMyGame connection from the person's own configuration", async () => {
    let config: Record<string, unknown> = {};
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start")
        config = params.config as Record<string, unknown>;
      cli.send({
        id: message.id,
        result:
          message.method === "config/read"
            ? {
                config: {
                  mcp_servers: {
                    personal: { command: "x" },
                    "ohmygame-studio": { command: "ohmygame-mcp" },
                  },
                },
              }
            : message.method === "thread/start"
              ? {
                  thread: { id: "thread-1" },
                  activePermissionProfile: { id: params.permissions },
                }
              : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "hi", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(config["mcp_servers.ohmygame-studio.enabled"]).toBe(false);
    expect(config).not.toHaveProperty("mcp_servers.personal.enabled");
    expect(config).not.toHaveProperty("notify");
  });

  it("denies the shared temporary folders Codex's minimal access would read", async () => {
    for (const filesystem of await codexProfiles())
      for (const shared of ["/tmp", "/var/tmp"])
        expect(filesystem[canonicalPath(shared)]).toBe(
          process.platform === "win32" ? undefined : "deny",
        );
  });

  it("denies Pi's agent folder in every Codex permission profile", async () => {
    // The desktop app keeps Pi's agent folder beside the data folder.
    const piAgentDirectory = "/tmp/ohmygame/pi-agent";
    const profiles = await codexProfiles({
      policy: {
        workspacePath: "/tmp/workspace",
        neverTouch: neverTouchPaths("/tmp/ohmygame/data", piAgentDirectory),
      },
    });
    for (const filesystem of profiles)
      expect(filesystem[canonicalPath(piAgentDirectory)]).toBe("deny");
  });

  it("shares one app server between conversations and keeps their threads apart", async () => {
    let threads = 0;
    const turns: string[] = [];
    let toolAnswer: unknown;
    const clis = fakeCli((message, cli) => {
      if (message.id === 900 && "result" in message)
        toolAnswer = message.result;
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start") {
        const id = `thread-${++threads}`;
        return cli.send({
          id: message.id,
          result: {
            thread: { id },
            activePermissionProfile: { id: params.permissions },
          },
        });
      }
      if (message.method === "turn/start") {
        turns.push(String(params.threadId));
        return cli.send({
          id: message.id,
          result: { turn: { id: `turn-${String(params.threadId)}` } },
        });
      }
      cli.send({ id: message.id, result: {} });
    });
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-codex-shared-"),
    );
    const codexServer = { key: `test-${directory}`, directory };
    const first = new CodexDriver(await context({ codexServer }));
    // The second conversation has no tools: a call routed to it would fail.
    const second = new CodexDriver(
      await context({ codexServer, bridge: new ToolBridge([]) }),
    );
    const one = recordingSink();
    const two = recordingSink();
    const firstTurn = first.runTurn(
      { text: "one", images: [], readOnly: false },
      one.sink,
      new AbortController().signal,
    );
    const secondTurn = second.runTurn(
      { text: "two", images: [], readOnly: false },
      two.sink,
      new AbortController().signal,
    );
    // Preparing the shared app server took over two seconds on a Windows runner, past the default wait.
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 10_000 });
    expect(clis).toHaveLength(1);
    const cli = clis[0]!;
    // Threads are numbered in the order the conversations asked for them.
    const firstThread = one.sessionId()!;
    const secondThread = two.sessionId()!;
    expect(new Set([firstThread, secondThread]).size).toBe(2);
    // A tool call on the first thread runs with the first conversation's bridge.
    cli.send({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: firstThread,
        turnId: `turn-${firstThread}`,
        callId: "call-1",
        tool: "echo_tool",
        arguments: { value: "first" },
      },
    });
    await vi.waitFor(() => expect(toolAnswer).toBeDefined());
    expect(toolAnswer).toEqual({
      contentItems: [{ type: "inputText", text: "echo first" }],
      success: true,
    });
    cli.send({
      method: "turn/completed",
      params: {
        threadId: secondThread,
        turn: { id: `turn-${secondThread}`, status: "completed" },
      },
    });
    expect(await secondTurn).toEqual({ status: "completed" });
    let firstSettled = false;
    void firstTurn.then(() => (firstSettled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstSettled).toBe(false);
    cli.send({
      method: "turn/completed",
      params: {
        threadId: firstThread,
        turn: { id: `turn-${firstThread}`, status: "completed" },
      },
    });
    expect(await firstTurn).toEqual({ status: "completed" });
    await second.dispose();
    expect(cli.exited).toBeFalsy();
    await first.dispose();
    expect(cli.exited).toBe(true);
    await expect(stat(directory)).rejects.toThrow();
  });

  it("projects quota windows from initial limits and live updates", async () => {
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const result =
        message.method === "thread/start"
          ? {
              thread: { id: "thread-1" },
              activePermissionProfile: {
                id: (message.params as Record<string, unknown>).permissions,
              },
            }
          : message.method === "account/rateLimits/read"
            ? {
                rateLimitsByLimitId: {
                  codex: {
                    primary: {
                      usedPercent: 25,
                      windowDurationMins: 300,
                      resetsAt: 1234,
                    },
                  },
                },
              }
            : {};
      cli.send({ id: message.id, result });
      if (message.method === "turn/start")
        setTimeout(() => {
          cli.send({
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                secondary: { usedPercent: 120, windowDurationMins: 10080 },
              },
            },
          });
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }, 0);
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    await driver.runTurn(
      { text: "quota", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(recorded.calls).toContain(
      'limits:[{"id":"codex/primary","usedPercent":25,"windowMinutes":300,"resetsAt":1234}]',
    );
    expect(recorded.calls).toContain(
      'limits:[{"id":"codex/secondary","usedPercent":100,"windowMinutes":10080}]',
    );
  });

  it("reports expired resume to the shared session without silently creating an empty thread", async () => {
    const methods: string[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      methods.push(message.method);
      cli.send(
        message.method === "thread/resume"
          ? { id: message.id, error: { message: "thread not found" } }
          : { id: message.id, result: {} },
      );
    });
    const driver = new CodexDriver(await context({ resume: "expired" }));
    cleanup.push(() => driver.dispose());
    await expect(
      driver.runTurn(
        { text: "continue", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
    expect(methods).not.toContain("thread/start");
  });

  it("denies protected permission roots and shows all allowed roots before granting", async () => {
    const answers: Array<Record<string, unknown>> = [];
    fakeCli((message, cli) => {
      if (typeof message.id === "string" && message.id.startsWith("grant-")) {
        answers.push(message.result as Record<string, unknown>);
        if (message.id === "grant-denied")
          cli.send({
            id: "grant-glob",
            method: "item/permissions/requestApproval",
            params: {
              permissions: { fileSystem: { read: ["/tmp/**"], write: null } },
            },
          });
        else if (message.id === "grant-glob")
          cli.send({
            id: "grant-visible",
            method: "item/permissions/requestApproval",
            params: {
              permissions: {
                fileSystem: {
                  read: ["/tmp/reference"],
                  write: null,
                  entries: [
                    {
                      path: { type: "path", path: "/tmp/reference" },
                      access: "read",
                    },
                  ],
                },
                network: { enabled: true },
              },
              reason: "Read reference files",
            },
          });
        else
          cli.send({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          });
        return;
      }
      if (!message.method || message.id === undefined) return;
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: {
                  id: (message.params as Record<string, unknown>).permissions,
                },
              }
            : message.method === "turn/start"
              ? { turn: { id: "turn-1" } }
              : {},
      });
      if (message.method === "turn/start")
        setTimeout(
          () =>
            cli.send({
              id: "grant-denied",
              method: "item/permissions/requestApproval",
              params: {
                permissions: {
                  fileSystem: { read: ["/tmp/secrets/auth.json"], write: null },
                },
              },
            }),
          0,
        );
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "permissions", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(answers[0]).toEqual({ permissions: {}, scope: "turn" });
    expect(answers[1]).toEqual({ permissions: {}, scope: "turn" });
    expect(recorded.asked).toEqual([
      expect.objectContaining({
        paths: [{ path: "/tmp/reference", access: "read" }],
        network: true,
        canAllowSession: false,
      }),
    ]);
    expect(answers[2]).toMatchObject({
      permissions: {
        fileSystem: { read: ["/tmp/reference"] },
        network: { enabled: true },
      },
      scope: "turn",
    });
  });
  it("rejects write permission grants during a planning turn", async () => {
    let answer: unknown;
    fakeCli((message, cli) => {
      if (message.id === "plan-write") {
        answer = message.result;
        cli.send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
        return;
      }
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? {
                thread: { id: "plan-thread" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start") {
        expect(params.permissions).toMatch(/-read$/);
        setTimeout(
          () =>
            cli.send({
              id: "plan-write",
              method: "item/permissions/requestApproval",
              params: {
                permissions: { fileSystem: { write: ["/tmp/workspace/a"] } },
              },
            }),
          0,
        );
      }
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "plan", images: [], readOnly: true },
      recorded.sink,
      new AbortController().signal,
    );
    expect(answer).toEqual({ permissions: {}, scope: "turn" });
    expect(recorded.asked).toEqual([]);
  });

  it.each([
    { toolName: "echo_tool", enabled: true },
    { toolName: "mcp", enabled: true },
    { toolName: "mcp", enabled: false },
  ])("runs $toolName (enabled: $enabled) with sandbox approvals", async ({ toolName, enabled }) => {
    const toolResult = {
      contentItems: [
        {
          type: "inputText",
          text: enabled ? "echo y" : `Tool ${toolName} is not available`,
        },
      ],
      success: enabled,
    };
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const pending = new Map<
      number,
      (result: Record<string, unknown>) => void
    >();
    let serverId = 100;
    const fromServer = (
      cli: FakeCli,
      method: string,
      params: Record<string, unknown>,
    ) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++serverId;
        pending.set(id, resolve);
        cli.send({ jsonrpc: "2.0", id, method, params });
      });
    const notify = (
      cli: FakeCli,
      method: string,
      params: Record<string, unknown>,
    ) => cli.send({ jsonrpc: "2.0", method, params });
    fakeCli(async (message, cli) => {
      if (message.method === undefined && typeof message.id === "number") {
        pending.get(message.id)?.(message.result as Record<string, unknown>);
        return;
      }
      const method = String(message.method);
      requests.push({
        method,
        params: (message.params ?? {}) as Record<string, unknown>,
      });
      const reply = (result: unknown) =>
        cli.send({ jsonrpc: "2.0", id: message.id, result });
      if (method === "initialized") return;
      if (method === "initialize") return reply({});
      if (method === "config/read")
        return reply({
          config: { mcp_servers: { personal: { command: "x" } } },
        });
      if (method === "thread/start")
        return reply({
          thread: { id: "thread-1" },
          activePermissionProfile: {
            id: (message.params as Record<string, unknown>).permissions,
          },
        });
      if (method !== "turn/start") return reply({});
      reply({ turn: { id: "turn-1" } });
      const turn = { threadId: "thread-1", turnId: "turn-1" };
      notify(cli, "item/started", {
        ...turn,
        item: { type: "agentMessage", id: "msg-1", text: "" },
      });
      notify(cli, "item/agentMessage/delta", {
        ...turn,
        itemId: "msg-1",
        delta: "Working",
      });
      notify(cli, "item/completed", {
        ...turn,
        item: { type: "agentMessage", id: "msg-1", text: "Working" },
      });
      notify(cli, "item/started", {
        ...turn,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: `ohmygame_${toolName}`,
          arguments: { value: "y" },
        },
      });
      expect(
        await fromServer(cli, "item/tool/call", {
          ...turn,
          callId: "call-1",
          tool: `ohmygame_${toolName}`,
          arguments: { value: "y" },
        }),
      ).toEqual(toolResult);
      notify(cli, "item/completed", {
        ...turn,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: `ohmygame_${toolName}`,
          ...toolResult,
        },
      });
      notify(cli, "item/started", {
        ...turn,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "/bin/zsh -lc 'touch /tmp/workspace/a'",
        },
      });
      // Inside the workspace, but Codex only asks when its sandbox would stop the command, so the person decides.
      expect(
        await fromServer(cli, "item/commandExecution/requestApproval", {
          ...turn,
          itemId: "cmd-1",
          command: "/bin/zsh -lc 'touch /tmp/workspace/a'",
          startedAtMs: 1,
        }),
      ).toEqual({ decision: "decline" });
      notify(cli, "item/completed", {
        ...turn,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "touch",
          status: "declined",
          aggregatedOutput: "",
        },
      });
      notify(cli, "thread/tokenUsage/updated", {
        ...turn,
        tokenUsage: {
          total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 },
          last: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 5 },
          modelContextWindow: 400_000,
        },
      });
      notify(cli, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
    });
    const driverContext = await context({ model: "gpt-5.6-sol" }, toolName);
    driverContext.bridge.setActive(enabled ? [toolName] : []);
    const driver = new CodexDriver(driverContext);
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const outcome = await driver.runTurn(
      {
        text: "go",
        images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        readOnly: false,
      },
      recorded.sink,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "completed" });
    const thread = requests.find(
      (request) => request.method === "thread/start",
    )!.params;
    expect(thread).toMatchObject({
      cwd: "/tmp/workspace",
      approvalPolicy: {
        granular: { sandbox_approval: false, request_permissions: true },
      },
      permissions: expect.stringMatching(/^ohmygame-/),
      developerInstructions: "Project instructions",
      // Only the workspace's own AGENTS.md counts, as for OhMyGame's own agent.
      config: {
        project_root_markers: [],
        // Commands keep the given PATH rather than a login shell's.
        allow_login_shell: false,
      },
    });
    expect(thread.config).not.toHaveProperty("mcp_servers.personal.enabled");
    expect(thread.config).not.toHaveProperty("notify");
    expect(thread.dynamicTools).toEqual([
      expect.objectContaining({ type: "function", name: `ohmygame_${toolName}` }),
    ]);
    const turn = requests.find(
      (request) => request.method === "turn/start",
    )!.params;
    expect(turn).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      input: [
        { type: "text", text: "go" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(recorded.sessionId()).toBe("thread-1");
    expect(recorded.calls).toEqual([
      "text:msg-1:Working",
      "textDone:msg-1:Working",
      `toolCall:call-1:${toolName}:{"value":"y"}`,
      "toolStarted:call-1",
      `toolResult:call-1:${!enabled}`,
      'toolCall:cmd-1:bash:{"command":"touch /tmp/workspace/a"}',
      "toolStarted:cmd-1",
      "toolResult:cmd-1:true",
      "usage:10:5:400000:35",
    ]);
    expect(recorded.results.get("call-1")?.result.details).toEqual(
      enabled ? {
        artifact: { type: "image", path: "art.png", mediaType: "image/png" },
      } : undefined,
    );
    expect(recorded.asked).toEqual([]);
    expect(turn).not.toHaveProperty("sandboxPolicy");
    expect(turn.permissions).toBe(thread.permissions);
    expect(
      (thread.config as Record<string, unknown>).permissions,
    ).toMatchObject({
      [String(thread.permissions)]: {
        filesystem: {
          [process.platform === "win32" ? ":root" : ":minimal"]: "read",
          [canonicalPath("/tmp/secrets")]: "deny",
          ":workspace_roots": { ".": "write" },
        },
      },
      [`${thread.permissions}-read`]: {
        filesystem: { ":workspace_roots": { ".": "read" } },
      },
    });
  });
});

// Legacy execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
describe.skip("OpenCode adapter", () => {
  it("cancels startup before OpenCode announces its listening address", async () => {
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const clis = fakeCli((message) => {
      if (message.type === "spawned") spawned();
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "opencode-cli",
      model: "test/model",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new OpenCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("cancel startup");
    await ready;
    await session.abort();
    await run;
    expect(clis[0]!.exited).toBe(true);
  });

  async function openCodeFixture(overrides: Partial<DriverContext> = {}) {
    const ctx = await context({
      model: "anthropic/claude-sonnet-5",
      reasoningLevel: "high",
      ...overrides,
    });
    const sent: Array<{ method: string; route: string; body: unknown }> = [];
    let events: ServerResponse | undefined;
    let sessionPermissions: unknown = [
      { action: "*", resource: "*", effect: "ask" },
    ];
    let saved: unknown[] = [];
    let sessionMissing = false;
    let sessionMoved = false;
    let pendingConfiguration = 0;
    const emit = (type: string, data: Record<string, unknown> = {}) =>
      events?.write(
        `data: ${JSON.stringify({ type, data: { sessionID: "ses_1", ...data } })}\n\n`,
      );
    let prompt: () => void = () => {};
    let modelChanged: () => void = () => {};
    let sessionChecked: () => void = () => {};
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const route = url.pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      sent.push({ method: request.method!, route, body });
      expect(request.headers.authorization).toMatch(/^Basic /);
      if (route === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        events = response;
        emit("server.connected", {});
        return;
      }
      response.setHeader("content-type", "application/json");
      const reply = (value: unknown) => response.end(JSON.stringify(value));
      if (route === "/api/info") return reply({ version: "2.1.0" });
      if (route === "/api/location") {
        expect(url.searchParams.get("location[directory]")).toBe(
          ctx.workspacePath,
        );
        return reply({
          directory: ctx.workspacePath,
          project: { id: "project", directory: ctx.workspacePath },
        });
      }
      if (route === "/api/permission/saved") return reply({ data: saved });
      if (route === "/api/agent" && pendingConfiguration-- > 0)
        return reply({
          data: [
            {
              id: "build",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
          ],
        });
      if (route === "/api/agent")
        return reply({
          data: ["build", "plan"].map((id) => ({
            id,
            permissions: [
              { action: "*", resource: "*", effect: "ask" },
              { action: "browser", resource: "*", effect: "deny" },
            ],
          })),
        });
      if (route === "/api/session" && request.method === "POST")
        return reply({ data: { id: "ses_1" } });
      if (route === "/api/session/ses_1") {
        if (sessionMissing) return response.writeHead(404).end("{}");
        if (request.method === "PATCH") {
          sessionPermissions = body.permissions;
          return response.writeHead(204).end();
        }
        sessionChecked();
        return reply({
          data: {
            id: "ses_1",
            location: {
              directory: sessionMoved
                ? "/another-workspace"
                : ctx.workspacePath,
            },
            permissions: sessionPermissions,
          },
        });
      }
      if (route.endsWith("/prompt")) {
        response.end("{}");
        emit("session.execution.started");
        prompt();
        return;
      }
      if (route.endsWith("/interrupt")) {
        response.end("{}");
        emit("session.execution.interrupted");
        return;
      }
      if (route.endsWith("/compact")) {
        response.end("{}");
        emit("session.compaction.started", { reason: "manual" });
        emit("session.compaction.ended", { reason: "manual", text: "summary" });
        emit("session.execution.succeeded");
        return;
      }
      if (route.includes("/permission/")) {
        response.writeHead(204).end();
        return;
      }
      if (route.endsWith("/model")) modelChanged();
      if (route.endsWith("/agent") || route.endsWith("/model"))
        return response.writeHead(204).end();
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          events?.end();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as { port: number }).port;
    const clis = fakeCli((message, cli) => {
      if (message.type === "spawned")
        queueMicrotask(() => cli.send({ url: `http://127.0.0.1:${port}` }));
    });
    const driver = new OpenCodeDriver(ctx);
    cleanup.push(() => driver.dispose());
    return {
      driver,
      ctx,
      clis,
      sent,
      emit,
      onPrompt: (callback: () => void) => {
        prompt = callback;
      },
      saveGrant: () => {
        saved = [{ id: "grant", projectID: "project" }];
      },
      missing: () => {
        sessionMissing = true;
      },
      move: () => {
        sessionMoved = true;
      },
      deferConfiguration: () => {
        pendingConfiguration = 2;
      },
      onModelChange: (callback: () => void) => {
        modelChanged = callback;
      },
      onSessionCheck: (callback: () => void) => {
        sessionChecked = callback;
      },
    };
  }

  it("waits for v2 configuration transforms before offering a turn", async () => {
    const f = await openCodeFixture();
    f.deferConfiguration();
    f.onPrompt(() => f.emit("session.execution.succeeded"));
    expect(
      await f.driver.runTurn(
        { text: "go", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).toEqual({ status: "completed" });
    expect(f.sent.filter((r) => r.route === "/api/agent")).toHaveLength(3);
    expect(f.sent.findIndex((r) => r.route === "/api/session")).toBeGreaterThan(
      f.sent.findLastIndex((r) => r.route === "/api/agent"),
    );
  });

  it("does not send a late prompt when cancellation arrives while selecting the model", async () => {
    const f = await openCodeFixture();
    const controller = new AbortController();
    f.onModelChange(() => controller.abort());
    expect(
      await f.driver.runTurn(
        { text: "cancel", images: [], readOnly: false },
        recordingSink().sink,
        controller.signal,
      ),
    ).toEqual({ status: "aborted" });
    expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
  });

  it("does not start compaction after cancellation, including during session setup", async () => {
    for (const phase of ["before-start", "session-setup"]) {
      const f = await openCodeFixture();
      const recorded = recordingSink();
      const controller = new AbortController();
      if (phase === "before-start") controller.abort();
      else f.onSessionCheck(() => controller.abort());
      await f.driver.compact(recorded.sink, controller.signal);
      expect(f.sent.some((r) => r.route.endsWith("/compact"))).toBe(false);
      expect(recorded.calls.filter((c) => c.startsWith("compaction:"))).toEqual([]);
      if (phase === "before-start") expect(f.clis).toEqual([]);
    }
  });

  it("drives v2 messages, images, thinking, tools, usage and planning permissions", async () => {
    const f = await openCodeFixture();
    const recorded = recordingSink();
    f.onPrompt(() => {
      f.emit("session.reasoning.started", {
        assistantMessageID: "msg_a",
        ordinal: 0,
      });
      f.emit("session.reasoning.delta", {
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "Thinking",
      });
      f.emit("session.reasoning.ended", {
        assistantMessageID: "msg_a",
        ordinal: 0,
        text: "Thinking",
      });
      f.emit("session.tool.input.started", {
        assistantMessageID: "msg_a",
        id: "call_1",
        name: "shell",
      });
      f.emit("session.tool.input.delta", {
        assistantMessageID: "msg_a",
        id: "call_1",
        delta: '{"command":',
      });
      f.emit("session.tool.called", {
        assistantMessageID: "msg_a",
        id: "call_1",
        input: { command: "sudo ls" },
        executed: true,
      });
      f.emit("permission.asked", {
        id: "per_1",
        action: "shell",
        resources: ["sudo ls"],
        metadata: { command: "sudo ls" },
        source: { type: "tool", id: "call_1", messageID: "msg_a" },
      });
      f.emit("permission.asked", {
        id: "per_2",
        action: "subagent",
        resources: ["explore"],
        metadata: {},
        save: ["*"],
      });
    });
    const run = f.driver.runTurn(
      {
        text: "go",
        images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        readOnly: true,
      },
      recorded.sink,
      new AbortController().signal,
    );
    await expect
      .poll(
        () =>
          f.sent.filter(
            (r) => r.route.includes("/permission/") && r.method === "POST",
          ).length,
      )
      .toBe(2);
    f.emit("session.tool.failed", {
      id: "call_1",
      error: { type: "declined", message: "rejected" },
      executed: true,
    });
    f.emit("session.text.ended", {
      assistantMessageID: "msg_a",
      ordinal: 1,
      text: "Could not",
    });
    f.emit("session.step.ended", {
      assistantMessageID: "msg_a",
      tokens: { input: 30, output: 4, cache: { read: 10, write: 0 } },
    });
    f.emit("session.execution.succeeded");
    expect(await run).toEqual({ status: "completed" });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/model",
      body: {
        model: {
          providerID: "anthropic",
          id: "claude-sonnet-5",
          variant: "high",
        },
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/agent",
      body: { agent: "plan" },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/prompt",
      body: {
        text: "go",
        files: [{ name: "image-1", uri: "data:image/png;base64,aGVsbG8=" }],
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/permission/per_1/reply",
      body: {
        decision: "reject",
        message: expect.stringContaining("planning turn"),
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/permission/per_2/reply",
      body: { decision: "once" },
    });
    expect(recorded.asked).toEqual([]);
    expect(recorded.sessionId()).toBe("opencode-v2:ses_1");
    expect(recorded.calls).toEqual([
      "thinking:msg_a:reasoning:0:Thinking",
      "thinkingDone:msg_a:reasoning:0",
      'toolCall:call_1:bash:{"command":"sudo ls"}',
      "toolStarted:call_1",
      "toolResult:call_1:true",
      "text:msg_a:text:1:Could not",
      "textDone:msg_a:text:1:Could not",
      "usage:30:4::40",
    ]);
    expect(f.clis[0]!.args).toEqual([
      "serve",
      "--stdio",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(JSON.parse(f.clis[0]!.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      snapshots: false,
      share: "disabled",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
    const config = JSON.parse(f.clis[0]!.env.OPENCODE_CONFIG_CONTENT!);
    expect(await readFile(config.instructions[0], "utf8")).toBe(
      "Project instructions",
    );
    expect(f.clis[0]!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
  });

  it("resumes a v2 session, reapplies permissions, compacts it and reports terminal failures", async () => {
    const f = await openCodeFixture({ resume: "opencode-v2:ses_1" });
    const recorded = recordingSink();
    f.onPrompt(() =>
      f.emit("session.execution.failed", {
        error: { type: "provider", message: "No model access" },
      }),
    );
    expect(
      await f.driver.runTurn(
        { text: "go", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      ),
    ).toEqual({ status: "failed", error: "No model access" });
    expect(
      f.sent.some((r) => r.route === "/api/session" && r.method === "POST"),
    ).toBe(false);
    expect(f.sent).toContainEqual({
      method: "PATCH",
      route: "/api/session/ses_1",
      body: { permissions: [{ action: "*", resource: "*", effect: "ask" }] },
    });
    await f.driver.compact(recorded.sink, new AbortController().signal);
    expect(recorded.calls.filter((c) => c.startsWith("compaction:"))).toEqual([
      "compaction:start",
      "compaction:end",
    ]);
    f.saveGrant();
    expect(
      await f.driver.runTurn(
        { text: "again", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("saved permissions"),
    });
    expect(f.sent.filter((r) => r.route.endsWith("/prompt"))).toHaveLength(1);
  });

  it("rebuilds a native session moved out of the app workspace", async () => {
    const f = await openCodeFixture({ resume: "opencode-v2:ses_1" });
    f.move();
    await expect(
      f.driver.runTurn(
        { text: "resume", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
    expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
  });

  it.each(["ses_legacy", "opencode-v2:ses_1"])(
    "rebuilds expired or v1 context %s through the shared handoff",
    async (resume) => {
      const f = await openCodeFixture({ resume });
      f.missing();
      await expect(
        f.driver.runTurn(
          { text: "resume", images: [], readOnly: false },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(NativeSessionExpiredError);
      expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
    },
  );
});


describe("controlled Codex adapter", () => {
  function config() {
    const value: Record<string, any> = {};
    for (const [key, entry] of Object.entries(CODEX_CONTROLLED_CONFIG)) {
      const parts = key.split(".");
      let target = value;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)!] = entry;
    }
    return value;
  }

  async function setup(onTurn: (cli: FakeCli, params: any) => void, onRequest?: (m: any, cli: FakeCli) => boolean) {
    const calls: any[] = [];
    const children = fakeCli((m, cli) => {
      calls.push(m);
      if (onRequest?.(m, cli)) return;
      if (typeof m.method !== "string" || m.id === undefined) return;
      const p = m.params as any;
      const result = m.method === "config/read" ? { config: config() }
        : m.method === "thread/start" || m.method === "thread/resume" ? { thread: { id: "controlled-thread" }, activePermissionProfile: { id: p.permissions } }
        : m.method === "turn/start" ? { turn: { id: "controlled-turn" } } : {};
      cli.send({ id: m.id, result });
      if (m.method === "turn/start") setTimeout(() => onTurn(cli, p));
      if (m.method === "turn/interrupt") cli.send({ method: "turn/completed", params: { threadId: "controlled-thread", turn: { status: "interrupted" } } });
    });
    const c = await context();
    c.env = await controlledCodexEnvironment(c.privateDirectory);
    c.workspacePath = path.join(c.privateDirectory, "project");
    await (await import("node:fs/promises")).mkdir(c.workspacePath);
    return { c, calls, children };
  }

  const tool = (cli: FakeCli, id: number, name: string, args: any, callId = `call-${id}`, namespace = CODEX_TOOL_NAMESPACE) => cli.send({
    id, method: "item/tool/call", params: { threadId: "controlled-thread", turnId: "controlled-turn", callId, namespace, tool: `ohmygame_${name}`, arguments: args },
  });
  const done = (cli: FakeCli, status = "completed") => cli.send({ method: "turn/completed", params: { threadId: "controlled-thread", turn: { status, error: null } } });
  const admitted = (cli: FakeCli, id: string) => {
    for (const method of ["item/started", "item/completed"]) cli.send({ method, params: { threadId: "controlled-thread", turnId: "controlled-turn", item: { type: "userMessage", id: "native-item", clientId: id, content: [{ type: "text", text: "New instruction" }] } } });
  };

  it.each([true, false])("validates the retained planning profile before starting the next turn (owned=%s)", async owned => {
    let previousProfile: string | undefined;
    const f = await setup((child, params) => {
      previousProfile = params.permissions;
      done(child);
    }, (message, child) => {
      if (message.method !== "thread/resume") return false;
      child.send({ id: message.id, result: { thread: { id: "controlled-thread" },
        activePermissionProfile: { id: owned ? previousProfile : "unrelated-profile" } } });
      return true;
    });
    const driver = new CodexDriver(f.c);
    cleanup.push(() => driver.dispose());
    const run = (readOnly: boolean) => driver.runTurn({ text: "Check the project", images: [], readOnly }, recordingSink().sink, new AbortController().signal);
    expect(await run(true)).toEqual({ status: "completed" });
    const planProfile = previousProfile;
    if (owned) {
      expect(await run(false)).toEqual({ status: "completed" });
      expect(previousProfile).not.toBe(planProfile);
    } else {
      expect(await run(false)).toMatchObject({ status: "failed", error: expect.stringContaining("filesystem permissions") });
      expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    }
  });

  it("delivers startup-time steering to the same active Codex turn and waits for its user item", async () => {
    let cli!: FakeCli;
    const f = await setup(child => { cli = child; }, (message, child) => {
      if (message.method !== "turn/steer") return false;
      child.send({ id: message.id, result: { turnId: "controlled-turn" } });
      return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const sink = { ...recordingSink().sink, steeringStarted: vi.fn(async () => {}) };
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal);
    expect(await driver.steer("startup-instruction", { text: "New instruction", images: [], readOnly: false })).toBe(true);
    expect(f.calls.find(call => call.method === "turn/steer").params).toMatchObject({ threadId: "controlled-thread", expectedTurnId: "controlled-turn", clientUserMessageId: "startup-instruction" });
    expect(sink.steeringStarted).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(cli).toBeDefined());
    admitted(cli, "startup-instruction");
    await vi.waitFor(() => expect(sink.steeringStarted).toHaveBeenCalledOnce());
    done(cli); expect(await run).toMatchObject({ status: "completed" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "turn/interrupt")).toBe(false);
  });

  it("serializes Codex project writes and projected events after old tools and the steering checkpoint", async () => {
    let cli!: FakeCli;
    const original = deferred<void>(), checkpoint = deferred<void>();
    const execute = vi.fn(async (_id: string, args: { value: string }) => {
      if (args.value === "old") await original.promise;
      return { content: [{ type: "text" as const, text: args.value }], details: {} };
    });
    const f = await setup(child => { cli = child; tool(child, 771, "echo_tool", { value: "old" }, "old-call"); }, (message, child) => {
      if (message.method !== "turn/steer") return false;
      admitted(child, message.params.clientUserMessageId);
      tool(child, 772, "echo_tool", { value: "new" }, "new-call");
      child.send({ method: "item/agentMessage/delta", params: { threadId: "controlled-thread", turnId: "controlled-turn", itemId: "after-steering", delta: "Received new instructions" } });
      child.send({ id: message.id, result: { turnId: "controlled-turn" } });
      return true;
    });
    f.c.bridge = new ToolBridge([defineTool({ name: "echo_tool", label: "Echo", description: "Local fixture", parameters: Type.Object({ value: Type.String() }), execute })] as never, true);
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const { sink, results, calls } = recordingSink();
    sink.steeringStarted = vi.fn(() => checkpoint.promise);
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const input = { text: "New instruction", images: [], readOnly: false };
    expect(await driver.steer("logical-instruction", input)).toBe(true);
    expect(await driver.steer("logical-instruction", input)).toBe(true);
    expect(sink.steeringStarted).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    original.resolve();
    await vi.waitFor(() => expect(sink.steeringStarted).toHaveBeenCalledOnce());
    expect(results.has("old-call")).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(calls.some(call => call.includes("Received new instructions"))).toBe(false);
    checkpoint.resolve();
    await vi.waitFor(() => expect(results.has("new-call")).toBe(true));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls.some(call => call.includes("Received new instructions"))).toBe(true);
    done(cli); expect(await run).toMatchObject({ status: "completed" });
    expect(f.calls.filter(call => call.method === "turn/steer")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "turn/interrupt")).toBe(false);
  });

  it("retains Codex's early terminal behind the original tool receipt and steering checkpoint", async () => {
    let cli!: FakeCli;
    const original = deferred<void>(), checkpoint = deferred<void>();
    const execute = vi.fn(async () => { await original.promise; return { content: [{ type: "text" as const, text: "Original effect retained" }], details: {} }; });
    const f = await setup(child => { cli = child; tool(child, 773, "echo_tool", { value: "old" }, "old-call"); }, (message, child) => {
      if (message.method !== "turn/steer") return false;
      admitted(child, message.params.clientUserMessageId);
      tool(child, 775, "echo_tool", { value: "after-terminal" }, "never-started-call");
      child.send({ id: message.id, result: { turnId: "controlled-turn" } });
      done(child);
      return true;
    });
    f.c.bridge = new ToolBridge([defineTool({ name: "echo_tool", label: "Echo", description: "Local fixture", parameters: Type.Object({ value: Type.String() }), execute })] as never, true);
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const { sink, results } = recordingSink();
    sink.steeringStarted = vi.fn(() => checkpoint.promise);
    let finished = false;
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal).then(outcome => { finished = true; return outcome; });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await driver.steer("terminal-instruction", { text: "New instruction", images: [], readOnly: false });
    expect(finished).toBe(false);
    original.resolve();
    await vi.waitFor(() => expect(sink.steeringStarted).toHaveBeenCalledOnce());
    expect(results.has("old-call")).toBe(true);
    expect(finished).toBe(false);
    checkpoint.resolve();
    expect(await run).toMatchObject({ status: "completed" });
    expect(execute).toHaveBeenCalledOnce();
    expect(cli).toBeDefined();
  });

  it("interrupts the same Codex turn when the steering checkpoint fails without executing queued writes", async () => {
    let cli!: FakeCli;
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Must not run" }], details: {} }));
    const f = await setup(child => { cli = child; }, (message, child) => {
      if (message.method !== "turn/steer") return false;
      admitted(child, message.params.clientUserMessageId);
      tool(child, 774, "echo_tool", { value: "blocked" });
      child.send({ id: message.id, result: { turnId: "controlled-turn" } });
      return true;
    });
    f.c.bridge = new ToolBridge([defineTool({ name: "echo_tool", label: "Echo", description: "Local fixture", parameters: Type.Object({ value: Type.String() }), execute })] as never, true);
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const sink = { ...recordingSink().sink, steeringStarted: vi.fn(async () => { throw new Error("Snapshot failed"); }) };
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal);
    await vi.waitFor(() => expect(cli).toBeDefined());
    await driver.steer("rejected-instruction", { text: "New instruction", images: [], readOnly: false });
    expect(await run).toMatchObject({ status: "failed", interruption: { code: "codex_steering_checkpoint" } });
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
  });

  it.each([-32600, -32000])("only treats the exact native no-active-turn rejection as not submitted (code %s)", async code => {
    let cli!: FakeCli;
    const f = await setup(child => { cli = child; }, (message, child) => {
      if (message.method !== "turn/steer") return false;
      child.send({ id: message.id, error: { code, message: "no active turn to steer" } });
      return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const sink = { ...recordingSink().sink, steeringStarted: vi.fn(async () => {}) };
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal);
    await vi.waitFor(() => expect(cli).toBeDefined());
    const submitted = driver.steer("late-instruction", { text: "New instruction", images: [], readOnly: false });
    if (code === -32600) expect(await submitted).toBe(false);
    else await expect(submitted).rejects.toThrow("no active turn to steer");
    expect(sink.steeringStarted).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === "turn/steer")).toHaveLength(1);
    done(cli); await run;
  });

  it.each(["interrupted", "completed", "unknown-status"])("classifies a Codex terminal %s without inventing a user cancellation", async status => {
    const f = await setup(cli => done(cli, status));
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const result = await driver.runTurn({ text: "Inspect retained state", images: [], readOnly: true }, recordingSink().sink, new AbortController().signal);
    expect(result).toMatchObject(status === "completed" ? { status: "completed" } : { status: "failed", interruption: { kind: status === "interrupted" ? "runtime_interrupted" : "unknown", source: "codex" } });
  });

  it("does not complete Codex with an outstanding effect and retains its late settlement under the original ID", async () => {
    let cli!: FakeCli, complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const execute = vi.fn(async () => { await gate; return { content: [{ type: "text" as const, text: "Existing effect receipt" }], details: {} }; });
    const f = await setup(child => { cli = child; tool(child, 777, "write", { path: "game.txt", content: "saved" }, "original-effect"); });
    f.c.bridge = new ToolBridge([defineTool({ name: "write", label: "Write", description: "Local effect fixture", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute })] as never, true);
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const late = vi.fn();
    const run = driver.runTurn({ text: "Save once", images: [], readOnly: false }, { ...recordingSink().sink, toolSettled: late }, new AbortController().signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    done(cli);
    expect(await run).toMatchObject({ status: "failed", interruption: { code: "codex_pending_tool_result", phase: "tools" } });
    complete();
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith("original-effect", expect.objectContaining({ content: [{ type: "text", text: "Existing effect receipt" }] }), false));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains correctable preflight failures through the Codex protocol and one safe continuation", async () => {
    let segment = 0;
    const f = await setup(cli => {
      segment++;
      tool(cli, 990, "edit", { path: "fixture.txt", edits: [{ oldText: "absent", newText: "after" }] }, "rejected-edit");
    }, (message, cli) => {
      if (message.id === 990 && message.result) {
        expect(message.result.success).toBe(false);
        tool(cli, 991, "edit", { path: "fixture.txt", edits: [{ oldText: "before", newText: "after" }] }, segment === 1 ? "corrected-edit" : "continuation-edit");
        return true;
      }
      if (message.id === 991 && message.result) {
        expect(message.result.success).toBe(true);
        done(cli, segment === 1 ? "interrupted" : "completed");
        return true;
      }
      return false;
    });
    await writeFile(path.join(f.c.workspacePath, "fixture.txt"), "before");
    const edit = createLocalAgentFileTools(f.c.workspacePath).find(tool => tool.name === "edit")!;
    const execute = vi.fn(edit.execute);
    const manager = SessionManager.create(f.c.workspacePath, path.join(f.c.privateDirectory, "sessions"));
    const guard = new AutoContinueTools([{ ...edit, execute }], { sessionManager: manager });
    f.c.bridge = new ToolBridge(guard.wrap(), true);
    const snapshot = vi.fn(async () => "1".repeat(40));
    const session = new NativeCodingSession({ runtime: "codex-cli", model: f.c.model!, sessionManager: manager, continuationTools: guard,
      snapshotBeforeMessage: snapshot, toolNames: ["edit"], requestApproval: async () => "deny", createDriver: () => new CodexDriver(f.c) });
    cleanup.push(() => session.dispose());
    await session.prompt("Correct the edit arguments and retain all original results");
    expect(session.interruption).toMatchObject({ kind: "runtime_interrupted", source: "codex" });
    expect(handoffSummary(manager.getBranch())).toContain('"state":"not_executed","reason":"edit_text_not_unique"');
    await session.prepareContinuation(new AbortController().signal);
    await session.resumeAfterInterruption();
    expect(session.interruption).toBeUndefined();
    expect(await readFile(path.join(f.c.workspacePath, "fixture.txt"), "utf8")).toBe("after");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledOnce();
    const branch = SessionManager.open(manager.getSessionFile()!).getBranch();
    expect(branch.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "rejected-edit")).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ isError: true, preflightFailure: { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" } }) }),
      expect.objectContaining({ message: expect.objectContaining({ isError: true, preflightFailure: { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" } }) }),
    ]);
    expect(f.calls.filter(call => call.method === "turn/start")[1]!.params.input[0].text).toContain("rejected-edit");
  });

  it("keeps normal tool ownership checks lightweight across catalog refresh and refuses continuation after disable", async () => {
    let sequence = 0, service!: AgentRuntimeService, readsAfterRefresh = 0;
    const next = (cli: FakeCli) => tool(cli, 880 + ++sequence, "list_media_capabilities", {}, `catalog-read-${sequence}`);
    const f = await setup(cli => { sequence = 0; next(cli); }, (message, cli) => {
      if (message.method === "model/list") { cli.send({ id: message.id, result: { data: [{ id: "fixture-model", displayName: "Fixture", inputModalities: ["text"] }] } }); return true; }
      if (typeof message.id === "number" && message.id >= 881 && message.id <= 883 && message.result) {
        if (sequence < 3) next(cli); else done(cli, "interrupted");
        return true;
      }
      return false;
    });
    const resolve = vi.spyOn(discovery, "resolveBinary").mockResolvedValue({ path: "/fixture/codex", signature: "fixed-service-fixture", source: "manual" });
    vi.spyOn(discovery, "probeVersion").mockResolvedValue(controlledCodex.CONTROLLED_CODEX_VERSION);
    vi.spyOn(discovery, "probeAuth").mockResolvedValue({ status: "signed-in", billing: "subscription" });
    vi.spyOn(controlledCodex, "verifyControlledCodexBinary").mockResolvedValue();
    vi.spyOn(codexIsolation, "checkCodexIsolation").mockResolvedValue();
    service = new AgentRuntimeService(f.c.privateDirectory, () => undefined);
    await service.load(); cleanup.push(() => service.close());
    await service.update("codex-cli", { enabled: true });
    await service.status("codex-cli", true);
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        await service.status("codex-cli", true);
        readsAfterRefresh = resolve.mock.calls.length;
      }
      return { content: [{ type: "text" as const, text: "Local metadata fixture" }], details: {} };
    });
    const session = await service.createSession({ runtime: "codex-cli", model: "fixture-model", workspacePath: f.c.workspacePath,
      sessionManager: SessionManager.inMemory(f.c.workspacePath), tools: [defineTool({ name: "list_media_capabilities", label: "Metadata", description: "Local metadata", parameters: Type.Object({}), execute })] as never,
      instructions: "Local fixture", skillDirectories: [], policy: { workspacePath: f.c.workspacePath, neverTouch: [] }, requestApproval: async () => "deny" });
    cleanup.push(() => session.dispose());
    await session.prompt("Inspect metadata only");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(readsAfterRefresh);
    expect(session.interruption).toMatchObject({ kind: "runtime_interrupted" });
    await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("connection changed");
    // A new explicit user task may bind the refreshed account epoch; no old task is resumed.
    await session.prompt("Inspect metadata for this new task");
    expect(execute).toHaveBeenCalledTimes(6);
    await session.prepareContinuation(new AbortController().signal);
    await service.update("codex-cli", { enabled: false });
    await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("connection changed");
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
  });

  it("preserves built-in authentication routing instead of forcing ChatGPT credentials onto the API endpoint", async () => {
    const f = await setup((cli) => done(cli), (m, cli) => {
      if (m.method !== "config/read") return false;
      cli.send({ id: m.id, result: { config: { ...config(), openai_base_url: null } } }); return true;
    });
    vi.stubEnv("OPENAI_BASE_URL", "https://unexpected.invalid/v1");
    vi.stubEnv("OPENAI_API_KEY", "fake-ambient-key");
    const env = await controlledCodexEnvironment(f.c.privateDirectory);
    expect(env).not.toHaveProperty("OPENAI_BASE_URL");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    const driver = new CodexDriver({ ...f.c, env }); cleanup.push(() => driver.dispose());
    expect(await driver.runTurn({ text: "fixture", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal)).toEqual({ status: "completed" });
    expect(CODEX_CONTROLLED_CONFIG).not.toHaveProperty("openai_base_url");
    expect(f.children[0].args.some(arg => arg.startsWith("openai_base_url="))).toBe(false);
    expect(f.calls.find(m => m.method === "thread/start").params.config).not.toHaveProperty("openai_base_url");
  });

  it.each(["https://api.openai.com/v1", "https://chatgpt.com/backend-api/codex", "https://unexpected.invalid/v1", ""])("rejects inherited endpoint override %s before a model turn", async (base) => {
    const f = await setup(() => {}, (m, cli) => {
      if (m.method !== "config/read") return false;
      cli.send({ id: m.id, result: { config: { ...config(), openai_base_url: base } } }); return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    expect(await driver.runTurn({ text: "fixture", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal)).toMatchObject({ status: "failed", error: expect.stringContaining("active authentication method") });
    expect(f.calls.some(m => m.method === "turn/start")).toBe(false);
  });

  it("rejects an inherited replacement for the built-in OpenAI provider before a model turn", async () => {
    const f = await setup(() => {}, (m, cli) => {
      if (m.method !== "config/read") return false;
      cli.send({ id: m.id, result: { config: { ...config(), model_providers: { openai: { base_url: "https://unexpected.invalid/v1" } } } } }); return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    expect(await driver.runTurn({ text: "fixture", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal)).toMatchObject({ status: "failed", error: expect.stringContaining("Custom OpenAI routing") });
    expect(f.calls.some(m => m.method === "turn/start")).toBe(false);
  });

  it("edits through safe files, delivers Kunpo artifacts once, and resumes the same thread", async () => {
    const replies: any[] = [];
    let cli!: FakeCli;
    const f = await setup((child) => { cli = child; tool(child, 101, "write", { path: "index.html", content: "<p>game</p>" }); }, (m) => {
      if (m.id >= 100 && !m.method) { replies.push(m); return true; } return false;
    });
    const generate = vi.fn(async () => ({ content: [{ type: "text", text: "Kunpo task existing-1" }], details: { artifact: { type: "image", path: "art.png", mediaType: "image/png" } } }));
    const media = defineTool({ name: "generate_image", label: "Kunpo image", description: "Mock Kunpo", parameters: Type.Object({ prompt: Type.String() }), execute: generate as never });
    f.c.bridge = new ToolBridge([...createLocalAgentFileTools(f.c.workspacePath), media], true);
    const driver = new CodexDriver(f.c);
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const run = driver.runTurn({ text: "game and art", images: [], readOnly: false }, recorded.sink, new AbortController().signal);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(await readFile(path.join(f.c.workspacePath, "index.html"), "utf8")).toBe("<p>game</p>");
    tool(cli, 102, "generate_image", { prompt: "sprite" }, "paid-call");
    tool(cli, 103, "generate_image", { prompt: "sprite" }, "paid-call");
    cli.send({ method: "item/started", params: { threadId: "controlled-thread", turnId: "controlled-turn", item: { id: "paid-call", type: "dynamicToolCall", namespace: "ohmygame", tool: "ohmygame_generate_image", arguments: { prompt: "sprite" } } } });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    cli.send({ method: "item/completed", params: { threadId: "controlled-thread", turnId: "controlled-turn", item: { id: "paid-call", type: "dynamicToolCall", success: true, contentItems: [{ type: "inputText", text: "Native text without artifact details" }] } } });
    expect(generate).toHaveBeenCalledOnce();
    expect(recorded.calls.filter(c => c.startsWith("toolCall:paid-call:"))).toHaveLength(1);
    expect(recorded.calls.filter(c => c.startsWith("toolResult:paid-call:"))).toHaveLength(1);
    expect(recorded.results.get("paid-call")).toMatchObject({ isError: false, result: { details: { artifact: { path: "art.png" } } } });
    done(cli);
    expect(await run).toEqual({ status: "completed" });
    const start = f.calls.find(m => m.method === "thread/start").params;
    expect(start.cwd).toBe(f.c.privateDirectory);
    expect(start.dynamicTools).toHaveLength(1);
    expect(start.dynamicTools[0]).toMatchObject({ type: "namespace", name: "ohmygame" });
    expect(start.dynamicTools[0].tools.map((t: any) => t.name)).toContain("ohmygame_write");
    expect(Object.values(start.config.permissions).every((p: any) => p.network.enabled === false)).toBe(true);
    expect(f.children[0].args).toContain("features.image_generation=false");
    expect(f.children[0].env).not.toHaveProperty("OPENAI_API_KEY");
    await driver.dispose();
    const resumed = new CodexDriver({ ...f.c, resume: recorded.sessionId() });
    cleanup.push(() => resumed.dispose());
    const second = resumed.runTurn({ text: "continue", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal);
    await vi.waitFor(() => expect(f.calls.some(m => m.method === "thread/resume")).toBe(true));
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    done(cli);
    expect(await second).toEqual({ status: "completed" });
  });

  it("fails before the turn if the CLI ignores a security setting", async () => {
    const f = await setup(() => {}, (m, cli) => {
      if (m.method !== "config/read") return false;
      cli.send({ id: m.id, result: { config: { ...config(), features: { ...config().features, image_generation: true } } } }); return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    expect(await driver.runTurn({ text: "no model", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal)).toMatchObject({ status: "failed", error: expect.stringContaining("image_generation") });
    expect(f.calls.some(m => m.method === "turn/start")).toBe(false);
  });

  it.each(["enabled", "disable_in_process_fallback"])("fails closed if the CLI ignores Code Mode host %s", async (setting) => {
    const f = await setup(() => {}, (m, cli) => {
      if (m.method !== "config/read") return false;
      const current = config();
      current.features.code_mode_host[setting] = false;
      cli.send({ id: m.id, result: { config: current } }); return true;
    });
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    expect(await driver.runTurn({ text: "fixture", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal)).toMatchObject({ status: "failed", error: expect.stringContaining(`code_mode_host.${setting}`) });
    expect(f.calls.some(m => m.method === "turn/start")).toBe(false);
  });

  it("refuses a tool call from another namespace without running the project bridge", async () => {
    const replies: any[] = [];
    const f = await setup((cli) => tool(cli, 101, "echo_tool", { value: "blocked" }, "wrong-namespace", "functions"), (m) => {
      if (m.id === 101 && !m.method) { replies.push(m); return true; } return false;
    });
    const execute = vi.spyOn(f.c.bridge, "call");
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const run = driver.runTurn({ text: "fixture", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0].error.message).toContain("Invalid OhMyGame tool call");
    expect(execute).not.toHaveBeenCalled();
    done(f.children[0]);
    expect(await run).toEqual({ status: "completed" });
  });

  it("rejects planning writes, wrong threads, permissions, and tools arriving after cancellation", async () => {
    const replies: any[] = []; let cli!: FakeCli;
    const f = await setup((child) => { cli = child; tool(child, 201, "write", { path: "blocked.txt", content: "bad" }); }, (m) => {
      if (m.id >= 200 && !m.method) { replies.push(m); return true; } return false;
    });
    f.c.bridge = new ToolBridge(createLocalAgentFileTools(f.c.workspacePath), true);
    f.c.bridge.setActive(["read", "ls"]);
    const driver = new CodexDriver(f.c); cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    const controller = new AbortController();
    const run = driver.runTurn({ text: "plan", images: [], readOnly: true }, recorded.sink, controller.signal);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0].result.success).toBe(false);
    cli.send({ id: 202, method: "item/tool/call", params: { threadId: "other", turnId: "controlled-turn", callId: "wrong", tool: "ohmygame_read", arguments: { path: "a" } } });
    cli.send({ id: 203, method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[1].error.message).toContain("No conversation is waiting");
    expect(replies[2].result).toEqual({ permissions: {}, scope: "turn" });
    expect(recorded.asked).toEqual([]);
    controller.abort(); await driver.interrupt();
    expect(await run).toEqual({ status: "aborted" });
    tool(cli, 204, "write", { path: "late.txt", content: "bad" });
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect(replies[3].error.message).toContain("No turn");
    await expect(readFile(path.join(f.c.workspacePath, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, "controlled-codex-v1", "controlled-codex-v2", "controlled-codex-v3", "controlled-codex-v4", "controlled-codex-v5", "controlled-codex-v6"])("keeps account and media selections separate while rebuilding legacy context %s", async (contextVersion) => {
    const f = await setup((cli) => {
      cli.send({ method: "item/completed", params: { threadId: "controlled-thread", item: { id: "answer", type: "agentMessage", text: "Ready" } } });
      done(cli);
    }, (m, cli) => {
      if (m.method !== "model/list") return false;
      cli.send({ id: m.id, result: { data: [{ id: "fixture-model", displayName: "Fixture", inputModalities: ["text"] }] } }); return true;
    });
    vi.spyOn(discovery, "resolveBinary").mockResolvedValue({ path: "/fixture/codex", signature: "fake", source: "manual" });
    vi.spyOn(discovery, "probeVersion").mockResolvedValue(controlledCodex.CONTROLLED_CODEX_VERSION);
    const auth = vi.spyOn(discovery, "probeAuth").mockResolvedValue({ status: "signed-out", billing: "unknown" });
    vi.spyOn(controlledCodex, "verifyControlledCodexBinary").mockResolvedValue();
    vi.spyOn(codexIsolation, "checkCodexIsolation").mockResolvedValue();
    const service = new AgentRuntimeService(f.c.privateDirectory, () => undefined);
    await service.load(); cleanup.push(() => service.close());
    expect(await service.models()).toEqual({ models: [], loading: [] });
    await service.update("codex-cli", { enabled: true });
    expect(await service.models()).toEqual({ models: [], loading: [] });
    expect(f.children).toHaveLength(0);
    expect(await service.codexImageConnection()).toBeUndefined();
    await expect(service.update("codex-cli", { permissionMode: "full" })).rejects.toThrow("Full access");
    auth.mockResolvedValue({ status: "signed-in", billing: "subscription" });
    await service.status("codex-cli", true);
    expect((await service.models()).models).toMatchObject([{ provider: "codex-cli", id: "fixture-model" }]);
    expect(service.settings.defaultModel()).toBeUndefined();
    const pluginTool = vi.fn();
    const manager = SessionManager.inMemory(f.c.workspacePath);
    manager.appendMessage({ role: "user", content: "Preserve the existing game and artwork", timestamp: 1 });
    manager.appendCustomEntry("ohmygame-native-session", { version: 2, runtime: "codex-cli", state: "ready", sessionId: "legacy-unsafe-tools", contextVersion });
    const session = await service.createSession({ runtime: "codex-cli", model: "fixture-model", workspacePath: f.c.workspacePath,
      sessionManager: manager, tools: [...createLocalAgentFileTools(f.c.workspacePath), createIsolatedRecoveryTool(async () => ({ state: "resident", dirty: false, recoverable: false }), async () => ({ changed: [] }))], instructions: "Fixture",
      skillDirectories: [], policy: { workspacePath: f.c.workspacePath, neverTouch: [] },
      pluginMcp: { config: { mcpServers: { forbidden: { command: "/never" } } }, host: { tool: pluginTool } as never, agentDir: "/never" },
      requestApproval: async () => "deny",
    }); cleanup.push(() => session.dispose());
    session.setActiveToolsByName(["read", "write", "edit", "ls"]);
    await session.prompt("Inspect the game");
    expect(pluginTool).not.toHaveBeenCalled();
    expect(f.calls.some(m => m.method === "thread/resume" && m.params.threadId === "legacy-unsafe-tools")).toBe(false);
    const recovery = f.calls.filter(m => m.method === "thread/start").at(-1)!.params.dynamicTools[0].tools.find((tool: any) => tool.name === "ohmygame_recover_isolated_changes");
    expect(recovery).toBeDefined();
    expect(JSON.stringify(recovery.inputSchema)).toContain('"const":"review"');
    expect(JSON.stringify(recovery.inputSchema)).toContain('"const":"adopt"');
    expect(JSON.stringify(recovery.inputSchema)).toContain('"const":"capacity"');
    expect(recovery.inputSchema.properties).toHaveProperty("reviewId");
    expect(recovery.inputSchema.properties).not.toHaveProperty("approved");
    expect(manager.getBranch().some(e => e.type === "custom" && e.customType === "ohmygame-native-session" && (e.data as any).contextVersion === "controlled-codex-v20")).toBe(true);
    expect(f.calls.find(m => m.method === "turn/start").params.input[0].text).toContain("Preserve the existing game and artwork");
    expect(manager.getBranch().some(e => e.type === "message" && e.message.role === "assistant")).toBe(true);
    const launches = f.children.map(c => c.env);
    expect(launches.every(env => env.HOME !== process.env.HOME && !env.OPENAI_API_KEY && !env.KUNPO_API_KEY)).toBe(true);
    expect(f.calls.some(m => m.method === "account/login/start")).toBe(false);
  });
});

describe("native capacity context contract", () => {
  it.each([
    { runtime: "codex-cli" as const, old: "controlled-codex-v19", current: "controlled-codex-v20" },
    { runtime: "qoder-cli" as const, old: "controlled-qoder-v18", current: "controlled-qoder-v19" },
  ])("rebuilds $runtime's previous tool schema and retains only capacity's read-only arguments", async ({ runtime, old, current }) => {
    const manager = SessionManager.inMemory("/tmp/native-capacity-context");
    manager.appendMessage({ role: "user", content: "Preserve the existing retained work", timestamp: 1 });
    manager.appendCustomEntry("ohmygame-native-session", { version: 2, runtime, state: "ready", sessionId: "legacy-tools", contextVersion: old });
    const recover = vi.fn(async () => ({ changed: [] }));
    const bridge = new ToolBridge([createIsolatedRecoveryTool(async () => ({ state: "resident", dirty: false, recoverable: false }), recover)], true);
    const resumes: Array<string | undefined> = [], texts: string[] = [];
    const session = new NativeCodingSession({ runtime, model: "fixture", contextVersion: current, sessionManager: manager, toolNames: bridge.names, requestApproval: async () => "deny",
      createDriver: resume => { resumes.push(resume); return { interrupt: async () => {}, dispose: async () => {}, runTurn: async (input, sink) => {
        texts.push(input.text); sink.nativeSession("capacity-context"); sink.textDone("answer", "Capacity checks remain read-only"); return { status: "completed" };
      } }; },
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Check capacity before proposing recovery");
    expect(resumes).toEqual([undefined]); expect(texts[0]).toContain("Preserve the existing retained work");
    const schemas = bridge.list(); expect(JSON.stringify(schemas)).toContain('"const":"capacity"');
    expect(JSON.stringify(schemas)).toContain('"const":"plan_capacity"');
    expect(JSON.stringify(schemas)).toContain('"const":"plan_first_allocation"');
    expect(await bridge.call("recover_isolated_changes", { action: "plan_first_allocation", profileId: "capacity-64-v1" }, "invalid-first-allocation")).toMatchObject({ isError: true });
    expect(await bridge.call("recover_isolated_changes", { action: "plan_capacity", profileId: "unknown" }, "invalid-profile")).toMatchObject({ isError: true });
    for (const extra of [{ generation: "4" }, { reviewId: "a".repeat(64) }, { approved: true }]) {
      expect(await bridge.call("recover_isolated_changes", { action: "capacity", ...extra }, "invalid-capacity")).toMatchObject({ isError: true, result: { content: [{ type: "text", text: expect.stringContaining("approved" in extra ? "Invalid arguments" : "Capacity accepts only action") }] } });
    }
    expect(recover).not.toHaveBeenCalled();
    expect(manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "ohmygame-native-session" && (entry.data as { contextVersion?: string }).contextVersion === current)).toBe(true);
    expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Qoder driver text projection into persisted sessions", () => {
  type Frame = Record<string, unknown>;
  const stream = (event: Frame): Frame => ({ type: "stream_event", event });
  const start = (id: string): Frame => stream({ type: "message_start", message: { id, role: "assistant", content: [] } });
  const block = (index: number, type = "text"): Frame => stream({ type: "content_block_start", index, content_block: type === "text" ? { type, text: "" } : { type, thinking: "" } });
  const delta = (index: number, text: string): Frame => stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
  const stop = (index: number): Frame => stream({ type: "content_block_stop", index });
  const final = (id: string | undefined, uuid: string, texts: string[]): Frame => ({ type: "assistant", uuid, message: { ...(id ? { id } : {}), role: "assistant", content: texts.map(text => ({ type: "text", text })) } });

  it.each(["stream-first", "request-first", "fresh-fails"])("rebuilds a missing Qoder context once through the actual driver without replaying retained work (%s)", async order => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Must not replay" }], details: {} }));
    const ctx = await context({ model: "gmodel", bridge: new ToolBridge([defineTool({ name: "echo_tool", label: "Echo", description: "Retained fixture tool", parameters: Type.Object({}), execute })] as never) });
    const manager = SessionManager.create(ctx.privateDirectory, path.join(ctx.privateDirectory, "sessions"));
    manager.appendMessage({ role: "user", content: "Keep the approved character and original workflow", timestamp: 1 });
    manager.appendMessage({ role: "toolResult", toolCallId: "retained-blender-call", toolName: "run_blender", isError: false, content: [{ type: "text", text: "Existing model normalized; model.glb retained" }], timestamp: 2 });
    manager.appendCustomEntry("ohmygame-native-session", { version: 2, runtime: "qoder-cli", state: "ready", sessionId: "expired-qoder-context" });
    const inputs: Frame[] = [], resumes: Array<string | undefined> = [];
    const snapshot = vi.fn(async () => "1".repeat(40));
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, toolNames: ["echo_tool"], snapshotBeforeMessage: snapshot, requestApproval: async () => "deny", createDriver: resume => {
      resumes.push(resume);
      return new QoderDriver({ ...ctx, resume }, receive => ({
        start: async () => {}, stop: async () => {}, respond: () => {},
        request: async (method, params = {}) => {
          expect(method).toBe("turn/start"); inputs.push(params);
          if (resume || order === "fresh-fails") {
            const failure = { code: "QODER_SESSION_HISTORY_MISSING", phase: "session-initialize", message: "PRIVATE_TRANSCRIPT_PATH" };
            if (order !== "request-first") receive({ method: "sdk/error", params: { turnId: params.turnId, ...failure } });
            throw qoderHelperError(failure);
          }
          queueMicrotask(() => {
            receive({ method: "sdk/message", params: { turnId: params.turnId, message: { type: "system", subtype: "init", session_id: "replacement-qoder-context" } } });
            receive({ method: "sdk/message", params: { turnId: params.turnId, message: final("fresh-response", "fresh-block", ["Continuing the retained work."]) } });
            receive({ method: "sdk/message", params: { turnId: params.turnId, message: { type: "result", subtype: "success", is_error: false } } });
          });
          return { sessionId: "replacement-qoder-context" };
        },
      }));
    } });
    cleanup.push(() => session.dispose());
    await session.prompt("Accept and continue");
    expect(resumes.slice(0, 2)).toEqual(["expired-qoder-context", undefined]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].resume).toBe("expired-qoder-context");
    expect(inputs[1]).not.toHaveProperty("resume");
    expect(inputs[1].text).toContain("<conversation-handoff>");
    expect(inputs[1].text).toContain("Keep the approved character");
    expect(inputs[1].text).toContain('"originalCallId":"retained-blender-call","tool":"run_blender","state":"completed"');
    expect(snapshot).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    const entries = manager.getBranch();
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(1);
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome").at(-1)).toMatchObject({ data: { status: order === "fresh-fails" ? "failed" : "completed" } });
    expect(JSON.stringify(entries)).not.toContain("PRIVATE_TRANSCRIPT_PATH");
  });

  it.each(["response-stream", "query-start"])("does not classify a saved-context message as expired after an unverified boundary (%s)", phase => {
    expect(qoderHelperError({ code: "QODER_SESSION_HISTORY_MISSING", phase })).not.toBeInstanceOf(NativeSessionExpiredError);
    expect(qoderHelperError({ code: "QODER_SDK", phase: "session-initialize", message: "CHAT_SESSION_HISTORY_MISSING" })).not.toBeInstanceOf(NativeSessionExpiredError);
  });

  it("acknowledges steering once after the original tool receipt and the stable checkpoint", async () => {
    const tool = deferred<NativeToolResult & { details: object }>();
    const execute = vi.fn(() => tool.promise);
    const echo = defineTool({ name: "echo_tool", label: "Echo", description: "Local fixture", parameters: Type.Object({ value: Type.String() }), execute });
    const ctx = await context({ model: "gmodel", bridge: new ToolBridge([echo] as never) });
    const responses: { id: unknown; value: unknown }[] = [], requests: { method: string; params: Frame }[] = [];
    let receive!: (message: Frame) => void;
    const driver = new QoderDriver(ctx, handler => {
      receive = handler;
      return {
        start: async () => {}, stop: async () => {},
        respond: (id, value) => { responses.push({ id, value }); },
        request: async (method, params = {}) => {
          requests.push({ method, params });
          if (method === "turn/start") receive({ method: "sdk/message", params: { turnId: params.turnId, message: { type: "system", subtype: "init", session_id: "steering-session" } } });
          return method === "turn/steer" ? { queued: true } : {};
        },
      };
    });
    cleanup.push(() => driver.dispose());
    const { sink, results } = recordingSink();
    const checkpoint = deferred<void>();
    sink.steeringStarted = vi.fn(() => checkpoint.promise);
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, sink, new AbortController().signal);
    await vi.waitFor(() => expect(requests.some(request => request.method === "turn/start")).toBe(true));
    const turnId = requests[0].params.turnId;
    receive({ id: "original-tool", method: "tool/call", params: { turnId, sessionId: "steering-session", name: "echo_tool", callId: "only-call", arguments: { value: "original" } } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const input = { text: "New instruction", images: [], readOnly: false };
    expect(await driver.steer("logical-queue-id", input)).toBe(true);
    expect(await driver.steer("logical-queue-id", input)).toBe(true);
    expect(requests.filter(request => request.method === "turn/steer")).toHaveLength(1);
    const commandId = requests.find(request => request.method === "turn/steer")!.params.commandId;
    const startSteering = (id: string) => receive({ id, method: "steering/started", params: { turnId, sessionId: "steering-session", commandId } });
    startSteering("admit-1"); startSteering("admit-2");
    await new Promise(resolve => setImmediate(resolve));
    expect(sink.steeringStarted).not.toHaveBeenCalled();
    tool.resolve({ content: [{ type: "text", text: "Original tool result" }], details: {} });
    await vi.waitFor(() => expect(sink.steeringStarted).toHaveBeenCalledExactlyOnceWith("logical-queue-id", expect.any(AbortSignal)));
    expect(results.has("only-call")).toBe(true);
    expect(responses.map(response => response.id)).toEqual(["original-tool"]);
    expect(await driver.cancelSteering(["logical-queue-id"])).toEqual([]);
    checkpoint.resolve();
    await vi.waitFor(() => expect(responses.filter(response => String(response.id).startsWith("admit-"))).toEqual([
      { id: "admit-1", value: { accepted: true } }, { id: "admit-2", value: { accepted: true } },
    ]));
    receive({ method: "sdk/message", params: { turnId, message: { type: "result", subtype: "success", is_error: false } } });
    expect(await run).toMatchObject({ status: "completed" });
    expect(execute).toHaveBeenCalledOnce();
    expect(requests.some(request => request.method === "turn/interrupt")).toBe(false);
  });

  it("keeps uncertain queued messages and assigns a fresh SDK UUID only after confirmed cancellation", async () => {
    const ctx = await context({ model: "gmodel" });
    const submissions: Frame[] = [];
    let cancel = false;
    const driver = new QoderDriver(ctx, () => ({
      start: async () => {}, stop: async () => {}, respond: () => {},
      request: async (method, params = {}) => {
        if (method === "turn/steer") { submissions.push(params); return { queued: true }; }
        if (method === "turn/cancel-steering") return { cancelled: cancel ? params.commandIds : [] };
        return {};
      },
    }));
    cleanup.push(() => driver.dispose());
    const run = driver.runTurn({ text: "Original", images: [], readOnly: false }, recordingSink().sink, new AbortController().signal);
    const input = { text: "Next", images: [], readOnly: false };
    expect(await driver.steer("queued-id", input)).toBe(true);
    expect(await driver.cancelSteering(["queued-id"])).toEqual([]);
    expect(await driver.steer("queued-id", input)).toBe(true);
    expect(submissions).toHaveLength(1);
    cancel = true;
    expect(await driver.cancelSteering(["queued-id"])).toEqual(["queued-id"]);
    expect(await driver.steer("queued-id", input)).toBe(true);
    expect(submissions).toHaveLength(2);
    expect(submissions[0].commandId).not.toBe(submissions[1].commandId);
    await driver.dispose();
    await run;
  });

  it.each([
    [{ subtype: "error_max_turns", num_turns: 64 }, "turn_limit", "qoder_max_turns"],
    [{ subtype: "error_max_budget_usd" }, "blocked", "qoder_budget_limit"],
    [{ subtype: "error_during_execution", terminal_reason: "aborted_streaming" }, "runtime_interrupted", "qoder_runtime_interrupted"],
    [{ subtype: "error_during_execution", terminal_reason: "hook_stopped" }, "blocked", "qoder_hook_stopped"],
    [{ subtype: "error_max_turns", terminal_reason: "hook_stopped" }, "blocked", "qoder_hook_stopped"],
    [{ subtype: "error_during_execution", error_code: 500 }, "unknown", "qoder_execution_error"],
    [{ subtype: "unexpected-subtype" }, "unknown", "qoder_execution_error"],
    [{ subtype: "success", is_error: false, terminal_reason: "PRIVATE_TERMINAL_CANARY" }, "unknown", "qoder_unknown_terminal"],
    [{ subtype: "success", is_error: false, stop_reason: "max_tokens" }, "runtime_interrupted", "qoder_output_limit"],
    [{ subtype: "success", is_error: false, stop_reason: "tool_use", terminal_reason: "hook_stopped" }, "blocked", "qoder_hook_stopped"],
    [{ subtype: "success", is_error: false, terminal_reason: "max_turns" }, "unknown", "qoder_unknown_terminal"],
    [{ subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed" }, undefined, undefined],
  ] as const)("preserves the safe Qoder result category %j", async (result, kind, code) => {
    const ctx = await context({ model: "gmodel" });
    const driver = new QoderDriver(ctx, receive => ({ start: async () => {}, stop: async () => {}, respond: () => {}, request: async (method, params = {}) => {
      if (method === "turn/start") queueMicrotask(() => {
        const message = { method: "sdk/message", params: { turnId: params.turnId, message: { type: "result", is_error: true, errors: ["PRIVATE_TERMINAL_CANARY"], ...result } } };
        receive(message); receive(message);
      });
      return { sessionId: "result-fixture" };
    } }));
    cleanup.push(() => driver.dispose());
    const outcome = await driver.runTurn({ text: "Continue existing work", images: [], readOnly: true }, recordingSink().sink, new AbortController().signal);
    expect(outcome).toMatchObject(kind ? { status: "failed", interruption: { kind, source: "qoder", code } } : { status: "completed" });
    if ("num_turns" in result) expect(outcome).toHaveProperty("modelTurns", 64);
    if ("terminal_reason" in result) expect(outcome).toHaveProperty("terminalReason", result.terminal_reason === "PRIVATE_TERMINAL_CANARY" ? "unknown" : result.terminal_reason);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_TERMINAL_CANARY");
  });

  it("continues one native logical task without duplicate user messages, checkpoints or completed effects", async () => {
    const ctx = await context();
    const manager = SessionManager.create(ctx.privateDirectory, path.join(ctx.privateDirectory, "sessions"));
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Original effect complete, receipt original-receipt" }], details: {} }));
    const write = defineTool({ name: "write", label: "Write", description: "Local effect fixture", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute });
    const guard = new AutoContinueTools([write] as never, { sessionManager: manager });
    const bridge = new ToolBridge(guard.wrap(), true);
    const snapshot = vi.fn(async () => "1".repeat(40));
    const inputs: string[] = [], resumes: Array<string | undefined> = [];
    let attempt = 0;
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, continuationTools: guard, snapshotBeforeMessage: snapshot,
      toolNames: ["write"], requestApproval: async () => "deny", createDriver: resume => {
        resumes.push(resume);
        return { dispose: async () => {}, interrupt: async () => {}, runTurn: async (input, sink, signal) => {
          inputs.push(input.text);
          const current = attempt++, callId = current === 0 ? "original-effect" : `continuation-effect-${current}`;
          const args = { path: "game.txt", content: "saved" };
          sink.nativeSession(`native-${current}`); sink.toolCall(callId, "write", args); sink.toolStarted(callId);
          const outcome = await bridge.call("write", args, callId, signal); sink.toolResult(callId, outcome.result, outcome.isError);
          sink.textDone("answer", current === 0 ? "Partial work retained" : "The requested task is complete");
          return current === 0 ? { status: "failed", error: "Qoder reached its native turn limit", modelTurns: 64, interruption: { kind: "turn_limit", source: "qoder", code: "qoder_max_turns", phase: "result", terminalReason: "max_turns" } } : { status: "completed", modelTurns: 2 };
        } };
      } });
    cleanup.push(() => session.dispose());
    await session.prompt("Perform the original task once");
    expect(session.interruption).toMatchObject({ kind: "turn_limit" });
    await session.prepareContinuation(new AbortController().signal);
    await session.resumeAfterInterruption();
    expect(execute).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(inputs[1]).toContain("original-effect"); expect(inputs[1]).toContain("original-receipt");
    expect(manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome").at(-1)).toMatchObject({ data: { status: "completed", segment: 2, sdkNumTurns: 2 } });
    expect(session.interruption).toBeUndefined();
    expect(resumes).toEqual([undefined, undefined]);
    await session.prompt("Perform the newly requested task");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it.each(["user", "host"] as const)("records %s cancellation without offering continuation", async origin => {
    const manager = SessionManager.inMemory("/tmp/native-cancellation-origin");
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, toolNames: [], requestApproval: async () => "deny",
      createDriver: () => ({ dispose: async () => {}, interrupt: async () => {}, runTurn: async (_input, _sink, signal) => {
        started();
        return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true }));
      } }),
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("Keep the original user task");
    await ready;
    const cancelled = session.abort(origin === "user" ? undefined : "host");
    if (origin === "user") await session.abort("host");
    await cancelled; await run;
    expect(session.interruption).toBeUndefined();
    expect(manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome")).toMatchObject({ data: { status: "aborted", cancelOrigin: origin } });
    await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("no longer eligible");
  });

  it.each(["qoder-cli", "codex-cli"] as const)("records a rejected read before stopping the %s native loop", async runtime => {
    const manager = SessionManager.inMemory("/tmp/native-rejected-read");
    const rejected = "This attachment reference is unavailable in the current conversation branch";
    const read = defineTool({ name: "read_attachment", label: "Read", description: "Read fixture", parameters: Type.Object({ path: Type.String() }),
      execute: async () => { throw toolPreflightError(rejected, "authorization_denied"); } });
    const guard = new AutoContinueTools([read], { sessionManager: manager });
    const bridge = new ToolBridge(guard.wrap());
    let branchAtInterrupt: unknown;
    const interrupt = vi.fn(async () => { branchAtInterrupt = manager.getBranch(); });
    const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard, toolNames: bridge.names, requestApproval: async () => "deny",
      createDriver: () => ({ dispose: async () => {}, interrupt, runTurn: async (_input, sink) => {
        sink.toolCall("rejected-read", "read_attachment", { path: "attachment:mistyped" });
        sink.toolStarted("rejected-read");
        const outcome = await bridge.call("read_attachment", { path: "attachment:mistyped" }, "rejected-read");
        sink.toolResult("rejected-read", outcome.result, outcome.isError);
        return { status: "completed" };
      } }),
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Read the existing attachment");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(branchAtInterrupt).toContainEqual(expect.objectContaining({ type: "message", message: expect.objectContaining({
      role: "toolResult", toolCallId: "rejected-read", isError: true, content: [{ type: "text", text: rejected }],
      preflightFailure: { effect: "none", reason: "authorization_denied", disposition: "blocked" },
    }) }));
    expect(guard.stopRequested).toBe(true);
    const errors = manager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message.errorMessage] : []);
    expect(errors).toContain("Automatic continuation stopped: read_attachment (rejected-read) was rejected by a protected tool boundary. Review the original rejection before continuing.");
    expect(errors.some(error => error?.includes("unconfirmed outcome"))).toBe(false);
    await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("no longer eligible");
  });

  it("stops a native loop immediately for an unconfirmed effect without treating its internal interrupt as user cancellation", async () => {
    const manager = SessionManager.inMemory("/tmp/native-blocked-effect");
    let started!: () => void, terminal!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const interrupt = vi.fn(async () => { terminal(); });
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, toolNames: [], requestApproval: async () => "deny",
      createDriver: () => ({ dispose: async () => {}, interrupt, runTurn: async () => new Promise(resolve => {
        terminal = () => resolve({ status: "aborted" }); started();
      }) }),
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("Keep the original operation");
    await ready; await session.stopForUnconfirmedEffect(); await run;
    expect(interrupt).toHaveBeenCalledOnce();
    expect(session.interruption).toMatchObject({ kind: "blocked", cancelOrigin: "host", code: "unconfirmed_tool_effect" });
    expect(manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome")).toMatchObject({ data: { status: "failed", cancelOrigin: "host" } });
    await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("no longer eligible");
  });

  it.each([false, true])("delivers queued user input after an automatic continuation and propagates its checkpoint failure: %s", async checkpointFails => {
    const manager = SessionManager.inMemory("/tmp/native-queued-continuation");
    const guard = new AutoContinueTools([], { sessionManager: manager });
    const inputs: string[] = [];
    let started!: () => void, release!: () => void;
    const startedContinuation = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const snapshot = vi.fn(async () => {
      if (checkpointFails && snapshot.mock.calls.length === 2) throw new Error("Queued checkpoint unavailable");
      return "2".repeat(40);
    });
    let attempt = 0;
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, continuationTools: guard, toolNames: [], snapshotBeforeMessage: snapshot, requestApproval: async () => "deny",
      createDriver: () => ({ dispose: async () => {}, interrupt: async () => {}, runTurn: async (input, sink) => {
        const index = attempt++; inputs.push(input.text);
        if (index === 0) return { status: "failed", error: "Turn limit", interruption: { kind: "turn_limit", source: "qoder", code: "qoder_max_turns" } };
        if (index === 1) { started(); await gate; }
        sink.textDone("done", "The requested work completed");
        return { status: "completed" };
      } }),
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Original task");
    await session.prepareContinuation(new AbortController().signal);
    const resumed = session.resumeAfterInterruption();
    await startedContinuation;
    await session.followUp("A newly queued user task");
    release();
    if (checkpointFails) await expect(resumed).rejects.toThrow("Queued checkpoint unavailable");
    else await resumed;
    expect(inputs).toHaveLength(checkpointFails ? 2 : 3);
    if (!checkpointFails) expect(inputs[2]).toBe("A newly queued user task");
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(checkpointFails ? 1 : 2);
  });

  it("passes visual history requirements to the helper and projects only the fixed image failure", async () => {
    const ctx = await context({ model: "gmodel" });
    let input: Frame | undefined;
    const driver = new QoderDriver(ctx, receive => ({
      start: async () => {}, stop: async () => {}, respond: () => {},
      request: async (method, params = {}) => {
        if (method === "turn/start") {
          input = params;
          queueMicrotask(() => receive({ method: "sdk/error", params: { turnId: params.turnId, code: "QODER_IMAGE_INPUT", message: "PRIVATE_IMAGE_ERROR_CANARY" } }));
        }
        return { sessionId: "visual-driver-session" };
      },
    }));
    cleanup.push(() => driver.dispose());
    const result = await driver.runTurn({ text: "Recall the retained reference", images: [], requiresImageInput: true, readOnly: true }, recordingSink().sink, new AbortController().signal);
    expect(input).toMatchObject({ requiresImageInput: true, images: [] });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("valid PNG, JPEG or WebP") });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_IMAGE_ERROR_CANARY");
  });
  const cases = [
    {
      name: "thinking index zero followed by an early single-block text snapshot",
      frames: [start("message-a"), block(0, "thinking"), stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Local fixture reasoning" } }), stop(0), block(1), delta(1, "One "), delta(1, "answer."), final("message-a", "block-a", ["One answer."]), stop(1)],
      expected: ["One answer."],
    },
    {
      name: "identical text in separate streamed blocks and separate messages",
      frames: [start("message-a"), block(0), delta(0, "Same."), final("message-a", "block-a", ["Same."]), stop(0), block(1), delta(1, "Same."), final("message-a", "block-b", ["Same."]), stop(1), start("message-b"), block(0), delta(0, "Same."), final("message-b", "block-c", ["Same."]), stop(0), start("message-a"), block(0), delta(0, "Same."), final("message-a", "block-d", ["Same."]), stop(0)],
      expected: ["Same.", "Same.", "Same.", "Same."],
    },
    {
      name: "unstreamed single-block snapshots sharing a message id with distinct envelope ids",
      frames: [final("message-a", "block-a", ["First."]), final("message-a", "block-b", ["Second."]), final("message-a", "block-c", ["Same."]), final("message-a", "block-d", ["Same."])],
      expected: ["First.", "Second.", "Same.", "Same."],
    },
    {
      name: "several text blocks in one completed message",
      frames: [final("message-a", "block-a", ["First paragraph.", "Repeated paragraph.", "Repeated paragraph."])],
      expected: ["First paragraph.", "Repeated paragraph.", "Repeated paragraph."],
    },
    {
      name: "completed text longer than the streamed prefix before block stop",
      frames: [start("message-a"), block(0), delta(0, "Partial"), final("message-a", "block-a", ["Partial completed answer."]), stop(0)],
      expected: ["Partial completed answer."],
    },
    {
      name: "a completed single-block snapshot after the original stream block stops",
      frames: [start("message-a"), block(0, "thinking"), stop(0), block(1), delta(1, "After stop."), stop(1), final("message-a", "block-a", ["After stop."])],
      expected: ["After stop."],
    },
    {
      name: "missing message ids without borrowing the preceding streamed message",
      frames: [start("message-a"), block(0), delta(0, "Same."), final("message-a", "block-a", ["Same."]), stop(0), final(undefined, "block-b", ["Same."]), final(undefined, "block-c", ["Same."])],
      expected: ["Same.", "Same.", "Same."],
    },
    {
      name: "an identical completed envelope replay with the same uuid",
      frames: [start("message-a"), block(0), delta(0, "Idempotent."), final("message-a", "block-a", ["Idempotent."]), final("message-a", "block-a", ["Idempotent."]), stop(0)],
      expected: ["Idempotent."],
    },
    {
      name: "a completed multi-block snapshot after both original stream blocks stop",
      frames: [start("message-a"), block(0), delta(0, "First."), stop(0), block(1), delta(1, "Second."), stop(1), final("message-a", "block-a", ["First.", "Second."])],
      expected: ["First.", "Second."],
    },
  ];

  it.each(cases)("stores and displays $name once per native block", async ({ frames, expected }) => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Local tool result" }], details: {} }));
    const echo = defineTool({ name: "echo_tool", label: "Echo", description: "Local fixture", parameters: Type.Object({ value: Type.String() }), execute });
    const ctx = await context({ model: "gmodel", bridge: new ToolBridge([echo] as never) });
    ctx.workspacePath = ctx.privateDirectory;
    ctx.policy = { workspacePath: ctx.privateDirectory, neverTouch: [] };
    const manager = SessionManager.create(ctx.privateDirectory, path.join(ctx.privateDirectory, "sessions"));
    const events: Frame[] = [];
    const replies = new Map<string, (value: unknown) => void>();
    let sequence = 0;
    const sessionId = "native-projection-session";
    const driver = new QoderDriver(ctx, (receive) => {
      const connection: QoderHostConnection = {
        start: async () => {},
        stop: async () => {},
        respond: (id, value) => { replies.get(String(id))?.(value); replies.delete(String(id)); },
        request: async (method, params = {}) => {
          if (method !== "turn/start") return {};
          queueMicrotask(() => { void (async () => {
            const emit = (message: Frame) => receive({ method: "sdk/message", params: { turnId: params.turnId, message: { session_id: sessionId, parent_tool_use_id: null, ...message } } });
            emit({ type: "system", subtype: "init" });
            for (const frame of frames) emit(frame);
            // A genuine tool ID replay must not execute or record a second tool call.
            for (let replay = 0; replay < 2; replay++) {
              const id = `fixture-tool-${++sequence}`;
              const reply = new Promise<unknown>(resolve => replies.set(id, resolve));
              receive({ id, method: "tool/call", params: { turnId: params.turnId, sessionId, name: "echo_tool", callId: "genuine-call-id", arguments: { value: "fixture" } } });
              expect(await reply).toMatchObject({ isError: false });
            }
            emit({ type: "result", subtype: "success", is_error: false });
          })(); });
          return { sessionId };
        },
      };
      return connection;
    });
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "gmodel", sessionManager: manager, toolNames: ["echo_tool"], createDriver: () => driver, requestApproval: async () => "deny" });
    cleanup.push(() => session.dispose());
    session.subscribe(event => events.push(event as unknown as Frame));
    await session.prompt("Use only the local fixture messages and tool.");
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const texts = reopened.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter(part => part.type === "text").map(part => part.text) : []);
    expect(texts).toEqual(expected);
    expect(conversationItems(reopened.getBranch()).filter(item => item.type === "agentMessage").map(item => item.text)).toEqual(expected);
    const handoff = handoffSummary(reopened.getBranch())!;
    const replayed = JSON.stringify(replayNativeMessages(reopened.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : [])));
    for (const text of new Set(expected)) {
      const copies = expected.filter(value => value === text).length;
      expect(handoff.split(`Assistant: ${text}`).length - 1).toBe(copies);
      expect(replayed.split(text).length - 1).toBe(copies);
    }
    const displayed = events.flatMap(event => event.type === "message_end" && (event.message as Frame)?.role === "assistant" ? ((event.message as Frame).content as Frame[]).filter(part => part.type === "text").map(part => part.text) : []);
    expect(displayed).toEqual(expected);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reopened.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(1);
  });
});

describe("Qoder SDK host controlled bridge", () => {
  type Data = Record<string, unknown>;
  type Tool = { name: string; description: string; inputSchema: Data };
  type Handler = (request: unknown, extra: { signal?: AbortSignal }) => unknown;
  type QueryOptions = Data & {
    canUseTool(name: string, input: Data, context: Data): Promise<Data>;
    hooks: {
      PreToolUse: Array<{
        hooks: Array<(input: Data, callId?: string) => Promise<Data>>;
      }>;
    };
    resolveModel?: (context?: Data) => Promise<Data>;
  };
  const builtinAgentNames = ["general-purpose", "Explore", "Plan"];
  const readTool: Tool = {
    name: "read",
    description: "Read a controlled project file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  };
  const initialize = {
    binaryPath: "/audited/qoder",
    runtimeVersion: "1.1.83",
    privateDirectory: "/tmp/qoder-fixture-session",
    configurationRoot: "/tmp/qoder-fixture-persistent",
    env: {
      HOME: "/tmp/qoder-fixture-persistent/home",
      QODER_CONFIG_DIR: "/tmp/qoder-fixture-persistent/config",
      TMPDIR: "/tmp/qoder-fixture-session/tmp",
      PATH: "/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1",
      OTEL_SDK_DISABLED: "true",
      QODER_DISABLE_MALFORMED_TOOL_USE_RETRY: "1",
      QODER_MAX_REASONING_ONLY_RETRIES: "0",
    },
  };

  function fixture(
    options: {
      tools?: Tool[];
      init?: Data | null;
      mcpStatus?: unknown;
      handshake?: Promise<unknown>;
      statusGate?: Promise<unknown>;
      sdkVersion?: string;
      runtimeVersion?: string;
    } = {},
  ) {
    const sent: Data[] = [];
    const prompts: unknown[] = [];
    const registered: Array<Map<unknown, Handler>> = [];
    const queries: Array<{
      options: QueryOptions;
      emit(message: unknown): void;
      close: ReturnType<typeof vi.fn>;
      interrupt: ReturnType<typeof vi.fn>;
      cancelAsyncMessage: ReturnType<typeof vi.fn>;
    }> = [];
    const tools = options.tools ?? [readTool];
    const accountInfo = vi.fn(async () => ({ userId: "fixture-user" }));
    const getModels = vi.fn(
      async (input: { fetchStrategy: "live" | "cache" }) => [
        { value: input.fetchStrategy },
      ],
    );
    const stop = vi.fn(async () => {});
    const startDaemon = vi.fn(async (_options: Data) => ({
      accountInfo,
      getModels,
      stop,
    }));
    const auth = vi.fn(() => ({ type: "qodercli" }));
    const sdkQuery = vi.fn(
      ({
        prompt,
        options: configuration,
      }: {
        prompt: AsyncIterable<unknown>;
        options: Data;
      }) => {
        const sessionId = `qoder-fixture-session-${queries.length + 1}`;
        const events: unknown[] = [];
        let ended = false;
        let wake: (() => void) | undefined;
        const emit = (message: unknown) => {
          events.push(message);
          wake?.();
        };
        const query = {
          options: configuration as QueryOptions,
          emit,
          close: vi.fn(async () => {
            ended = true;
            wake?.();
          }),
          interrupt: vi.fn(async () => ({})),
          cancelAsyncMessage: vi.fn(async (_uuid: string) => false),
          initializationResult: vi.fn(async () =>
            options.handshake
              ? await options.handshake
              : {
                  commands: [],
                  permissionPolicy: { disabledModes: [] },
                  agents: builtinAgentNames.map((name) => ({
                    name,
                    description: "Native built-in",
                  })),
                  skills: [],
                  output_style: "default",
                  available_output_styles: ["default"],
                  models: [{ value: configuration.model }],
                  account: {},
                  capabilities: [],
                  permissionMode: "default",
                },
          ),
          mcpServerStatus: vi.fn(async () =>
            options.statusGate
              ? await options.statusGate
              : (options.mcpStatus ?? [
                  {
                    name: "ohmygame",
                    status: "connected",
                    tools: tools.map(({ name }) => ({ name: `mcp__ohmygame__${name}` })),
                  },
                ]),
          ),
          async *[Symbol.asyncIterator]() {
            while (!ended) {
              if (events.length) yield events.shift();
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          },
        };
        queries.push(query);
        if (options.init !== null)
          emit({
            type: "system",
            subtype: "init",
            qodercli_version: "1.1.83",
            cwd: initialize.privateDirectory,
            tools: tools.map(({ name }) => `mcp__ohmygame__${name}`),
            skills: [],
            plugins: [],
            // Native 1.1.83 Rne/Rv reports registry entries, not invocation permissions.
            agents: [...builtinAgentNames],
            model: configuration.model,
            mcp_servers: [{ name: "ohmygame", status: "connected" }],
            permissionMode: "default",
            session_id: sessionId,
            ...options.init,
          });
        void (async () => {
          for await (const message of prompt) prompts.push(message);
        })();
        return query;
      },
    );
    const dependencies: QoderSdkHostDependencies = {
      sdkVersion: options.sdkVersion ?? "1.0.59",
      runtimeVersion: options.runtimeVersion ?? "1.1.83",
      schemas: { listTools: "tools/list", callTool: "tools/call" },
      sdk: {
        qodercliAuth: auth,
        startDaemon,
        query: sdkQuery,
        createSdkMcpServer: vi.fn(() => {
          const handlers = new Map<unknown, Handler>();
          registered.push(handlers);
          return {
            type: "sdk",
            name: "ohmygame",
            instance: {
              server: {
                registerCapabilities: vi.fn(),
                setRequestHandler: (schema: unknown, handler: Handler) => {
                  handlers.set(schema, handler);
                },
              },
            },
          };
        }),
      },
    };
    const host = new QoderSdkHost(dependencies, (message) =>
      sent.push(message),
    );
    cleanup.push(() => host.close());
    const initializeHost = async (params: Data = initialize) => {
      await host.handle({ id: "initialize", method: "initialize", params });
    };
    const start = async (params: Data = {}) => {
      const id = `start-${queries.length + 1}`;
      await host.handle({
        id,
        method: "turn/start",
        params: {
          turnId: `turn-${queries.length + 1}`,
          model: "gmodel",
          text: "Inspect this project",
          tools,
          instructions: "Only use OhMyGame's controlled project tools.",
          ...params,
        },
      });
      return sent.find((message) => message.id === id)!;
    };
    const toolCalls = () =>
      sent.filter((message) => message.method === "tool/call");
    const hook = (input: Data, callId?: string, index = queries.length - 1) =>
      queries[index].options.hooks.PreToolUse[0].hooks[0](input, callId);
    const call = (
      name: string,
      args: Data = {},
      index = registered.length - 1,
      signal?: AbortSignal,
    ) =>
      registered[index].get("tools/call")!(
        { params: { name, arguments: args } },
        { signal },
      ) as Promise<Data>;
    return {
      host,
      dependencies,
      sent,
      prompts,
      queries,
      registered,
      startDaemon,
      auth,
      accountInfo,
      getModels,
      stop,
      sdkQuery,
      initializeHost,
      start,
      toolCalls,
      hook,
      call,
    };
  }

  it("starts the serialized helper with native metadata and returns a controlled tool result over stdio", async () => {
    const f = fixture();
    const input = new PassThrough(), output = new PassThrough();
    const frames: Data[] = [];
    let pending = "";
    output.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        frames.push(JSON.parse(pending.slice(0, end)) as Data);
        pending = pending.slice(end + 1);
      }
    });
    const run = runQoderSdkHost(input, output, async () => f.dependencies);
    cleanup.push(async () => { input.end(); await run; output.destroy(); });
    const send = (value: Data) => input.write(`${JSON.stringify(value)}\n`);
    send({ id: "initialize", method: "initialize", params: initialize });
    await vi.waitFor(() => expect(frames.find(frame => frame.id === "initialize")).toHaveProperty("result"));
    const frame = Buffer.from(`${JSON.stringify({ id: "start", method: "turn/start", params: {
      turnId: "stdio-turn", model: "gmodel", text: "Inspect 项目", tools: [readTool],
    } })}\n`);
    const split = frame.indexOf(Buffer.from("项目")) + 1;
    input.write(frame.subarray(0, split)); input.write(frame.subarray(split));
    await vi.waitFor(() => expect(frames.find(message => message.id === "start")).toHaveProperty("result.sessionId"));
    expect(JSON.stringify(f.prompts)).toContain("Inspect 项目");
    expect(f.queries[0].options.model).toBe("gmodel");
    await f.hook({ tool_name: "mcp__ohmygame__read", tool_input: { path: "game.ts" } }, "stdio-read");
    const result = f.call("read", { path: "game.ts" });
    await vi.waitFor(() => expect(frames.filter(message => message.method === "tool/call")).toHaveLength(1));
    const request = frames.find(message => message.method === "tool/call")!;
    expect(request.params).toMatchObject({ turnId: "stdio-turn", callId: "stdio-read", name: "read" });
    send({ id: request.id, result: { content: [{ type: "text", text: "controlled project content" }], isError: false } });
    expect(await result).toMatchObject({ content: [{ text: "controlled project content" }], isError: false });
    expect(f.accountInfo).not.toHaveBeenCalled();
    expect(f.getModels).not.toHaveBeenCalled();
    send({ id: "close", method: "session/close" });
    await vi.waitFor(() => expect(frames.find(message => message.id === "close")).toHaveProperty("result"));
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("admits next-priority steering only at a main model boundary after old tools and checkpoint acknowledgement", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    await f.hook({ tool_name: "mcp__ohmygame__read", tool_input: { path: "game.ts" } }, "old-tool");
    const tool = f.call("read", { path: "game.ts" });
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    await f.host.handle({ id: "steer", method: "turn/steer", params: { turnId: "turn-1", commandId: "command-next", text: "Change the model", images: [] } });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
    expect(f.prompts[1]).toMatchObject({ uuid: "command-next", priority: "next" });
    expect(f.sent.filter(message => message.method === "steering/started")).toEqual([]);
    f.queries[0].emit({ type: "command_lifecycle", command_uuid: "command-next", state: "started", session_id: "qoder-fixture-session-1" });
    let released = false;
    const policy = f.queries[0].options.resolveModel!({ purpose: "main" }).then(() => { released = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.sent.filter(message => message.method === "steering/started")).toEqual([]);
    await f.host.handle({ id: f.toolCalls()[0].id, result: { content: [{ type: "text", text: "Original result" }] } });
    await tool;
    await vi.waitFor(() => expect(f.sent.filter(message => message.method === "steering/started")).toHaveLength(1));
    expect(released).toBe(false);
    const admission = f.sent.find(message => message.method === "steering/started")!;
    await f.host.handle({ id: admission.id, result: { accepted: true } });
    await policy;
    expect(released).toBe(true);
    await f.queries[0].options.resolveModel!({ purpose: "main" });
    expect(f.sent.filter(message => message.method === "steering/started")).toHaveLength(1);
    expect(f.queries[0].interrupt).not.toHaveBeenCalled();
  });

  it("keeps unconfirmed cancellation in the SDK and allows reordering only after a confirmed cancellation", async () => {
    const f = fixture();
    await f.initializeHost(); await f.start();
    await f.host.handle({ id: "steer", method: "turn/steer", params: { turnId: "turn-1", commandId: "command-next", text: "Change", images: [] } });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
    await f.host.handle({ id: "cancel-unknown", method: "turn/cancel-steering", params: { turnId: "turn-1", commandIds: ["command-next"] } });
    expect(f.sent.find(message => message.id === "cancel-unknown")).toMatchObject({ result: { cancelled: [] } });
    f.queries[0].cancelAsyncMessage.mockResolvedValue(true);
    await f.host.handle({ id: "cancel-confirmed", method: "turn/cancel-steering", params: { turnId: "turn-1", commandIds: ["command-next"] } });
    expect(f.sent.find(message => message.id === "cancel-confirmed")).toMatchObject({ result: { cancelled: ["command-next"] } });
    expect(f.queries[0].interrupt).not.toHaveBeenCalled();
  });

  it.each(["consumed", "cancelled"])("retains a late queued command across the previous success result until %s", async (state) => {
    const f = fixture();
    await f.initializeHost(); await f.start();
    await f.host.handle({ id: "steer", method: "turn/steer", params: { turnId: "turn-1", commandId: "late-command", text: "Next instruction", images: [] } });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
    const terminalMessages = () => f.sent.filter(message => message.method === "sdk/message" && (message.params as { message: { type: string } }).message.type === "result");
    f.queries[0].emit({ type: "result", subtype: "success", is_error: false, result: "Original turn" });
    await new Promise(resolve => setImmediate(resolve));
    expect(terminalMessages()).toEqual([]);
    if (state === "cancelled") {
      f.queries[0].cancelAsyncMessage.mockResolvedValue(true);
      await f.host.handle({ id: "cancel", method: "turn/cancel-steering", params: { turnId: "turn-1", commandIds: ["late-command"] } });
      expect(f.sent.find(message => message.id === "cancel")).toMatchObject({ result: { cancelled: ["late-command"] } });
    } else {
      f.queries[0].emit({ type: "command_lifecycle", command_uuid: "late-command", state: "started", session_id: "qoder-fixture-session-1" });
      const policy = f.queries[0].options.resolveModel!({ purpose: "main" });
      await vi.waitFor(() => expect(f.sent.some(message => message.method === "steering/started")).toBe(true));
      await f.host.handle({ id: f.sent.find(message => message.method === "steering/started")!.id, result: { accepted: true } });
      await policy;
      expect(terminalMessages()).toEqual([]);
      f.queries[0].emit({ type: "result", subtype: "success", is_error: false, result: "Steered turn" });
    }
    await vi.waitFor(() => expect(terminalMessages()).toHaveLength(1));
    expect(f.queries[0].interrupt).not.toHaveBeenCalled();
  });

  it("stops before model dispatch if the steering checkpoint is rejected", async () => {
    const f = fixture();
    await f.initializeHost(); await f.start();
    await f.host.handle({ id: "steer", method: "turn/steer", params: { turnId: "turn-1", commandId: "rejected-command", text: "Next instruction", images: [] } });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
    f.queries[0].emit({ type: "command_lifecycle", command_uuid: "rejected-command", state: "started", session_id: "qoder-fixture-session-1" });
    const policy = f.queries[0].options.resolveModel!({ purpose: "main" });
    const rejected = expect(policy).rejects.toThrow("checkpoint was not confirmed");
    await vi.waitFor(() => expect(f.sent.some(message => message.method === "steering/started")).toBe(true));
    await f.host.handle({ id: f.sent.find(message => message.method === "steering/started")!.id, result: { accepted: false } });
    await rejected;
    expect(f.sent.find(message => message.method === "sdk/error")).toBeDefined();
    expect(await f.call("read")).toMatchObject({ isError: true });
  });

  it("withholds the first prompt until the exact inventory and MCP handshake pass", async () => {
    const status = deferred<unknown>();
    const f = fixture({ init: null, statusGate: status.promise });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No network in the fixture"));
    await f.initializeHost();
    const run = f.start({ reasoningLevel: "high", contextWindow: 200_000 });
    await vi.waitFor(() => expect(f.queries).toHaveLength(1));
    expect(f.prompts).toEqual([]);
    f.queries[0].emit({
      type: "system",
      subtype: "init",
      qodercli_version: "1.1.83",
      cwd: initialize.privateDirectory,
      tools: ["mcp__ohmygame__read"],
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "ohmygame", status: "connected" }],
      permissionMode: "default",
      session_id: "gated-session",
    });
    await vi.waitFor(() =>
      expect(f.sent.some((message) => message.method === "sdk/message")).toBe(
        true,
      ),
    );
    expect(f.prompts).toEqual([]);
    status.resolve([
      { name: "ohmygame", status: "connected", tools: [{ name: "mcp__ohmygame__read" }] },
    ]);
    expect(await run).toMatchObject({ result: { sessionId: "gated-session" } });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    expect(f.startDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: "process",
        pathToQoderCLIExecutable: initialize.binaryPath,
        auth: { type: "qodercli" },
        debugFile: path.join(initialize.privateDirectory, "tmp", "qoder-sdk.log"),
        env: initialize.env,
      }),
    );
    const config = f.queries[0].options;
    expect(config).toMatchObject({
      cwd: initialize.privateDirectory,
      tools: ["mcp__ohmygame__read"],
      allowedTools: [],
      disallowedTools: ["mcp_list", "mcp_get", "mcp_call"],
      permissionMode: "default",
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      agents: {},
      plugins: [],
      memory: {},
      evolution: {},
      securityScan: {
        l1StaticCheck: false,
        l2LightweightScan: false,
        l3DeepScan: false,
      },
      promptSuggestions: false,
      maxTurns: 64,
      allowDangerouslySkipPermissions: false,
      enableFileCheckpointing: false,
      settings: {
        general: { enableAutoUpdate: false },
        skills: { enabled: false },
        mcp: { lazyLoad: false },
      },
    });
    expect(config.mcpServers).toHaveProperty("ohmygame");
    expect(Object.keys(config.mcpServers as Data)).toEqual(["ohmygame"]);
    expect(config).not.toHaveProperty("additionalDirectories");
    expect(config).not.toHaveProperty("experimentalCloudAgent");
    for (const field of [
      "auth",
      "env",
      "transport",
      "pathToQoderCLIExecutable",
      "executable",
      "executableArgs",
      "proxy",
      "vpcEndpoint",
      "spawnQoderCLIProcess",
      "closeGraceMs",
    ])
      expect(config).not.toHaveProperty(field);
    expect(await config.resolveModel!()).toEqual({
      model: "gmodel",
      parameters: { reasoningEffort: "high", contextWindow: 200_000 },
    });
    expect(f.accountInfo).not.toHaveBeenCalled();
    expect(f.getModels).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, undefined, "true"])("rejects unverified live vision metadata %s despite caller capability claims", async (isVl) => {
    const f = fixture();
    await f.initializeHost();
    await f.start({ requiresImageInput: true, supportsImages: true, vision: true, isVl: true });
    await expect(f.queries[0].options.resolveModel!({
      sessionId: "qoder-fixture-session-1",
      availableModels: [{ value: "gmodel", isVl, description: "PRIVATE_VISION_POLICY_CANARY" }],
    })).rejects.toMatchObject({ code: "QODER_IMAGE_INPUT" });
    expect(f.sent.find(message => message.method === "sdk/error")).toMatchObject({ params: { code: "QODER_IMAGE_INPUT" } });
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_VISION_POLICY_CANARY");
    expect(f.queries[0].close).toHaveBeenCalled();
    expect(f.toolCalls()).toEqual([]);
  });

  it.each([
    { type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
    { type: "image", mimeType: "image/png", data: "PRIVATE_INVALID_IMAGE_CANARY" },
    { type: "image", mimeType: "image/jpeg", data: "aW52YWxpZA==" },
  ])("rejects unsupported or damaged image envelopes before constructing a query: $mimeType", async (image) => {
    const f = fixture();
    await f.initializeHost();
    expect(await f.start({ images: [image] })).toMatchObject({ error: { code: "QODER_IMAGE_INPUT", message: expect.stringContaining("valid PNG, JPEG or WebP") } });
    expect(f.sdkQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_INVALID_IMAGE_CANARY");
  });

  it("requires fresh vision metadata after a tool image and on a resumed visual session", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    expect(await f.queries[0].options.resolveModel!({ availableModels: [] })).toMatchObject({ model: "gmodel" });
    await f.hook({ tool_name: "mcp__ohmygame__read", tool_input: { path: "reference.png" }, tool_use_id: "visual-read" });
    const result = f.call("read", { path: "reference.png" });
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
    await f.host.handle({ id: f.toolCalls()[0].id, result: { content: [image] } });
    expect(await result).toEqual({ content: [image] });
    expect(await f.queries[0].options.resolveModel!({ sessionId: "qoder-fixture-session-1", availableModels: [{ value: "gmodel", isVl: true }] })).toMatchObject({ model: "gmodel" });
    f.queries[0].emit({ type: "result", session_id: "qoder-fixture-session-1" });
    await vi.waitFor(() => expect(f.sent.some(message => message.method === "sdk/message" && (message.params as Data).message && ((message.params as Data).message as Data).type === "result")).toBe(true));
    await f.start({ resume: "qoder-fixture-session-1" });
    await expect(f.queries[1].options.resolveModel!({ sessionId: "qoder-fixture-session-2", availableModels: [] })).rejects.toMatchObject({ code: "QODER_IMAGE_INPUT" });
  });

  it.each([
    ["missing tools", { tools: undefined }],
    ["extra native tool", { tools: ["mcp__ohmygame__read", "Bash"] }],
    [
      "duplicate tool",
      { tools: ["mcp__ohmygame__read", "mcp__ohmygame__read"] },
    ],
    ["missing controlled tool", { tools: [] }],
    ["wrong runtime", { qodercli_version: "1.1.85" }],
    ["project cwd", { cwd: "/tmp/a-user-project" }],
    ["user skill", { skills: ["local-shell"] }],
    ["plugin", { plugins: [{ name: "external" }] }],
    ["unknown agent metadata", { agents: ["writer"] }],
    ["duplicate agent metadata", { agents: ["Plan", "Plan"] }],
    ["mixed agent metadata", { agents: ["general-purpose", 7] }],
    ["malformed agents", { agents: "writer" }],
    ["bypass mode", { permissionMode: "bypassPermissions" }],
    ["native Agent tool", { tools: ["mcp__ohmygame__read", "Agent"] }],
    [
      "foreign MCP server",
      { mcp_servers: [{ name: "external", status: "connected" }] },
    ],
  ])("rejects %s before releasing any prompt", async (_label, init) => {
    const f = fixture({ init });
    await f.initializeHost();
    expect(await f.start()).toMatchObject({
      error: { code: "QODER_INVENTORY" },
    });
    expect(
      f.sent.find((message) => message.method === "sdk/error"),
    ).toMatchObject({ params: { code: "QODER_INVENTORY" } });
    expect(f.prompts).toEqual([]);
    expect(f.toolCalls()).toEqual([]);
    expect(f.queries[0].close).toHaveBeenCalled();
  });

  it.each([[], ["general-purpose"], ["Explore", "Plan"]])(
    "accepts only audited built-in registry subsets %j",
    async (...agents) => {
      const f = fixture({ init: { agents } });
      await f.initializeHost();
      expect(await f.start()).toHaveProperty("result");
      await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
      expect(f.toolCalls()).toEqual([]);
    },
  );

  it("starts gmodel with the native built-in metadata and permits only the controlled project tool", async () => {
    const f = fixture();
    await f.initializeHost();
    expect(await f.start()).toMatchObject({
      result: { sessionId: "qoder-fixture-session-1" },
    });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    expect(f.queries[0].options.model).toBe("gmodel");
    const initialized = f.sent.find(
      (entry) =>
        entry.method === "sdk/message" &&
        ((entry.params as Data)?.message as Data)?.subtype === "init",
    );
    expect((initialized?.params as Data).message).toMatchObject({
      agents: builtinAgentNames,
      model: "gmodel",
      tools: ["mcp__ohmygame__read"],
    });
    const delegation = {
      subagent_type: "general-purpose",
      prompt: "Do not run",
    };
    expect(
      await f.queries[0].options.canUseTool("Agent", delegation, {
        toolUseID: "forbidden-agent",
      }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await f.hook({
        tool_name: "Agent",
        tool_input: delegation,
        tool_use_id: "forbidden-agent",
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await f.call("Agent", delegation)).toMatchObject({ isError: true });
    expect(f.toolCalls()).toEqual([]);
    await f.hook({
      tool_name: "mcp__ohmygame__read",
      tool_input: { path: "index.html" },
      tool_use_id: "controlled-read",
    });
    const read = f.call("read", { path: "index.html" });
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    const request = f.toolCalls()[0];
    expect(request.params).toMatchObject({
      callId: "controlled-read",
      name: "read",
    });
    await f.host.handle({
      id: request.id,
      result: { content: [{ type: "text", text: "fixture project" }] },
    });
    expect(await read).toEqual({
      content: [{ type: "text", text: "fixture project" }],
    });
    f.queries[0].emit({
      type: "result",
      subtype: "success",
      session_id: "qoder-fixture-session-1",
    });
    await vi.waitFor(() =>
      expect(
        f.sent.some(
          (entry) =>
            entry.method === "sdk/message" &&
            ((entry.params as Data)?.message as Data)?.type === "result",
        ),
      ).toBe(true),
    );
  });

  it("emits fixed protocol and SDK error codes without exposing third-party diagnostics", async () => {
    const f = fixture();
    f.startDaemon.mockRejectedValueOnce(
      new Error("private SDK diagnostic must stay private"),
    );
    await f.initializeHost();
    expect(f.sent[0]).toMatchObject({
      error: { code: "QODER_SDK", message: "The Qoder SDK operation failed" },
    });
    await f.host.handle({ id: "unknown", method: "unknown/method" });
    expect(f.sent.find((entry) => entry.id === "unknown")).toMatchObject({
      error: { code: "QODER_PROTOCOL" },
    });
    expect(JSON.stringify(f.sent)).not.toContain("private SDK diagnostic");
  });

  it("preserves a safe SDK failure category and the local startup phase", async () => {
    const f = fixture();
    f.sdkQuery.mockImplementationOnce(() => { throw Object.assign(new Error("PRIVATE_SDK_CANARY"), { code: "DAEMON_PROTOCOL_ERROR" }); });
    await f.initializeHost();
    expect(await f.start()).toMatchObject({ error: { code: "QODER_SDK_DAEMON_PROTOCOL", phase: "query-start" } });
    expect(f.prompts).toEqual([]);
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_SDK_CANARY");
  });

  it.each([
    { resume: true, source: "stream", code: "CHAT_SESSION_HISTORY_MISSING", expected: "QODER_SESSION_HISTORY_MISSING" },
    { resume: true, source: "request", code: "CHAT_SESSION_HISTORY_MISSING", expected: "QODER_SESSION_HISTORY_MISSING" },
    { resume: true, source: "query", code: "CHAT_SESSION_HISTORY_MISSING", expected: "QODER_SDK" },
    { resume: false, source: "request", code: "CHAT_SESSION_HISTORY_MISSING", expected: "QODER_SDK" },
    { resume: true, source: "request", code: "DAEMON_REQUEST_FAILED", expected: "QODER_SDK" },
  ])("only exposes a known pre-input resume failure ($source, resume=$resume, code=$code)", async ({ resume, source, code, expected }) => {
    const f = fixture();
    const failure = Object.assign(new Error("PRIVATE_TRANSCRIPT_PATH"), { name: "DaemonRpcError", code });
    const query = f.sdkQuery.getMockImplementation()!;
    f.sdkQuery.mockImplementationOnce(input => {
      if (source === "query") throw failure;
      const runtime = query(input);
      return { ...runtime,
        initializationResult: vi.fn(async () => { throw failure; }),
        ...(source === "stream" ? { async *[Symbol.asyncIterator]() { throw failure; yield {}; } } : {}),
      };
    });
    await f.initializeHost();
    expect(await f.start(resume ? { resume: "retained-context" } : {})).toMatchObject({ error: { code: expected, phase: source === "query" ? "query-start" : "session-initialize" } });
    if (source === "stream") expect(f.sent.find(entry => entry.method === "sdk/error")).toMatchObject({ params: { code: expected, phase: "session-initialize" } });
    expect(f.prompts).toEqual([]);
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_TRANSCRIPT_PATH");
  });

  it("does not treat missing history after input dispatch as a safe context rebuild", async () => {
    const f = fixture(), fail = deferred<void>();
    const query = f.sdkQuery.getMockImplementation()!;
    f.sdkQuery.mockImplementationOnce(input => {
      const runtime = query(input);
      return { ...runtime, async *[Symbol.asyncIterator]() {
        yield (await runtime[Symbol.asyncIterator]().next()).value;
        await fail.promise;
        throw Object.assign(new Error("PRIVATE_TRANSCRIPT_PATH"), { name: "DaemonRpcError", code: "CHAT_SESSION_HISTORY_MISSING" });
      } };
    });
    await f.initializeHost(); await f.start({ resume: "retained-context" });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    fail.resolve();
    await vi.waitFor(() => expect(f.sent.find(entry => entry.method === "sdk/error")).toMatchObject({ params: { code: "QODER_SDK", phase: "response-stream" } }));
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_TRANSCRIPT_PATH");
  });

  it("keeps the primary boundary failure when SDK query cleanup also fails", async () => {
    const status = deferred<unknown>();
    const f = fixture({ statusGate: status.promise });
    await f.initializeHost();
    const start = f.start();
    await vi.waitFor(() => expect(f.queries).toHaveLength(1));
    f.queries[0].close.mockRejectedValueOnce(new Error("PRIVATE_CLOSE_CANARY"));
    status.resolve([]);
    expect(await start).toMatchObject({ error: { code: "QODER_MCP" } });
    expect(f.prompts).toEqual([]);
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_CLOSE_CANARY");
  });

  it("times out without a complete initialization inventory and never starts inference", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ init: null });
      await f.initializeHost();
      const run = f.start();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await run).toMatchObject({
        error: { message: expect.stringContaining("before any prompt") },
      });
      expect(f.prompts).toEqual([]);
      expect(f.queries[0].close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { memory: { enabled: true } },
    { evolution: { enabled: true } },
    { permissionMode: "acceptEdits" },
  ])(
    "rejects an unexpected effective SDK policy %j before releasing a prompt",
    async (effective) => {
      const f = fixture({ handshake: Promise.resolve(effective) });
      await f.initializeHost();
      expect(await f.start()).toMatchObject({
        error: {
          code: "QODER_POLICY",
          message: expect.stringContaining("runtime policy"),
        },
      });
      expect(f.prompts).toEqual([]);
      expect(f.toolCalls()).toEqual([]);
    },
  );

  it.each([
    [],
    [{ name: "ohmygame", status: "connected", tools: [{ name: "read" }] }],
    [{ name: "ohmygame", status: "connected", tools: [{ name: "mcp__ohmygame__read" }, { name: "mcp__ohmygame__read" }] }],
    [{ name: "external", status: "connected", tools: [{ name: "read" }] }],
    [
      {
        name: "ohmygame",
        status: "connected",
        tools: [{ name: "read" }, { name: "Bash" }],
      },
    ],
    [{ name: "ohmygame", status: "failed", tools: [{ name: "read" }] }],
  ])(
    "rejects MCP status that disagrees with the controlled inventory: %j",
    async (...status) => {
      const f = fixture({ mcpStatus: status });
      await f.initializeHost();
      expect(await f.start()).toMatchObject({ error: { code: "QODER_MCP" } });
      expect(f.prompts).toEqual([]);
      expect(f.toolCalls()).toEqual([]);
    },
  );

  it.each([
    [
      "ambient credential",
      { env: { ...initialize.env, KUNPO_API_KEY: "fixture-not-a-key" } },
    ],
    [
      "inherited HOME",
      { env: { ...initialize.env, HOME: "/Users/other/home" } },
    ],
    [
      "inherited configuration",
      { env: { ...initialize.env, QODER_CONFIG_DIR: "/Users/other/.qoder" } },
    ],
    [
      "overlapping workspace",
      { privateDirectory: initialize.configurationRoot },
    ],
    [
      "Electron override",
      { env: { ...initialize.env, ELECTRON_RUN_AS_NODE: "0" } },
    ],
    [
      "telemetry override",
      { env: { ...initialize.env, OTEL_SDK_DISABLED: "false" } },
    ],
    [
      "tool retry override",
      {
        env: { ...initialize.env, QODER_DISABLE_MALFORMED_TOOL_USE_RETRY: "0" },
      },
    ],
    [
      "reasoning retry override",
      { env: { ...initialize.env, QODER_MAX_REASONING_ONLY_RETRIES: "2" } },
    ],
  ])(
    "rejects unsafe %s before starting the SDK daemon",
    async (_label, params) => {
      const f = fixture();
      await f.initializeHost({ ...initialize, ...params });
      expect(f.sent[0]).toHaveProperty("error");
      expect(f.startDaemon).not.toHaveBeenCalled();
      expect(f.auth).not.toHaveBeenCalled();
    },
  );

  it.each([{ sdkVersion: "1.0.60" }, { runtimeVersion: "1.1.85" }])(
    "rejects unaudited package versions %j before runtime startup",
    async (versions) => {
      const f = fixture(versions);
      await f.initializeHost();
      expect(f.sent[0]).toHaveProperty("error");
      expect(f.startDaemon).not.toHaveBeenCalled();
    },
  );

  it("does not import local account state or list live models implicitly", async () => {
    vi.stubEnv("HOME", "/fixture/host-home");
    vi.stubEnv("QODER_CONFIG_DIR", "/fixture/host-home/.qoder");
    vi.stubEnv("KUNPO_API_KEY", "fixture-never-inherit");
    const f = fixture();
    await f.initializeHost();
    expect(f.auth).toHaveBeenCalledOnce();
    expect(f.startDaemon.mock.calls[0][0]).toMatchObject({
      env: initialize.env,
    });
    expect(f.accountInfo).not.toHaveBeenCalled();
    expect(f.getModels).not.toHaveBeenCalled();
    await f.host.handle({ id: "cached", method: "models/list" });
    expect(f.getModels).toHaveBeenLastCalledWith({ fetchStrategy: "cache" });
    expect(f.accountInfo).not.toHaveBeenCalled();
    await f.host.handle({
      id: "live",
      method: "models/list",
      params: { live: true },
    });
    expect(f.getModels).toHaveBeenLastCalledWith({ fetchStrategy: "live" });
    await f.host.handle({ id: "account", method: "account/read" });
    expect(f.accountInfo).toHaveBeenCalledOnce();
    expect(f.sdkQuery).not.toHaveBeenCalled();
  });

  it("denies native tools, foreign MCP tools and missing call IDs in both permission paths", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    for (const name of [
      "Bash",
      "Read",
      "Agent",
      "WebFetch",
      "mcp__external__read",
    ]) {
      expect(
        await f.queries[0].options.canUseTool(
          name,
          {},
          { toolUseID: "native" },
        ),
      ).toMatchObject({ behavior: "deny" });
      expect(
        await f.hook({
          tool_name: name,
          tool_input: {},
          tool_use_id: "native",
        }),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    }
    expect(
      await f.queries[0].options.canUseTool("mcp__ohmygame__read", {}, {}),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await f.hook({ tool_name: "mcp__ohmygame__read", tool_input: {} }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await f.call("read")).toMatchObject({ isError: true });
    expect(f.toolCalls()).toEqual([]);
    expect(
      await f.queries[0].options.canUseTool(
        "mcp__ohmygame__read",
        {},
        { toolUseID: "real-id" },
      ),
    ).toMatchObject({ behavior: "allow", toolUseID: "real-id" });
  });

  it("reuses pending and completed paid results for the same genuine call ID and arguments", async () => {
    const f = fixture({
      tools: [
        {
          name: "generate_image",
          description: "Mock Kunpo image",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
          },
        },
      ],
    });
    await f.initializeHost();
    await f.start();
    const args = { prompt: "sprite" };
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await f.hook({
        tool_name: "mcp__ohmygame__generate_image",
        tool_input: args,
        tool_use_id: "paid-call",
      });
    const result = f.call("generate_image", args);
    const pendingDuplicate = f.call("generate_image", args);
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    const request = f.toolCalls()[0];
    expect(request.params).toEqual({
      name: "generate_image",
      arguments: args,
      callId: "paid-call",
      turnId: "turn-1",
      sessionId: "qoder-fixture-session-1",
    });
    const artifact = {
      content: [{ type: "text", text: "Kunpo existing-task" }],
      details: { artifact: { path: "art.png" } },
    };
    await f.host.handle({ id: request.id, result: artifact });
    expect(await result).toEqual(artifact);
    expect(await pendingDuplicate).toEqual(artifact);
    await f.hook({
      tool_name: "mcp__ohmygame__generate_image",
      tool_input: args,
      tool_use_id: "paid-call",
    });
    expect(await f.call("generate_image", args)).toEqual(artifact);
    expect(f.toolCalls()).toHaveLength(1);
    expect(await f.call("generate_image", args)).toMatchObject({
      isError: true,
    });
    expect(f.toolCalls()).toHaveLength(1);
  });

  it("rejects reuse of a genuine call ID with changed arguments without forwarding again", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    await f.hook({
      tool_name: "mcp__ohmygame__read",
      tool_input: { path: "first.js" },
      tool_use_id: "same-call",
    });
    const first = f.call("read", { path: "first.js" });
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    await f.host.handle({
      id: f.toolCalls()[0].id,
      result: { content: [{ type: "text", text: "first file" }] },
    });
    expect(await first).not.toHaveProperty("isError");
    await f.hook({
      tool_name: "mcp__ohmygame__read",
      tool_input: { path: "changed.js" },
      tool_use_id: "same-call",
    });
    expect(await f.call("read", { path: "changed.js" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("different arguments") }],
    });
    expect(f.toolCalls()).toHaveLength(1);
  });

  it("refuses indistinguishable concurrent hook IDs instead of inventing an effectful call ID", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    for (const callId of ["first", "second"])
      await f.hook({
        tool_name: "mcp__ohmygame__read",
        tool_input: { path: "game.js" },
        tool_use_id: callId,
      });
    expect(await f.call("read", { path: "game.js" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("unambiguous") }],
    });
    expect(f.toolCalls()).toEqual([]);
  });

  it("fails a premature Qoder completion without claiming an unsettled tool succeeded", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    await f.hook({
      tool_name: "mcp__ohmygame__read",
      tool_input: {},
      tool_use_id: "pending-result",
    });
    const pending = f.call("read");
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    f.queries[0].emit({ type: "result", subtype: "success" });
    await vi.waitFor(() =>
      expect(f.sent.some((message) => message.method === "sdk/error")).toBe(
        true,
      ),
    );
    expect(await pending).toMatchObject({ isError: true });
    expect(
      f.sent.some(
        (message) =>
          message.method === "sdk/message" &&
          (message.params as Data)?.message &&
          ((message.params as Data).message as Data).type === "result",
      ),
    ).toBe(false);
    expect(f.toolCalls()).toHaveLength(1);
  });

  it("revokes dispatch before interruption and ignores late replies and cancelled callbacks", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    await f.hook({
      tool_name: "mcp__ohmygame__read",
      tool_input: {},
      tool_use_id: "pending",
    });
    const pending = f.call("read");
    await vi.waitFor(() => expect(f.toolCalls()).toHaveLength(1));
    await f.host.handle({
      id: "wrong-turn",
      method: "turn/interrupt",
      params: { turnId: "other" },
    });
    expect(f.queries[0].interrupt).not.toHaveBeenCalled();
    await f.host.handle({
      id: "cancel",
      method: "turn/interrupt",
      params: { turnId: "turn-1" },
    });
    expect(await pending).toMatchObject({ isError: true });
    expect(f.queries[0].interrupt).toHaveBeenCalledOnce();
    expect(f.queries[0].close).toHaveBeenCalled();
    await f.host.handle({
      id: f.toolCalls()[0].id,
      result: { content: [{ type: "text", text: "late" }] },
    });
    expect(
      await f.hook({
        tool_name: "mcp__ohmygame__read",
        tool_input: {},
        tool_use_id: "late",
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await f.call("read")).toMatchObject({ isError: true });
    expect(f.toolCalls()).toHaveLength(1);
    await f.host.close();
    await f.host.close();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("resumes only the supplied session and refuses callbacks from the preceding turn", async () => {
    const f = fixture();
    await f.initializeHost();
    await f.start();
    f.queries[0].emit({
      type: "result",
      subtype: "success",
      session_id: "qoder-fixture-session-1",
    });
    await vi.waitFor(() =>
      expect(
        f.sent.some(
          (message) =>
            (message.params as Data)?.message &&
            ((message.params as Data).message as Data).type === "result",
        ),
      ).toBe(true),
    );
    expect(await f.start({ resume: "qoder-fixture-session-1" })).toHaveProperty(
      "result",
    );
    expect(f.queries[1].options.resume).toBe("qoder-fixture-session-1");
    expect(f.queries[1].options).not.toHaveProperty("continue");
    expect(
      await f.hook(
        {
          tool_name: "mcp__ohmygame__read",
          tool_input: {},
          tool_use_id: "stale",
        },
        undefined,
        0,
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await f.call("read", {}, 0)).toMatchObject({ isError: true });
    expect(f.toolCalls()).toEqual([]);
  });

  it.each(["foreign message", "replacement session init"])(
    "fails closed on %s after binding the runtime session",
    async (kind) => {
      const f = fixture();
      await f.initializeHost();
      await f.start();
      f.queries[0].emit(
        kind === "foreign message"
          ? {
              type: "assistant",
              session_id: "another-session",
              message: { content: [{ type: "text", text: "must not appear" }] },
            }
          : { type: "system", subtype: "init", session_id: "replaced-session" },
      );
      await vi.waitFor(() =>
        expect(f.sent.some((message) => message.method === "sdk/error")).toBe(
          true,
        ),
      );
      expect(JSON.stringify(f.sent)).not.toContain("must not appear");
      expect(await f.call("read")).toMatchObject({ isError: true });
      expect(f.toolCalls()).toEqual([]);
    },
  );

  it("stops a newer compatible Qoder turn when a later snapshot reports a different native version", async () => {
    const f = fixture({ init: { qodercli_version: "1.1.84" } });
    await f.initializeHost({ ...initialize, runtimeVersion: "1.1.84" });
    expect(await f.start()).toHaveProperty("result.sessionId", "qoder-fixture-session-1");
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    f.queries[0].emit({ type: "system", subtype: "init", session_id: "qoder-fixture-session-1", qodercli_version: "1.1.85" });
    await vi.waitFor(() => expect(f.sent.find(message => message.method === "sdk/error")).toMatchObject({
      params: { code: "QODER_RUNTIME_INVENTORY", boundary: "runtime-version" },
    }));
    expect(await f.call("read")).toMatchObject({ isError: true });
    expect(f.toolCalls()).toEqual([]);
  });
});

const installedQoderSdk = fileURLToPath(new URL("../.runtime/qoder-sdk/1.0.59/node_modules/@qoder-ai/qoder-agent-sdk/dist/index.js", import.meta.url));
describe.skipIf(!existsSync(installedQoderSdk) || !!process.versions.bun || process.platform === "win32")("installed Qoder SDK through real host stdio and a local protocol daemon", () => {
  it("reads the local account and catalog again after restarting the helper without creating a session", async () => {
    expect(createHash("sha256").update(await readFile(installedQoderSdk)).digest("hex")).toBe("d7b28e41087eafe2913affdfbf37cf72825ff4d1c458debf3fc1490481bf895f");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-real-qoder-probe-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const env = await controlledQoderEnvironment(root);
    const directory = path.join(root, "probe");
    const temporary = path.join(directory, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const privateEnv = { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, ELECTRON_RUN_AS_NODE: "1" };
    const account = { userId: "local-fixture-user" };
    const models = [{ value: "local-fixture-model", displayName: "Local fixture model", description: "Public synthetic catalog data" }];
    await writeFile(path.join(env.QODER_CONFIG_DIR!, "fixture-account-catalog.json"), JSON.stringify({ account, models }), { mode: 0o600 });
    await expect(access(path.join(env.QODER_CONFIG_DIR!, ".auth", "user"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.keys(privateEnv).filter(key => /token|secret|auth/i.test(key))).toEqual([]);
    const fake = path.join(root, "fake-cli.mjs");
    await copyFile(fileURLToPath(new URL("./fixtures/qoder-sdk-daemon.mjs", import.meta.url)), fake);
    const ts = await import("typescript");
    const host = path.join(root, "qoder-host.mjs");
    await writeFile(host, ts.transpileModule(await readFile(fileURLToPath(new URL("../src/daemon/agent-runtimes/qoder-sdk-host.ts", import.meta.url)), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText, { mode: 0o600 });
    type Frame = Record<string, unknown>;
    for (let restart = 0; restart < 2; restart++) {
      // Each helper imports the pinned SDK anew, with every network API and extra process denied.
      const child = spawnFixtureProcess(process.execPath, ["--import", fileURLToPath(new URL("./fixtures/qoder-sdk-network-guard.mjs", import.meta.url)), host, installedQoderSdk], {
        cwd: directory, env: { ...privateEnv, OHMYGAME_QODER_FIXTURE_ROOT: root }, stdio: ["pipe", "pipe", "pipe"], detached: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      cleanup.push(async () => {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
        }
        await exited;
      });
      const sent: Frame[] = [];
      const pending = new Map<string, { resolve(value: Frame): void; reject(error: Error): void }>();
      readline.createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line) as Frame;
        sent.push(message);
        const request = pending.get(String(message.id));
        pending.delete(String(message.id));
        request?.resolve(message);
      });
      child.on("error", error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
      child.on("close", () => {
        for (const request of pending.values()) request.reject(new Error(`Isolated host closed: ${stderr}`));
        pending.clear();
      });
      let nextId = 0;
      const request = (method: string, params: Frame = {}) => {
        const id = String(++nextId);
        return new Promise<Frame>((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Isolated host timed out for ${method}: ${stderr}`)); }, 6000);
          pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
      };
      expect(await request("initialize", { binaryPath: fake, runtimeVersion: "1.1.83", privateDirectory: directory, configurationRoot: path.dirname(env.QODER_CONFIG_DIR!), env: privateEnv }), stderr).toMatchObject({ result: { sdkVersion: "1.0.59", runtimeVersion: "1.1.83" } });
      expect(await request("account/read")).toMatchObject({ result: account });
      expect(await request("models/list")).toMatchObject({ result: models });
      expect(await request("models/list", { live: true })).toMatchObject({ result: models });
      expect(await request("session/close")).toMatchObject({ result: {} });
      child.stdin.end();
      await exited;
      expect(child.exitCode, stderr).toBe(0);
      expect(child.signalCode).toBeNull();
      expect(sent).toHaveLength(5);
      expect(sent.every(message => message.id !== undefined && message.method === undefined)).toBe(true);
    }
    const frames = (await readFile(path.join(env.QODER_CONFIG_DIR!, "fixture-frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
    const received = frames.map(frame => frame.received as Frame);
    expect(received.every(frame => frame.type === "control_request" && frame.session_id === undefined)).toBe(true);
    expect(received.map(frame => (frame.request as Frame).type)).toEqual(Array.from({ length: 2 }, () => ["daemon.initialize", "daemon.account_info", "daemon.get_models", "daemon.get_models", "daemon.shutdown"]).flat());
    expect(received.filter(frame => (frame.request as Frame).type === "daemon.get_models").map(frame => (frame.request as Frame).fetchStrategy)).toEqual(["cache", "live", "cache", "live"]);
    const guards = (await readFile(path.join(root, "guard.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
    expect(guards).toHaveLength(2);
    for (const guard of guards) {
      expect(guard).toMatchObject({ spawned: "local-fake-cli", args: [fake, "--sdk"] });
      try { process.kill(guard.pid as number, 0); expect.fail("The fixture daemon must exit with its SDK host"); }
      catch (error) { expect(error).toMatchObject({ code: "ESRCH" }); }
    }
    await expect(access(path.join(env.QODER_CONFIG_DIR!, ".auth", "user"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);

  it.each(["safe", "newer-compatible", "unsafe-inventory", "ignored-skills", "ignored-meta-deny", "malformed-control", "changed-snapshot-tools", "changed-snapshot-session", "snapshot-after-hook", "vision-initial", "vision-tool", "vision-resume", "vision-false", "vision-missing", "vision-drift", "vision-tool-false", "vision-resume-missing", "vision-tool-gif", "vision-tool-malformed", "result-turn-limit", "result-turn-limit-recover", "edit-preflight-recover", "game-use-recover", "steering", "steering-timeout"] as const)("checks actual SDK startup, control frames and tools with %s output", async (scenario) => {
    const steering = scenario.startsWith("steering");
    const steeringTimeout = scenario === "steering-timeout";
    const preflightRecovery = scenario === "edit-preflight-recover";
    const gameUseRecovery = scenario === "game-use-recover";
    const recovers = scenario === "result-turn-limit-recover" || preflightRecovery || gameUseRecovery;
    const toolName = gameUseRecovery ? "game_use" : preflightRecovery ? "edit" : "write";
    const invalidToolImage = scenario === "vision-tool-gif" || scenario === "vision-tool-malformed";
    const structuredFailure = scenario === "result-turn-limit";
    const usesSession = scenario === "safe" || scenario === "newer-compatible" || scenario === "snapshot-after-hook" || scenario === "vision-initial" || scenario === "vision-tool" || invalidToolImage || structuredFailure || recovers;
    const visual = scenario.startsWith("vision-");
    const completes = steering && !steeringTimeout || usesSession && !invalidToolImage && !structuredFailure || ["vision-initial", "vision-tool", "vision-resume"].includes(scenario);
    const afterToolFailure = scenario === "vision-drift" || scenario === "vision-tool-false" || invalidToolImage;
    const hasToolImage = scenario === "vision-tool" || scenario === "vision-tool-false" || invalidToolImage;
    const images = visual && !scenario.startsWith("vision-tool") && !scenario.startsWith("vision-resume") ? [
      { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" },
      { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC" },
    ] : [];
    const toolImage = { type: "image" as const, mimeType: scenario === "vision-tool-gif" ? "image/gif" : "image/png", data: scenario === "vision-tool-gif" ? "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" : scenario === "vision-tool-malformed" ? "INVALID_TOOL_IMAGE_CANARY" : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
    const changesSnapshot = scenario === "changed-snapshot-tools" || scenario === "changed-snapshot-session";
    const selectedModel = scenario === "safe" ? "gmodel" : `fixture-${scenario}`;
    expect(createHash("sha256").update(await readFile(installedQoderSdk)).digest("hex")).toBe("d7b28e41087eafe2913affdfbf37cf72825ff4d1c458debf3fc1490481bf895f");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ohmygame-real-qoder-sdk-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const env = await controlledQoderEnvironment(root);
    const directory = path.join(root, "session");
    const temporary = path.join(directory, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const privateEnv = { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, ELECTRON_RUN_AS_NODE: "1" };
    await expect(access(path.join(env.QODER_CONFIG_DIR!, ".auth", "user"))).rejects.toMatchObject({ code: "ENOENT" });
    const fake = path.join(root, "fake-cli.mjs");
    await copyFile(fileURLToPath(new URL("./fixtures/qoder-sdk-daemon.mjs", import.meta.url)), fake);
    const ts = await import("typescript");
    const host = path.join(root, "qoder-host.mjs");
    await writeFile(host, ts.transpileModule(await readFile(fileURLToPath(new URL("../src/daemon/agent-runtimes/qoder-sdk-host.ts", import.meta.url)), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText, { mode: 0o600 });
    let entrypoint = host;
    if (steeringTimeout) {
      // Exercise the fixed SDK's actual deadline through its existing dependency-injection seam.
      entrypoint = path.join(root, "timeout-host.mjs");
      await writeFile(entrypoint, `import { runQoderSdkHost, loadQoderSdkHostDependencies } from ${JSON.stringify(pathToFileURL(host).href)};
await runQoderSdkHost(process.stdin, process.stdout, async () => {
  const dependencies = await loadQoderSdkHostDependencies(process.argv[2]);
  return { ...dependencies, sdk: { ...dependencies.sdk, query: input => dependencies.sdk.query({ ...input, options: { ...input.options, resolveModelTimeoutMs: 200 } }) } };
});`, { mode: 0o600 });
    }
    // The real SDK may spawn only our local daemon. Networking is denied before SDK import.
    const child = spawnFixtureProcess(process.execPath, ["--import", fileURLToPath(new URL("./fixtures/qoder-sdk-network-guard.mjs", import.meta.url)), entrypoint, installedQoderSdk], {
      cwd: directory, env: { ...privateEnv, OHMYGAME_QODER_FIXTURE_ROOT: root }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let stderr = "", stdout = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    cleanup.push(async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      await exited;
    });
    type Frame = Record<string, unknown>;
    const sent: Frame[] = [], toolCalls: Frame[] = [];
    let driverReceive: ((message: Frame) => void) | undefined;
    const pending = new Map<string, { resolve(value: Frame): void; reject(error: Error): void }>();
    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", line => {
      const message = JSON.parse(line) as Frame;
      sent.push(message);
      if (message.method === "tool/call") {
        toolCalls.push(message);
        if (driverReceive) driverReceive(message);
        else if (!steering) child.stdin.write(JSON.stringify({ id: message.id, result: { content: hasToolImage ? [toolImage] : [{ type: "text", text: "Local controlled tool completed" }], isError: false } }) + "\n");
      } else if (message.id !== undefined) {
        const request = pending.get(String(message.id));
        pending.delete(String(message.id));
        request?.resolve(message);
      } else driverReceive?.(message);
    });
    child.on("error", error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
    child.on("close", () => {
      for (const request of pending.values()) request.reject(new Error(`Isolated host closed: ${stderr}`));
      pending.clear();
    });
    let nextId = 0;
    const request = (method: string, params: Frame = {}) => {
      const id = String(++nextId);
      return new Promise<Frame>((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Isolated host timed out for ${method}: ${stderr}`)); }, 6000);
        pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    };
    const runtimeVersion = scenario === "newer-compatible" ? "1.1.84" : "1.1.83";
    const initialized = await request("initialize", { binaryPath: fake, runtimeVersion, privateDirectory: directory, configurationRoot: path.dirname(env.QODER_CONFIG_DIR!), env: privateEnv });
    const startupDiagnostics = initialized.error ? `${stderr}\n${await readFile(path.join(root, "guard.jsonl"), "utf8").catch(() => "No guard events")}\n${await readFile(path.join(env.QODER_CONFIG_DIR!, "fixture-frames.jsonl"), "utf8").catch(() => "No daemon frames")}` : "";
    expect(initialized, startupDiagnostics).toMatchObject({ result: { sdkVersion: "1.0.59", runtimeVersion } });
    let started!: Frame;
    if (usesSession) {
      const workspace = path.join(root, "project");
      await mkdir(workspace, { mode: 0o700 });
      const edit = createLocalAgentFileTools(workspace).find(tool => tool.name === "edit")!;
      if (preflightRecovery) await writeFile(path.join(workspace, "fixture.txt"), "before");
      let opened = 0;
      let firstClosed = false;
      const play = vi.fn<GameRuntimeAdapter["request"]>(async input => {
        if (input.operation === "open") return { operation: "open", snapshot: { sessionId: `fixture-playtest-${++opened}`,
          runtime: "web", capabilities: WEB_GAME_USE_CAPABILITIES, viewport: input.viewport } };
        if (input.operation === "close" && input.sessionId === "fixture-playtest-1") {
          firstClosed = true;
          return { operation: "close", resourceStatus: "closed" };
        }
        throw Error("Unexpected SDK playtest fixture request");
      });
      const gameUse = createGameUseTool({ available: true, capabilities: WEB_GAME_USE_CAPABILITIES, request: play, close() {},
        sessionStatus: async () => firstClosed ? "closed" : "live" }, async () => ({ runtime: "web", url: "http://127.0.0.1:43123/" }));
      const execute = vi.fn(async (...call: unknown[]) => gameUseRecovery ? gameUse.execute(...call as Parameters<typeof gameUse.execute>) : preflightRecovery ? edit.execute(...call as Parameters<typeof edit.execute>) : ({ content: hasToolImage ? [toolImage] : [{ type: "text" as const, text: "Local controlled tool completed" }], details: {} }));
      const controlledTool = gameUseRecovery ? { ...gameUse, execute } : preflightRecovery ? { ...edit, execute } : defineTool({ name: "write", label: "Local write fixture", description: "Controlled local fixture", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute });
      const manager = SessionManager.create(workspace, path.join(root, "persisted-session"));
      const guard = new AutoContinueTools([controlledTool] as never, { sessionManager: manager });
      const bridge = new ToolBridge(guard.wrap(), true, false, { getBranch: () => manager.getBranch() });
      const drivers: QoderDriver[] = [];
      const createDriver = () => {
        const driver = new QoderDriver({ binaryPath: fake, workspacePath: workspace, privateDirectory: directory, env: privateEnv, instructions: "Use only the provided local fixture tool.", bridge, policy: { workspacePath: workspace, neverTouch: [] }, skillDirectories: [], model: selectedModel, reasoningLevel: "high", contextWindow: 128000 }, receive => {
        driverReceive = receive;
        return {
          start: async () => {}, stop: async () => { driverReceive = undefined; },
          respond: (id, result) => { child.stdin.write(JSON.stringify({ id, result }) + "\n"); },
          request: async (method, params) => {
            const reply = await request(method, params);
            if (method === "turn/start") started = reply;
            if (reply.error) throw new Error("The local fixture host rejected a request");
            return reply.result;
          },
        };
        });
        drivers.push(driver); return driver;
      };
      const snapshot = vi.fn(async () => "1".repeat(40));
      const session = new NativeCodingSession({ runtime: "qoder-cli", model: selectedModel, sessionManager: manager, continuationTools: guard, ...(recovers ? { snapshotBeforeMessage: snapshot } : {}), toolNames: [toolName], setActiveTools: names => bridge.setActive(names), createDriver, requestApproval: async () => "deny" });
      cleanup.push(() => session.dispose());
      const events: Frame[] = [];
      session.subscribe(event => events.push(event as unknown as Frame));
      await session.prompt("Exercise only the local SDK protocol fixture.", images.length ? { images } : undefined);
      if (recovers) {
        expect(session.interruption).toMatchObject({ kind: "turn_limit", source: "qoder", code: "qoder_max_turns" });
        if (preflightRecovery) {
          expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("after");
          expect(guard.recoverySummary).toContain("not_executed");
          expect(handoffSummary(manager.getBranch())).toContain('"state":"not_executed","reason":"edit_text_not_unique"');
        }
        await session.prepareContinuation(new AbortController().signal);
        await session.resumeAfterInterruption();
        expect(session.interruption).toBeUndefined();
        expect(snapshot).toHaveBeenCalledOnce();
        expect(drivers).toHaveLength(2);
        const trustedContext = execute.mock.calls[0]?.[4] as { sessionManager?: { getBranch(): unknown[] } } | undefined;
        expect(Object.keys(trustedContext?.sessionManager ?? {})).toEqual(["getBranch"]);
        expect(trustedContext?.sessionManager?.getBranch().length).toBeGreaterThan(0);
      }
      const reopened = SessionManager.open(manager.getSessionFile()!);
      if (recovers) {
        expect(reopened.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
        expect(reopened.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome").map(entry => entry.type === "custom" ? entry.data : undefined)).toEqual([
          expect.objectContaining({ status: "failed", segment: 1, sdkNumTurns: 64, resultSubtype: "error_max_turns" }), expect.objectContaining({ status: "completed", segment: 2, sdkNumTurns: 1, resultSubtype: "success" }),
        ]);
        expect(await readFile(manager.getSessionFile()!, "utf8")).not.toContain("PRIVATE_TERMINAL_CANARY");
      } else if (!invalidToolImage && !structuredFailure) {
        expect(conversationItems(reopened.getBranch()).filter(item => item.type === "agentMessage").map(item => item.text)).toEqual(["Local SDK protocol completed."]);
        expect(handoffSummary(reopened.getBranch())!.split("Assistant: Local SDK protocol completed.").length - 1).toBe(1);
        expect(JSON.stringify(replayNativeMessages(reopened.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []))).split("Local SDK protocol completed.").length - 1).toBe(1);
      } else if (invalidToolImage) {
        expect(reopened.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult")).toMatchObject({ message: { content: [toolImage], isError: false } });
      } else {
        expect(session.interruption).toMatchObject({ kind: "turn_limit", source: "qoder", code: "qoder_max_turns" });
        expect(reopened.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ohmygame-native-outcome").at(-1)).toMatchObject({ data: { segment: 1, sdkNumTurns: 64 } });
        expect(await readFile(manager.getSessionFile()!, "utf8")).not.toContain("PRIVATE_TERMINAL_CANARY");
      }
      expect(execute).toHaveBeenCalledTimes(gameUseRecovery ? 3 : preflightRecovery ? 2 : 1);
      const retainedResults = reopened.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
      expect(retainedResults).toHaveLength(gameUseRecovery || preflightRecovery ? 4 : recovers ? 2 : 1);
      if (gameUseRecovery) expect(play.mock.calls.map(([input]) => input.operation)).toEqual(["open", "close", "open"]);
      if (preflightRecovery) {
        expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("after");
        expect(retainedResults.filter(entry => entry.type === "message" && (entry.message as { toolCallId?: string }).toolCallId === "rejected-edit")).toEqual([
          expect.objectContaining({ message: expect.objectContaining({ isError: true, preflightFailure: { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" } }) }),
          expect.objectContaining({ message: expect.objectContaining({ isError: true, preflightFailure: { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" } }) }),
        ]);
        expect(handoffSummary(reopened.getBranch())).toContain('"originalCallId":"corrected-edit","tool":"edit","state":"completed"');
      }
      expect(events.filter(event => event.type === "tool_execution_start")).toHaveLength(gameUseRecovery || preflightRecovery ? 4 : recovers ? 2 : 1);
      expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(gameUseRecovery || preflightRecovery ? 4 : recovers ? 2 : 1);
    } else {
      started = await request("turn/start", { turnId: "sdk-wire-turn", model: selectedModel, reasoningLevel: "high", contextWindow: 128000, text: "Exercise only the local SDK protocol fixture.", images, ...(scenario.startsWith("vision-resume") ? { resume: "11111111-1111-4111-8111-111111111111", requiresImageInput: true } : {}), instructions: "Use only the provided local fixture tool.",
        tools: [{ name: "write", description: "Controlled local fixture", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } }] });
    }
    if (steering) {
      await vi.waitFor(() => expect(toolCalls).toHaveLength(1));
      expect(await request("turn/steer", { turnId: "sdk-wire-turn", commandId: "22222222-2222-4222-8222-222222222222", text: "Use the new instructions at the next safe boundary.", images: [] })).toMatchObject({ result: { queued: true } });
      await vi.waitFor(async () => {
        const frames = (await readFile(path.join(env.QODER_CONFIG_DIR!, "fixture-frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
        expect(frames.filter(frame => (frame.received as Frame | undefined)?.type === "user")).toHaveLength(2);
      });
      child.stdin.write(JSON.stringify({ id: toolCalls[0].id, result: { content: [{ type: "text", text: "Local controlled tool completed" }], isError: false } }) + "\n");
      await vi.waitFor(() => expect(sent.some(message => message.method === "steering/started"), JSON.stringify(sent)).toBe(true));
      const beforeAdmission = (await readFile(path.join(env.QODER_CONFIG_DIR!, "fixture-frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
      expect(beforeAdmission.filter(frame => frame.modelRequest)).toHaveLength(1);
      expect(beforeAdmission.filter(frame => frame.toolResult)).toHaveLength(1);
      if (steeringTimeout) {
        await vi.waitFor(() => expect(sent.some(message => message.method === "sdk/error")).toBe(true));
      } else {
        // Exercise the real SDK beyond its default 500 ms model-policy deadline.
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(sent.some(message => message.method === "sdk/error")).toBe(false);
        const admission = sent.find(message => message.method === "steering/started")!;
        expect(admission.params).toMatchObject({ commandId: "22222222-2222-4222-8222-222222222222", sessionId: "11111111-1111-4111-8111-111111111111" });
        child.stdin.write(JSON.stringify({ id: admission.id, result: { accepted: true } }) + "\n");
      }
      expect(sent.some(message => message.method === "sdk/message" && ((message.params as Frame).message as Frame).type === "result")).toBe(false);
    }
    if (completes) {
      expect(started, JSON.stringify(sent)).toMatchObject({ result: { sessionId: "11111111-1111-4111-8111-111111111111" } });
      await vi.waitFor(() => expect(sent.some(message => message.method === "sdk/message" && ((message.params as Frame).message as Frame).type === "result"), JSON.stringify(sent)).toBe(true));
      expect(toolCalls).toHaveLength(gameUseRecovery ? 6 : preflightRecovery ? 4 : recovers ? 2 : 1);
      expect(toolCalls[0]!.params).toMatchObject(gameUseRecovery ? { name: "game_use", callId: "game-open-first", arguments: { operation: "open" } } : preflightRecovery ? { name: "edit", callId: "rejected-edit", arguments: { path: "fixture.txt", edits: [{ oldText: "absent", newText: "after" }] } } : { name: "write", callId: "runtime-call-1", arguments: { path: "fixture.txt", content: "SDK transport result" } });
      const emitted = sent.filter(message => message.method === "sdk/message").map(message => (message.params as Frame).message as Frame);
      const completedIndex = emitted.findIndex(message => message.type === "assistant");
      expect(emitted[completedIndex]!.message).toMatchObject({ id: "fixture-assistant", content: [{ type: "text", text: "Local SDK protocol completed." }] });
      expect(emitted.slice(0, completedIndex).some(message => (message.event as Frame | undefined)?.type === "content_block_start" && (message.event as Frame).index === 1)).toBe(true);
      expect(emitted.slice(completedIndex + 1).some(message => (message.event as Frame | undefined)?.type === "content_block_stop" && (message.event as Frame).index === 1)).toBe(true);
    } else if (steeringTimeout) {
      expect(started).toHaveProperty("result.sessionId");
      expect(toolCalls).toHaveLength(1);
    } else if (structuredFailure) {
      expect(started).toHaveProperty("result.sessionId");
      expect(sent.find(message => message.method === "sdk/message" && ((message.params as Frame).message as Frame).type === "result")).toMatchObject({ params: { message: { subtype: "error_max_turns", num_turns: 64 } } });
      expect(toolCalls).toHaveLength(1);
    } else if (changesSnapshot || visual) {
      expect(started, JSON.stringify(sent)).toMatchObject({ result: { sessionId: "11111111-1111-4111-8111-111111111111" } });
      await vi.waitFor(() => expect(sent.some(message => message.method === "sdk/error"), JSON.stringify(sent)).toBe(true));
      const failed = sent.find(message => message.method === "sdk/error")!;
      expect(failed.params).toMatchObject({ code: visual ? "QODER_IMAGE_INPUT" : scenario === "changed-snapshot-tools" ? "QODER_RUNTIME_INVENTORY" : "QODER_SDK_DAEMON_PROTOCOL" });
      if (scenario === "changed-snapshot-tools") expect(failed.params).toMatchObject({ boundary: "active-tools" });
      expect(String((failed.params as Frame).message)).not.toMatch(/no prompt|未发送/i);
      expect(toolCalls).toHaveLength(afterToolFailure ? 1 : 0);
    } else {
      expect(started, JSON.stringify(sent)).toMatchObject({ error: { code: scenario === "malformed-control" ? "QODER_SDK_DAEMON_PROTOCOL" : "QODER_INVENTORY" } });
      if (scenario !== "malformed-control") expect(started).toMatchObject({ error: { boundary: scenario === "ignored-skills" ? "skills" : "active-tools" } });
      if (scenario === "malformed-control") expect(started).toMatchObject({ error: { phase: "session-initialize" } });
      expect(toolCalls).toEqual([]);
    }
    await request("session/close");
    child.stdin.end();
    await exited;
    expect(stdout).not.toContain("PRIVATE_SDK_PROTOCOL_CANARY");
    expect(stderr).not.toContain("PRIVATE_SDK_PROTOCOL_CANARY");
    expect(stdout).not.toContain("PRIVATE_VISION_POLICY_CANARY");
    expect(stderr).not.toContain("PRIVATE_VISION_POLICY_CANARY");
    expect(stdout).not.toContain("INVALID_TOOL_IMAGE_CANARY");
    expect(stderr).not.toContain("INVALID_TOOL_IMAGE_CANARY");
    expect(stdout).not.toContain("PRIVATE_TERMINAL_CANARY");
    expect(stderr).not.toContain("PRIVATE_TERMINAL_CANARY");
    if (completes) expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    const frames = (await readFile(path.join(env.QODER_CONFIG_DIR!, "fixture-frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
    const received = frames.filter(frame => frame.received).map(frame => frame.received as Frame);
    expect(received.some(frame => String((frame.request as Frame | undefined)?.type).match(/account|authenticate|get_models/))).toBe(false);
    const userFrames = received.filter(frame => frame.type === "user");
    expect(userFrames).toHaveLength(recovers || steering ? 2 : completes || changesSnapshot || visual || structuredFailure ? 1 : 0);
    if (steering) {
      expect(userFrames[1]).toMatchObject({ priority: "next", uuid: "22222222-2222-4222-8222-222222222222" });
      expect(frames.filter(frame => frame.modelRequest)).toHaveLength(steeringTimeout ? 1 : 2);
      expect(frames.filter(frame => frame.modelPolicyDenied)).toHaveLength(steeringTimeout ? 1 : 0);
      expect(frames.filter(frame => frame.toolResult)).toHaveLength(1);
      expect(received.some(frame => (frame.request as Frame | undefined)?.subtype === "interrupt")).toBe(false);
    }
    if (visual) {
      expect((userFrames[0]!.message as Frame).content).toEqual([{ type: "text", text: "Exercise only the local SDK protocol fixture." }, ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))]);
      expect(frames.filter(frame => frame.modelRequest)).toHaveLength(completes ? 2 : afterToolFailure ? 1 : 0);
      if (hasToolImage && !invalidToolImage) expect(frames.find(frame => frame.toolResult)).toMatchObject({ toolResult: { mcp_response: { result: { content: [toolImage] } } } });
      if (scenario.startsWith("vision-resume")) {
        const opened = received.find(frame => (frame.request as Frame | undefined)?.type === "daemon.open_session")!.request as Frame;
        expect(opened.worker_args).toEqual(expect.arrayContaining(["--resume", "11111111-1111-4111-8111-111111111111"]));
      }
    }
    if (scenario !== "malformed-control") {
      const metaTools = ["mcp_list", "mcp_get", "mcp_call"];
      const inventory = frames.find(frame => frame.inventory)!.inventory as Frame;
      expect(inventory.registered).toEqual(expect.arrayContaining(metaTools));
      expect(inventory.explicitDeny).toEqual(metaTools);
      expect(inventory.active).toEqual(scenario === "ignored-meta-deny" ? ["mcp__ohmygame__write", ...metaTools] : [`mcp__ohmygame__${toolName}`]);
    }
    if (completes) {
      expect(frames.filter(frame => frame.snapshot).map(frame => (frame.snapshot as Frame).stage)).toEqual(recovers ? ["initialize", "turn-start", "initialize", "turn-start"] : scenario === "snapshot-after-hook" ? ["initialize", "turn-start", "after-hook", "after-tool-result"] : ["initialize", "turn-start"]);
      expect(sent.filter(message => message.method === "sdk/message" && ((message.params as Frame).message as Frame).subtype === "init")).toHaveLength(recovers ? 2 : 1);
      expect(received.some(frame => (frame.request as Frame | undefined)?.subtype === "set_plan_mode")).toBe(true);
      const opened = received.find(frame => (frame.request as Frame | undefined)?.type === "daemon.open_session")!.request as Frame;
      expect(opened.worker_args).toEqual(expect.arrayContaining(["--model", selectedModel, "--strict-mcp-config"]));
      const workerArgs = opened.worker_args as string[];
      expect(workerArgs[workerArgs.indexOf("--tools") + 1]).toBe(`mcp__ohmygame__${toolName}`);
      expect(workerArgs.flatMap((value, index) => value === "--disallowed-tools" ? [workerArgs[index + 1]] : [])).toEqual(["mcp_list", "mcp_get", "mcp_call"]);
      expect(workerArgs[workerArgs.indexOf("--setting-sources") + 1]).toBe("");
      expect(workerArgs[workerArgs.indexOf("--max-turns") + 1]).toBe("64");
      expect(JSON.parse(workerArgs[workerArgs.indexOf("--settings") + 1]!)).toHaveProperty("skills.enabled", false);
      expect(workerArgs).not.toContain("--dangerously-skip-permissions");
      const queryInitialize = received.find(frame => (frame.request as Frame | undefined)?.type === "initialize")!.request as Frame;
      expect(queryInitialize).toMatchObject({ sdkMcpServers: ["ohmygame"], skills: [], agents: {}, enableFileCheckpointing: false, promptSuggestions: false, independentPlanModeControls: true, permissionMode: "default" });
      expect(frames.find(frame => frame.modelPolicy)).toMatchObject({ modelPolicy: { model: selectedModel, parameters: { reasoningEffort: "high", contextWindow: 128000 } } });
      expect(frames.find(frame => frame.permission === "native")).toMatchObject({ response: { behavior: "deny" } });
      expect(frames.find(frame => frame.permission === "controlled")).toMatchObject({ response: { behavior: "allow", toolUseID: gameUseRecovery ? "game-open-first" : preflightRecovery ? "rejected-edit" : "runtime-call-1" } });
      if (gameUseRecovery) {
        const receipts = frames.filter(frame => frame.toolResult).map(frame => JSON.stringify(frame.toolResult));
        expect(receipts).toHaveLength(6);
        expect(receipts[0]).toContain("fixture-playtest-1");
        expect(receipts[1]).toContain('\\"resourceStatus\\":\\"live\\"');
        expect(receipts[3]).toContain('\\"resourceStatus\\":\\"closed\\"');
        expect(receipts[4]).toContain('\\"resourceStatus\\":\\"closed\\"');
        expect(receipts[5]).toContain("fixture-playtest-2");
        expect(JSON.stringify(frames.find(frame => frame.conflictingToolResult)?.conflictingToolResult)).toContain("CALL_ID_CONFLICT");
      } else if (preflightRecovery) {
        expect(frames.filter(frame => frame.toolResult && frame.callId === "rejected-edit")).toEqual([
          expect.objectContaining({ toolResult: { mcp_response: { jsonrpc: "2.0", id: expect.any(Number), result: { isError: true, content: [{ type: "text", text: "oldText must match exactly once" }] } } } }),
          expect.objectContaining({ toolResult: { mcp_response: { jsonrpc: "2.0", id: expect.any(Number), result: { isError: true, content: [{ type: "text", text: "oldText must match exactly once" }] } } } }),
        ]);
        const continuationText = JSON.stringify((userFrames[1]!.message as Frame).content);
        expect(continuationText).toContain("rejected-edit");
        expect(continuationText).toContain("not_executed");
        expect(continuationText).toContain("corrected-edit");
      } else if (!hasToolImage) expect(frames.find(frame => frame.toolResult)).toMatchObject({ toolResult: { mcp_response: { result: { content: [{ type: "text", text: "Local controlled tool completed" }] } } } });
      if (scenario === "snapshot-after-hook") expect(frames.find(frame => frame.replayedToolResult)).toMatchObject({ replayedToolResult: { mcp_response: { result: { content: [{ type: "text", text: "Local controlled tool completed" }] } } } });
    }
    const guards = (await readFile(path.join(root, "guard.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({ spawned: "local-fake-cli", args: [fake, "--sdk"] });
    try { process.kill(guards[0]!.pid as number, 0); expect.fail("The fixture daemon must exit with its SDK host"); }
    catch (error) { expect(error).toMatchObject({ code: "ESRCH" }); }
    await expect(access(path.join(env.QODER_CONFIG_DIR!, ".auth", "user"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);
});
