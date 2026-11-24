import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  getToolPreflightFailure,
  confirmBlenderRunFailure,
  confirmIsolatedCommandFailure,
  getToolConfirmedFailure,
  inheritToolConfirmedFailure,
  inheritToolPreflightFailure,
  parseToolConfirmedFailure,
  parseToolPreflightFailure,
  toolPreflightError,
  type ToolPreflightFailure,
  type ToolConfirmedFailure,
} from "./agent-tool-errors.js";
import { getIsolatedOperationReceipts, inheritIsolatedOperationReceipts, isolatedCommandsNotSubmitted, isolatedInputBudgetError,
  isIsolatedInputBudgetError, retainedIsolatedOperationEvidence, withIsolatedOperationScope, type IsolatedOperationReceipt } from "./isolated-tool-receipts.js";
import { getIsolatedRepairResolutions, inheritIsolatedRepairProof, inheritIsolatedRepairResolutions, createIsolatedRepairPending, inheritIsolatedRepairPending, getIsolatedRepairPending, retainedIsolatedRepairPending, retainedIsolatedRepairResolutions, parseIsolatedOperationReceipts, type IsolatedRepairPending, type IsolatedRepairProof, type IsolatedRepairResolution, type IsolatedRepairTarget } from "./isolated-tool-receipts.js";
import { currentPlaytestStatus, replayPlaytestReceipt } from "./playtest-tools.js";

export interface AgentInterruption {
  kind:
    "transient" | "turn_limit" | "runtime_interrupted" | "blocked" | "unknown";
  source: "pi" | "qoder" | "codex";
  code?: string;
  phase?:
    | "start"
    | "stream"
    | "tools"
    | "result"
    | "daemon-start"
    | "query-start"
    | "session-initialize"
    | "mcp-status"
    | "response-stream";
  terminalReason?:
    | "max_turns"
    | "abort"
    | "aborted_streaming"
    | "aborted_tools"
    | "hook_stopped"
    | "runtime_interrupted"
    | "transport_lost"
    | "process_exited"
    | "control_timeout"
    | "execution_error"
    | "unknown";
  cancelOrigin?: "user" | "host" | "runtime";
  repairOnly?: true;
}

export function isRecoverableInterruption(
  value: AgentInterruption | undefined,
): boolean {
  return (
    !!value &&
    ["pi", "qoder", "codex"].includes(value.source) &&
    ["transient", "turn_limit", "runtime_interrupted"].includes(value.kind) &&
    value.cancelOrigin !== "user" &&
    value.cancelOrigin !== "host" &&
    value.terminalReason !== "hook_stopped"
  );
}

export const AUTO_CONTINUE_ENTRY = "ohmygame-auto-continue";
export const AUTO_CONTINUE_TOOL_ENTRY = "ohmygame-tool-attempt";
export const AUTO_CONTINUE_DELAYS = [5_000, 15_000, 45_000] as const;
export const AUTO_CONTINUE_PROMPT =
  "The agent stopped before completing this user task. Continue only the same unfinished task from its saved conversation and current files. Completed tool results describe earlier operations, not current file snapshots: read current state before further changes or player actions. Do not repeat completed generation, edits or other side effects. Recover existing media only by its original call or job ID; never buy a replacement automatically. Stop and explain any unknown outcome. A normal final answer ends the task; this message does not request additional work.";

type Call = Parameters<ToolDefinition["execute"]>;
export type AutoContinueToolResult = Awaited<
  ReturnType<ToolDefinition["execute"]>
>;
type Result = AutoContinueToolResult;
const SOURCE_WITHDRAWAL_DISPOSITION = "ohmygame-source-deletion-withdrawn";
export interface AutoContinueAttemptSummary {
  taskId: string;
  userEntryId?: string;
  tool: string;
  callId: string;
  state: "started" | "completed" | "failed_confirmed" | "unknown" | "not_executed" | "command_not_submitted" | "effects_recovered" | "observed" | "blocked";
  anchorId?: string;
  preflightFailure?: ToolPreflightFailure;
  confirmedFailure?: ToolConfirmedFailure;
  isolatedOperations?: readonly IsolatedOperationReceipt[];
  effectsRecovered?: readonly IsolatedRepairResolution[];
  repairResolutions?: readonly IsolatedRepairResolution[];
  pendingVerification?: Readonly<IsolatedRepairPending>;
}
type Attempt = {
  tool: string;
  call: Call;
  key?: string;
  result?: Result;
  retainedResult?: Result;
  failure?: unknown;
  preflightFailure?: ToolPreflightFailure;
  confirmedFailure?: ToolConfirmedFailure;
  isolatedOperations?: readonly IsolatedOperationReceipt[];
  commandNotSubmitted?: boolean;
  effectsRecovered?: readonly IsolatedRepairResolution[];
  deletionDisposition?: { reviewId: string; withdrawalId: string };
  repairResolutions?: readonly IsolatedRepairResolution[];
  repairMapped?: boolean;
  pendingVerification?: Readonly<IsolatedRepairPending>;
  observation?: boolean;
  publicationEpoch?: string;
  unconfirmed?: boolean;
  settled: boolean;
  anchorId?: string;
  sessionFile?: string;
  sessionIdentity?: { dev: number; ino: number };
  pending?: Promise<Result>;
};
type Task = {
  id: string;
  userId?: string;
  attempts: Map<string, Attempt>;
  continuing: boolean;
  blocked?: string;
  blockedKind?: "unknown";
  repairOnly?: boolean;
  verifyOnly?: boolean;
  needsRead?: boolean;
  publicationEpoch?: string;
  observations?: Map<string, { key: string; pending: Promise<Result> }>;
};
export interface AutoContinueToolOptions {
  sessionManager?: Pick<SessionManager, "getBranch" | "appendCustomEntry"> &
    Partial<Pick<SessionManager, "getSessionFile">>;
  assertCurrent?: () => void | Promise<void>;
  /** Return true only after durably retaining this result outside the detached branch. */
  onDetachedResult?: (
    summary: AutoContinueAttemptSummary,
    result?: Result,
  ) => boolean | void | Promise<boolean | void>;
}
export type RecoverableTool = ToolDefinition & {
  recoverAfterHttp500?: (...call: Call) => Promise<Result>;
  sourceDeletionDisposition?: (target: IsolatedRepairTarget) => Promise<{ reviewId: string; withdrawalId: string } | undefined>;
  /** A new call with identical arguments may depend on a newly saved input file. */
  canReuseResult?: (previous: Result, ...call: Call) => boolean;
};
const READ_ONLY = new Set([
  "read",
  "read_project_file",
  "read_attachment",
  "ls",
  "find",
  "grep",
  "recall_image",
  "recall_tool_text",
  "read_workflow_guide",
  "inspect_3d_views",
  "blender_status",
  "list_media_capabilities",
  "list_animation_actions",
  "canvas_check",
  "playable_check",
  "recover_media",
  "recover_canvas_media",
]);
const REPAIR_READS = new Set(["read", "read_project_file", "read_attachment", "ls", "find", "grep", "recall_image", "recall_tool_text", "read_workflow_guide", "inspect_3d_views", "blender_status", "list_media_capabilities", "list_animation_actions", "canvas_check", "playable_check"]);
const REPAIR_ACTIONS = new Set(["inspect", "capacity", "plan_capacity", "plan_first_allocation", "inspect_capacity_migration", "review", "read_image", "prepare-review", "optimize", "adopt", "recover", "verify"]);
const OBSERVATION_ACTIONS = new Set(["inspect", "capacity", "plan_capacity", "plan_first_allocation", "inspect_capacity_migration", "read_image"]);
const BLENDER_TOOLS = new Set(["run_blender", "recover_blender_run"]);

function confirmedToolFailure(tool: string, failure: ToolConfirmedFailure | undefined, receipts?: readonly IsolatedOperationReceipt[]): ToolConfirmedFailure | undefined {
  if (failure?.reason === "blender_run_failed") return BLENDER_TOOLS.has(tool) ? failure : undefined;
  if (failure?.reason !== "isolated_command_failed" || tool !== "isolated_shell") return;
  const history = parseIsolatedOperationReceipts(receipts);
  if (history && history.every(receipt => receipt.operationId === failure.operationId && receipt.mode === "shell" && receipt.phase !== "retained") &&
    ["captured", "acknowledged", "released"].every(phase => history.some(receipt => receipt.phase === phase && receipt.snapshotId && receipt.generation)))
    return failure;
}

// Request identities stay in memory. Neither arguments nor their fingerprints enter diagnostics.
function identity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identity).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${identity((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Per-user-task effect ownership shared by Pi and native tool bridges. */
export class AutoContinueTools {
  #task: Task = { id: randomUUID(), attempts: new Map(), continuing: false };
  readonly #unrecorded = new Map<Attempt, AutoContinueAttemptSummary>();
  constructor(
    private readonly tools: ToolDefinition[],
    private readonly options: AutoContinueToolOptions = {},
  ) {}

  get stopRequested(): boolean {
    return this.#task.blocked !== undefined || this.#unrecorded.size > 0;
  }

  get repairOnly(): boolean { return this.#task.repairOnly === true; }
  get repairable(): boolean {
    const task = this.#task;
    if (this.#unrecorded.size || task.blocked && task.blockedKind !== "unknown") return false;
    if ([...task.attempts.values()].some(attempt => attempt.preflightFailure?.disposition === "blocked")) return false;
    try { this.#assertBranch(task); } catch { return false; }
    const unknown = [...task.attempts.values()].filter(attempt => !attempt.observation && !attempt.result && !attempt.confirmedFailure && !attempt.preflightFailure && !attempt.commandNotSubmitted && !attempt.effectsRecovered?.length && !attempt.deletionDisposition);
    return unknown.length > 0 && unknown.every(attempt => this.#targets(task, attempt).length > 0 || this.#pendingTargets(task, attempt).length > 0);
  }

  #pendingTargets(task: Task, attempt: Attempt): IsolatedRepairTarget[] {
    const pending = attempt.pendingVerification;
    if (!task.userId || !attempt.settled || attempt.effectsRecovered?.length || attempt.result || !pending || attempt.tool !== "recover_isolated_changes" || !["adopt", "recover"].includes(String((attempt.call[1] as Record<string, unknown>).action))) return [];
    const input = attempt.call[1] as Record<string, unknown>;
    if (input.action === "adopt" && input.reviewId !== pending.reviewId || input.action === "recover" && String(input.generation) !== String(pending.generation)) return [];
    return [Object.freeze({ taskId: task.id, userEntryId: task.userId, callId: attempt.call[0], tool: attempt.tool, namespace: pending.namespace, projectId: pending.projectId,
      operationId: pending.recoveryOperationId, generation: pending.generation, rawSnapshotId: pending.rawSnapshotId, mode: "recovery" as const })];
  }

  #targets(task: Task, attempt: Attempt): IsolatedRepairTarget[] {
    if (!task.userId || !attempt.repairMapped || !attempt.settled || attempt.result || attempt.preflightFailure || attempt.commandNotSubmitted || attempt.effectsRecovered?.length || attempt.deletionDisposition || !attempt.isolatedOperations?.length) return [];
    const groups = new Map<string, IsolatedOperationReceipt[]>();
    for (const receipt of attempt.isolatedOperations) groups.set(receipt.operationId, [...groups.get(receipt.operationId) ?? [], receipt]);
    const targets: IsolatedRepairTarget[] = [];
    for (const receipts of groups.values()) {
      const captured = receipts.find(receipt => receipt.phase === "captured");
      if (!captured?.snapshotId || !captured.generation || !["shell", "build", "install"].includes(captured.mode ?? "") ||
        !receipts.some(receipt => receipt.phase === "retained") || receipts.at(-1)?.phase !== "released" ||
        receipts.some(receipt => receipt.namespace !== captured.namespace || receipt.projectId !== captured.projectId || receipt.generation !== undefined && receipt.generation !== captured.generation || receipt.snapshotId !== undefined && receipt.snapshotId !== captured.snapshotId || receipt.mode !== captured.mode)) return [];
      targets.push(Object.freeze({ taskId: task.id, userEntryId: task.userId, callId: attempt.call[0], tool: attempt.tool,
        namespace: captured.namespace, projectId: captured.projectId, operationId: captured.operationId, generation: captured.generation, rawSnapshotId: captured.snapshotId, mode: captured.mode as IsolatedRepairTarget["mode"] }));
    }
    return targets;
  }

  #repairScope(task: Task, repair: Attempt) {
    return { getTargets: () => {
      this.#assertBranch(task);
      if (this.#unrecorded.size || task.blocked && task.blockedKind !== "unknown") return Object.freeze([]);
      return Object.freeze([...task.attempts.values()].flatMap(attempt => [...this.#targets(task, attempt), ...this.#pendingTargets(task, attempt)]));
    }, settle: async (proof: Readonly<IsolatedRepairProof>) => {
      await this.#assertCurrent(task, repair.call[2]);
      if (repair.tool !== "recover_isolated_changes" || !["adopt", "recover", "verify"].includes(String((repair.call[1] as Record<string, unknown>).action))) throw new Error("Only the controlled recovery publication may settle isolated effects");
      const settled: IsolatedRepairResolution[] = [];
      for (const attempt of task.attempts.values()) {
        const targets = [...this.#targets(task, attempt), ...this.#pendingTargets(task, attempt)];
        if (!targets.length || targets.some(target => target.namespace !== proof.namespace || target.projectId !== proof.projectId || target.generation !== proof.generation || target.rawSnapshotId !== proof.rawSnapshotId ||
          (target.mode === "recovery" ? !attempt.pendingVerification || target.operationId !== proof.recoveryOperationId ||
            ["preparedBatchId", "reviewId", "preparedSnapshotId", "hostTargetFingerprint", "publicationId"].some(key => attempt.pendingVerification![key as keyof IsolatedRepairPending] !== proof[key as keyof IsolatedRepairProof])
            : !proof.originOperations.some(origin => origin.operationId === target.operationId && origin.mode === target.mode && origin.snapshotId === target.rawSnapshotId)))) continue;
        const entries = targets.map(target => Object.freeze({ ...target, version: 1 as const, repairCallId: repair.call[0], preparedBatchId: proof.preparedBatchId, reviewId: proof.reviewId, preparedSnapshotId: proof.preparedSnapshotId,
          hostTargetFingerprint: proof.hostTargetFingerprint, publicationId: proof.publicationId, recoveryOperationId: proof.recoveryOperationId, ...(proof.workspaceVersion ? { workspaceVersion: proof.workspaceVersion } : {}) }));
        const previous = attempt.effectsRecovered;
        attempt.effectsRecovered = Object.freeze(entries);
        try { await this.#record(task, attempt, "effects_recovered"); await this.#assertCurrent(task, repair.call[2]); }
        catch { attempt.effectsRecovered = previous; task.blocked = "The recovery settlement could not be safely recorded; inspect the original publication before continuing."; task.blockedKind = undefined; throw new Error(task.blocked); }
        settled.push(...entries);
      }
      if (settled.length) {
        task.repairOnly = [...task.attempts.values()].some(attempt => attempt !== repair && !attempt.observation && !attempt.result && !attempt.confirmedFailure && !attempt.preflightFailure && !attempt.commandNotSubmitted && !attempt.effectsRecovered?.length && !attempt.deletionDisposition);
        task.verifyOnly = [...task.attempts.values()].some(attempt => this.#pendingTargets(task, attempt).length > 0);
        if (!task.repairOnly && task.blockedKind === "unknown") { task.blocked = undefined; task.blockedKind = undefined; }
        task.needsRead = true;
        task.publicationEpoch = proof.publicationId;
      }
      return Object.freeze(settled);
    } };
  }

  get recoverySummary(): string | undefined {
    const summaries = [...this.#task.attempts.values()].map((attempt) =>
      this.#summary(this.#task, attempt),
    );
    summaries.push(...this.#unrecorded.values());
    if (!summaries.length) return undefined;
    return (
      (this.#task.verifyOnly ? "Verification-only continuation: use controlled reads and recover_isolated_changes inspect/capacity/verify/read_image or read-only plan_capacity/plan_first_allocation only. Never retry adopt, recover, review, optimize or the original command while its publication is unconfirmed.\n" : this.#task.repairOnly ? "Repair-only continuation: use controlled reads and recover_isolated_changes inspect/capacity/review/read_image/prepare-review/optimize/adopt/recover/verify or read-only plan_capacity/plan_first_allocation only. Do not write, generate, build, run shell commands or control the game until exact recovery settlement. Never replay the original failed command; after settlement read current project files before corrected new work.\n" : "") +
      "Original tool operations (these are historical results, not current file snapshots):\n" +
      summaries
        .slice(-100)
        .map(
          (item) =>
            item.tool +
            " — original call " +
            JSON.stringify(item.callId) +
            ": " +
            item.state +
            (item.preflightFailure
              ? " (" + item.preflightFailure.reason + ")"
              : "") + (item.confirmedFailure?.reason === "blender_run_failed" ? " — retained Blender run " + item.confirmedFailure.runId + "; process failed, no result published. Inspect its diagnostic and correct the script before a new call; the original call must not be replayed." : item.confirmedFailure?.reason === "isolated_command_failed" ? " — command exited " + item.confirmedFailure.exitCode + "; source was unchanged and cleanup confirmed. Inspect the diagnostic and correct the command under a new call; the original call must not be replayed." : "") + (item.isolatedOperations ? " — project-command receipts " + JSON.stringify(item.isolatedOperations) + ". Command submission scope only; VM startup or preview pauses may already have occurred." : "") +
            (item.pendingVerification ? " — pending publication verification " + JSON.stringify({ reviewId: item.pendingVerification.reviewId, recoveryOperationId: item.pendingVerification.recoveryOperationId, rawSnapshotId: item.pendingVerification.rawSnapshotId, preparedSnapshotId: item.pendingVerification.preparedSnapshotId, publicationId: item.pendingVerification.publicationId }) : ""),
        )
        .join("\n") +
      (summaries.length > 100
        ? "\nEarlier operations remain in the saved conversation."
        : "")
    );
  }

  /** Only a fresh, explicit user task resets the cache; automatic continuation must not reset it. */
  reset(taskId?: string): void {
    const branch = this.options.sessionManager?.getBranch() ?? [];
    const user = branch.findLast(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    let id = taskId ?? randomUUID();
    let ambiguous = false;
    if (taskId && user?.id === taskId) {
      const saved = branch.flatMap(entry => entry.type === "custom" && entry.customType === AUTO_CONTINUE_TOOL_ENTRY ? [entry.data as Partial<AutoContinueAttemptSummary> & { version?: unknown }] : [])
        .filter(item => item?.version === 1 && (item.userEntryId === taskId || item.taskId === taskId) && validId(item.taskId));
      const ids = new Set(saved.map(item => item.taskId!));
      ambiguous = ids.size > 1;
      if (ids.size === 1) id = saved[0]!.taskId!;
    }
    if (taskId && this.#task.id === id && !ambiguous) return;
    // Pi announces a fresh user message before persisting it. Bind a no-ID reset
    // at the first tool dispatch, rather than retaining the preceding user.
    const task: Task = {
      id,
      ...(taskId ? { userId: user?.id } : {}),
      attempts: new Map(),
      continuing: false,
      ...(ambiguous ? { blocked: "The original user message has multiple logical tool tasks. Review the original operations before continuing." } : {}),
    };
    this.#task = task;
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        entry.customType !== AUTO_CONTINUE_TOOL_ENTRY
      )
        continue;
      const item = entry.data as Partial<AutoContinueAttemptSummary> & {
        version?: unknown;
      };
      if (
        !item ||
        item.version !== 1 ||
        item.taskId !== id ||
        !validId(item.callId) ||
        !this.tools.some((tool) => tool.name === item.tool) ||
        ![
          "started",
          "completed",
          "failed_confirmed",
          "unknown",
          "not_executed",
          "command_not_submitted",
          "effects_recovered",
          "observed",
          "blocked",
        ].includes(String(item.state))
      )
        continue;
      const previous = task.attempts.get(item.callId);
      const currentBranch = user
        ? branch.slice(
            branch.findIndex((candidate) => candidate.id === user.id) + 1,
          )
        : [];
      const originalCalls = currentBranch.flatMap((candidate) =>
        candidate.type === "message" && candidate.message.role === "assistant"
          ? candidate.message.content.filter(
              (part) => part.type === "toolCall" && part.id === item.callId,
            )
          : [],
      );
      const original = originalCalls.at(0);
      const input =
        original?.type === "toolCall" ? original.arguments : undefined;
      const changedCall = originalCalls.some(
        (part) =>
          part.type === "toolCall" &&
          (part.name !== item.tool ||
            identity(part.arguments) !== identity(input)),
      );
      const output = currentBranch.findLast(
        (candidate) =>
          candidate.type === "message" &&
          candidate.message.role === "toolResult" &&
          candidate.message.toolCallId === item.callId &&
          candidate.message.toolName === item.tool,
      );
      const message =
        output?.type === "message" && output.message.role === "toolResult"
          ? output.message
          : undefined;
      const attempt: Attempt = previous ?? {
        tool: item.tool!,
        call: [
          item.callId,
          input,
          undefined,
          undefined,
          { sessionManager: this.options.sessionManager },
        ] as unknown as Call,
        ...(input !== undefined && !changedCall
          ? { key: item.tool + ":" + identity(input) }
          : {}),
        settled: false,
        sessionFile: this.options.sessionManager?.getSessionFile?.(),
      };
      if (item.state === "started") attempt.anchorId = entry.id;
      const wasUnknown =
        attempt.unconfirmed ||
        (attempt.settled && !attempt.result && !attempt.preflightFailure && !attempt.commandNotSubmitted);
      const firstTerminal = !attempt.settled && !attempt.unconfirmed;
      if (!wasUnknown && !changedCall && item.state === "observed" && item.tool === "recover_isolated_changes" && (input as Record<string, unknown> | undefined)?.action === "verify") attempt.observation = true;
      attempt.settled = item.state !== "started";
      attempt.preflightFailure = undefined;
      attempt.confirmedFailure = undefined;
      attempt.commandNotSubmitted = false;
      attempt.failure = undefined;
      attempt.retainedResult = undefined;
      attempt.result =
        item.state === "completed" &&
        message &&
        !message.isError &&
        !changedCall
          ? ({ content: message.content, details: message.details } as Result)
          : undefined;
      const confirmedFailure = parseToolConfirmedFailure(item.confirmedFailure);
      if (item.state === "failed_confirmed" && BLENDER_TOOLS.has(attempt.tool) &&
        original && !changedCall && message?.isError && confirmedFailure?.reason === "blender_run_failed") {
        attempt.confirmedFailure = confirmedFailure;
        attempt.unconfirmed = false;
        attempt.retainedResult = confirmBlenderRunFailure({
          content: message.content, details: message.details, isError: true,
        } as Result, confirmedFailure.runId);
      }
      const rejection = parseToolPreflightFailure(item.preflightFailure);
      const canonicalRejection = parseToolPreflightFailure(
        (message as unknown as { preflightFailure?: unknown } | undefined)
          ?.preflightFailure,
      );
      const matchingRejection =
        !message ||
        !Object.hasOwn(message, "preflightFailure") ||
        (canonicalRejection &&
          canonicalRejection.reason === rejection?.reason &&
          canonicalRejection.disposition === rejection?.disposition);
      if (
        !wasUnknown &&
        original &&
        !changedCall &&
        message?.isError &&
        rejection &&
        matchingRejection &&
        ((item.state === "not_executed" &&
          rejection.disposition === "correctable") ||
          (item.state === "blocked" && rejection.disposition === "blocked"))
      ) {
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        attempt.failure = toolPreflightError(
          text || "The original tool input was rejected before execution",
          rejection.reason,
        );
        attempt.preflightFailure = getToolPreflightFailure(attempt.failure);
        attempt.retainedResult = inheritToolPreflightFailure(
          {
            content: message.content,
            details: message.details,
            isError: true,
          } as Result,
          attempt.failure,
        );
      }
      if (item.state === "blocked")
        task.blocked = this.#blockedMessage(attempt);
      if (item.isolatedOperations) {
        const history = retainedIsolatedOperationEvidence(branch, id, item.callId, item.tool!, "history");
        attempt.isolatedOperations = getIsolatedOperationReceipts(history);
        if (firstTerminal && item.state === "unknown" && attempt.isolatedOperations) {
          const initial = parseIsolatedOperationReceipts(item.isolatedOperations);
          const ids = new Set(initial?.map(receipt => receipt.operationId));
          attempt.repairMapped = !!initial && [...ids].every(id => initial.some(receipt => receipt.operationId === id && receipt.phase === "captured" && receipt.snapshotId && receipt.generation && ["shell", "build", "install"].includes(receipt.mode ?? "")));
        }
        if (history && attempt.result) attempt.result = inheritIsolatedOperationReceipts(attempt.result, history);
        if (history && message?.isError) attempt.retainedResult = inheritIsolatedOperationReceipts({ content: message.content, details: message.details, isError: true } as Result, history);
        if (!wasUnknown && !changedCall && item.state === "failed_confirmed" && original && message?.isError &&
          confirmedFailure?.reason === "isolated_command_failed" && confirmedToolFailure(attempt.tool, confirmedFailure, attempt.isolatedOperations)) {
          attempt.confirmedFailure = confirmedFailure;
          attempt.unconfirmed = false;
          attempt.retainedResult = confirmIsolatedCommandFailure(attempt.retainedResult!, confirmedFailure.operationId, confirmedFailure.exitCode);
        }
        // A parser cannot authorize retry: the evidence loader requires the host journal and canonical failure.
        const evidence = retainedIsolatedOperationEvidence(branch, id, item.callId, item.tool!);
        const receipts = getIsolatedOperationReceipts(evidence);
        if (!wasUnknown && !changedCall && item.state === "command_not_submitted" && receipts && isolatedCommandsNotSubmitted(receipts)) {
          const text = message?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
          attempt.failure = inheritIsolatedOperationReceipts(isolatedInputBudgetError(text || "The original project command was rejected before submission"), evidence);
          attempt.isolatedOperations = receipts;
          attempt.commandNotSubmitted = true;
          attempt.retainedResult = inheritIsolatedOperationReceipts({ content: message!.content, details: message!.details, isError: true } as Result, evidence);
        }
      }
      if (
        item.state !== "started" &&
        !attempt.result &&
        !attempt.confirmedFailure && !attempt.preflightFailure && !attempt.commandNotSubmitted && !attempt.observation
      )
        attempt.unconfirmed = true;
      task.attempts.set(item.callId, attempt);
    }
    if (task.userId && !ambiguous && this.tools.some(tool => tool.name === "game_use")) {
      const observations = new Map<string, string>();
      const currentBranch = branch.slice(branch.findIndex(entry => entry.id === task.userId) + 1);
      for (const entry of currentBranch) {
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (message.role === "assistant") {
          for (const part of message.content) {
            if (part.type !== "toolCall" || part.name !== "game_use" || !validId(part.id) || observations.has(part.id)) continue;
            if (part.arguments.operation === "inspect" || part.arguments.operation === "capture") observations.set(part.id, "game_use:" + identity(part.arguments));
          }
        } else if (message.role === "toolResult" && message.toolName === "game_use" && observations.has(message.toolCallId)) {
          task.observations ??= new Map();
          const id = message.toolCallId;
          if (!task.observations.has(id)) task.observations.set(id, { key: observations.get(id)!, pending: Promise.resolve({
            content: message.content, details: message.details, ...(message.isError ? { isError: true } : {}),
          }) });
        }
      }
    }
    let publication: { id: string; index: number } | undefined;
    for (const attempt of task.attempts.values()) {
      attempt.pendingVerification = retainedIsolatedRepairPending(branch, task.id, attempt.call[0], attempt.tool);
      if (attempt.pendingVerification) {
        const original = branch.findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === attempt.call[0] && entry.message.toolName === attempt.tool);
        if (original?.type === "message" && original.message.role === "toolResult") {
          const token = createIsolatedRepairPending(attempt.pendingVerification);
          attempt.failure = inheritIsolatedRepairPending(new Error(original.message.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "The original recovery publication awaits verification"), token);
          attempt.retainedResult = inheritIsolatedRepairPending({ content: original.message.content, details: original.message.details, isError: true } as Result, token);
        }
      }
      const settled = retainedIsolatedRepairResolutions(branch, task.id, attempt.call[0], attempt.tool);
      if (!settled?.length) continue;
      attempt.effectsRecovered = settled; attempt.unconfirmed = false;
      for (const resolution of settled) {
        const index = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === AUTO_CONTINUE_TOOL_ENTRY &&
          (entry.data as AutoContinueAttemptSummary).taskId === task.id && (entry.data as AutoContinueAttemptSummary).callId === resolution.repairCallId && (entry.data as AutoContinueAttemptSummary).state === "completed");
        if (index >= 0 && (!publication || index > publication.index)) publication = { id: resolution.publicationId, index };
      }
      const original = branch.findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === attempt.call[0] && entry.message.toolName === attempt.tool);
      if (original?.type === "message" && original.message.role === "toolResult") {
        attempt.failure = new Error(original.message.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "The original command failed; its effects were recovered separately");
        attempt.retainedResult = { content: original.message.content, details: original.message.details, isError: true } as Result;
      }
      task.needsRead = true;
    }
    if (publication) {
      task.publicationEpoch = publication.id;
      for (const attempt of task.attempts.values()) {
        const index = branch.findIndex(entry => entry.type === "custom" && entry.customType === AUTO_CONTINUE_TOOL_ENTRY &&
          (entry.data as AutoContinueAttemptSummary).taskId === task.id && (entry.data as AutoContinueAttemptSummary).callId === attempt.call[0] && (entry.data as AutoContinueAttemptSummary).state === "started");
        if (index > publication.index) attempt.publicationEpoch = publication.id;
      }
    }
  }

  wrap(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      ...tool,
      execute: async (...call: Call) => {
        const task = this.#task;
        await this.#assertCurrent(task, call[2]);
        if (!validId(call[0])) throw new Error("Invalid original tool call ID");
        const input = call[1] as Record<string, unknown>;
        const playtest = tool.name === "game_use";
        const playtestObservation = playtest && (input.operation === "inspect" || input.operation === "capture");
        const repairAction = tool.name === "recover_isolated_changes" && REPAIR_ACTIONS.has(String(input.action));
        const inspection = tool.name === "recover_isolated_changes" && OBSERVATION_ACTIONS.has(String(input.action));
        const verification = tool.name === "recover_isolated_changes" && input.action === "verify";
        const observed = task.observations?.get(call[0]);
        const sameId = task.attempts.get(call[0]);
        const key = tool.name + ":" + identity(input);
        if ((observed && observed.key !== key) || (sameId && (playtest || sameId.tool === "game_use") && sameId.key !== key)) {
          const conflict = playtest || sameId?.tool === "game_use" || observed?.key.startsWith("game_use:");
          throw new Error(`${conflict ? "CALL_ID_CONFLICT: " : ""}A tool call ID was reused with different arguments`);
        }
        if (task.verifyOnly && !REPAIR_READS.has(tool.name) && !inspection && !verification && !task.attempts.has(call[0]))
          throw new Error("Only controlled reads, inspect, capacity, read_image and verify are allowed while the original recovery publication awaits verification");
        if (task.repairOnly && !REPAIR_READS.has(tool.name) && !repairAction && !task.attempts.has(call[0]))
          throw new Error("Only controlled reads and retained-change repair actions are allowed until the original isolated effects are settled");
        if (
          READ_ONLY.has(tool.name) || inspection ||
          playtestObservation
        ) {
          const readEpoch = task.publicationEpoch;
          let result: Result;
          try {
            if (playtestObservation) {
              if (observed) {
                const previous = await observed.pending;
                result = await replayPlaytestReceipt(tool, call[0], input, previous, (previous as Result & { isError?: boolean }).isError === true, call[2]);
              }
              else {
                task.observations ??= new Map();
                const pending = tool.execute(...call);
                task.observations.set(call[0], { key, pending });
                result = await pending;
              }
            } else if (inspection) {
              task.observations ??= new Map();
              const previous = task.observations.get(call[0]);
              const attempted = task.attempts.get(call[0]);
              if (previous && previous.key !== key || attempted && attempted.key !== key) throw new Error("A tool call ID was reused with different arguments");
              if (!previous) task.observations.set(call[0], { key, pending: withIsolatedOperationScope(async () => { throw new Error("A read-only recovery observation cannot submit project commands"); },
                () => tool.execute(...call), { getTargets: () => this.#repairScope(task, { tool: tool.name, call, settled: false }).getTargets(), settle: async () => { throw new Error("Read-only observations cannot settle isolated effects"); } }) });
              result = await task.observations.get(call[0])!.pending;
            } else result = await tool.execute(...call);
          } catch (cause) {
            if (getToolPreflightFailure(cause))
              await this.#readRejection(task, tool, call, cause);
            throw cause;
          }
          if (
            (result as Result & { isError?: boolean }).isError &&
            getToolPreflightFailure(result)
          )
            await this.#readRejection(task, tool, call, result);
          await this.#assertCurrent(task, call[2]);
          if (readEpoch === task.publicationEpoch && ["read", "read_project_file"].includes(tool.name) && typeof input.path === "string" && !input.path.startsWith("attachment:") && !(result as Result & { isError?: boolean }).isError) task.needsRead = false;
          return result;
        }
        const reusable = (attempt: Attempt) => attempt.key === key && attempt.result &&
          !(playtest && (input.operation === "open" || input.operation === "act" || input.operation === "close")) &&
          !(task.publicationEpoch && attempt.publicationEpoch !== task.publicationEpoch && tool.name === "build_game") &&
          ((tool as RecoverableTool).canReuseResult?.(attempt.result, ...call) ?? true);
        if (sameId) {
          if (sameId.key !== key)
            throw new Error(
              "A tool call ID was reused with different arguments",
            );
          if (sameId.pending && !playtest) return sameId.pending;
          if (sameId.pending) await sameId.pending.catch(() => {});
          return this.#reuse(task, sameId, call[2]);
        }
        if ((task.blocked || this.#unrecorded.size) && !(task.repairOnly && task.blockedKind === "unknown" && repairAction && !this.#unrecorded.size))
          throw new Error(
            task.blocked ??
              "A late tool result could not be recorded. Review the original operation before continuing.",
          );
        const recovered = [...task.attempts.values()].find(previous => previous.key === key && (previous.effectsRecovered?.length || previous.deletionDisposition));
        if (recovered) throw new Error("The original failed command has recovered effects. Do not replay it under a new call ID; inspect current files and correct the requested operation");
        if (task.needsRead && !repairAction) throw new Error("Read the current project files after the controlled recovery publication before making another change");
        if (task.continuing && !repairAction) {
          const previous = [...task.attempts.values()].findLast(reusable);
          if (previous?.result)
            return originalResult(previous.result, previous);
          // Native Code Mode can dispatch several independent effects at once.
          // An in-flight effect is not a failed outcome: wait, then recheck before
          // letting the next new effect run under the same continuation owner.
          let waited = false;
          for (;;) {
            const pending = [...task.attempts.values()].flatMap((attempt) =>
              attempt.pending ? [attempt.pending] : [],
            );
            if (!pending.length) break;
            waited = true;
            await waitForEffects(pending, call[2]);
            await this.#assertCurrent(task, call[2]);
            if (task.blocked || this.#unrecorded.size) this.assertSafe();
          }
          if (waited) {
            const known = task.attempts.get(call[0]);
            if (known && known.key !== key)
              throw new Error(
                `${playtest || known.tool === "game_use" ? "CALL_ID_CONFLICT: " : ""}A tool call ID was reused with different arguments`,
              );
            if (known) return this.#reuse(task, known, call[2]);
            const completed = [...task.attempts.values()].findLast(reusable);
            if (completed?.result)
              return originalResult(completed.result, completed);
          }
        }
        const unknown = [...task.attempts.values()].find(
          (attempt) =>
            !attempt.result &&
            !attempt.confirmedFailure &&
            !attempt.observation && attempt.preflightFailure?.disposition !== "correctable" && !attempt.commandNotSubmitted && !attempt.effectsRecovered?.length && !attempt.deletionDisposition,
        );
        if (task.continuing && unknown && !(task.repairOnly && repairAction)) throw this.#stop(task, unknown);
        if (playtest) {
          const previous = [...task.attempts.values()].filter(attempt => attempt.tool === "game_use" && attempt.settled && !attempt.result && !attempt.preflightFailure && !attempt.confirmedFailure);
          if (previous.length) {
            const sessionId = input.operation !== "open" && typeof input.sessionId === "string" ? input.sessionId : undefined;
            const related = previous.find(attempt => {
              const original = attempt.call[1] as Record<string, unknown> | undefined;
              return original?.operation === "open" || typeof original?.sessionId !== "string" || original.sessionId === sessionId;
            });
            if (!sessionId || related || await currentPlaytestStatus(tool, sessionId, call[2]) !== "live") throw this.#stop(task, related ?? previous[0]!);
            await this.#assertCurrent(task, call[2]);
            if (task.blocked || this.#unrecorded.size) this.assertSafe();
            if (task.observations?.has(call[0])) throw new Error("CALL_ID_CONFLICT: A tool call ID was reused with different arguments");
            const known = task.attempts.get(call[0]);
            if (known) {
              if (known.key !== key) throw new Error("CALL_ID_CONFLICT: A tool call ID was reused with different arguments");
              if (known.pending) await known.pending.catch(() => {});
              return this.#reuse(task, known, call[2]);
            }
          }
        }
        if (task.continuing && paidTool(tool.name)) {
          task.blocked =
            "Automatic continuation stopped: a new media request cannot be proven to be the original operation. Recover the original call or job; no replacement was submitted.";
          throw new Error(task.blocked);
        }
        const attempt: Attempt = {
          tool: tool.name,
          call,
          key,
          settled: false,
          ...(task.publicationEpoch ? { publicationEpoch: task.publicationEpoch } : {}),
          ...(verification ? { observation: true } : {}),
          sessionFile: this.options.sessionManager?.getSessionFile?.(),
        };
        task.attempts.set(call[0], attempt);
        attempt.pending = this.#execute(task, attempt, tool);
        return attempt.pending;
      },
    }));
  }

  async #execute(
    task: Task,
    attempt: Attempt,
    tool: ToolDefinition,
  ): Promise<Result> {
    try {
      await this.#record(task, attempt, "started");
    } catch {
      task.attempts.delete(attempt.call[0]);
      throw new Error(
        "Could not record the tool attempt; no operation was started",
      );
    }
    let result: Result | undefined, failure: unknown;
    try {
      await this.#assertCurrent(task, attempt.call[2]);
      result = await withIsolatedOperationScope(async (receipts, late) => {
        if (attempt.observation) { task.blocked = "A read-only recovery verification attempted a new isolated operation"; task.blockedKind = undefined; throw new Error(task.blocked); }
        attempt.isolatedOperations = receipts;
        if (late) {
          // A ready preview is a completed tool result even while its process remains alive.
          // Cleanup belongs to this original task and must never cancel a later task.
          try { await this.#record(task, attempt, this.#summary(task, attempt).state, false, attempt.retainedResult); }
          catch {
            await retainDetachedResult(attempt.sessionFile, attempt.sessionIdentity, this.#summary(task, attempt), attempt.retainedResult);
          }
          return;
        }
        let changed: unknown;
        try { await this.#assertCurrent(task, attempt.call[2]); } catch (cause) { changed = cause; }
        try { await this.#record(task, attempt, changed ? "unknown" : this.#summary(task, attempt).state, !!changed, attempt.retainedResult); }
        catch {
          task.blocked = "The isolated command receipt could not be safely recorded; review the original operation before continuing.";
          this.#unrecorded.set(attempt, this.#summary(task, attempt));
          throw new Error(task.blocked);
        }
        if (changed) throw changed;
      }, async () => {
        const output = await tool.execute(...attempt.call);
        // Each attempt needs its own evidence identity even if a handler returns a shared object.
        if (!attempt.isolatedOperations?.length) return output;
        const clone = inheritToolPreflightFailure({ ...output, content: [...output.content] }, output);
        inheritIsolatedRepairResolutions(clone, output);
        inheritIsolatedRepairProof(clone, output);
        return inheritIsolatedRepairPending(clone, output);
      }, this.#repairScope(task, attempt));
      attempt.retainedResult = result;
      if (!(result as Result & { isError?: boolean }).isError)
        attempt.result = result;
    } catch (cause) {
      failure = cause;
    }
    attempt.failure = failure;
    attempt.pendingVerification = getIsolatedRepairPending(failure) ?? getIsolatedRepairPending(result);
    const isolated = getIsolatedOperationReceipts(failure) ?? getIsolatedOperationReceipts(result);
    if (isolated) attempt.isolatedOperations = isolated;
    attempt.confirmedFailure = confirmedToolFailure(attempt.tool,
      failure !== undefined ? getToolConfirmedFailure(failure) :
        (result as (Result & { isError?: boolean }) | undefined)?.isError ? getToolConfirmedFailure(result) : undefined,
      attempt.isolatedOperations);
    if (attempt.confirmedFailure && failure !== undefined)
      attempt.retainedResult = inheritToolConfirmedFailure(inheritIsolatedOperationReceipts({ content: [{ type: "text", text: failure instanceof Error ? failure.message : "The original command failed without source changes" }], details: {}, isError: true } as Result, failure), failure);
    attempt.repairMapped = !!isolated;
    attempt.repairResolutions = getIsolatedRepairResolutions(result) ?? getIsolatedRepairResolutions(failure);
    attempt.commandNotSubmitted = isIsolatedInputBudgetError(failure) && isolatedCommandsNotSubmitted(isolated);
    const rejection =
      !attempt.isolatedOperations?.length ? getToolPreflightFailure(failure) ??
      ((result as (Result & { isError?: boolean }) | undefined)?.isError
        ? getToolPreflightFailure(result)
        : undefined) : undefined;
    if (rejection) {
      attempt.preflightFailure = rejection;
      attempt.retainedResult ??= inheritToolPreflightFailure(
        {
          content: [
            {
              type: "text",
              text:
                failure instanceof Error
                  ? failure.message
                  : "The tool input was rejected before execution",
            },
          ],
          details: {},
          isError: true,
        } as Result,
        failure,
      );
      if (rejection.disposition === "blocked")
        { task.blocked = this.#blockedMessage(attempt); task.blockedKind = undefined; }
    }
    if (attempt.commandNotSubmitted) attempt.retainedResult ??= inheritIsolatedOperationReceipts({ content: [{ type: "text", text: failure instanceof Error ? failure.message : "The project command was rejected before submission" }], details: {}, isError: true } as Result, failure);
    attempt.settled = true;
    let ownershipFailure: unknown;
    try {
      await this.#assertCurrent(task, attempt.call[2]);
    } catch (cause) {
      ownershipFailure = cause;
    }
    try {
      await this.#record(
        task,
        attempt,
        this.#summary(task, attempt).state,
        !!ownershipFailure,
        attempt.retainedResult,
      );
    } catch {
      attempt.result = undefined;
      attempt.confirmedFailure = undefined;
      attempt.preflightFailure = undefined;
      attempt.commandNotSubmitted = false;
      task.blocked =
        "The original tool outcome could not be safely recorded. Review its retained result; do not repeat the operation.";
      this.#unrecorded.set(attempt, this.#summary(task, attempt));
      throw new Error(task.blocked);
    } finally {
      attempt.pending = undefined;
    }
    if (!attempt.observation && !attempt.result && !attempt.confirmedFailure && !attempt.preflightFailure && !attempt.commandNotSubmitted && task.continuing)
      { task.blocked = this.#unknownMessage(attempt); task.blockedKind = "unknown"; }
    if (!attempt.observation && !attempt.result && !attempt.confirmedFailure && !attempt.preflightFailure && !attempt.commandNotSubmitted && (attempt.isolatedOperations?.length || attempt.pendingVerification)) {
      if (this.repairable) { task.repairOnly = true; task.verifyOnly = [...task.attempts.values()].some(attempt => this.#pendingTargets(task, attempt).length > 0); }
      else { task.blocked = this.#unknownMessage(attempt); task.blockedKind = "unknown"; }
    }
    if (ownershipFailure) throw ownershipFailure;
    if (failure !== undefined) throw failure;
    return result!;
  }

  async #readRejection(
    task: Task,
    tool: ToolDefinition,
    call: Call,
    failure: unknown,
  ): Promise<void> {
    await this.#assertCurrent(task, call[2]);
    const rejection = getToolPreflightFailure(failure)!;
    const attempt: Attempt = {
      tool: tool.name,
      call,
      key: tool.name + ":" + identity(call[1]),
      settled: true,
      preflightFailure: rejection,
      ...(failure instanceof Error
        ? { failure }
        : { retainedResult: failure as Result }),
      sessionFile: this.options.sessionManager?.getSessionFile?.(),
    };
    task.attempts.set(call[0], attempt);
    if (rejection.disposition === "blocked")
      task.blocked = this.#blockedMessage(attempt);
    try {
      await this.#record(task, attempt, this.#summary(task, attempt).state);
    } catch {
      attempt.preflightFailure = undefined;
      task.blocked =
        "The rejected tool outcome could not be safely recorded. Automatic continuation is unavailable.";
      this.#unrecorded.set(attempt, this.#summary(task, attempt));
      throw new Error(task.blocked);
    }
  }

  #reuse(task: Task, attempt: Attempt, signal?: AbortSignal): Result | Promise<Result> {
    if (attempt.deletionDisposition) return {
      content: [{ type: "text", text: "The retained source deletion was withdrawn and the isolated baseline was restored. The original command was not run again. Read the current project files before editing." }],
      details: { sourceDeletionDisposition: attempt.deletionDisposition }, isError: true,
    } as Result;
    const tool = attempt.tool === "game_use" ? this.tools.find(item => item.name === attempt.tool) : undefined;
    if (attempt.result) {
      if (tool) return replayPlaytestReceipt(tool, attempt.call[0], attempt.call[1] as Record<string, unknown>, attempt.result, false, signal);
      return originalResult(attempt.result, attempt);
    }
    if (tool) {
      const failure = attempt.preflightFailure ? attempt.failure : this.#stop(task, attempt);
      const retained = attempt.retainedResult ?? { content: [{ type: "text" as const, text: String(failure) }], details: {} };
      const result = inheritToolPreflightFailure({ ...retained, isError: true }, failure ?? retained);
      return replayPlaytestReceipt(tool, attempt.call[0], attempt.call[1] as Record<string, unknown>, result, true, signal);
    }
    if (attempt.confirmedFailure || attempt.preflightFailure || attempt.commandNotSubmitted || attempt.effectsRecovered?.length || attempt.observation || this.#targets(task, attempt).length || this.#pendingTargets(task, attempt).length) {
      if (attempt.failure !== undefined) throw attempt.failure;
      if (attempt.retainedResult)
        return inheritToolConfirmedFailure(inheritIsolatedRepairPending(inheritIsolatedRepairResolutions(inheritIsolatedOperationReceipts(inheritToolPreflightFailure(
          {
            ...attempt.retainedResult,
            content: [...attempt.retainedResult.content],
          },
          attempt.retainedResult,
        ), attempt.retainedResult), attempt.retainedResult), attempt.retainedResult), attempt.retainedResult);
    }
    throw this.#stop(task, attempt);
  }

  #reconcileLegacyRecoveryRefusals(task: Task, target: IsolatedRepairTarget, reviewId: string): void {
    const journal = this.options.sessionManager;
    if (!journal || !task.userId) return;
    const branch = journal.getBranch();
    const origin = branch.findIndex(entry => entry.id === task.userId);
    if (origin < 0) return;
    const calls = new Map<string, Record<string, unknown>>();
    let inspected: Record<string, unknown> | undefined, reviewed: Record<string, unknown> | undefined;
    for (const entry of branch.slice(origin + 1)) {
      if (entry.type !== "message") continue;
      const { message } = entry;
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall" && part.name === "recover_isolated_changes" && !calls.has(part.id)) calls.set(part.id, part.arguments);
        continue;
      }
      if (message.role !== "toolResult" || message.toolName !== "recover_isolated_changes") continue;
      const input = calls.get(message.toolCallId);
      if (!input) continue;
      if (!message.isError) {
        const detail = message.details as Record<string, unknown> | undefined;
        if (input.action === "inspect") inspected = detail;
        if (input.action === "review") reviewed = detail;
        continue;
      }
      const attempt = task.attempts.get(message.toolCallId);
      if (!attempt?.settled || !attempt.unconfirmed || attempt.result || attempt.preflightFailure || attempt.isolatedOperations?.length || attempt.pendingVerification ||
        attempt.key !== "recover_isolated_changes:" + identity(input)) continue;
      const refusal = message.content.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : undefined;
      const adopt = input.action === "adopt" && input.reviewId === reviewId;
      const recover = input.action === "recover" && input.generation === String(target.generation);
      const invalidField = (adopt || recover) && ["path", "variant", "sha256"].some(key => input[key] !== undefined) &&
        refusal === "path, variant and sha256 are valid only for read_image";
      const blockedReview = adopt && reviewed?.reviewId === reviewId && reviewed.projectId === target.projectId &&
        reviewed.rawSnapshotId === target.rawSnapshotId && Array.isArray(reviewed.blockers) && reviewed.blockers.length > 0 &&
        refusal === "This review has blocked files; preserve every version and resolve the listed risks before adoption";
      const refusedRecovery = recover && inspected?.projectId === target.projectId && inspected?.generation === input.generation && inspected.dirty === true && inspected.recoverable === false &&
        refusal === "This inspected generation is not eligible for recovery. Keep both versions. Do not repeat inspect/recover or regenerate to clear the blocker. " +
          (inspected.reason ?? "Review the listed blocked paths in Execution storage & recovery.");
      if (!invalidField && !blockedReview && !refusedRecovery) continue;
      const disposition = { taskId: task.id, userEntryId: task.userId, callId: message.toolCallId, reviewId, reason: invalidField ? "invalid-input" : blockedReview ? "blocked-review" : "recovery-ineligible" };
      const type = "ohmygame-source-recovery-not-started";
      if (!journal.getBranch().some(candidate => candidate.type === "custom" && candidate.customType === type && identity(candidate.data) === identity(disposition)))
        journal.appendCustomEntry(type, disposition);
      attempt.failure = toolPreflightError("The original recovery was refused before submission. Its reviewed deletion has been withdrawn.", "invalid_recovery_input");
      attempt.preflightFailure = getToolPreflightFailure(attempt.failure);
      attempt.unconfirmed = false;
    }
  }

  /** Query only the exact original calls; no recovery hook can authorize a replacement. */
  async prepare(
    signal: AbortSignal,
    onRecovered?: (
      result: Result,
      tool: string,
      callId: string,
    ) => Promise<void>,
  ): Promise<void> {
    const task = this.#task;
    await this.#assertCurrent(task, signal);
    for (const attempt of task.attempts.values()) {
      if (attempt.tool !== "isolated_shell" || !attempt.key) continue;
      const targets = this.#targets(task, attempt);
      if (targets.length !== 1) continue;
      const tool = this.tools.find(item => item.name === attempt.tool) as RecoverableTool | undefined;
      const disposition = await tool?.sourceDeletionDisposition?.(targets[0]!);
      if (!disposition) continue;
      await this.#assertCurrent(task, signal);
      const journal = this.options.sessionManager;
      const entry = { ...targets[0]!, ...disposition };
      if (journal && !journal.getBranch().some(item => item.type === "custom" && item.customType === SOURCE_WITHDRAWAL_DISPOSITION && identity(item.data) === identity(entry)))
        journal.appendCustomEntry(SOURCE_WITHDRAWAL_DISPOSITION, entry);
      attempt.deletionDisposition = disposition;
      this.#reconcileLegacyRecoveryRefusals(task, targets[0]!, disposition.reviewId);
      task.needsRead = true;
    }
    if (task.repairOnly && [...task.attempts.values()].some(attempt => attempt.deletionDisposition)) {
      task.repairOnly = this.repairable;
      if (!task.repairOnly) task.verifyOnly = false;
    }
    if (this.repairable) { task.repairOnly = true; task.verifyOnly = [...task.attempts.values()].some(attempt => this.#pendingTargets(task, attempt).length > 0); task.continuing = true; return; }
    // An unknown local outcome may now have a retained terminal receipt. Only
    // the original tool's recovery hook can resolve it; execution is never retried.
    if (task.blockedKind !== "unknown" || this.#unrecorded.size) this.assertSafe();
    for (const attempt of task.attempts.values()) {
      if (attempt.result) continue;
      if (attempt.confirmedFailure) continue;
      if (attempt.observation) continue;
      if (attempt.preflightFailure?.disposition === "correctable") continue;
      if (attempt.commandNotSubmitted) continue;
      if (attempt.effectsRecovered?.length || attempt.deletionDisposition) continue;
      if (attempt.preflightFailure?.disposition === "blocked")
        throw this.#stop(task, attempt);
      const source = this.tools.find((tool) => tool.name === attempt.tool) as
        RecoverableTool | undefined;
      const saved = source?.recoverAfterHttp500;
      const recover = this.tools.find((tool) => tool.name === "recover_media");
      if (
        !attempt.settled ||
        !attempt.key ||
        (!saved &&
          (!paidTool(attempt.tool) ||
            attempt.tool === "generate_canvas_media" ||
            !recover))
      )
        throw this.#stop(task, attempt);
      let result: Result;
      try {
        await this.#pinSession(attempt);
        await this.#assertCurrent(task, signal);
        result = saved
          ? await saved(
              attempt.call[0],
              attempt.call[1],
              signal,
              undefined,
              attempt.call[4],
            )
          : await recover!.execute(
              "auto-recover-" + attempt.call[0],
              {
                tool: attempt.tool,
                recoverCallId: attempt.call[0],
                originalArguments: attempt.call[1],
              },
              signal,
              undefined,
              attempt.call[4],
            );
        if ((result as Result & { isError?: boolean }).isError &&
          !(BLENDER_TOOLS.has(attempt.tool) && getToolConfirmedFailure(result)))
          throw new Error("Recovery did not confirm the original result");
      } catch {
        await this.#assertCurrent(task, signal);
        throw this.#stop(task, attempt);
      }
      attempt.confirmedFailure = BLENDER_TOOLS.has(attempt.tool) &&
        (result as Result & { isError?: boolean }).isError ? getToolConfirmedFailure(result) : undefined;
      attempt.result = attempt.confirmedFailure ? undefined : result;
      attempt.failure = undefined;
      attempt.unconfirmed = false;
      attempt.retainedResult = result;
      try {
        await this.#assertCurrent(task, signal);
      } catch (cause) {
        try {
          await this.#record(task, attempt, this.#summary(task, attempt).state, true, result);
        } catch {
          attempt.result = undefined;
          attempt.confirmedFailure = undefined;
          this.#unrecorded.set(attempt, this.#summary(task, attempt));
        }
        throw cause;
      }
      try {
        await onRecovered?.(result, attempt.tool, attempt.call[0]);
        await this.#assertCurrent(task, signal);
        await this.#record(task, attempt, this.#summary(task, attempt).state);
      } catch {
        task.blocked =
          "The recovered original result could not be recorded for this task; no replacement was submitted.";
        task.blockedKind = undefined;
        throw new Error(task.blocked);
      }
    }
    await this.#assertCurrent(task, signal);
    if (task.blockedKind === "unknown") { task.blocked = undefined; task.blockedKind = undefined; }
    task.continuing = true;
  }

  assertSafe(): void {
    if (this.#task.repairOnly && this.repairable) return;
    if (this.#task.blocked || this.#unrecorded.size)
      throw new Error(
        this.#task.blocked ??
          "A late tool result is unrecorded; automatic continuation is unavailable.",
      );
  }

  #summary(task: Task, attempt: Attempt): AutoContinueAttemptSummary {
    return {
      taskId: task.id,
      ...(task.userId ? { userEntryId: task.userId } : {}),
      tool: attempt.tool,
      callId: attempt.call[0],
      state: attempt.result
        ? "completed"
        : attempt.confirmedFailure ? "failed_confirmed"
        : attempt.observation ? "observed"
        : attempt.effectsRecovered?.length ? "effects_recovered"
        : attempt.preflightFailure
          ? attempt.preflightFailure.disposition === "correctable"
            ? "not_executed"
            : "blocked"
          : attempt.settled
            ? attempt.commandNotSubmitted ? "command_not_submitted" : "unknown"
            : "started",
      ...(attempt.anchorId ? { anchorId: attempt.anchorId } : {}),
      ...(attempt.preflightFailure
        ? { preflightFailure: attempt.preflightFailure }
        : {}),
      ...(attempt.confirmedFailure ? { confirmedFailure: attempt.confirmedFailure } : {}),
      ...(attempt.isolatedOperations ? { isolatedOperations: attempt.isolatedOperations } : {}),
      ...(attempt.effectsRecovered?.length ? { effectsRecovered: attempt.effectsRecovered } : {}),
      ...(attempt.repairResolutions?.length ? { repairResolutions: attempt.repairResolutions } : {}),
      ...(attempt.pendingVerification ? { pendingVerification: attempt.pendingVerification } : {}),
    };
  }
  #unknownMessage(attempt: Attempt): string {
    return (
      "Automatic continuation stopped: the outcome of " +
      attempt.tool +
      " (" +
      attempt.call[0] +
      ") is unconfirmed. Recover or review the original operation and retained changes; no replacement was submitted."
    );
  }
  #blockedMessage(attempt: Attempt): string {
    return (
      "Automatic continuation stopped: " +
      attempt.tool +
      " (" +
      attempt.call[0] +
      ") was rejected by a protected tool boundary. Review the original rejection before continuing."
    );
  }
  #stop(task: Task, attempt: Attempt): Error {
    task.blocked =
      attempt.preflightFailure?.disposition === "blocked"
        ? this.#blockedMessage(attempt)
        : this.#unknownMessage(attempt);
    task.blockedKind = attempt.preflightFailure?.disposition === "blocked" ? undefined : "unknown";
    return inheritIsolatedOperationReceipts(new Error(task.blocked), attempt.failure ?? attempt.retainedResult);
  }

  async #assertCurrent(task: Task, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#assertBranch(task);
    await this.options.assertCurrent?.();
    signal?.throwIfAborted();
    this.#assertBranch(task);
  }
  #assertBranch(task: Task): void {
    if (task !== this.#task)
      throw new Error(
        "The user task changed; the old continuation was stopped",
      );
    const manager = this.options.sessionManager;
    if (!manager) return;
    const branch = manager.getBranch();
    const user = branch.findLast(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    task.userId ??= user?.id;
    if (!task.userId || user?.id !== task.userId)
      throw new Error(
        "The conversation branch changed; automatic continuation was stopped",
      );
    if (
      [...task.attempts.values()].some(
        (attempt) =>
          attempt.anchorId &&
          !branch.some((entry) => entry.id === attempt.anchorId),
      )
    )
      throw new Error(
        "The original tool branch changed; automatic continuation was stopped",
      );
  }

  async #record(
    task: Task,
    attempt: Attempt,
    state: AutoContinueAttemptSummary["state"],
    late = false,
    result?: Result,
  ): Promise<void> {
    const manager = this.options.sessionManager;
    if (!manager) return;
    const record = { version: 1, ...this.#summary(task, attempt), state };
    const attached =
      !attempt.anchorId ||
      manager.getBranch().some((entry) => entry.id === attempt.anchorId);
    if (attached) {
      const anchor = manager.appendCustomEntry(
        AUTO_CONTINUE_TOOL_ENTRY,
        record,
      );
      if (state === "started") {
        attempt.anchorId = anchor;
        await this.#pinSession(attempt);
      }
    }
    if (!attached || (late && result)) {
      const summary = {
        ...record,
        ...(attempt.anchorId ? { anchorId: attempt.anchorId } : {}),
      };
      if ((await this.options.onDetachedResult?.(summary, result)) !== true)
        await retainDetachedResult(
          attempt.sessionFile,
          attempt.sessionIdentity,
          summary,
          result,
        );
    }
  }

  async #pinSession(attempt: Attempt): Promise<void> {
    if (!attempt.sessionFile || attempt.sessionIdentity) return;
    const original = await lstat(attempt.sessionFile);
    if (!original.isFile() || original.nlink !== 1)
      throw new Error("Invalid original session file");
    const canonical = await realpath(attempt.sessionFile),
      pinned = await lstat(canonical);
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1 ||
      pinned.dev !== original.dev ||
      pinned.ino !== original.ino
    )
      throw new Error("The original session changed");
    attempt.sessionFile = canonical;
    attempt.sessionIdentity = { dev: pinned.dev, ino: pinned.ino };
  }
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function paidTool(name: string): boolean {
  return (
    /^(?:generate_|animate_)/.test(name) || name === "replace_canvas_media"
  );
}
function originalResult(result: Result, attempt: Attempt): Result {
  return inheritIsolatedOperationReceipts(inheritToolPreflightFailure(
    {
      ...result,
      content: [
        {
          type: "text",
          text:
            "Original completed result of " +
            attempt.tool +
            " (" +
            attempt.call[0] +
            "), reused without executing it again. This is not a current file snapshot; read current state before changing it.",
        },
        ...result.content,
      ],
    },
    result,
  ), result);
}

async function waitForEffects(
  effects: Promise<Result>[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => {
      signal?.removeEventListener("abort", cancelled);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", cancelled, { once: true });
    void Promise.allSettled(effects).then(() => {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    });
  });
}

/** No mkdir or branch navigation: a deleted project must never be silently recreated. */
async function retainDetachedResult(
  sessionFile: string | undefined,
  sessionIdentity: Attempt["sessionIdentity"],
  summary: AutoContinueAttemptSummary,
  result?: Result,
): Promise<void> {
  if (!sessionFile || !path.isAbsolute(sessionFile))
    throw new Error("The original session has no durable result location");
  const directory = path.dirname(sessionFile);
  const entry = await lstat(sessionFile);
  if (
    !entry.isFile() ||
    entry.nlink !== 1 ||
    !sessionIdentity ||
    entry.dev !== sessionIdentity.dev ||
    entry.ino !== sessionIdentity.ino ||
    (await realpath(directory)) !== directory ||
    (await realpath(sessionFile)) !== sessionFile
  )
    throw new Error("The original session location changed");
  const contents = JSON.stringify({
    version: 1,
    ...summary,
    ...(result ? { result } : {}),
  });
  if (Buffer.byteLength(contents) > 64 * 1024 * 1024)
    throw new Error("The late result exceeded the safe recording limit");
  const handle = await open(
    path.join(directory, ".late-tool-result-" + randomUUID() + ".json"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function waitForContinuation(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      resolve(ready);
    };
    const cancelled = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}
