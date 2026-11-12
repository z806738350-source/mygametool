import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "./process.js";
import {
  controlledQoderProcess,
  resolveControlledQoder,
} from "./controlled-qoder.js";
import { number, record, type DriverContext } from "./driver-context.js";
import {
  AgentRuntimeCompatibilityError,
  AgentRuntimeProbeError,
} from "./compatibility.js";
import type {
  NativeDriver,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
  NativeResultMetadata,
} from "./native-session.js";
import type { AgentInterruption } from "../agent-auto-continue.js";

const CONTROL_TIMEOUT = 30_000;
type Message = Record<string, unknown>;

const QODER_STARTUP_FAILURES: Record<string, string> = {
  QODER_INVENTORY:
    "Qoder's tool inventory does not match the controlled project tools. No prompt was sent. Check the runtime integration.",
  QODER_RUNTIME_INVENTORY:
    "Qoder changed the controlled tool inventory during the turn. The turn was stopped; existing tool results are retained.",
  QODER_POLICY:
    "Qoder did not apply the controlled session permissions. No prompt was sent. Check the runtime integration.",
  QODER_MCP:
    "Qoder could not verify the controlled project tool bridge. No prompt was sent. Check the runtime integration.",
  QODER_IMAGE_INPUT:
    "Qoder could not verify image input. Use a valid PNG, JPEG or WebP and an available vision-capable model. Original images are retained.",
  QODER_PROTOCOL:
    "The controlled Qoder helper rejected the local protocol. Check the runtime integration.",
  QODER_SDK_DAEMON_PROTOCOL:
    "The Qoder SDK rejected a daemon protocol frame. Check the runtime integration.",
  QODER_SDK_PROTOCOL_VERSION:
    "The Qoder SDK and CLI announced incompatible protocol versions.",
  QODER_SDK_CAPABILITY:
    "The Qoder CLI did not advertise a capability required by the SDK.",
  QODER_SDK_FRAME:
    "The Qoder SDK rejected an input or output frame that exceeded its size limit.",
};
const QODER_SDK_FAILURES: Record<string, string> = {
  QODER_SDK_PROCESS:
    "The Qoder CLI process stopped before the SDK operation completed.",
  QODER_SDK_TIMEOUT: "A Qoder SDK control request timed out.",
  QODER_SDK_INITIALIZE:
    "Qoder rejected session initialization before any user prompt was sent.",
  QODER_SDK_CONTROL: "Qoder rejected an SDK control request.",
};
const QODER_FAILURE_PHASES: Record<string, string> = {
  "daemon-start": "daemon startup",
  "query-start": "session construction",
  "session-initialize": "session initialization",
  "mcp-status": "controlled tool bridge verification",
  "response-stream": "response processing",
};
const QODER_INVENTORY_FIELDS: Record<string, string> = {
  "runtime-version": "runtime version",
  "working-directory": "working directory",
  "active-tools": "active tools",
  skills: "registered skills",
  plugins: "loaded plugins",
  "agent-directory": "agent directory",
  "mcp-servers": "MCP servers",
  "permission-mode": "permission mode",
};
// Only fixed messages authored by our helper may be projected; SDK text stays opaque.
const QODER_PROTOCOL_DETAILS = new Set([
  "Qoder returned an initialization snapshot for another session",
  "Qoder returned a message for another session",
  "Qoder ended while a controlled tool result was still pending",
  "Qoder ended without a turn result",
  "The steering checkpoint was not confirmed",
  "Qoder returned an invalid message",
  "Qoder host messages require an ID",
  "Unknown Qoder host method",
  "Qoder host is closed",
]);

/** Only our finite host codes become diagnostics; SDK messages can contain private data. */
export function qoderHelperError(value: unknown): Error {
  const failure = record(value);
  const code = failure?.code;
  const phase = failure?.phase;
  const boundary = failure?.boundary;
  const stage =
    typeof phase === "string" && Object.hasOwn(QODER_FAILURE_PHASES, phase)
      ? ` Stage: ${QODER_FAILURE_PHASES[phase]}.`
      : "";
  const mismatch =
    (code === "QODER_INVENTORY" || code === "QODER_RUNTIME_INVENTORY") &&
    typeof boundary === "string" &&
    Object.hasOwn(QODER_INVENTORY_FIELDS, boundary)
      ? ` Mismatched boundary: ${QODER_INVENTORY_FIELDS[boundary]}.`
      : "";
  if (
    code === "QODER_PROTOCOL" &&
    typeof failure?.message === "string" &&
    QODER_PROTOCOL_DETAILS.has(failure.message)
  )
    return new AgentRuntimeCompatibilityError(
      `${failure.message}.${stage}`,
      code,
    );
  if (typeof code === "string" && Object.hasOwn(QODER_STARTUP_FAILURES, code))
    return new AgentRuntimeCompatibilityError(
      `${QODER_STARTUP_FAILURES[code]!}${mismatch}${stage}`,
      code,
    );
  return new AgentRuntimeProbeError(
    `${typeof code === "string" && Object.hasOwn(QODER_SDK_FAILURES, code) ? QODER_SDK_FAILURES[code]! : "The Qoder SDK session failed."}${stage} Check the local runtime diagnostics; existing tool results are retained.`,
  );
}

/** A private stdio connection to the SDK helper; it never serves an HTTP endpoint. */
export class QoderConnection {
  #process?: AgentProcess;
  #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  #closed = false;

  constructor(
    private context: Pick<
      DriverContext,
      "binaryPath" | "env" | "privateDirectory" | "processDirectory"
    >,
    private receive: (message: Message) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#closed) throw new Error("The Qoder connection is closed");
    const binary = await resolveControlledQoder(this.context.binaryPath);
    if (!binary)
      throw new Error(
        "Install the reviewed Qoder SDK and runtime before connecting",
      );
    const temporary = path.join(this.context.privateDirectory, "tmp");
    await mkdir(temporary, { mode: 0o700, recursive: true });
    if (this.#closed) throw new Error("The Qoder connection is closed");
    const env: Record<string, string> = {
      ...this.context.env,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      ELECTRON_RUN_AS_NODE: "1",
    };
    this.#process = new AgentProcess(
      controlledQoderProcess({
        binaryPath: process.execPath,
        args: [
          fileURLToPath(new URL("./qoder-sdk-host.js", import.meta.url)),
          binary.sdkEntry,
        ],
        cwd: this.context.privateDirectory,
        env,
        processDirectory: this.context.processDirectory,
        onLine: (line) => this.#line(line),
        onExit: () => this.#fail(new Error("The Qoder helper stopped")),
      }),
    );
    try {
      await this.request("initialize", {
        binaryPath: binary.path,
        privateDirectory: this.context.privateDirectory,
        configurationRoot: path.dirname(env.QODER_CONFIG_DIR!),
        env,
      });
    } catch (cause) {
      await this.stop();
      throw cause;
    }
  }

  request(method: string, params: Message = {}): Promise<unknown> {
    if (this.#closed || !this.#process?.running)
      return Promise.reject(new Error("The Qoder helper is unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("The Qoder helper did not answer in time"));
      }, CONTROL_TIMEOUT);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#process!.write({ id, method, params });
      } catch {
        this.#pending
          .get(id)
          ?.reject(new Error("The Qoder helper is unavailable"));
        this.#pending.delete(id);
      }
    });
  }

  respond(id: unknown, result: unknown): void {
    if (!this.#closed && this.#process?.running)
      this.#process.write({ id, result });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    const child = this.#process;
    this.#process = undefined;
    this.#fail(new Error("The Qoder connection was closed"));
    await child?.stop();
  }

  #line(line: string): void {
    try {
      if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error();
      const message = record(JSON.parse(line));
      if (!message) throw new Error();
      if (message.method) {
        this.receive(message);
        return;
      }
      const id = String(message.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (message.error) pending.reject(qoderHelperError(message.error));
      else pending.resolve(message.result);
    } catch {
      this.#fail(new Error("The Qoder helper returned an invalid message"));
      void this.stop();
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.receive({ method: "host/closed" });
  }
}

export interface QoderHostConnection {
  start(): Promise<void>;
  request(method: string, params?: Message): Promise<unknown>;
  respond(id: unknown, result: unknown): void;
  stop(): Promise<void>;
}

interface StreamBlock {
  key: string;
  type: string;
  closed: boolean;
  finalized: boolean;
}

interface StreamMessage {
  id?: string;
  key: string;
  blocks: Map<number, StreamBlock>;
}

interface Turn {
  id: string;
  sink: NativeTurnSink;
  controller: AbortController;
  resolve(outcome: NativeTurnOutcome): void;
  textSequence: number;
  stream?: StreamMessage;
  streams: StreamMessage[];
  frameKeys: Map<string, string[]>;
  text: Map<string, string>;
  calls: Map<string, { input: string; result: Promise<unknown> }>;
  steering: Map<string, { commandId: string; signature: string; admission?: Promise<void> }>;
  assistantError?: string;
}

/** The SDK owns inference; project operations always execute in the existing daemon bridge. */
export class QoderDriver implements NativeDriver {
  #connection?: QoderHostConnection;
  #starting?: Promise<void>;
  #stopping?: QoderHostConnection;
  #turn?: Turn;
  #session?: string;
  #disposed = false;

  constructor(
    private context: DriverContext,
    private connect: (
      receive: (message: Message) => void,
    ) => QoderHostConnection = (receive) =>
      new QoderConnection(context, receive),
  ) {
    this.#session = context.resume;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    if (this.#disposed) throw new Error("The Qoder session was closed");
    if (this.#turn) throw new Error("A Qoder turn is already running");
    if (signal.aborted) return { status: "aborted" };
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: Turn = {
        id: randomUUID(),
        sink,
        controller: new AbortController(),
        resolve,
        textSequence: 0,
        streams: [],
        frameKeys: new Map(),
        text: new Map(),
        calls: new Map(),
        steering: new Map(),
      };
      this.#turn = turn;
      const abort = () => {
        void this.interrupt().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      turn.resolve = (outcome) => {
        signal.removeEventListener("abort", abort);
        resolve(outcome);
      };
      void (async () => {
        try {
          if (!this.#connection) {
            let connection!: QoderHostConnection;
            connection = this.connect((message) => {
              if (this.#connection === connection) void this.#receive(message);
            });
            this.#connection = connection;
            this.#starting = connection.start();
          }
          await this.#starting;
          if (this.#turn !== turn || signal.aborted) return;
          await this.#connection!.request("turn/start", {
            turnId: turn.id,
            text: input.text,
            images: input.images,
            requiresImageInput: input.requiresImageInput === true,
            model: this.context.model,
            instructions: this.context.instructions,
            tools: this.context.bridge.list(),
            ...(this.#session ? { resume: this.#session } : {}),
            ...(this.context.reasoningLevel
              ? { reasoningLevel: this.context.reasoningLevel }
              : {}),
            ...(this.context.contextWindow
              ? { contextWindow: this.context.contextWindow }
              : {}),
          });
        } catch (cause) {
          if (this.#turn === turn) {
            const failed = this.#connection;
            this.#connection = undefined;
            this.#starting = undefined;
            this.#finish({
              status: signal.aborted ? "aborted" : "failed",
              error:
                cause instanceof AgentRuntimeCompatibilityError ||
                cause instanceof AgentRuntimeProbeError
                  ? cause.message
                  : "The controlled Qoder session could not start or continue. Check the local runtime diagnostics; existing tool results are retained.",
            } as NativeTurnOutcome);
            await failed?.stop();
          }
        }
      })();
      if (signal.aborted) abort();
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.controller.abort();
    const connection = this.#connection;
    this.#stopping = connection;
    this.#connection = undefined;
    this.#starting = undefined;
    this.#finish({ status: "aborted" });
    try {
      await connection?.request("turn/interrupt", { turnId: turn.id });
    } finally {
      await connection?.stop();
      if (this.#stopping === connection) this.#stopping = undefined;
    }
  }

  async steer(id: string, input: NativeTurnInput): Promise<boolean> {
    const turn = this.#turn;
    if (!turn || turn.controller.signal.aborted) return false;
    const signature = JSON.stringify(input);
    const existing = turn.steering.get(id);
    if (existing) {
      if (existing.signature !== signature) throw new Error("A steering message cannot change after submission");
      return true;
    }
    const command = { commandId: randomUUID(), signature };
    turn.steering.set(id, command);
    await this.#starting;
    if (this.#turn !== turn || !this.#connection) return false;
    const receipt = record(await this.#connection.request("turn/steer", {
      turnId: turn.id, commandId: command.commandId, text: input.text,
      images: input.images, requiresImageInput: input.requiresImageInput === true,
    }));
    if (receipt?.queued !== true) {
      turn.steering.delete(id);
      return false;
    }
    return true;
  }

  async cancelSteering(ids: readonly string[]): Promise<string[]> {
    const turn = this.#turn, connection = this.#connection;
    if (!turn || !connection) return [];
    const candidates = ids.flatMap(id => {
      const command = turn.steering.get(id);
      return command && !command.admission ? [{ id, command }] : [];
    });
    if (!candidates.length) return [];
    const receipt = record(await connection.request("turn/cancel-steering", {
      turnId: turn.id, commandIds: candidates.map(({ command }) => command.commandId),
    }));
    const cancelled: string[] = [];
    for (const { id, command } of candidates) {
      if (Array.isArray(receipt?.cancelled) && receipt.cancelled.includes(command.commandId) && !command.admission) {
        turn.steering.delete(id);
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#turn?.controller.abort();
    this.#finish({ status: "aborted" });
    const connection = this.#connection;
    const stopping = this.#stopping;
    this.#connection = undefined;
    this.#stopping = undefined;
    await Promise.allSettled([connection?.stop(), stopping?.stop()]);
  }

  async #receive(message: Message): Promise<void> {
    if (message.method === "host/closed") {
      this.#finish({
        status: "failed",
        error: "The Qoder helper stopped before completing the turn",
        interruption: { kind: "transient", source: "qoder", code: "qoder_process_exited", phase: "stream", terminalReason: "process_exited" },
      });
      return;
    }
    const params = record(message.params);
    const turn = this.#turn;
    if (!turn || turn.controller.signal.aborted || params?.turnId !== turn.id) {
      if (message.method === "steering/started") this.#connection?.respond(message.id, { accepted: false });
      if (message.method === "tool/call")
        this.#connection?.respond(message.id, {
          isError: true,
          content: [
            { type: "text", text: "The Qoder turn is no longer active" },
          ],
        });
      return;
    }
    if (message.method === "steering/started") {
      const entry = [...turn.steering].find(([, command]) => command.commandId === params.commandId);
      if (!entry || params.sessionId !== this.#session || !turn.sink.steeringStarted) {
        this.#connection?.respond(message.id, { accepted: false });
        return;
      }
      const [id, command] = entry;
      command.admission ??= (async () => {
        await Promise.all([...turn.calls.values()].map(call => call.result));
        if (this.#turn !== turn || turn.controller.signal.aborted) throw new Error("The Qoder turn was cancelled");
        await turn.sink.steeringStarted!(id, turn.controller.signal);
      })();
      try {
        await command.admission;
        this.#connection?.respond(message.id, { accepted: this.#turn === turn && !turn.controller.signal.aborted });
      } catch {
        this.#connection?.respond(message.id, { accepted: false });
      }
      return;
    }
    if (message.method === "tool/call") {
      const failure = {
        isError: true,
        content: [{ type: "text", text: "Invalid controlled Qoder tool call" }],
      };
      const name = params.name,
        callId = params.callId;
      if (
        typeof name !== "string" ||
        typeof callId !== "string" ||
        !callId ||
        params.sessionId !== this.#session
      ) {
        this.#connection?.respond(message.id, failure);
        return;
      }
      const args = record(params.arguments);
      if (!args) {
        this.#connection?.respond(message.id, failure);
        return;
      }
      const signature = JSON.stringify([name, args]);
      let call = turn.calls.get(callId);
      if (call && call.input !== signature) {
        this.#connection?.respond(message.id, failure);
        return;
      }
      if (!call) {
        const result = (async () => {
          turn.sink.toolCall(callId, name, args);
          turn.sink.toolStarted(callId);
          const outcome = await this.context.bridge.call(
            name,
            args,
            callId,
            turn.controller.signal,
          );
          if (this.#turn === turn && !turn.controller.signal.aborted)
            turn.sink.toolResult(callId, outcome.result, outcome.isError);
          else turn.sink.toolSettled?.(callId, outcome.result, outcome.isError);
          return {
            content: outcome.result.content,
            isError: outcome.isError || turn.controller.signal.aborted,
          };
        })();
        call = { input: signature, result };
        turn.calls.set(callId, call);
      }
      const result = await call.result;
      if (this.#turn === turn && !turn.controller.signal.aborted)
        this.#connection?.respond(message.id, result);
      return;
    }
    if (message.method === "sdk/error") {
      this.#finish({
        status: "failed",
        error: qoderHelperError(params).message,
        interruption: qoderHostInterruption(params),
      });
      return;
    }
    if (message.method !== "sdk/message") return;
    const value = record(params.message);
    if (!value || value.parent_tool_use_id != null) return;
    if (
      value.type === "system" &&
      value.subtype === "init" &&
      typeof value.session_id === "string" &&
      value.session_id
    ) {
      this.#session = value.session_id;
      turn.sink.nativeSession(value.session_id);
    } else if (value.type === "stream_event") {
      const event = record(value.event);
      const delta = record(event?.delta);
      if (event?.type === "message_start") {
        const id = record(event.message)?.id;
        this.#beginStream(turn, typeof id === "string" && id ? id : undefined);
      }
      const index =
        typeof event?.index === "number" &&
        Number.isInteger(event.index) &&
        event.index >= 0
          ? event.index
          : 0;
      if (event?.type === "content_block_start") {
        const content = record(event.content_block);
        const block = this.#streamBlock(
          turn,
          index,
          typeof content?.type === "string" ? content.type : "unknown",
        );
        if (
          block.type === "text" &&
          typeof content?.text === "string" &&
          content.text &&
          !turn.text.has(block.key)
        ) {
          turn.text.set(block.key, content.text);
          turn.sink.text(block.key, content.text);
        }
      }
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        const block = this.#streamBlock(turn, index, "text");
        turn.text.set(block.key, (turn.text.get(block.key) ?? "") + delta.text);
        turn.sink.text(block.key, delta.text);
      }
      if (event?.type === "content_block_stop") {
        const block = turn.stream?.blocks.get(index);
        if (block) this.#closeStreamBlock(turn, block);
      }
      if (event?.type === "message_stop") {
        for (const block of turn.stream?.blocks.values() ?? [])
          this.#closeStreamBlock(turn, block);
        turn.stream = undefined;
      }
    } else if (value.type === "assistant") {
      if (["authentication_failed", "billing_error", "rate_limit", "invalid_request", "server_error", "unknown", "max_output_tokens"].includes(String(value.error)))
        turn.assistantError = String(value.error);
      else if (value.error === undefined) turn.assistantError = undefined;
      const assistant = record(value.message);
      const messageId =
        typeof assistant?.id === "string" && assistant.id
          ? assistant.id
          : undefined;
      const stream = messageId
        ? turn.streams.findLast((message) => message.id === messageId)
        : undefined;
      const frameId =
        typeof value.uuid === "string" && value.uuid
          ? JSON.stringify([messageId, value.uuid])
          : undefined;
      const frameKeys = frameId ? (turn.frameKeys.get(frameId) ?? []) : [];
      const fallback = frameId ?? String(++turn.textSequence);
      const parts = assistant?.content;
      if (Array.isArray(parts))
        parts.forEach((part, index) => {
          const block = record(part);
          if (block?.type === "text" && typeof block.text === "string") {
            let key = frameKeys[index];
            if (!key) {
              // Native block snapshots contain one content[0] even when the
              // original stream block was at another index (e.g. after thinking).
              let matching: StreamBlock | undefined;
              if (parts.length > 1) {
                const indexed = stream?.blocks.get(index);
                if (indexed?.type === "text") matching = indexed;
              } else {
                const pending = [...(stream?.blocks.values() ?? [])].filter(
                  (block) => block.type === "text" && !block.finalized,
                );
                const open = pending.filter((block) => !block.closed);
                matching =
                  open.length === 1
                    ? open[0]
                    : pending.length === 1
                      ? pending[0]
                      : undefined;
              }
              if (matching) matching.finalized = true;
              key = matching?.key ?? `qoder-frame:${fallback}:${index}`;
              frameKeys[index] = key;
            }
            turn.text.set(key, block.text);
            turn.sink.textDone(key, block.text);
          }
        });
      if (frameId) turn.frameKeys.set(frameId, frameKeys);
      const usage = record(assistant?.usage);
      if (usage)
        turn.sink.usage(
          {
            input: number(usage.input_tokens),
            output: number(usage.output_tokens),
            cacheRead: number(usage.cache_read_input_tokens),
            cacheWrite: number(usage.cache_creation_input_tokens),
          },
          this.context.contextWindow,
        );
    } else if (value.type === "result") {
      const interruption = qoderResultInterruption(value, turn.assistantError);
      const modelTurns = typeof value.num_turns === "number" && Number.isSafeInteger(value.num_turns) && value.num_turns >= 0 && value.num_turns <= 1_000_000 ? value.num_turns : undefined;
      const resultSubtype = value.subtype === "success" || value.subtype === "error_during_execution" || value.subtype === "error_max_turns" || value.subtype === "error_max_budget_usd" ? value.subtype : undefined;
      const terminalReason = value.terminal_reason == null || value.terminal_reason === "" ? undefined : value.terminal_reason === "max_turns" || value.terminal_reason === "abort" || value.terminal_reason === "aborted_streaming" || value.terminal_reason === "aborted_tools" || value.terminal_reason === "hook_stopped" || value.terminal_reason === "repeated_tool_call_denied" || value.terminal_reason === "completed" ? value.terminal_reason : "unknown";
      const stopReason = value.stop_reason == null || value.stop_reason === "" ? undefined : value.stop_reason === "end_turn" || value.stop_reason === "stop_sequence" || value.stop_reason === "tool_use" || value.stop_reason === "max_tokens" || value.stop_reason === "pause_turn" || value.stop_reason === "refusal" ? value.stop_reason : "unknown";
      const terminalMetadata: NativeResultMetadata = { ...(modelTurns !== undefined ? { modelTurns } : {}), ...(resultSubtype ? { resultSubtype } : {}), ...(terminalReason ? { terminalReason } : {}), ...(stopReason ? { stopReason } : {}), ...(interruption?.cancelOrigin ? { cancelOrigin: interruption.cancelOrigin } : {}) };
      if (interruption)
        this.#finish({
          status: "failed",
          error:
            "Qoder did not complete the turn. Inspect the retained tool results before retrying.",
          interruption,
          ...terminalMetadata,
        });
      else this.#finish({ status: "completed", ...terminalMetadata });
    }
  }

  #beginStream(turn: Turn, id?: string): StreamMessage {
    const stream = {
      ...(id ? { id } : {}),
      key: `qoder-stream:${++turn.textSequence}`,
      blocks: new Map<number, StreamBlock>(),
    };
    turn.streams.push(stream);
    turn.stream = stream;
    return stream;
  }

  #streamBlock(turn: Turn, index: number, type: string): StreamBlock {
    const stream = turn.stream ?? this.#beginStream(turn);
    let block = stream.blocks.get(index);
    if (!block) {
      block = {
        key: `${stream.key}:${index}`,
        type,
        closed: false,
        finalized: false,
      };
      stream.blocks.set(index, block);
    } else if (block.type === "unknown") block.type = type;
    return block;
  }

  #closeStreamBlock(turn: Turn, block: StreamBlock): void {
    block.closed = true;
    const text = turn.text.get(block.key);
    if (block.type === "text" && text !== undefined)
      turn.sink.textDone(block.key, text);
  }

  #finish(outcome: NativeTurnOutcome): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    if (outcome.status !== "completed") this.#session = undefined;
    turn.controller.abort();
    for (const [key, value] of turn.text) turn.sink.textDone(key, value);
    turn.resolve(outcome);
  }
}

function qoderResultInterruption(value: Message, assistantError?: string): AgentInterruption | undefined {
  const base = { source: "qoder" as const, phase: "result" as const };
  if (value.subtype === "error_max_budget_usd")
    return { ...base, kind: "blocked", code: "qoder_budget_limit", terminalReason: "execution_error" };
  const terminal = value.terminal_reason;
  if (terminal === "hook_stopped")
    return { ...base, kind: "blocked", code: "qoder_hook_stopped", terminalReason: "hook_stopped", cancelOrigin: "host" };
  if (terminal === "repeated_tool_call_denied")
    return { ...base, kind: "blocked", code: "qoder_repeated_tool_denied", terminalReason: "execution_error", cancelOrigin: "host" };
  if (terminal != null && terminal !== "" && !["max_turns", "abort", "aborted_streaming", "aborted_tools", "completed"].includes(String(terminal)))
    return { ...base, kind: "unknown", code: "qoder_unknown_terminal", terminalReason: "unknown" };
  if (["authentication_failed", "billing_error", "rate_limit", "invalid_request"].includes(assistantError ?? "") && (value.is_error === true || value.subtype !== "success"))
    return { ...base, kind: "blocked", code: `qoder_${assistantError}`, terminalReason: "execution_error" };
  if (value.subtype === "error_max_turns")
    return { ...base, kind: "turn_limit", code: "qoder_max_turns", terminalReason: "max_turns" };
  if (terminal === "abort" || terminal === "aborted_streaming" || terminal === "aborted_tools")
    return { ...base, kind: "runtime_interrupted", code: "qoder_runtime_interrupted", terminalReason: terminal, cancelOrigin: "runtime" };
  if (value.subtype === "success" && value.is_error !== true) {
    if (value.stop_reason === "max_tokens" || assistantError === "max_output_tokens")
      return { ...base, kind: "runtime_interrupted", code: "qoder_output_limit", terminalReason: "runtime_interrupted" };
    if (value.stop_reason != null && value.stop_reason !== "" && !["end_turn", "stop_sequence", "tool_use", "pause_turn", "refusal"].includes(String(value.stop_reason)) || terminal === "max_turns")
      return { ...base, kind: "unknown", code: "qoder_unknown_terminal", terminalReason: "unknown" };
    return undefined;
  }
  if (assistantError === "server_error")
    return { ...base, kind: "transient", code: "qoder_server_error", terminalReason: "execution_error" };
  return { ...base, kind: "unknown", code: "qoder_execution_error", terminalReason: "unknown" };
}

function qoderHostInterruption(value: Message): AgentInterruption {
  if (value.code === "QODER_PROTOCOL" && value.message === "Qoder ended while a controlled tool result was still pending")
    return { kind: "runtime_interrupted", source: "qoder", code: "qoder_pending_tool_result", phase: "tools", terminalReason: "runtime_interrupted", cancelOrigin: "runtime" };
  if (value.code === "QODER_SDK_PROCESS")
    return { kind: "transient", source: "qoder", code: "qoder_process_exited", phase: "stream", terminalReason: "process_exited" };
  if (value.code === "QODER_SDK_TIMEOUT")
    return { kind: "transient", source: "qoder", code: "qoder_control_timeout", phase: "stream", terminalReason: "control_timeout" };
  if (value.code === "QODER_PROTOCOL" && value.message === "Qoder ended without a turn result")
    return { kind: "transient", source: "qoder", code: "qoder_stream_eof", phase: "stream", terminalReason: "transport_lost" };
  return { kind: "blocked", source: "qoder", code: "qoder_controlled_boundary", phase: "stream", terminalReason: "execution_error" };
}
