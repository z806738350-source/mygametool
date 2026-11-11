import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type {
  NativeDriver,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import {
  CodexAppServer,
  codexLimits,
  CODEX_APPROVAL_POLICY,
  requireCodexPermissionProfile,
} from "./codex-app-server.js";
import {
  number,
  record,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import {
  acquireCodexServer,
  type CodexServerLease,
} from "./codex-server-pool.js";
import { NativeSessionExpiredError } from "./native-session.js";
import { canonicalPath } from "./policy.js";
import type { AgentContextUsage } from "../../shared/contracts.js";
import { runtimeStartupError } from "./compatibility.js";
import type { AgentInterruption } from "../agent-auto-continue.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";
import {
  CODEX_TOOL_NAMESPACE,
  CODEX_CONTROLLED_CONFIG,
  requireControlledCodexConfig,
} from "./controlled-codex.js";

/** A turn on a shared server must stop on its own: the process outlives the conversation. */
const INTERRUPT_TIMEOUT_MS = 5_000;
const TOOL_PREFIX = `${BRIDGE_SERVER_NAME}_`;

interface CodexTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  resolve: (outcome: NativeTurnOutcome) => void;
  turnId?: string;
  error?: string;
  imageError?: string;
  finishing?: boolean;
  interruption?: AgentInterruption;
}

/**
 * Codex through its app server: one thread per conversation, one turn per
 * message. OhMyGame's tools are the thread's dynamic tools, answered over the
 * same pipe. Project operations run only in the host tool bridge; native tools
 * have a read-only private directory and cannot request additional permissions.
 */
export class CodexDriver implements NativeDriver {
  #disposed = false;
  readonly #profile = `ohmygame-${randomUUID()}`;
  readonly #readProfile = `${this.#profile}-read`;
  /** Both normal and planning turns deny native writes. */
  readonly #writeProfile: string;
  #limits: NonNullable<AgentContextUsage["limits"]> = [];
  #lease?: CodexServerLease;
  #starting?: Promise<CodexAppServer>;
  #threadId?: string;
  #turn?: CodexTurn;
  #toolCalls = new Map<string, { input: string; result: Promise<unknown>; settled: boolean }>();
  #completedTurns = new Set<string>();

  constructor(private readonly context: DriverContext) {
    this.#threadId = context.resume;
    this.#writeProfile = this.#profile;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    if (this.#turn) throw new Error("A Codex turn is already running");
    if (signal.aborted) return { status: "aborted" };
    let server: CodexAppServer;
    let threadId: string;
    try {
      server = await this.#start();
      if (signal.aborted) return { status: "aborted" };
      threadId = await this.#thread(server, sink);
      if (this.#limits.length) sink.limits?.(this.#limits);
      if (signal.aborted) return { status: "aborted" };
    } catch (cause) {
      if (cause instanceof NativeSessionExpiredError) throw cause;
      if (signal.aborted) return { status: "aborted" };
      return {
        status: "failed",
        error: runtimeStartupError(cause).message,
      };
    }
    this.#toolCalls.clear();
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = {
        sink,
        signal,
        resolve,
      };
      this.#turn = turn;
      server
        .request<{ turn?: { id?: string } }>("turn/start", {
          threadId,
          input: codexInput(input),
          ...(this.context.reasoningLevel
            ? { effort: this.context.reasoningLevel }
            : {}),
          model: this.context.model,
          permissions: input.readOnly ? this.#readProfile : this.#writeProfile,
        })
        .then(
          (response) => {
            turn.turnId ??= response.turn?.id;
          },
          (cause) => {
            if (this.#turn !== turn) return;
            this.#turn = undefined;
            resolve({
              status: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            });
          },
        );
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn?.turnId || !this.#lease || !this.#threadId) return;
    await this.#lease.server
      .request(
        "turn/interrupt",
        { threadId: this.#threadId, turnId: turn.turnId },
        INTERRUPT_TIMEOUT_MS,
      )
      .catch(() => {});
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    const server = await this.#start();
    const threadId = await this.#thread(server, sink);
    sink.compaction("start");
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = { sink, signal, resolve };
      this.#turn = turn;
      server.request("thread/compact/start", { threadId }).catch((cause) => {
        if (this.#turn !== turn) return;
        this.#turn = undefined;
        resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    sink.compaction(
      "end",
      outcome.status === "failed" ? { error: outcome.error } : {},
    );
    if (outcome.status === "failed") throw new Error(outcome.error);
  }

  /**
   * Lets go of the shared server. Other conversations may still use it, so a
   * turn of this thread is interrupted rather than ended with the process;
   * the server stops with its last conversation.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.interrupt();
    const turn = this.#turn;
    this.#turn = undefined;
    const lease = this.#lease;
    this.#lease = undefined;
    await lease?.release();
    turn?.resolve({ status: "aborted" });
  }

  async #start(): Promise<CodexAppServer> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#lease?.server.process.running) return this.#lease.server;
    return (this.#starting ??= (async () => {
      try {
        const shared = this.context.codexServer;
        const lease = await acquireCodexServer(
          {
            // Without a shared identity the server is this session's alone.
            key: shared?.key ?? `private-${this.#profile}`,
            directory: shared?.directory ?? this.context.privateDirectory,
            shared: Boolean(shared),
            binaryPath: this.context.binaryPath,
            env: this.context.env,
            processDirectory: this.context.processDirectory,
            skillDirectories: [],
          },
          {
            notification: (method, params) =>
              this.#notification(method, params),
            request: (method, params) => this.#request(method, params),
            exit: (failure) => {
              this.#lease = undefined;
              const turn = this.#turn;
              this.#turn = undefined;
              turn?.resolve(
                turn.signal.aborted
                  ? { status: "aborted" }
                  : { status: "failed", error: failure, interruption: { kind: "transient", source: "codex", code: "codex_process_exited", phase: "stream", terminalReason: "process_exited" } },
              );
            },
          },
          codexLimits,
        );
        if (this.#disposed) {
          await lease.release();
          throw new Error("The agent session was closed");
        }
        this.#lease = lease;
        this.#limits = lease.limits;
        return lease.server;
      } finally {
        this.#starting = undefined;
      }
    })());
  }

  async #thread(server: CodexAppServer, sink: NativeTurnSink): Promise<string> {
    const settings = {
      cwd: this.context.privateDirectory,
      // Never approve unrestricted sandbox escapes. Scoped permission requests
      // can still be reviewed without removing the protected-read boundary.
      approvalPolicy: CODEX_APPROVAL_POLICY,
      permissions: this.#writeProfile,
      model: this.context.model,
      developerInstructions: this.context.instructions,
      config: await this.#config(server),
    };
    if (this.#threadId) {
      try {
        const resumed = await server.request<{
          thread?: { id?: string };
          activePermissionProfile?: { id?: string };
        }>("thread/resume", { threadId: this.#threadId, ...settings });
        requireCodexPermissionProfile(resumed, this.#writeProfile);
        const id = resumed.thread?.id ?? this.#threadId;
        this.#threadId = id;
        this.#lease?.bind(id);
        sink.nativeSession(id);
        return id;
      } catch (cause) {
        if (
          /thread (?:not found|.*does not exist)|no rollout found|failed to (?:load|find).*rollout|not found.*thread/i.test(
            String(cause),
          )
        )
          throw new NativeSessionExpiredError(String(cause));
        throw cause;
      }
    }
    // Dynamic tools are fixed when the thread starts, including in planning.
    // Names such as mcp are reserved by Codex, so prefix the host's tools.
    const tools = this.context.bridge.list("all").map((tool) => ({
      type: "function",
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const started = await server.request<{
      thread?: { id?: string };
      activePermissionProfile?: { id?: string };
    }>("thread/start", {
      ...settings,
      dynamicTools: [
        {
          type: "namespace",
          name: CODEX_TOOL_NAMESPACE,
          description: "OhMyGame's controlled project and Kunpo asset tools.",
          tools,
        },
      ],
    });
    requireCodexPermissionProfile(started, this.#writeProfile);
    const id = started.thread?.id;
    if (!id) throw new Error("Codex did not start a thread");
    this.#threadId = id;
    this.#lease?.bind(id);
    sink.nativeSession(id);
    return id;
  }

  /** Permission overrides and prevention of a recursive OhMyGame MCP connection. */
  async #config(server: CodexAppServer): Promise<Record<string, unknown>> {
    // Native tools see only the empty session directory. Project access is through the host bridge.
    const directory = canonicalPath(this.context.privateDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const profile = {
      filesystem: {
        ":minimal": "read",
        ...Object.fromEntries(
          [
            "/tmp",
            "/var/tmp",
            this.context.env.HOME,
            this.context.env.CODEX_HOME,
            ...this.context.policy.neverTouch,
            this.context.workspacePath,
          ]
            .filter((value): value is string => Boolean(value))
            .map((value) => [canonicalPath(value), "deny"]),
        ),
        [directory]: "read",
      },
      network: { enabled: false },
    };
    const config: Record<string, unknown> = {
      ...CODEX_CONTROLLED_CONFIG,
      default_permissions: this.#writeProfile,
      allow_login_shell: false,
      project_root_markers: [],
      permissions: { [this.#profile]: profile, [this.#readProfile]: profile },
      "shell_environment_policy.inherit": "none",
      "shell_environment_policy.set": {},
    };
    // Fail closed: discovery of inherited MCP configuration must succeed before starting a thread.
    const read = await server.request<{ config?: Record<string, unknown> }>(
      "config/read",
      { cwd: directory },
    );
    requireControlledCodexConfig(read.config);
    for (const name of Object.keys(record(read.config?.mcp_servers) ?? {}))
      config[`mcp_servers.${name}.enabled`] = false;
    return config;
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      this.#limits = codexLimits(params);
      this.#turn?.sink.limits?.(this.#limits);
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    const eventTurnId =
      typeof params.turnId === "string"
        ? params.turnId
        : record(params.turn)?.id;
    if (
      typeof eventTurnId === "string" &&
      (this.#completedTurns.has(eventTurnId) ||
        (turn.turnId && turn.turnId !== eventTurnId))
    )
      return;
    if (typeof params.turnId === "string") turn.turnId ??= params.turnId;
    const sink = turn.sink;
    switch (method) {
      case "turn/started":
        turn.turnId ??= String(record(params.turn)?.id ?? "");
        return;
      case "item/agentMessage/delta":
        if (
          typeof params.itemId === "string" &&
          typeof params.delta === "string"
        )
          sink.text(params.itemId, params.delta);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (
          typeof params.itemId === "string" &&
          typeof params.delta === "string"
        )
          sink.thinking(params.itemId, params.delta);
        return;
      case "item/started":
        this.#itemStarted(sink, record(params.item) ?? {});
        return;
      case "item/completed":
        this.#itemCompleted(sink, record(params.item) ?? {});
        return;
      case "item/commandExecution/outputDelta":
        // The whole output comes with the completed item; streamed output is not repeated in the record.
        return;
      case "thread/tokenUsage/updated": {
        // `total` adds up the whole thread; `last` is the latest request,
        // which is what the context holds and what a stored message records.
        const usage = record(params.tokenUsage);
        const last = record(usage?.last);
        if (last) {
          sink.usage(
            {
              input: number(last.inputTokens) - number(last.cachedInputTokens),
              output: number(last.outputTokens),
              cacheRead: number(last.cachedInputTokens),
              cacheWrite: number(last.cacheWriteInputTokens),
            },
            typeof usage?.modelContextWindow === "number"
              ? usage.modelContextWindow
              : undefined,
            number(last.inputTokens) + number(last.outputTokens),
          );
        }
        return;
      }
      case "thread/started":
        if (typeof record(params.thread)?.id === "string")
          sink.nativeSession(String(record(params.thread)!.id));
        return;
      case "error": {
        const error = record(params.error);
        if (params.willRetry !== true) {
          turn.error = codexError(error?.message);
          turn.interruption = codexInterruption(error);
        }
        return;
      }
      case "turn/completed": {
        if (!turn.finishing) {
          turn.finishing = true;
          void this.#completeTurn(turn, record(params.turn) ?? {});
        }
        return;
      }
      default:
        return;
    }
  }

  async #completeTurn(
    turn: CodexTurn,
    completed: Record<string, unknown>,
  ): Promise<void> {
    if (this.#turn !== turn) return;
    this.#turn = undefined;
    if (turn.turnId) {
      this.#completedTurns.add(turn.turnId);
      if (this.#completedTurns.size > 200)
        this.#completedTurns.delete(
          this.#completedTurns.values().next().value!,
        );
    }
    const terminalInterruption = turn.interruption ?? codexInterruption(record(completed.error));
    if (turn.signal.aborted)
      turn.resolve({ status: "aborted" });
    else if (turn.imageError || terminalInterruption.kind === "blocked" || completed.error !== undefined && terminalInterruption.kind === "unknown")
      turn.resolve({ status: "failed", error: turn.imageError || "Codex stopped because the request could not safely continue.", interruption: turn.imageError ? { kind: "blocked", source: "codex", code: "codex_image_delivery", phase: "result" } : terminalInterruption });
    else if ([...this.#toolCalls.values()].some(call => !call.settled))
      turn.resolve({ status: "failed", error: "Codex ended before a controlled tool result was confirmed. Recover or review the original operation.", interruption: { kind: "runtime_interrupted", source: "codex", code: "codex_pending_tool_result", phase: "tools", terminalReason: "runtime_interrupted" } });
    else if (completed.status === "interrupted")
      turn.resolve({ status: "failed", error: "Codex interrupted the turn before completing the task.", interruption: { kind: "runtime_interrupted", source: "codex", code: "codex_runtime_interrupted", phase: "result", terminalReason: "runtime_interrupted", cancelOrigin: "runtime" } });
    else if (completed.status === "failed" || turn.imageError)
      turn.resolve({
        status: "failed",
        error:
          turn.imageError ||
          codexError(record(completed.error)?.message) ||
          turn.error ||
          "Codex could not finish the turn",
        interruption: turn.imageError ? { kind: "blocked", source: "codex", code: "codex_image_delivery", phase: "result" } : turn.interruption ?? codexInterruption(record(completed.error)),
      });
    else if (completed.status === "completed") turn.resolve({ status: "completed" });
    else turn.resolve({ status: "failed", error: "Codex returned an unknown terminal state.", interruption: { kind: "unknown", source: "codex", code: "codex_unknown_terminal", phase: "result", terminalReason: "unknown" } });
  }

  #itemStarted(sink: NativeTurnSink, item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "imageGeneration":
        sink.toolCall(id, "generate_image", {
          source: "codex",
          ...(typeof item.revisedPrompt === "string"
            ? { prompt: item.revisedPrompt }
            : {}),
        });
        sink.toolStarted(id);
        return;
      case "commandExecution":
        sink.toolCall(id, "bash", { command: commandText(item.command) });
        sink.toolStarted(id);
        return;
      case "fileChange": {
        const changes = Array.isArray(item.changes)
          ? (item.changes as Array<Record<string, unknown>>)
          : [];
        sink.toolCall(id, "edit", {
          ...(typeof changes[0]?.path === "string"
            ? { path: changes[0].path }
            : {}),
          ...(changes.length > 1
            ? { files: changes.map((change) => change.path) }
            : {}),
        });
        sink.toolStarted(id);
        return;
      }
      case "dynamicToolCall":
        // The validated item/tool/call request owns these events; notifications repeat it.
        return;
      case "mcpToolCall":
        sink.toolCall(
          id,
          `${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`,
          record(item.arguments) ?? {},
        );
        sink.toolStarted(id);
        return;
      case "webSearch":
        sink.toolCall(id, "web_search", { query: String(item.query ?? "") });
        sink.toolStarted(id);
        return;
      case "contextCompaction":
        sink.compaction("start");
        return;
      default:
        return;
    }
  }

  #itemCompleted(sink: NativeTurnSink, item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "imageGeneration":
        this.#turn!.imageError =
          "Codex native image generation is disabled. Use OhMyGame's Kunpo media tools.";
        sink.toolResult(id, textResult(this.#turn!.imageError), true);
        return;
      case "agentMessage":
        sink.textDone(
          id,
          typeof item.text === "string" ? item.text : undefined,
        );
        return;
      case "reasoning": {
        const summary = Array.isArray(item.summary)
          ? item.summary.filter((part) => typeof part === "string").join("\n\n")
          : "";
        sink.thinkingDone(id, summary || undefined);
        return;
      }
      case "commandExecution":
        sink.toolResult(
          id,
          textResult(
            typeof item.aggregatedOutput === "string"
              ? item.aggregatedOutput
              : "",
          ),
          item.status === "failed" ||
            (typeof item.exitCode === "number" && item.exitCode !== 0) ||
            item.status === "declined",
        );
        return;
      case "fileChange": {
        const changes = Array.isArray(item.changes)
          ? (item.changes as Array<Record<string, unknown>>)
          : [];
        sink.toolResult(
          id,
          textResult(
            changes
              .map(
                (change) =>
                  `${changeKind(change.kind)} ${String(change.path ?? "")}`,
              )
              .join("\n"),
          ),
          item.status === "failed" || item.status === "declined",
        );
        return;
      }
      case "dynamicToolCall":
        // Keep the host's single structured result, including its Kunpo artifact metadata.
        return;
      case "mcpToolCall": {
        const result = record(item.result);
        sink.toolResult(
          id,
          item.error
            ? textResult(String(record(item.error)?.message ?? item.error))
            : textResult(result?.content),
          Boolean(item.error) || item.status === "failed",
        );
        return;
      }
      case "webSearch":
        sink.toolResult(
          id,
          textResult(
            Array.isArray(item.results)
              ? JSON.stringify(item.results).slice(0, 4_000)
              : "",
          ),
          false,
        );
        return;
      case "contextCompaction":
        sink.compaction("end", {});
        return;
      default:
        return;
    }
  }

  #bridgeToolName(tool: unknown): string {
    const name = String(tool ?? "");
    // Existing native threads may still call the original unprefixed names.
    return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const turn = this.#turn;
    if (method === "item/tool/call") {
      if (!turn || turn.signal.aborted) throw new Error("No turn is running");
      if (
        params.threadId !== this.#threadId ||
        typeof params.turnId !== "string" ||
        (turn.turnId && turn.turnId !== params.turnId)
      )
        throw new Error("Tool call does not belong to the active Codex turn");
      const callId = typeof params.callId === "string" ? params.callId : "";
      if (
        !callId ||
        params.namespace !== CODEX_TOOL_NAMESPACE ||
        !String(params.tool).startsWith(TOOL_PREFIX)
      )
        throw new Error("Invalid OhMyGame tool call");
      const input = JSON.stringify([params.tool, params.arguments]);
      const previous = this.#toolCalls.get(callId);
      if (previous) {
        if (previous.input !== input)
          throw new Error(
            "A Codex tool call ID was reused with different arguments",
          );
        return previous.result;
      }
      const call = { input, result: undefined as unknown as Promise<unknown>, settled: false };
      const result = (async () => {
        const name = this.#bridgeToolName(params.tool);
        turn.sink.toolCall(callId, name, record(params.arguments) ?? {});
        turn.sink.toolStarted(callId);
        const outcome = await this.context.bridge.call(
          name,
          params.arguments,
          callId,
          turn.signal,
        );
        call.settled = true;
        if (this.#turn === turn && !turn.signal.aborted)
          turn.sink.toolResult(callId, outcome.result, outcome.isError);
        else turn.sink.toolSettled?.(callId, outcome.result, outcome.isError);
        return {
          contentItems: outcome.result.content.map((part) =>
            part.type === "text"
              ? { type: "inputText", text: part.text }
              : {
                  type: "inputImage",
                  imageUrl: `data:${part.mimeType};base64,${part.data}`,
                },
          ),
          success: !outcome.isError && !turn.signal.aborted,
        };
      })();
      call.result = result.finally(() => { call.settled = true; });
      this.#toolCalls.set(callId, call);
      return call.result;
    }
    if (!turn || turn.signal.aborted)
      return method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : method === "item/tool/requestUserInput"
          ? { answers: {} }
          : { decision: "decline" };
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "execCommandApproval"
    ) {
      return { decision: "decline" };
    }
    if (
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval"
    ) {
      return { decision: "decline" };
    }
    if (method === "item/permissions/requestApproval")
      return { permissions: {}, scope: "turn" };
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request")
      return { action: "decline" };
    throw new Error(`Unsupported request ${method}`);
  }
}

function codexInput(input: NativeTurnInput): Array<Record<string, unknown>> {
  return [
    { type: "text", text: input.text, text_elements: [] },
    ...input.images.map((image) => ({
      type: "image",
      url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}

/** The command as the person would type it, without the login shell Codex wraps it in. */
function commandText(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map(String).join(" ")
    : typeof value === "string"
      ? value
      : "";
  const wrapped = text.match(/^\S*\/(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/);
  return wrapped ? wrapped[2]! : text;
}

function changeKind(kind: unknown): string {
  const type = record(kind)?.type;
  return type === "add" ? "Added" : type === "delete" ? "Deleted" : "Updated";
}

function codexError(message: unknown): string {
  if (typeof message !== "string") return "";
  // Codex passes the model service's error body through as JSON text.
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    /* plain text */
  }
  return message;
}

function codexInterruption(error: Record<string, unknown> | undefined): AgentInterruption {
  const info = error?.codexErrorInfo;
  const allowedTransient = new Set(["internalServerError", "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]);
  const key = typeof info === "string" ? info : Object.keys(record(info) ?? {}).find(value => allowedTransient.has(value));
  if (key && allowedTransient.has(key))
    return { kind: "transient", source: "codex", code: `codex_${key}`, phase: "result", terminalReason: "transport_lost" };
  if (typeof info === "string" && ["contextWindowExceeded", "usageLimitExceeded", "badRequest", "unauthorized", "sandboxError"].includes(info))
    return { kind: "blocked", source: "codex", code: `codex_${info}`, phase: "result", terminalReason: "execution_error" };
  return { kind: "unknown", source: "codex", code: "codex_execution_error", phase: "result", terminalReason: "unknown" };
}
