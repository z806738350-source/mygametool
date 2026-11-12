import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK_VERSION = "1.0.59";
const RUNTIME_VERSION = "1.1.83";
const SERVER = "ohmygame";
// CLI 1.1.83 injects these meta tools outside its built-in --tools filter.
const DISALLOWED_MCP_META_TOOLS = ["mcp_list", "mcp_get", "mcp_call"];
// Native init reports registered built-ins even when the Agent tool is unavailable.
const BUILTIN_AGENT_METADATA = new Set(["general-purpose", "Explore", "Plan"]);
// A 32 MiB screenshot needs room for base64 and its JSON envelope.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const INITIALIZE_TIMEOUT_MS = 30_000;
const IMAGE_INPUT_MESSAGE = "Qoder could not verify image input. Use a valid PNG, JPEG or WebP and an available vision-capable model. Original images are retained.";
const ENVIRONMENT_KEYS = new Set([
  "HOME",
  "QODER_CONFIG_DIR",
  "PATH",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "ELECTRON_RUN_AS_NODE",
  "OTEL_SDK_DISABLED",
  "QODER_DISABLE_MALFORMED_TOOL_USE_RETRY",
  "QODER_MAX_REASONING_ONLY_RETRIES",
]);

type ObjectValue = Record<string, unknown>;
type HostMessage = ObjectValue & { id?: string | number };

interface HostDaemon {
  stop(): Promise<void>;
  getModels(options: { fetchStrategy: "cache" | "live" }): Promise<unknown>;
  accountInfo(): Promise<unknown>;
}

interface HostQuery extends AsyncIterable<unknown> {
  initializationResult(): Promise<unknown>;
  mcpServerStatus(): Promise<unknown>;
  interrupt(): Promise<unknown>;
  cancelAsyncMessage(uuid: string): Promise<boolean>;
  close(): Promise<void>;
}

interface HostMcpServer {
  instance: {
    server: {
      registerCapabilities(capabilities: ObjectValue): void;
      setRequestHandler(
        schema: unknown,
        handler: (request: unknown, extra: { signal?: AbortSignal }) => unknown,
      ): void;
    };
  };
  [key: string]: unknown;
}

/** The narrow SDK surface the helper uses; tests supply an in-memory runtime. */
export interface QoderSdkHostDependencies {
  sdkVersion: string;
  runtimeVersion: string;
  sdk: {
    qodercliAuth(): unknown;
    startDaemon(options: ObjectValue): Promise<HostDaemon>;
    query(params: {
      prompt: AsyncIterable<unknown>;
      options: ObjectValue;
    }): HostQuery;
    createSdkMcpServer(options: { name: string; tools: [] }): HostMcpServer;
  };
  schemas: { listTools: unknown; callTool: unknown };
}

interface HostTool {
  name: string;
  description: string;
  inputSchema: ObjectValue;
}

interface HostTurn {
  id: string;
  query?: HostQuery;
  sessionId?: string;
  controller: AbortController;
  tools: HostTool[];
  hookCalls: Map<string, Map<string, number>>;
  forwardedCalls: Map<string, { input: string; result: Promise<unknown> }>;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  releaseInput?(): void;
  pump?: Promise<void>;
  complete: boolean;
  inputSent: boolean;
  requiresImageInput: boolean;
  failure?: HostError;
  inputQueue: ObjectValue[];
  wakeInput?(): void;
  steering: Map<string, { state: "queued" | "sent" | "started" | "admitted" | "cancelled"; requiresImageInput: boolean }>;
  admission?: Promise<void>;
  deferredResult?: ObjectValue;
}

type InventoryField =
  | "runtime-version"
  | "working-directory"
  | "active-tools"
  | "skills"
  | "plugins"
  | "agent-directory"
  | "mcp-servers"
  | "permission-mode";

class HostError extends Error {
  constructor(
    message: string,
    readonly code: string = "QODER_PROTOCOL",
    readonly phase?:
      | "daemon-start"
      | "query-start"
      | "session-initialize"
      | "mcp-status"
      | "response-stream",
    readonly boundary?: InventoryField,
  ) {
    super(message);
  }
}

/** Runs only inside the separately managed helper, never in the application daemon. */
export class QoderSdkHost {
  #daemon?: HostDaemon;
  #configuration?: {
    binaryPath: string;
    privateDirectory: string;
    env: ObjectValue;
  };
  #initializing = false;
  #closed = false;
  #closing?: Promise<void>;
  #turn?: HostTurn;
  #imageSessions = new Set<string>();
  #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor(
    private dependencies: QoderSdkHostDependencies,
    private send: (message: HostMessage) => void,
  ) {}

  async handle(value: unknown): Promise<void> {
    const message = object(value);
    const id = message?.id;
    if (!message || (typeof id !== "string" && typeof id !== "number"))
      throw new HostError("Qoder host messages require an ID");
    if (typeof message.method !== "string") {
      const pending = this.#pending.get(String(id));
      if (!pending) return;
      this.#pending.delete(String(id));
      if (message.error !== undefined)
        pending.reject(new HostError("The controlled tool request failed"));
      else pending.resolve(message.result);
      return;
    }
    try {
      if (this.#closed && message.method !== "session/close")
        throw new HostError("Qoder host is closed");
      const params = object(message.params) ?? {};
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = await this.#initialize(params);
          break;
        case "turn/start":
          result = await this.#startTurn(params);
          break;
        case "turn/interrupt":
          result = await this.#interrupt(params);
          break;
        case "turn/steer":
          result = await this.#steer(params);
          break;
        case "turn/cancel-steering":
          result = await this.#cancelSteering(params);
          break;
        case "models/list":
          result = await this.#requireDaemon().getModels({
            fetchStrategy: params.live === true ? "live" : "cache",
          });
          break;
        case "account/read":
          result = await this.#requireDaemon().accountInfo();
          break;
        case "session/close":
          await this.close();
          result = {};
          break;
        default:
          throw new HostError("Unknown Qoder host method");
      }
      this.send({ id, result });
    } catch (cause) {
      this.send({
        id,
        error: {
          code: errorCode(cause),
          message: errorMessage(cause),
          ...(cause instanceof HostError && cause.phase
            ? { phase: cause.phase }
            : {}),
          ...(cause instanceof HostError && cause.boundary
            ? { boundary: cause.boundary }
            : {}),
        },
      });
    }
  }

  async #initialize(params: ObjectValue): Promise<unknown> {
    if (this.#daemon || this.#initializing)
      throw new HostError("Qoder host was already initialized");
    const { sdkVersion, runtimeVersion, sdk } = this.dependencies;
    if (sdkVersion !== SDK_VERSION || runtimeVersion !== RUNTIME_VERSION)
      throw new HostError(
        "The controlled Qoder SDK/runtime version is unavailable",
      );
    const binaryPath = absolutePath(params.binaryPath);
    const privateDirectory = absolutePath(params.privateDirectory);
    const configurationRoot = absolutePath(params.configurationRoot);
    const env = object(params.env);
    if (
      !env ||
      Object.keys(env).some((key) => !ENVIRONMENT_KEYS.has(key)) ||
      Object.values(env).some((value) => typeof value !== "string") ||
      !inside(configurationRoot, absolutePath(env.HOME)) ||
      !inside(configurationRoot, absolutePath(env.QODER_CONFIG_DIR)) ||
      configurationRoot === privateDirectory ||
      inside(configurationRoot, privateDirectory) ||
      inside(privateDirectory, configurationRoot) ||
      env.OTEL_SDK_DISABLED !== "true" ||
      env.QODER_DISABLE_MALFORMED_TOOL_USE_RETRY !== "1" ||
      env.QODER_MAX_REASONING_ONLY_RETRIES !== "0" ||
      (env.ELECTRON_RUN_AS_NODE !== undefined &&
        env.ELECTRON_RUN_AS_NODE !== "1")
    )
      throw new HostError(
        "Qoder requires private HOME and configuration directories",
      );
    this.#initializing = true;
    try {
      const daemon = await sdk.startDaemon({
        auth: sdk.qodercliAuth(),
        launchMode: "process",
        pathToQoderCLIExecutable: binaryPath,
        env,
        initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
        debug: false,
        stderr: () => {},
      });
      if (this.#closed) {
        await daemon.stop();
        throw new HostError("Qoder host is closed");
      }
      this.#daemon = daemon;
      this.#configuration = { binaryPath, privateDirectory, env };
      return { sdkVersion, runtimeVersion };
    } catch (cause) {
      throw sdkFailure(cause, "daemon-start");
    } finally {
      this.#initializing = false;
    }
  }

  async #startTurn(params: ObjectValue): Promise<unknown> {
    const daemon = this.#requireDaemon();
    const previous = this.#turn;
    if (previous && !previous.complete)
      throw new HostError("A Qoder turn is already running");
    const id = nonempty(params.turnId);
    const model = nonempty(params.model);
    const text = typeof params.text === "string" ? params.text : "";
    const tools = parseTools(params.tools);
    const images = parseImages(params.images);
    const expected = tools.map((tool) => `mcp__${SERVER}__${tool.name}`);
    let resolveReady!: () => void;
    let rejectReady!: (cause: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // The stream can fail before the caller starts waiting for initialization.
    void ready.catch(() => {});
    const turn: HostTurn = {
      id,
      controller: new AbortController(),
      tools,
      hookCalls: new Map(),
      forwardedCalls: new Map(),
      ready,
      resolveReady,
      rejectReady,
      complete: false,
      inputSent: false,
      inputQueue: [],
      steering: new Map(),
      requiresImageInput:
        images.length > 0 ||
        params.requiresImageInput === true ||
        (typeof params.resume === "string" && this.#imageSessions.has(params.resume)),
    };
    this.#turn = turn;
    const config = this.#configuration!;
    const userMessage = {
      type: "user",
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }, ...images],
      },
    };
    let releaseInput!: () => void;
    const inputReady = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    turn.releaseInput = releaseInput;
    const input = async function* () {
      await inputReady;
      if (!turn.controller.signal.aborted) yield userMessage;
      while (!turn.controller.signal.aborted) {
        const message = turn.inputQueue.shift();
        if (message) {
          const command = turn.steering.get(String(message.uuid));
          if (!command || command.state === "cancelled") continue;
          command.state = "sent";
          yield message;
        } else {
          await new Promise<void>((resolve) => { turn.wakeInput = resolve; });
          turn.wakeInput = undefined;
        }
      }
    };
    turn.controller.signal.addEventListener("abort", () => turn.wakeInput?.(), { once: true });
    let phase: NonNullable<HostError["phase"]> = "query-start";
    try {
      await previous?.query?.close();
      this.#assertActive(turn);
      const server = this.#mcpServer(turn);
      const query = this.dependencies.sdk.query({
        prompt: input(),
        options: {
          daemon,
          cwd: config.privateDirectory,
          model,
          ...(typeof params.resume === "string" && params.resume
            ? { resume: params.resume }
            : {}),
          // Stable project checkpoints can take longer than the SDK's 500 ms policy default.
          resolveModelTimeoutMs: 30_000,
          // Native otherwise replaces images with text when its selected model
          // loses vision. Recheck its live catalog before every model request,
          // including requests after controlled tools return new images.
          resolveModel: async (value: unknown) => {
            this.#assertActive(turn);
            const policy = object(value);
            if (policy?.purpose === "main" && !policy.agentId)
              await this.#admitSteering(turn);
            if (turn.requiresImageInput) {
              const context = object(value);
              const models = Array.isArray(context?.availableModels)
                ? context.availableModels.map(object).filter((entry) => entry?.value === model)
                : [];
              const selected = models[0];
              if (
                context?.sessionId !== turn.sessionId ||
                models.length !== 1 ||
                selected?.isVl !== true ||
                selected.isEnabled === false ||
                (selected.source !== undefined && selected.source !== "system")
              ) {
                const error = new HostError(
                  IMAGE_INPUT_MESSAGE,
                  "QODER_IMAGE_INPUT",
                );
                this.#failTurn(turn, error);
                throw error;
              }
            }
            return {
              model,
              parameters: {
                ...(typeof params.reasoningLevel === "string"
                  ? { reasoningEffort: params.reasoningLevel }
                  : {}),
                ...(typeof params.contextWindow === "number"
                  ? { contextWindow: params.contextWindow }
                  : {}),
              },
            };
          },
          systemPrompt:
            typeof params.instructions === "string"
              ? params.instructions
              : "Use only OhMyGame's controlled project tools.",
          tools: expected,
          allowedTools: [],
          disallowedTools: [...DISALLOWED_MCP_META_TOOLS],
          permissionMode: "default",
          allowDangerouslySkipPermissions: false,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: { [SERVER]: server },
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
          enableFileCheckpointing: false,
          includePartialMessages: true,
          settings: {
            general: { enableAutoUpdate: false },
            // The session allowlist alone does not stop native built-in discovery.
            skills: { enabled: false },
            security: { disableYoloMode: true },
            permissions: { disableBypassPermissionsMode: "disable" },
            mcp: { lazyLoad: false },
          },
          canUseTool: async (
            name: unknown,
            args: unknown,
            context: unknown,
          ) => {
            const details = object(context);
            const callId = details?.toolUseID;
            return turn.inputSent &&
              expected.includes(String(name)) &&
              !turn.controller.signal.aborted &&
              typeof callId === "string" &&
              callId
              ? { behavior: "allow", updatedInput: args, toolUseID: callId }
              : {
                  behavior: "deny",
                  message:
                    "Only active controlled OhMyGame tools are available",
                };
          },
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (value: unknown, toolUseID: unknown) => {
                    const hook = object(value);
                    const name =
                      typeof hook?.tool_name === "string" ? hook.tool_name : "";
                    const callId =
                      typeof hook?.tool_use_id === "string"
                        ? hook.tool_use_id
                        : typeof toolUseID === "string"
                          ? toolUseID
                          : "";
                    const allowed =
                      turn.inputSent &&
                      expected.includes(name) &&
                      !!callId &&
                      !turn.controller.signal.aborted;
                    if (allowed) {
                      const key = toolKey(name, hook?.tool_input);
                      const calls =
                        turn.hookCalls.get(key) ?? new Map<string, number>();
                      calls.set(callId, (calls.get(callId) ?? 0) + 1);
                      turn.hookCalls.set(key, calls);
                    }
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: allowed ? "allow" : "deny",
                        permissionDecisionReason:
                          "OhMyGame controlled tool boundary",
                      },
                    };
                  },
                ],
              },
            ],
          },
        },
      });
      turn.query = query;
      turn.pump = this.#consume(turn, expected);
      phase = "session-initialize";
      const [initialized] = await deadline(
        Promise.all([query.initializationResult(), ready]),
        INITIALIZE_TIMEOUT_MS,
      );
      const effective = object(initialized);
      if (
        !effective ||
        effective.memory !== undefined ||
        effective.evolution !== undefined ||
        (effective.permissionMode !== undefined &&
          effective.permissionMode !== "default")
      )
        throw new HostError(
          "Qoder enabled an unexpected runtime policy; no prompt was sent",
          "QODER_POLICY",
        );
      this.#assertActive(turn);
      phase = "mcp-status";
      const status = await deadline(
        query.mcpServerStatus(),
        INITIALIZE_TIMEOUT_MS,
      );
      verifyMcpStatus(status, tools);
      this.#assertActive(turn);
      turn.inputSent = true;
      releaseInput();
      return { sessionId: turn.sessionId };
    } catch (cause) {
      const error = turn.failure ?? sdkFailure(cause, phase);
      turn.rejectReady(error);
      // Keep the primary startup failure if SDK cleanup also rejects.
      await this.#stopTurn(turn).catch(() => {});
      throw error;
    }
  }

  #mcpServer(turn: HostTurn): HostMcpServer {
    const server = this.dependencies.sdk.createSdkMcpServer({
      name: SERVER,
      tools: [],
    });
    server.instance.server.registerCapabilities({
      tools: { listChanged: false },
    });
    server.instance.server.setRequestHandler(
      this.dependencies.schemas.listTools,
      () => ({ tools: turn.tools }),
    );
    server.instance.server.setRequestHandler(
      this.dependencies.schemas.callTool,
      async (value, extra) => {
        const params = object(object(value)?.params);
        const name = typeof params?.name === "string" ? params.name : "";
        try {
          this.#assertActive(turn);
          if (
            !turn.inputSent ||
            extra.signal?.aborted ||
            !turn.tools.some((tool) => tool.name === name)
          )
            throw new HostError("The controlled tool is unavailable");
          const key = toolKey(
            `mcp__${SERVER}__${name}`,
            params?.arguments ?? {},
          );
          const calls = turn.hookCalls.get(key);
          if (calls?.size !== 1)
            throw new HostError(
              "The Qoder tool call has no unambiguous runtime call ID",
            );
          const [callId, count] = [...calls.entries()][0];
          if (count > 1) calls.set(callId, count - 1);
          else turn.hookCalls.delete(key);
          let cached = turn.forwardedCalls.get(callId);
          if (cached && cached.input !== key)
            throw new HostError(
              "The Qoder tool call ID was reused with different arguments",
            );
          if (!cached) {
            cached = {
              input: key,
              result: this.#requestTool(
                turn,
                { name, arguments: params?.arguments ?? {}, callId },
                extra.signal,
              ),
            };
            turn.forwardedCalls.set(callId, cached);
          }
          const result = await cached.result;
          this.#assertActive(turn);
          const content = object(result)?.content;
          const images = Array.isArray(content)
            ? content.filter((block) => object(block)?.type === "image")
            : [];
          if (images.length) {
            // Validate with the initial-image contract; keep the original MCP
            // result and the daemon's completed tool record unchanged.
            parseImages(images);
            turn.requiresImageInput = true;
            if (turn.sessionId) this.#imageSessions.add(turn.sessionId);
          }
          return result;
        } catch (cause) {
          if (cause instanceof HostError && cause.code === "QODER_IMAGE_INPUT")
            this.#failTurn(turn, cause);
          return {
            isError: true,
            content: [{ type: "text", text: errorMessage(cause) }],
          };
        }
      },
    );
    return server;
  }

  async #consume(turn: HostTurn, expected: string[]): Promise<void> {
    try {
      for await (const value of turn.query!) {
        try {
          const message = object(value);
          if (!message)
            throw new HostError("Qoder returned an invalid message");
          if (message.type === "system" && message.subtype === "init") {
            const sessionId = nonempty(message.session_id);
            if (turn.sessionId !== undefined && turn.sessionId !== sessionId)
              throw new HostError(
                "Qoder returned an initialization snapshot for another session",
              );
            verifyInventory(
              message,
              expected,
              this.#configuration!.privateDirectory,
              turn.inputSent,
            );
            // CLI 1.1.83 emits another snapshot at the start of every user turn.
            // Revalidate it without rebinding, releasing input, or clearing tool IDs.
            if (turn.sessionId !== undefined) continue;
            turn.sessionId = sessionId;
            if (turn.requiresImageInput) this.#imageSessions.add(sessionId);
            turn.resolveReady();
          } else if (
            turn.sessionId !== undefined &&
            message.session_id !== undefined &&
            message.session_id !== turn.sessionId
          ) {
            throw new HostError("Qoder returned a message for another session");
          }
          if (
            message.type === "result" &&
            this.#turn === turn &&
            this.#pending.size
          )
            throw new HostError(
              "Qoder ended while a controlled tool result was still pending",
            );
          if (!turn.controller.signal.aborted)
            if (message.type === "command_lifecycle") {
              const command = turn.steering.get(String(message.command_uuid));
              if (command) {
                if (message.state === "started" && command.state !== "admitted") {
                  command.state = "started";
                  turn.deferredResult = undefined;
                }
                if ((message.state === "cancelled" || message.state === "discarded") && command.state !== "admitted") command.state = "cancelled";
              }
            }
          // A late queued user message can start another native turn in this same query.
          if (message.type === "result" && message.subtype === "success" && !message.is_error &&
            [...turn.steering.values()].some(command => command.state !== "admitted" && command.state !== "cancelled")) {
            turn.deferredResult = message;
            continue;
          }
          if (!turn.controller.signal.aborted)
            this.send({
              method: "sdk/message",
              params: { turnId: turn.id, message: message.type === "result" ? safeTerminalResult(message) : message },
            });
          if (message.type === "result") {
            turn.complete = true;
            turn.controller.abort();
            turn.releaseInput?.();
          }
          this.#finishCancelledSteering(turn);
        } catch (cause) {
          // AsyncIteratorClose can reject initialization before this loop's outer
          // catch runs. Publish and retain our boundary failure before it closes.
          this.#failTurn(turn, cause);
          return;
        }
      }
      if (!turn.complete && !turn.controller.signal.aborted)
        throw new HostError("Qoder ended without a turn result");
    } catch (cause) {
      this.#failTurn(turn, cause);
    }
  }

  #failTurn(turn: HostTurn, cause: unknown): void {
    if (turn.failure) return;
    const error = (turn.failure = sdkFailure(
      cause,
      turn.inputSent ? "response-stream" : "session-initialize",
    ));
    turn.rejectReady(error);
    if (!turn.controller.signal.aborted)
      this.send({
        method: "sdk/error",
        params: {
          turnId: turn.id,
          code: error.code,
          message: error.message,
          ...(error.phase ? { phase: error.phase } : {}),
          ...(error.boundary ? { boundary: error.boundary } : {}),
        },
      });
    turn.controller.abort();
    turn.releaseInput?.();
    turn.complete = true;
    if (this.#turn === turn) this.#rejectPending();
    void Promise.resolve()
      .then(() => turn.query?.close())
      .catch(() => {});
  }

  async #requestTool(
    turn: HostTurn,
    params: ObjectValue,
    signal?: AbortSignal,
    method = "tool/call",
  ): Promise<unknown> {
    const id = `tool:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        this.#pending.delete(id);
        reject(new HostError("The Qoder turn was cancelled"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        turn.controller.signal.removeEventListener("abort", abort);
      };
      this.#pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      turn.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || turn.controller.signal.aborted) {
        cleanup();
        abort();
        return;
      }
      this.send({
        id,
        method,
        params: { ...params, turnId: turn.id, sessionId: turn.sessionId },
      });
    });
  }

  async #steer(params: ObjectValue): Promise<unknown> {
    const turn = this.#turn;
    if (!turn || turn.complete || turn.controller.signal.aborted || params.turnId !== turn.id) return { queued: false };
    const id = nonempty(params.commandId);
    if (turn.steering.has(id)) throw new HostError("Duplicate Qoder steering command");
    const text = nonempty(params.text), images = parseImages(params.images);
    turn.steering.set(id, { state: "queued", requiresImageInput: images.length > 0 || params.requiresImageInput === true });
    turn.inputQueue.push({ type: "user", uuid: id, priority: "next", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }, ...images] } });
    turn.wakeInput?.();
    return { queued: true };
  }

  async #cancelSteering(params: ObjectValue): Promise<unknown> {
    const turn = this.#turn;
    if (!turn || params.turnId !== turn.id || !Array.isArray(params.commandIds) || !params.commandIds.every(id => typeof id === "string"))
      throw new HostError("Invalid Qoder steering cancellation");
    const cancelled: string[] = [];
    for (const id of params.commandIds as string[]) {
      const command = turn.steering.get(id);
      if (!command || command.state === "admitted" || command.state === "started") continue;
      if (command.state === "cancelled" || command.state === "queued" || await turn.query?.cancelAsyncMessage(id)) {
        // A started notification can race the cancellation response; never replay an admitted message.
        const current = turn.steering.get(id);
        if (current?.state === "admitted" || current?.state === "started") continue;
        command.state = "cancelled";
        cancelled.push(id);
      }
    }
    this.#finishCancelledSteering(turn);
    return { cancelled };
  }

  #finishCancelledSteering(turn: HostTurn): void {
    const result = turn.deferredResult;
    if (!result || turn.controller.signal.aborted || [...turn.steering.values()].some(command => command.state !== "admitted" && command.state !== "cancelled")) return;
    turn.deferredResult = undefined;
    turn.complete = true;
    turn.controller.abort();
    turn.releaseInput?.();
    this.send({ method: "sdk/message", params: { turnId: turn.id, message: safeTerminalResult(result) } });
  }

  async #admitSteering(turn: HostTurn): Promise<void> {
    // The pinned SDK dispatches control callbacks separately from its output iterator.
    // Drain already-arrived lifecycle frames before deciding which commands this request consumes.
    await new Promise<void>(resolve => setImmediate(resolve));
    turn.admission = (turn.admission ?? Promise.resolve()).then(async () => {
      this.#assertActive(turn);
      await Promise.all([...turn.forwardedCalls.values()].map(call => call.result));
      for (const [id, command] of turn.steering) {
        if (command.state !== "started") continue;
        const receipt = object(await this.#requestTool(turn, { commandId: id }, undefined, "steering/started"));
        if (receipt?.accepted !== true) throw new HostError("The steering checkpoint was not confirmed");
        this.#assertActive(turn);
        command.state = "admitted";
        turn.requiresImageInput ||= command.requiresImageInput;
        if (turn.requiresImageInput && turn.sessionId) this.#imageSessions.add(turn.sessionId);
      }
    });
    try { await turn.admission; }
    catch (cause) { this.#failTurn(turn, cause); throw cause; }
  }

  async #interrupt(params: ObjectValue): Promise<unknown> {
    const turn = this.#turn;
    if (!turn || turn.complete) return {};
    if (params.turnId !== turn.id)
      throw new HostError("The Qoder turn ID does not match");
    // Revoke tool dispatch before asking the runtime to interrupt remote work.
    turn.controller.abort();
    turn.releaseInput?.();
    this.#rejectPending();
    try {
      await turn.query?.interrupt();
    } finally {
      await this.#stopTurn(turn);
    }
    return {};
  }

  #requireDaemon(): HostDaemon {
    if (!this.#daemon) throw new HostError("Qoder host is not initialized");
    return this.#daemon;
  }

  #assertActive(turn: HostTurn): void {
    if (this.#turn !== turn || turn.complete || turn.controller.signal.aborted)
      throw new HostError("The Qoder turn was cancelled");
  }

  #rejectPending(): void {
    for (const pending of this.#pending.values())
      pending.reject(new HostError("The Qoder turn was cancelled"));
    this.#pending.clear();
  }

  async #stopTurn(turn: HostTurn): Promise<void> {
    turn.controller.abort();
    turn.releaseInput?.();
    turn.rejectReady(new HostError("The Qoder turn was cancelled"));
    turn.complete = true;
    turn.hookCalls.clear();
    this.#rejectPending();
    await turn.query?.close();
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      try {
        if (this.#turn) await this.#stopTurn(this.#turn);
      } finally {
        await this.#daemon?.stop();
        this.#daemon = undefined;
      }
    })());
  }
}

/** Result diagnostics may contain upstream request bodies. Project only finite terminal metadata. */
function safeTerminalResult(value: ObjectValue): ObjectValue {
  const subtype = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd"].includes(String(value.subtype)) ? value.subtype : "unknown";
  const terminal = value.terminal_reason == null || value.terminal_reason === "" ? undefined : ["max_turns", "abort", "aborted_streaming", "aborted_tools", "hook_stopped", "repeated_tool_call_denied", "completed"].includes(String(value.terminal_reason)) ? value.terminal_reason : "unknown";
  const stop = value.stop_reason == null || value.stop_reason === "" ? undefined : ["end_turn", "stop_sequence", "tool_use", "max_tokens", "pause_turn", "refusal"].includes(String(value.stop_reason)) ? value.stop_reason : "unknown";
  return { type: "result", subtype, is_error: value.is_error === true,
    ...(typeof value.session_id === "string" ? { session_id: value.session_id } : {}),
    ...(typeof value.num_turns === "number" && Number.isSafeInteger(value.num_turns) && value.num_turns >= 0 && value.num_turns <= 1_000_000 ? { num_turns: value.num_turns } : {}),
    ...(terminal ? { terminal_reason: terminal } : {}), ...(stop ? { stop_reason: stop } : {}),
  };
}

function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new HostError("Qoder requires a non-empty identifier");
  return value;
}

function absolutePath(value: unknown): string {
  const result = nonempty(value);
  if (!path.isAbsolute(result))
    throw new HostError("Qoder paths must be absolute");
  return path.resolve(result);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function errorMessage(cause: unknown): string {
  // Third-party errors may contain authentication payloads or environment values.
  return cause instanceof HostError
    ? cause.message
    : "The Qoder SDK operation failed";
}

function errorCode(cause: unknown): string {
  if (cause instanceof HostError) return cause.code;
  switch (object(cause)?.code) {
    case "DAEMON_PROTOCOL_ERROR":
      return "QODER_SDK_DAEMON_PROTOCOL";
    case "QODER_CLI_PROCESS_ERROR":
      return "QODER_SDK_PROCESS";
    case "CONTROL_REQUEST_TIMEOUT":
      return "QODER_SDK_TIMEOUT";
    case "SDK_INPUT_TOO_LARGE":
    case "SDK_OUTPUT_TOO_LARGE":
      return "QODER_SDK_FRAME";
  }
  switch (object(cause)?.name) {
    case "ProtocolVersionMismatchError":
      return "QODER_SDK_PROTOCOL_VERSION";
    case "UnsupportedCliCapabilityError":
      return "QODER_SDK_CAPABILITY";
    case "QoderCliInitializationError":
      return "QODER_SDK_INITIALIZE";
    case "ControlRequestError":
      return "QODER_SDK_CONTROL";
  }
  return "QODER_SDK";
}

function sdkFailure(
  cause: unknown,
  phase: NonNullable<HostError["phase"]>,
): HostError {
  return cause instanceof HostError
    ? cause.phase
      ? cause
      : new HostError(cause.message, cause.code, phase, cause.boundary)
    : new HostError("The Qoder SDK operation failed", errorCode(cause), phase);
}

function parseTools(value: unknown): HostTool[] {
  if (!Array.isArray(value) || !value.length)
    throw new HostError("Qoder requires an explicit controlled tool list");
  const names = new Set<string>();
  return value.map((item) => {
    const tool = object(item);
    const name = nonempty(tool?.name);
    if (!/^[a-zA-Z0-9_]+$/.test(name) || names.has(name))
      throw new HostError("Qoder tool names must be unique controlled names");
    names.add(name);
    const schema = object(tool?.inputSchema);
    if (!schema || schema.type !== "object")
      throw new HostError("Qoder tools require object input schemas");
    return {
      name,
      description:
        typeof tool?.description === "string" ? tool.description : "",
      inputSchema: schema,
    };
  });
}

function parseImages(value: unknown): ObjectValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new HostError(IMAGE_INPUT_MESSAGE, "QODER_IMAGE_INPUT");
  return value.map((item) => {
    const image = object(item);
    if (
      !image ||
      !["image/png", "image/jpeg", "image/webp"].includes(
        String(image.mimeType),
      ) ||
      typeof image.data !== "string" ||
      !validImageData(image.data, image.mimeType as string)
    )
      throw new HostError(IMAGE_INPUT_MESSAGE, "QODER_IMAGE_INPUT");
    return {
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    };
  });
}

/** Validate the wire envelope without loading a codec or changing original bytes. */
function validImageData(data: string, mimeType: string): boolean {
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return false;
  if (mimeType === "image/png")
    return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"));
  if (mimeType === "image/jpeg")
    return bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;
  return mimeType === "image/webp" && bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length;
}

function sameStrings(value: unknown, expected: string[]): boolean {
  const entries = new Set(Array.isArray(value) ? value : []);
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    entries.size === value.length &&
    expected.every((entry) => entries.has(entry))
  );
}

function verifyInventory(
  message: ObjectValue,
  expected: string[],
  cwd: string,
  promptSent: boolean,
): void {
  const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
  const checks: Record<InventoryField, boolean> = {
    "runtime-version": message.qodercli_version === RUNTIME_VERSION,
    "working-directory": message.cwd === cwd,
    "active-tools": sameStrings(message.tools, expected),
    skills: sameStrings(message.skills, []),
    plugins: sameStrings(message.plugins, []),
    "agent-directory":
      message.agents === undefined ||
      (Array.isArray(message.agents) &&
        new Set(message.agents).size === message.agents.length &&
        message.agents.every(
          (name) =>
            typeof name === "string" && BUILTIN_AGENT_METADATA.has(name),
        )),
    "mcp-servers":
      servers.length === 1 &&
      object(servers[0])?.name === SERVER &&
      object(servers[0])?.status === "connected",
    "permission-mode": message.permissionMode === "default",
  };
  const boundary = (Object.keys(checks) as InventoryField[]).find(
    (field) => !checks[field],
  );
  if (boundary)
    throw new HostError(
      promptSent
        ? "Qoder changed the controlled tool boundary; the turn was stopped and existing tool results are retained"
        : "Qoder did not apply the controlled tool boundary; no prompt was sent",
      promptSent ? "QODER_RUNTIME_INVENTORY" : "QODER_INVENTORY",
      undefined,
      boundary,
    );
}

function verifyMcpStatus(value: unknown, tools: HostTool[]): void {
  if (!Array.isArray(value) || value.length !== 1)
    throw new HostError("Qoder exposed an unexpected MCP server", "QODER_MCP");
  const server = object(value[0]);
  const names = Array.isArray(server?.tools)
    ? server.tools.map((tool) => object(tool)?.name)
    : undefined;
  if (
    server?.name !== SERVER ||
    server.status !== "connected" ||
    !sameStrings(
      names,
      tools.map((tool) => `mcp__${SERVER}__${tool.name}`),
    )
  )
    throw new HostError(
      "Qoder did not initialize the controlled MCP tools",
      "QODER_MCP",
    );
}

function toolKey(name: string, args: unknown): string {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : object(value)
        ? Object.fromEntries(
            Object.entries(value as ObjectValue)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)]),
          )
        : value;
  return `${name}:${JSON.stringify(normalize(args ?? {}))}`;
}

async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HostError(
                "Qoder initialization timed out before any prompt was sent",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves the already installed exact SDK; importing it never runs postinstall. */
export async function loadQoderSdkHostDependencies(
  sdkEntry?: string,
): Promise<QoderSdkHostDependencies> {
  const require = createRequire(import.meta.url);
  const entry =
    sdkEntry === undefined
      ? require.resolve("@qoder-ai/qoder-agent-sdk")
      : absolutePath(sdkEntry);
  const root = path.resolve(path.dirname(entry), "..");
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as ObjectValue;
  const runtime = JSON.parse(
    await readFile(path.join(root, "dist/runtime-manifest.json"), "utf8"),
  ) as ObjectValue;
  if (
    manifest.version !== SDK_VERSION ||
    manifest.qoderCliVersion !== RUNTIME_VERSION ||
    runtime.sdkVersion !== SDK_VERSION ||
    runtime.qoderCliVersion !== RUNTIME_VERSION
  )
    throw new HostError(
      "The controlled Qoder SDK/runtime version is unavailable",
    );
  const sdk = (await import(
    pathToFileURL(entry).href
  )) as QoderSdkHostDependencies["sdk"];
  const schemasModule = createRequire(entry).resolve(
    "@modelcontextprotocol/sdk/types.js",
  );
  const schemas = (await import(
    pathToFileURL(schemasModule).href
  )) as ObjectValue;
  return {
    sdkVersion: SDK_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    sdk,
    schemas: {
      listTools: schemas.ListToolsRequestSchema,
      callTool: schemas.CallToolRequestSchema,
    },
  };
}

export async function runQoderSdkHost(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  load: () => Promise<QoderSdkHostDependencies> = () =>
    loadQoderSdkHostDependencies(process.argv[2]),
): Promise<void> {
  const host = new QoderSdkHost(await load(), (message) => {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
      throw new HostError("Qoder host response exceeds the protocol budget");
    output.write(`${line}\n`);
  });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const stop = () => {
    void host.close().catch(() => {});
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    for await (const chunk of input) {
      pending +=
        typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES)
        throw new HostError("Qoder host input exceeds the protocol budget");
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) void host.handle(JSON.parse(line)).catch(stop);
      }
    }
    if ((pending + decoder.end()).trim())
      throw new HostError("Qoder host input ended inside a message");
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await host.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runQoderSdkHost().catch(() => {
    process.stderr.write("The controlled Qoder SDK host failed\n");
    process.exitCode = 1;
  });
}
