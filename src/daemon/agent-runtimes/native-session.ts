import { randomUUID } from "node:crypto";
import type {
  AgentSessionEvent,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentContextUsage,
  AgentUsageLimit,
} from "../../shared/contracts.js";
import type {
  AgentRuntimeId,
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import { CHECKPOINT_ENTRY, recordCheckpoint, type StoredCheckpoint } from "../checkpoint-extension.js";
import type { CodingQueuedPrompt, CodingSession, SkillCatalogItem } from "../agent.js";
import { handoffSummary } from "./handoff.js";
import { NATIVE_API } from "./replay.js";
import { inside } from "./policy.js";
import { hasSessionImages, sessionImageReferenceContext } from "../session-images.js";
import { isRecoverableInterruption, type AgentInterruption, type AutoContinueTools } from "../agent-auto-continue.js";
import { getToolConfirmedFailure, getToolPreflightFailure } from "../agent-tool-errors.js";
import { getIsolatedOperationReceipts, getIsolatedRepairResolutions, getIsolatedRepairPending } from "../isolated-tool-receipts.js";

/** The custom entry that records which native session a conversation's branch continues. */
export const NATIVE_SESSION_ENTRY = "ohmygame-native-session";

export interface StoredNativeSession {
  version: 2;
  runtime: AgentRuntimeId;
  state: "active" | "ready" | "invalid";
  sessionId?: string;
  contextVersion?: string;
}

/** A native context was removed; the shared session must rebuild it from the current branch. */
export class NativeSessionExpiredError extends Error {}

export interface PromptImage {
  type: "image";
  mimeType: string;
  data: string;
}

export interface NativeTurnInput {
  text: string;
  images: PromptImage[];
  /** Planning turns may read but not change the workspace. */
  readOnly: boolean;
  /** The current branch retains visual references even when its text handoff sends no old pixels. */
  requiresImageInput?: boolean;
}

/** A tool result in the shape OhMyGame's own tools return, so artifacts and images show the same way. */
export interface NativeToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
}

type NativeResultSubtype = "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
export interface NativeResultMetadata {
  /** SDK-reported count for this segment; provider counters are not a task budget. */
  modelTurns?: number;
  resultSubtype?: NativeResultSubtype;
  terminalReason?: "max_turns" | "abort" | "aborted_streaming" | "aborted_tools" | "hook_stopped" | "repeated_tool_call_denied" | "completed" | "unknown";
  stopReason?: "end_turn" | "stop_sequence" | "tool_use" | "max_tokens" | "pause_turn" | "refusal" | "unknown";
  cancelOrigin?: "user" | "host" | "runtime";
}
export type NativeTurnOutcome =
  | ({ status: "completed" } & NativeResultMetadata)
  | { status: "aborted" }
  | ({ status: "failed"; error: string; interruption?: AgentInterruption } & NativeResultMetadata);

export interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What a protocol adapter reports while a turn runs. Text and reasoning are
 * keyed by the adapter's own block ids; a tool call is announced with its
 * arguments, then started and finished by its call id.
 */
export interface NativeTurnSink {
  /** Awaited before subsequent project tools and transcript events, after prior tools settle. */
  steeringStarted?(id: string, admissionSignal?: AbortSignal): Promise<void>;
  limits?(limits: AgentUsageLimit[]): void;
  text(key: string, delta: string): void;
  textDone(key: string, text?: string): void;
  thinking(key: string, delta: string): void;
  thinkingDone(key: string, text?: string): void;
  toolCall(callId: string, name: string, args: Record<string, unknown>): void;
  toolStarted(callId: string): void;
  toolUpdate(callId: string, result: NativeToolResult): void;
  toolResult(callId: string, result: NativeToolResult, isError: boolean): void;
  /** A completed effect arriving after a terminal signal still needs a durable receipt. */
  toolSettled?(callId: string, result: NativeToolResult, isError: boolean): void;
  usage(
    usage: NativeUsage,
    contextWindow?: number,
    contextTokens?: number,
  ): void;
  compaction(
    phase: "start" | "end",
    result?: {
      summary?: string;
      tokensBefore?: number;
      error?: string;
      aborted?: boolean;
    },
  ): void;
  nativeSession(sessionId: string): void;
  /** Asks the person; `callId` names the tool call the request is about, when the agent says. */
  requestApproval(
    details: ApprovalRequestDetails,
    options?: { callId?: string; signal?: AbortSignal },
  ): Promise<ApprovalDecision>;
}

/** A protocol adapter: Claude Code stream-json, Codex app-server or OpenCode serve. */
export interface NativeDriver {
  steer?(id: string, input: NativeTurnInput): Promise<boolean>;
  cancelSteering?(ids: readonly string[]): Promise<string[]>;
  /** Runs one user message to the end of the native turn. */
  runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome>;
  interrupt(): Promise<void>;
  compact?(
    sink: NativeTurnSink,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeSessionOptions {
  runtime: AgentRuntimeId;
  /** The model as the conversation names it: the runtime's own model ID. */
  model: string;
  nativeReasoningLevel?: string;
  /** Rebuild native context when the host tool/security contract changes. */
  contextVersion?: string;
  /** Verified catalog capability; a text-only connection must not silently ignore retained images. */
  supportsImages?: boolean;
  sessionManager: SessionManager;
  /** Creates the adapter for the native session the branch continues, if any. */
  createDriver(
    resume: string | undefined,
    settings: { model: string; reasoningLevel?: string },
  ): NativeDriver;
  snapshotBeforeMessage?: () => Promise<string>;
  /** Text that the next message must carry, such as a notice that files were restored. */
  turnNotice?: () => Promise<string | undefined>;
  requestApproval(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  /** OhMyGame tools offered to the agent, by the names Pi gives them. */
  toolNames: readonly string[];
  setActiveTools?(names: readonly string[]): void;
  skills?: () => SkillCatalogItem[];
  /** The account's quota windows, whenever the CLI reports them. */
  onLimits?(limits: AgentUsageLimit[]): void;
  /** The account's quota windows as last reported by any conversation, or a check of the CLI. */
  accountLimits?(): AgentUsageLimit[] | undefined;
  dispose?(): void | Promise<void>;
  /** Time allowed for a native interrupt before its process is stopped. */
  cancellationTimeoutMs?: number;
  /** How long a CLI may sit idle before it is stopped; the next message resumes its native session. */
  idleTimeoutMs?: number;
  continuationTools?: AutoContinueTools;
  assertContinuation?(): void | Promise<void>;
  beginTask?(userEntryId: string): void | Promise<void>;
}

const IDLE_PROCESS_MS = 10 * 60_000;
interface NativeContinuation {
  text: string;
  images: PromptImage[];
  userEntryId: string;
  model: string;
  reasoningLevel?: string;
  readOnly: boolean;
}

interface NativeQueuedPrompt extends CodingQueuedPrompt {
  submitted?: Promise<boolean>;
}

/**
 * A conversation run by a coding agent CLI. It keeps the conversation in the
 * same Pi session file as OhMyGame's own agent: every user message, answer
 * and tool result is stored as a Pi message, after the checkpoint taken for
 * it, so the conversation list, Undo, message edits and restarts work the
 * same. The CLI keeps its own context; the stored messages are a record and,
 * when the conversation moves to another agent, the source of a summary.
 */
export class NativeCodingSession implements CodingSession {
  readonly runtime: AgentRuntimeId;
  readonly sessionManager: SessionManager;
  readonly emitsInitialUserMessage = true;
  readonly messages: unknown[] = [];
  #driver: NativeDriver;
  #listeners = new Set<(event: AgentSessionEvent) => void>();
  #followUps: Array<{ text: string; images: PromptImage[] }> = [];
  #steering: NativeQueuedPrompt[] = [];
  #deliveredSteering = new Set<string>();
  #running?: { controller: AbortController; done: Promise<void> };
  #readOnly = false;
  #handoff: boolean;
  #nativeSessionId?: string;
  #imageReferencesThrough?: string;
  #usage?: AgentContextUsage;
  #allowed = new Set<string>();
  #readFolders: string[] = [];
  #checkpointFailure?: { cause: unknown };
  #disposed = false;
  #disposal?: Promise<void>;
  #idleTimer?: ReturnType<typeof setTimeout>;
  /** An idle CLI still stopping; the next run waits so two processes never share a native session. */
  #idleStop?: Promise<void>;
  #interruption?: AgentInterruption;
  #continuation?: NativeContinuation;
  #continuationPrepared = false;
  #segment = 0;
  #cancelOrigin?: "user" | "host";
  #forcedInterruption?: AgentInterruption;
  #stoppingUnconfirmed?: Promise<void>;

  get interruption(): AgentInterruption | undefined {
    return this.#interruption && isRecoverableInterruption(this.#interruption) && this.options.continuationTools?.repairable
      ? { ...this.#interruption, repairOnly: true } : this.#interruption;
  }

  #toolStopMessage(): string {
    try { this.options.continuationTools?.assertSafe(); }
    catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
    return "An operation has an unconfirmed outcome. Recover or review the original operation before continuing.";
  }

  /** A daemon-owned effect guard can stop the native loop without impersonating a user Stop. */
  stopForUnconfirmedEffect(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    if (this.#stoppingUnconfirmed) return this.#stoppingUnconfirmed;
    this.#forcedInterruption = { kind: "blocked", source: this.runtime === "qoder-cli" ? "qoder" : "codex", code: "unconfirmed_tool_effect", phase: "tools", cancelOrigin: "host" };
    const running = this.#running;
    const driver = this.#driver;
    return this.#stoppingUnconfirmed = (async () => {
      await bounded(driver.interrupt().catch(() => {}), this.options.cancellationTimeoutMs ?? 1_500);
      if (!await bounded(running.done, this.options.cancellationTimeoutMs ?? 1_500)) await driver.dispose();
    })().finally(() => { this.#stoppingUnconfirmed = undefined; });
  }

  constructor(private readonly options: NativeSessionOptions) {
    this.runtime = options.runtime;
    this.sessionManager = options.sessionManager;
    this.messages.push(
      ...this.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
    const stored = latestNativeSession(
      this.sessionManager.getBranch(),
      options.runtime,
      options.contextVersion,
    );
    this.#nativeSessionId = stored?.sessionId;
    // A branch with messages and no native session of this agent was held by another agent, or by this one before
    // an edit or a restore went back past where its session began.
    this.#handoff = !stored && hasMessages(this.sessionManager.getBranch());
    this.#driver = options.createDriver(stored?.sessionId, {
      model: options.model,
      reasoningLevel: options.nativeReasoningLevel,
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(
    prompt: string,
    options?: { images?: PromptImage[] },
  ): Promise<void> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#running) throw new Error("The agent is already running");
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#running = { controller, done };
    this.#deliveredSteering.clear();
    this.#checkpointFailure = undefined;
    try {
      const stopping = this.#takeIdleStop();
      if (stopping) await stopping;
      let next: { text: string; images: PromptImage[] } | undefined = {
        text: prompt,
        images: options?.images ?? [],
      };
      while (next && !controller.signal.aborted) {
        const failed = await this.#runMessage(
          next.text,
          next.images,
          controller.signal,
        );
        if (failed) {
          this.#followUps = [];
          this.#steering = [];
          break;
        }
        next = await this.#nextQueuedPrompt();
      }
    } finally {
      this.#running = undefined;
      settle();
      this.#scheduleIdleStop();
      this.#emit({ type: "agent_settled", aborted: controller.signal.aborted });
    }
    // A failed snapshot stops the run before the agent sees the message, as it does for Pi.
    const failure = this.#checkpointFailure as { cause: unknown } | undefined;
    if (failure) throw failure.cause;
  }

  async #nextQueuedPrompt(): Promise<{ text: string; images: PromptImage[] } | undefined> {
    const queued = this.#steering.shift();
    if (queued?.submitted) {
      // A successful native turn does not prove an in-flight steering request was unused.
      let notSubmitted = false;
      try { notSubmitted = await queued.submitted === false; } catch { /* An uncertain input must not be replayed. */ }
      if (!notSubmitted) {
        await this.#resetContext();
        throw new Error("The queued instruction's receipt is unconfirmed; it was not sent again.");
      }
    }
    return queued ?? this.#followUps.shift();
  }

  async followUp(prompt: string, images?: PromptImage[]): Promise<void> {
    this.#followUps.push({ text: prompt, images: images ?? [] });
  }

  async steer(prompt: string, images?: PromptImage[]): Promise<void> {
    const entry = { id: randomUUID(), text: prompt, images: images ?? [] };
    this.#steering.push(entry);
    await this.#sendSteering(entry);
  }

  async replaceQueue(steering: readonly CodingQueuedPrompt[], followUp: readonly CodingQueuedPrompt[]): Promise<void> {
    const desired = new Set(steering.map((item) => item.id));
    const removed = this.#steering.filter((item) => !desired.has(item.id));
    const admitted = removed.filter((item) => item.submitted);
    if (admitted.length) {
      const cancelled = new Set(await this.#driver.cancelSteering?.(admitted.map((item) => item.id)) ?? []);
      if (admitted.some((item) => !cancelled.has(item.id) && !this.#deliveredSteering.has(item.id)))
        throw new Error("A queued instruction is already being delivered; it was not replayed");
    }
    this.#steering = this.#steering.filter((item) => desired.has(item.id));
    this.#followUps = followUp.map(({ text, images }) => ({ text, images }));
    for (const entry of steering) {
      if (this.#deliveredSteering.has(entry.id)) continue;
      let queued = this.#steering.find((item) => item.id === entry.id);
      if (!queued) { queued = { ...entry }; this.#steering.push(queued); }
      await this.#sendSteering(queued);
    }
  }

  async #sendSteering(entry: NativeQueuedPrompt): Promise<void> {
    // Other native adapters retain next-turn delivery until they expose a safe boundary.
    if (!this.#running || !this.#driver.steer || entry.submitted) return;
    const requiresImageInput = entry.images.length > 0 || hasSessionImages(this.sessionManager.getBranch());
    if (requiresImageInput && this.options.supportsImages === false)
      throw new Error("This conversation contains images, but the selected connection does not have image input enabled; the instruction was not submitted.");
    const sending = this.#driver.steer(entry.id, { text: entry.text, images: entry.images, readOnly: this.#readOnly,
      requiresImageInput });
    entry.submitted = sending;
    if (!await sending) entry.submitted = undefined;
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const followUp = this.#followUps.map((item) => item.text);
    this.#followUps = [];
    const steering = this.#steering.map((item) => item.text);
    this.#steering = [];
    return { steering, followUp };
  }

  async abort(origin: "user" | "host" = "user"): Promise<void> {
    this.#cancelOrigin ??= origin;
    this.#interruption = undefined;
    this.#continuation = undefined;
    this.#continuationPrepared = false;
    this.#followUps = [];
    this.#steering = [];
    const running = this.#running;
    if (!running) return;
    running.controller.abort();
    const timeout = this.options.cancellationTimeoutMs ?? 1_500;
    await bounded(
      this.#driver.interrupt().catch(() => {}),
      timeout,
    );
    if (!(await bounded(running.done, timeout))) {
      await this.#driver.dispose();
      await running.done;
    }
  }

  #assertContinuation(): NativeContinuation {
    const task = this.#continuation;
    const lastUser = this.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
    if (this.#disposed || this.#running || !task || lastUser?.id !== task.userEntryId || !isRecoverableInterruption(this.interruption) ||
      task.model !== this.options.model || task.reasoningLevel !== this.options.nativeReasoningLevel || task.readOnly !== this.#readOnly)
      throw new Error("This interrupted task is no longer eligible for automatic continuation");
    return task;
  }

  async prepareContinuation(signal: AbortSignal): Promise<void> {
    this.#assertContinuation();
    signal.throwIfAborted();
    await this.options.assertContinuation?.();
    this.#assertContinuation();
    const guard = this.options.continuationTools;
    if (!guard) throw new Error("Automatic continuation has no controlled tool-result guard");
    await guard.prepare(signal, async (result, tool, callId) => {
      this.#assertContinuation();
      signal.throwIfAborted();
      const confirmedFailure = getToolConfirmedFailure(result);
      this.sessionManager.appendCustomMessageEntry("ohmygame-native-recovered-tool", [
        { type: "text", text: `${confirmedFailure ? "Confirmed the failed outcome" : "Recovered the existing result"} of ${tool}, original call ${callId}. No replacement operation was submitted.` },
        ...result.content,
      ] as never, false, { tool, originalCallId: callId, ...(confirmedFailure ? { isError: true, confirmedFailure } : {}) });
    });
    signal.throwIfAborted();
    await this.options.assertContinuation?.();
    this.#assertContinuation();
    this.#continuationPrepared = true;
  }

  async resumeAfterInterruption(): Promise<void> {
    this.#assertContinuation();
    if (!this.#continuationPrepared) throw new Error("Confirm retained tool outcomes before continuing");
    await this.options.assertContinuation?.();
    this.#assertContinuation();
    this.#continuationPrepared = false;
    this.#cancelOrigin = undefined;
    this.#forcedInterruption = undefined;
    this.#checkpointFailure = undefined;
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    this.#running = { controller, done };
    try {
      const stopping = this.#takeIdleStop();
      if (stopping) await stopping;
      let failed = await this.#runMessage("Continue the same unfinished user task from the retained conversation and current files. Reuse completed tool results. Never replay completed effects; recover uncertain operations by their original call or job ID. A normal final answer ends this task.", [], controller.signal, true);
      while (!failed && !controller.signal.aborted) {
        const next = await this.#nextQueuedPrompt();
        if (!next) break;
        failed = await this.#runMessage(next.text, next.images, controller.signal);
      }
      if (failed || controller.signal.aborted) { this.#followUps = []; this.#steering = []; }
    } finally {
      this.#running = undefined;
      settle();
      this.#scheduleIdleStop();
      this.#emit({ type: "agent_settled", aborted: controller.signal.aborted });
    }
    const failure = this.#checkpointFailure as { cause: unknown } | undefined;
    if (failure) throw failure.cause;
  }

  async compact(customInstructions?: string): Promise<void> {
    if (!this.#driver.compact)
      throw new Error("This agent cannot compact its context");
    if (this.#running)
      throw new Error(
        "Wait for the agent to finish before compacting the session",
      );
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#running = { controller, done };
    const turn = new TurnRecorder(this, this.options.model);
    this.#storeNativeState("active");
    try {
      const stopping = this.#takeIdleStop();
      if (stopping) await stopping;
      const sink = turn.sink();
      const report = sink.compaction;
      sink.compaction = (phase, result) =>
        report(phase, {
          ...result,
          ...(controller.signal.aborted ? { aborted: true } : {}),
        });
      await this.#driver.compact(sink, controller.signal, customInstructions);
      if (controller.signal.aborted) await this.#resetContext();
      else this.#storeNativeState("ready");
    } catch (cause) {
      await this.#resetContext();
      throw cause;
    } finally {
      this.#running = undefined;
      settle();
      this.#scheduleIdleStop();
    }
  }

  abortCompaction(origin: "user" | "host" = "user"): void {
    void this.abort(origin);
  }

  getContextUsage(): AgentContextUsage | undefined {
    // Quota windows belong to the account, not this conversation.
    const limits = this.options.accountLimits?.();
    if (!limits?.length) return this.#usage;
    return {
      tokens: null,
      contextWindow: 0,
      percent: null,
      ...this.#usage,
      limits,
    };
  }

  async navigateTree(
    targetId: string,
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    if (this.#running)
      throw new Error(
        "Wait for the current response to finish before navigating the session tree.",
      );
    const target = this.sessionManager.getEntry(targetId);
    if (!target) throw new Error(`Entry ${targetId} not found`);
    let editorText: string | undefined;
    if (target.type === "message" && target.message.role === "user") {
      editorText = contentText(target.message.content);
      if (target.parentId === null) this.sessionManager.resetLeaf();
      else this.sessionManager.branch(target.parentId);
    } else {
      this.sessionManager.branch(targetId);
    }
    // Even an unchanged native ID may contain turns removed by this rewind.
    await this.#resetContext();
    this.messages.splice(
      0,
      this.messages.length,
      ...this.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
    return {
      cancelled: false,
      ...(editorText !== undefined ? { editorText } : {}),
    };
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.#readOnly =
      !toolNames.includes("write") &&
      !toolNames.includes("edit") &&
      !toolNames.includes("bash");
    this.options.setActiveTools?.(toolNames);
  }

  getAllTools(): Array<{ name: string }> {
    return [
      ...new Set([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        ...this.options.toolNames,
      ]),
    ].map((name) => ({ name }));
  }

  getSkills(): SkillCatalogItem[] {
    return this.options.skills?.() ?? [];
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#cancelOrigin ??= "host";
    clearTimeout(this.#idleTimer);
    this.#running?.controller.abort();
    // Keep generated config/Skills until the process has actually stopped.
    const disposal = this.#disposal = (async () => {
      await this.#driver.dispose();
      await this.#idleStop;
      await this.options.dispose?.();
    })();
    // Existing callers may only initiate disposal; project deletion awaits it.
    // A failed cleanup remains retryable and never grants a successful deletion.
    void disposal.catch(() => { if (this.#disposal === disposal) this.#disposal = undefined; });
    this.#listeners.clear();
    return disposal;
  }

  /** Records the usage the agent reported for its context. */
  reportUsage(
    tokens: number | undefined,
    contextWindow: number | undefined,
  ): void {
    if (!contextWindow) return;
    this.#usage = {
      ...this.#usage,
      tokens: tokens ?? null,
      contextWindow,
      percent:
        tokens === undefined
          ? null
          : Math.min(100, (tokens / contextWindow) * 100),
    };
  }

  reportLimits(limits: AgentUsageLimit[]): void {
    this.options.onLimits?.(limits);
  }

  recordNativeSession(sessionId: string): void {
    if (sessionId === this.#nativeSessionId) return;
    if (this.#nativeSessionId) this.#imageReferencesThrough = undefined;
    this.#nativeSessionId = sessionId;
    this.sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      runtime: this.runtime,
      state: "active",
      sessionId,
      ...(this.options.contextVersion ? { contextVersion: this.options.contextVersion } : {}),
    } satisfies StoredNativeSession);
  }

  async approve(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal?.aborted || this.#disposed) return "deny";
    if (this.#covered(details)) return "allow";
    const decision = await this.options.requestApproval(
      details,
      toolCallId,
      signal,
    );
    if (decision === "allow-session" && details.canAllowSession)
      this.#remember(details);
    return decision;
  }

  /** Whether the person already allowed this, or all it covers, for the conversation. */
  #covered(details: ApprovalRequestDetails): boolean {
    const scope = details.sessionScope;
    if (!scope) return this.#allowed.has(approvalKey(details));
    return (
      (scope.commands ?? []).every((command) =>
        this.#allowed.has(`command:${command}`),
      ) &&
      (scope.readFolders ?? []).every((folder) =>
        this.#readFolders.some((root) => inside(folder, root)),
      )
    );
  }

  #remember(details: ApprovalRequestDetails): void {
    const scope = details.sessionScope;
    if (!scope) {
      this.#allowed.add(approvalKey(details));
      return;
    }
    for (const command of scope.commands ?? [])
      this.#allowed.add(`command:${command}`);
    this.#readFolders.push(...(scope.readFolders ?? []));
  }

  emit(event: AgentSessionEvent): void {
    if (event.type === "compaction_end") this.#imageReferencesThrough = undefined;
    this.#emit(event);
  }

  storeMessage(message: Record<string, unknown>): void {
    this.sessionManager.appendMessage(
      message as Parameters<SessionManager["appendMessage"]>[0],
    );
    this.messages.push(message);
  }

  async #runMessage(
    text: string,
    images: PromptImage[],
    signal: AbortSignal,
    continuation = false,
  ): Promise<boolean> {
    const history = this.sessionManager.getBranch();
    if (!continuation) {
      this.#cancelOrigin = undefined;
      this.#forcedInterruption = undefined;
      this.#interruption = undefined;
      this.#continuationPrepared = false;
      if (!(await this.#storeUserMessage(text, images))) return true;
      const user = this.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
      if (!user) throw new Error("The current user message was not retained");
      this.#continuation = { text, images, userEntryId: user.id, model: this.options.model, reasoningLevel: this.options.nativeReasoningLevel, readOnly: this.#readOnly };
      this.#segment = 0;
      this.options.continuationTools?.reset(user.id);
      await this.options.beginTask?.(user.id);
    }
    if (signal.aborted) return true;
    const branch = this.sessionManager.getBranch();
    const requiresImageInput = images.length > 0 || hasSessionImages(branch);
    const notice = await this.options.turnNotice?.().catch(() => undefined);
    const currentPrompt = notice
      ? `${text}\n\nWorkspace restore notice (inspect current files before continuing):\n${notice}`
      : text;
    let listedThrough: string | undefined;
    let listedSession: string | undefined;
    const wirePrompt = (handoff: boolean) => {
      let references: string | undefined;
      if (requiresImageInput && this.options.toolNames.includes("recall_image")) {
        listedSession = this.#nativeSessionId;
        const previous = listedSession && this.#imageReferencesThrough;
        const start = previous ? branch.findLastIndex(entry => entry.id === previous) + 1 : 0;
        references = sessionImageReferenceContext(start ? branch.slice(start) : branch);
        listedThrough = branch.at(-1)?.id;
      }
      return [continuation && this.options.continuationTools?.recoverySummary, references, handoff && handoffSummary(history), currentPrompt]
        .filter(Boolean).join("\n\n");
    };
    const wire = wirePrompt(this.#handoff);
    // A crash or interrupted write must never leave an earlier ready marker
    // claiming that this native context still matches the branch.
    this.#storeNativeState("active");
    let turn = new TurnRecorder(this, this.options.model);
    const sink = turn.sink();
    const bindRecorder = () => {
      Object.assign(sink, turn.sink());
      const recordCompaction = sink.compaction;
      sink.compaction = (phase, result) => {
        if (phase === "end") listedThrough = undefined;
        recordCompaction(phase, result);
      };
      const recordToolResult = sink.toolResult;
      sink.toolResult = (...result) => {
        // Persist the actual rejection/effect receipt before interrupting the adapter.
        recordToolResult(...result);
        if (this.options.continuationTools?.stopRequested && !this.options.continuationTools.repairable)
          void this.stopForUnconfirmedEffect().catch(() => {});
      };
    };
    bindRecorder();
    sink.steeringStarted = async (id, admissionSignal) => {
      const admission = admissionSignal ? AbortSignal.any([signal, admissionSignal]) : signal;
      if (this.#deliveredSteering.has(id)) return;
      const entry = this.#steering.find((item) => item.id === id);
      if (!entry) throw new Error("The queued instruction is no longer available");
      admission.throwIfAborted();
      if (turn.hasPendingTools()) throw new Error("A tool result is still pending; the instruction was not admitted");
      this.options.continuationTools?.assertSafe();
      if (this.options.continuationTools?.stopRequested || this.options.continuationTools?.repairOnly)
        throw new Error("Original tool effects still need recovery; the instruction was not admitted");
      if (entry.images.length && this.options.supportsImages === false)
        throw new Error("The selected connection does not have image input enabled");
      turn.closeAssistant("stop");
      if (!await this.#storeUserMessage(entry.text, entry.images, entry.id, admission)) throw this.#checkpointFailure?.cause ?? new Error("Workspace checkpoint failed");
      admission.throwIfAborted();
      this.#deliveredSteering.add(id);
      this.#steering = this.#steering.filter((item) => item.id !== id);
      const user = this.sessionManager.getBranch().findLast((item) => item.type === "message" && item.message.role === "user");
      if (!user) throw new Error("The queued instruction was not retained");
      this.#continuation = { text: entry.text, images: entry.images, userEntryId: user.id, model: this.options.model, reasoningLevel: this.options.nativeReasoningLevel, readOnly: this.#readOnly };
      this.#segment = 0;
      this.options.continuationTools?.reset(user.id);
      await this.options.beginTask?.(user.id);
      turn = new TurnRecorder(this, this.options.model);
      bindRecorder();
    };
    const runNative = async (input: NativeTurnInput): Promise<NativeTurnOutcome> => {
      const running = this.#driver.runTurn(input, sink, signal);
      // Inputs arriving during a checkpoint or expired-context rebuild join this live turn.
      try { for (const entry of this.#steering) await this.#sendSteering(entry); }
      catch (cause) { await this.#driver.interrupt(); await running; throw cause; }
      return running;
    };
    let outcome: NativeTurnOutcome;
    try {
      try {
        if (requiresImageInput && this.options.supportsImages === false)
          throw new Error("This conversation contains retained images, but the selected connection does not have image input enabled. Choose an image-enabled connection before continuing; original images are retained and no model task was sent.");
        outcome = await runNative(
          { text: wire, images, readOnly: this.#readOnly, ...(requiresImageInput ? { requiresImageInput: true } : {}) },
        );
      } catch (cause) {
        if (!(cause instanceof NativeSessionExpiredError) || signal.aborted)
          throw cause;
        await this.#resetContext();
        outcome = await runNative(
          {
            text: wirePrompt(true),
            images,
            readOnly: this.#readOnly,
            ...(requiresImageInput ? { requiresImageInput: true } : {}),
          },
        );
      }
    } catch (cause) {
      outcome = signal.aborted
        ? { status: "aborted" }
        : {
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          };
    }
    if (signal.aborted && outcome.status !== "failed")
      outcome = { status: "aborted" };
    if (this.#forcedInterruption && !signal.aborted)
      outcome = { status: "failed", error: this.#toolStopMessage(), interruption: this.#forcedInterruption };
    if (outcome.status === "completed" && this.options.continuationTools?.stopRequested)
      outcome = { status: "failed", error: this.#toolStopMessage(), interruption: { kind: "blocked", source: this.runtime === "qoder-cli" ? "qoder" : "codex", code: "unconfirmed_tool_effect", phase: "tools" } };
    if (outcome.status === "failed" && !signal.aborted) {
      const receipts = await Promise.allSettled(this.#steering.flatMap(({ submitted }) => submitted ? [submitted] : []));
      if (receipts.some(receipt => receipt.status === "rejected" || receipt.value))
        outcome = { ...outcome, error: `${outcome.error} The queued instruction's receipt is unconfirmed; it was not sent again.`,
          interruption: { kind: "blocked", source: outcome.interruption?.source ?? (this.runtime === "qoder-cli" ? "qoder" : "codex"), code: "native_steering_unconfirmed", phase: "result" } };
    }
    this.#interruption = outcome.status === "failed" && !signal.aborted ? outcome.interruption : undefined;
    this.sessionManager.appendCustomEntry("ohmygame-native-outcome", { version: 1, taskId: this.#continuation?.userEntryId, status: outcome.status,
      segment: ++this.#segment,
      ...(outcome.status !== "aborted" && outcome.modelTurns !== undefined ? { sdkNumTurns: outcome.modelTurns } : {}),
      ...(outcome.status !== "aborted" && outcome.resultSubtype ? { resultSubtype: outcome.resultSubtype } : {}),
      ...(outcome.status !== "aborted" && outcome.terminalReason ? { terminalReason: outcome.terminalReason } : {}),
      ...(outcome.status !== "aborted" && outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.status !== "aborted" && (outcome.cancelOrigin ?? this.#interruption?.cancelOrigin) ? { cancelOrigin: outcome.cancelOrigin ?? this.#interruption?.cancelOrigin } : {}),
      ...(this.#interruption ? { interruption: this.#interruption } : {}),
      ...(signal.aborted ? { cancelOrigin: this.#cancelOrigin ?? "host" } : {}),
    });
    turn.finish(outcome);
    if (outcome.status === "completed") {
      this.#storeNativeState("ready");
      this.#handoff = false;
      if (!listedSession || listedSession === this.#nativeSessionId) this.#imageReferencesThrough = listedThrough;
    } else await this.#resetContext();
    return outcome.status !== "completed";
  }

  #scheduleIdleStop(): void {
    clearTimeout(this.#idleTimer);
    if (this.#disposed) return;
    this.#idleTimer = setTimeout(
      () => this.#stopIdleProcess(),
      this.options.idleTimeoutMs ?? IDLE_PROCESS_MS,
    );
    this.#idleTimer.unref?.();
  }

  /**
   * Stops a CLI no message has used for a while. Its replacement starts only
   * with the next message and resumes the same native session, which is
   * valid here: a turn that did not complete has already reset the context.
   */
  #stopIdleProcess(): void {
    if (this.#running || this.#disposed) return;
    const idle = this.#driver;
    this.#driver = this.options.createDriver(this.#nativeSessionId, {
      model: this.options.model,
      reasoningLevel: this.options.nativeReasoningLevel,
    });
    this.#idleStop = (async () => { await idle.dispose(); })();
    void this.#idleStop.catch(() => {});
  }

  /** Cancels the idle stop and returns a stop still in progress, if any; awaiting nothing keeps the snapshot synchronous. */
  #takeIdleStop(): Promise<void> | undefined {
    clearTimeout(this.#idleTimer);
    const stopping = this.#idleStop;
    this.#idleStop = undefined;
    return stopping;
  }

  #storeNativeState(state: StoredNativeSession["state"]): void {
    this.sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      runtime: this.runtime,
      state,
      ...(this.options.contextVersion ? { contextVersion: this.options.contextVersion } : {}),
      ...(state !== "invalid" && this.#nativeSessionId
        ? { sessionId: this.#nativeSessionId }
        : {}),
    } satisfies StoredNativeSession);
  }

  async #resetContext(): Promise<void> {
    this.#storeNativeState("invalid");
    this.#nativeSessionId = undefined;
    this.#imageReferencesThrough = undefined;
    await this.#driver.dispose();
    this.#driver = this.options.createDriver(undefined, {
      model: this.options.model,
      reasoningLevel: this.options.nativeReasoningLevel,
    });
    this.#handoff = hasMessages(this.sessionManager.getBranch());
    this.#usage = undefined;
    this.#allowed.clear();
    this.#readFolders = [];
  }

  /** Stores a user message after the checkpoint taken for it, as Pi does. False when the snapshot failed. */
  async #storeUserMessage(
    text: string,
    images: PromptImage[],
    queuedPromptId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const message = {
      role: "user" as const,
      content: images.length
        ? [{ type: "text" as const, text }, ...images]
        : text,
      timestamp: Date.now(),
    };
    const start = () => this.#emit({ type: "message_start", message, ...(queuedPromptId ? { queuedPromptId } : {}) } as AgentSessionEvent);
    if (!queuedPromptId) start();
    const snapshot = this.options.snapshotBeforeMessage;
    let checkpoint: StoredCheckpoint | { version: 1 } | undefined;
    if (snapshot) {
      try {
        await recordCheckpoint(
          (data) => {
            if (queuedPromptId) checkpoint = data;
            else this.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, data);
          },
          snapshot,
        );
      } catch (cause) {
        this.#checkpointFailure ??= { cause };
        return false;
      }
    }
    if (queuedPromptId) {
      // Queue consumption is announced only after the snapshot succeeds. Keep start before
      // checkpoint insertion so AgentManager can associate that checkpoint with this message.
      signal?.throwIfAborted();
      start();
      if (checkpoint) this.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, checkpoint);
    }
    // As in Pi, the message ends before it is stored: OhMyGame finds the message's checkpoint among the entries before it.
    this.#emit({ type: "message_end", message } as AgentSessionEvent);
    this.storeMessage(message);
    return true;
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* A listener's failure is its own. */
      }
    }
  }
}

interface ToolState {
  name: string;
  args: Record<string, unknown>;
  started: boolean;
  finished: boolean;
}

/**
 * Turns what an adapter reports into Pi's events and messages. An assistant
 * message collects text, reasoning and tool calls until a tool runs or the
 * turn ends; each tool result is its own message, as in a Pi session.
 */
class TurnRecorder {
  readonly #userEntryId?: string;
  #assistant?: { message: AssistantRecord; blocks: Map<string, number> };
  #tools = new Map<string, ToolState>();
  /** Cumulative text survives flushing an assistant before a tool starts. */
  #blockText = new Map<string, string>();
  #usage: NativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(
    private readonly session: NativeCodingSession,
    private readonly model: string,
  ) {
    this.#userEntryId = session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user")?.id;
  }

  hasPendingTools(): boolean {
    return [...this.#tools.values()].some((tool) => !tool.finished);
  }

  sink(): NativeTurnSink {
    return {
      limits: (limits) => this.session.reportLimits(limits),
      text: (key, delta) => this.#text("text", key, delta),
      textDone: (key, text) => this.#textDone("text", key, text),
      thinking: (key, delta) => this.#text("thinking", key, delta),
      thinkingDone: (key, text) => this.#textDone("thinking", key, text),
      toolCall: (callId, name, args) => this.#toolCall(callId, name, args),
      toolStarted: (callId) => this.#toolStarted(callId),
      toolUpdate: (callId, result) => {
        const tool = this.#tools.get(callId);
        if (!tool || tool.finished) return;
        this.#toolStarted(callId);
        this.session.emit({
          type: "tool_execution_update",
          toolCallId: callId,
          toolName: tool.name,
          args: tool.args,
          partialResult: result,
        } as AgentSessionEvent);
      },
      toolResult: (callId, result, isError) =>
        this.#toolResult(callId, result, isError),
      toolSettled: (callId, result, isError) => {
        const tool = this.#tools.get(callId);
        const user = this.session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
        if (!tool || user?.id !== this.#userEntryId) return;
        const preflightFailure = isError ? getToolPreflightFailure(result) : undefined;
        const isolatedOperations = getIsolatedOperationReceipts(result);
        const isolatedRepairResolutions = getIsolatedRepairResolutions(result);
        const isolatedRepairPending = getIsolatedRepairPending(result);
        this.session.sessionManager.appendCustomEntry("ohmygame-native-tool-settlement", { version: 1, taskId: this.#userEntryId, originalCallId: callId, tool: tool.name,
          state: preflightFailure ? preflightFailure.disposition === "correctable" ? "not_executed" : "blocked" : isError ? "returned-error" : "completed", result,
          ...(preflightFailure ? { preflightFailure } : {}), ...(isolatedOperations ? { isolatedOperations } : {}), ...(isolatedRepairResolutions ? { isolatedRepairResolutions } : {}), ...(isolatedRepairPending ? { isolatedRepairPending } : {}) });
      },
      usage: (usage, contextWindow, contextTokens) => {
        this.#usage = usage;
        this.session.reportUsage(
          contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite,
          contextWindow,
        );
      },
      compaction: (phase, result) => {
        if (phase === "start") {
          this.closeAssistant();
          this.session.emit({
            type: "compaction_start",
            reason: "manual",
          } as AgentSessionEvent);
        } else {
          this.session.sessionManager.appendCustomEntry(
            "ohmygame-native-compaction",
            { version: 1, ...result },
          );
          this.session.emit({
            type: "compaction_end",
            reason: "manual",
            result:
              result?.summary !== undefined ||
              result?.tokensBefore !== undefined
                ? {
                    summary: result.summary ?? "",
                    tokensBefore: result.tokensBefore ?? 0,
                  }
                : undefined,
            aborted: result?.aborted ?? false,
            willRetry: false,
            ...(result?.error ? { errorMessage: result.error } : {}),
          } as AgentSessionEvent);
        }
      },
      nativeSession: (sessionId) => this.session.recordNativeSession(sessionId),
      requestApproval: (details, options) =>
        this.session.approve(
          details,
          options?.callId ?? this.#lastToolCallId() ?? randomUUID(),
          options?.signal,
        ),
    };
  }

  /** Ends the assistant message in progress, as before a tool runs or a message is steered in. */
  closeAssistant(
    stopReason: "stop" | "toolUse" | "aborted" | "error" = "toolUse",
    errorMessage?: string,
  ): void {
    const current = this.#assistant;
    if (!current) return;
    this.#assistant = undefined;
    const message = current.message;
    for (const [, index] of current.blocks) {
      const block = message.content[index];
      if (block?.type === "text")
        this.#emitUpdate(
          { type: "text_end", contentIndex: index, content: block.text },
          message,
        );
      else if (block?.type === "thinking")
        this.#emitUpdate(
          {
            type: "thinking_end",
            contentIndex: index,
            content: block.thinking,
          },
          message,
        );
    }
    message.stopReason = stopReason;
    message.usage = usageRecord(this.#usage);
    if (errorMessage) message.errorMessage = errorMessage;
    this.session.storeMessage(message as unknown as Record<string, unknown>);
    this.session.emit({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
  }

  finish(outcome: NativeTurnOutcome): void {
    // Tools the agent never finished cannot be finished now.
    for (const [callId, tool] of this.#tools) {
      if (!tool.finished)
        this.#toolResult(
          callId,
          {
            details: { nativeToolState: "unconfirmed", executionStarted: tool.started },
            content: [
              {
                type: "text",
                text:
                  outcome.status === "aborted"
                    ? "Stopped"
                    : "The agent did not finish this tool call",
              },
            ],
          },
          true,
        );
    }
    if (outcome.status === "completed") {
      // A native loop may finish after a denied tool without final text.
      // Persist the terminal stop so reload does not invent an interruption.
      if (!this.#assistant)
        this.#assistant = { message: this.#newMessage(), blocks: new Map() };
      this.closeAssistant("stop");
      return;
    }
    const stopReason = outcome.status === "aborted" ? "aborted" : "error";
    const errorMessage =
      outcome.status === "failed" ? outcome.error : undefined;
    if (!this.#assistant)
      this.#assistant = { message: this.#newMessage(), blocks: new Map() };
    this.closeAssistant(stopReason, errorMessage);
  }

  #ensureAssistant(): {
    message: AssistantRecord;
    blocks: Map<string, number>;
  } {
    if (this.#assistant) return this.#assistant;
    const message = this.#newMessage();
    this.#assistant = { message, blocks: new Map() };
    this.session.emit({
      type: "message_start",
      message,
    } as unknown as AgentSessionEvent);
    return this.#assistant;
  }

  #newMessage(): AssistantRecord {
    return {
      role: "assistant",
      content: [],
      api: NATIVE_API,
      provider: this.session.runtime,
      model: this.model,
      usage: usageRecord(this.#usage),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  #text(kind: "text" | "thinking", key: string, delta: string): void {
    if (!delta) return;
    const current = this.#ensureAssistant();
    const blockKey = `${kind}:${key}`;
    this.#blockText.set(
      blockKey,
      (this.#blockText.get(blockKey) ?? "") + delta,
    );
    let index = current.blocks.get(blockKey);
    if (index === undefined) {
      index = current.message.content.length;
      current.message.content.push(
        kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "" },
      );
      current.blocks.set(blockKey, index);
      this.#emitUpdate(
        {
          type: kind === "text" ? "text_start" : "thinking_start",
          contentIndex: index,
        },
        current.message,
      );
    }
    const block = current.message.content[index];
    if (block?.type === "text") block.text += delta;
    else if (block?.type === "thinking") block.thinking += delta;
    this.#emitUpdate(
      {
        type: kind === "text" ? "text_delta" : "thinking_delta",
        contentIndex: index,
        delta,
      },
      current.message,
    );
  }

  #textDone(kind: "text" | "thinking", key: string, text?: string): void {
    const blockKey = `${kind}:${key}`;
    const seen = this.#blockText.get(blockKey) ?? "";
    let index = this.#assistant?.blocks.get(blockKey);
    if (index === undefined) {
      // A final full-text event can arrive after its message was flushed for
      // a tool. Only an unseen suffix belongs in a new assistant segment.
      const unseen = text?.startsWith(seen) ? text.slice(seen.length) : text;
      if (!unseen) return;
      if (text !== undefined && !text.startsWith(seen))
        this.#blockText.delete(blockKey);
      this.#text(kind, key, unseen);
      index = this.#assistant?.blocks.get(blockKey);
      if (index === undefined) return;
    }
    const current = this.#assistant!;
    const block = current.message.content[index];
    if (block?.type === "text" || block?.type === "thinking") {
      const content = block.type === "text" ? block.text : block.thinking;
      // Earlier portions may already be stored in a message before a tool.
      const prefixLength =
        (this.#blockText.get(blockKey)?.length ?? content.length) -
        content.length;
      const final = text !== undefined ? text.slice(prefixLength) : content;
      if (block.type === "text") block.text = final;
      else block.thinking = final;
      this.#emitUpdate(
        {
          type: kind === "text" ? "text_end" : "thinking_end",
          contentIndex: index,
          content: final,
        },
        current.message,
      );
      if (text !== undefined) this.#blockText.set(blockKey, text);
    }
    current.blocks.delete(blockKey);
  }

  #toolCall(callId: string, name: string, args: Record<string, unknown>): void {
    if (this.#tools.has(callId)) return;
    const current = this.#ensureAssistant();
    const index = current.message.content.length;
    const toolCall = {
      type: "toolCall" as const,
      id: callId,
      name,
      arguments: args,
    };
    current.message.content.push(toolCall);
    this.#tools.set(callId, { name, args, started: false, finished: false });
    this.#emitUpdate(
      { type: "toolcall_start", contentIndex: index },
      current.message,
    );
    this.#emitUpdate(
      { type: "toolcall_end", contentIndex: index, toolCall },
      current.message,
    );
  }

  #toolStarted(callId: string): void {
    const tool = this.#tools.get(callId);
    if (!tool || tool.started) return;
    this.closeAssistant("toolUse");
    tool.started = true;
    this.session.emit({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: tool.name,
      args: tool.args,
    } as AgentSessionEvent);
  }

  #toolResult(
    callId: string,
    result: NativeToolResult,
    isError: boolean,
  ): void {
    const tool = this.#tools.get(callId);
    if (!tool || tool.finished) return;
    const preflightFailure = isError ? getToolPreflightFailure(result) : undefined;
    const isolatedOperations = getIsolatedOperationReceipts(result);
    const isolatedRepairResolutions = getIsolatedRepairResolutions(result);
    const isolatedRepairPending = getIsolatedRepairPending(result);
    this.#toolStarted(callId);
    tool.finished = true;
    this.session.emit({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: tool.name,
      result,
      isError,
    } as AgentSessionEvent);
    this.session.storeMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: tool.name,
      content: result.content,
      ...(result.details !== undefined ? { details: result.details } : {}),
      ...(preflightFailure ? { preflightFailure } : {}),
      ...(isolatedOperations ? { isolatedOperations } : {}),
      ...(isolatedRepairResolutions ? { isolatedRepairResolutions } : {}),
      ...(isolatedRepairPending ? { isolatedRepairPending } : {}),
      isError,
      timestamp: Date.now(),
    });
  }

  #lastToolCallId(): string | undefined {
    return [...this.#tools].findLast(([, tool]) => !tool.finished)?.[0];
  }

  #emitUpdate(
    assistantMessageEvent: Record<string, unknown>,
    message: AssistantRecord,
  ): void {
    this.session.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { ...assistantMessageEvent, partial: message },
    } as unknown as AgentSessionEvent);
  }
}

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

interface AssistantRecord {
  role: "assistant";
  content: AssistantBlock[];
  api: string;
  provider: string;
  model: string;
  usage: ReturnType<typeof usageRecord>;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

function usageRecord(usage: NativeUsage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens:
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function latestNativeSession(
  entries: readonly SessionEntry[],
  runtime: AgentRuntimeId,
  contextVersion?: string,
): StoredNativeSession | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    // Only a completed turn anchors resumable context. A later Pi/native
    // message, compaction or model switch means that anchor is stale.
    if (
      entry?.type === "message" ||
      entry?.type === "compaction" ||
      entry?.type === "model_change"
    )
      return undefined;
    if (entry?.type !== "custom" || entry.customType !== NATIVE_SESSION_ENTRY)
      continue;
    const data = entry.data as Partial<StoredNativeSession> | undefined;
    // A later session of another agent means this agent's earlier one has not seen what came since.
    if (
      data?.version !== 2 ||
      data.state !== "ready" ||
      (contextVersion !== undefined && data.contextVersion !== contextVersion) ||
      typeof data.sessionId !== "string" ||
      !data.sessionId
    )
      return undefined;
    return data.runtime === runtime
      ? { version: 2, runtime, state: "ready", sessionId: data.sessionId, ...(typeof data.contextVersion === "string" ? { contextVersion: data.contextVersion } : {}) }
      : undefined;
  }
  return undefined;
}

async function bounded(
  work: Promise<unknown>,
  timeout: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hasMessages(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "message");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("");
}

function approvalKey(details: ApprovalRequestDetails): string {
  return JSON.stringify([
    details.kind,
    details.tool,
    details.command ?? "",
    details.path ?? "",
    details.paths ?? [],
    details.network ?? false,
  ]);
}
