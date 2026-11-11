import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const phases = [
  "input_preflight",
  "input_rejected",
  "prepare_submitting",
  "prepared",
  "run_submitting",
  "running",
  "captured",
  "published",
  "acknowledged",
  "released",
  "retained",
] as const;
export interface IsolatedOperationReceipt {
  readonly scope: "project_command";
  readonly namespace: "test" | "manual";
  readonly projectId: string;
  readonly operationId: string;
  readonly generation?: number;
  readonly snapshotId?: string;
  readonly phase: (typeof phases)[number];
  readonly rejection?: "input_budget";
  readonly mode?: "shell" | "build" | "install" | "preview";
}
export interface IsolatedRepairTarget {
  readonly taskId: string;
  readonly userEntryId: string;
  readonly callId: string;
  readonly tool: string;
  readonly namespace: "manual" | "test";
  readonly projectId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly rawSnapshotId: string;
  readonly mode: "shell" | "build" | "install" | "recovery";
}
export interface IsolatedRepairProof {
  readonly namespace: "manual" | "test";
  readonly projectId: string;
  readonly generation: number;
  readonly rawSnapshotId: string;
  readonly preparedBatchId: string;
  readonly reviewId: string;
  readonly preparedSnapshotId: string;
  readonly hostTargetFingerprint: string;
  readonly publicationId: string;
  readonly recoveryOperationId: string;
  readonly originOperations: readonly {
    operationId: string;
    mode: "shell" | "build" | "install";
    snapshotId: string;
    phase?: string;
    acknowledged?: boolean;
  }[];
  readonly allOriginalsDurable: true;
  readonly acknowledged: true;
  readonly released: true;
  readonly workspaceVersion?: string;
}
export interface IsolatedRepairResolution extends IsolatedRepairTarget {
  readonly version: 1;
  readonly repairCallId: string;
  readonly preparedBatchId: string;
  readonly reviewId: string;
  readonly preparedSnapshotId: string;
  readonly hostTargetFingerprint: string;
  readonly publicationId: string;
  readonly workspaceVersion?: string;
  readonly recoveryOperationId: string;
}
export type IsolatedRepairPending = Omit<
  IsolatedRepairProof,
  "acknowledged" | "workspaceVersion"
> & { readonly publicationVerified: true };
export interface IsolatedRepairScope {
  getTargets(): readonly IsolatedRepairTarget[];
  settle(
    proof: Readonly<IsolatedRepairProof>,
  ): Promise<readonly IsolatedRepairResolution[]>;
}
type Observe = (
  receipts: readonly IsolatedOperationReceipt[],
  late: boolean,
) => Promise<void>;
type Evidence = { receipts: readonly IsolatedOperationReceipt[] };
type Scope = Evidence & {
  observe: Observe;
  closed: boolean;
  invalid: boolean;
  tail: Promise<void>;
  repair?: IsolatedRepairScope;
  resolutions: readonly IsolatedRepairResolution[];
};
const scopes = new AsyncLocalStorage<Scope>();
const budgets = new WeakSet<object>();
const trusted = new WeakMap<object, Evidence>();
const repairProofs = new WeakMap<object, Readonly<IsolatedRepairProof>>();
const repairPending = new WeakMap<object, Readonly<IsolatedRepairPending>>();
const resolutions = new WeakMap<
  object,
  { resolutions: readonly IsolatedRepairResolution[] }
>();
const failureMessage =
  "The isolated command receipt could not be safely recorded. Review the original operation before continuing; do not repeat it.";

/** This brand describes a file-budget rejection, not whether an entire tool had effects. */
export function isolatedInputBudgetError(message: string): Error {
  const error = new Error(message);
  budgets.add(error);
  return error;
}
export function isIsolatedInputBudgetError(value: unknown): boolean {
  return !!value && typeof value === "object" && budgets.has(value);
}
export function getIsolatedOperationReceipts(
  value: unknown,
): readonly IsolatedOperationReceipt[] | undefined {
  return value && typeof value === "object"
    ? trusted.get(value)?.receipts
    : undefined;
}
export function inheritIsolatedOperationReceipts<T extends object>(
  target: T,
  original: unknown,
): T {
  const evidence =
    original && typeof original === "object"
      ? trusted.get(original)
      : undefined;
  if (evidence) trusted.set(target, evidence);
  return target;
}

/** Host/backend-only: call after immutable originals, committed publication, raw ACK and release were verified. */
function normalizeRepairProof(
  input: IsolatedRepairProof,
): Readonly<IsolatedRepairProof> | undefined {
  const hash = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    !["manual", "test"].includes(input.namespace) ||
    !/^[a-f0-9-]{36}$/.test(input.projectId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    ![
      input.rawSnapshotId,
      input.preparedBatchId,
      input.reviewId,
      input.preparedSnapshotId,
      input.hostTargetFingerprint,
    ].every(hash) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.publicationId,
    ) ||
    !/^[a-f0-9]{32}$/.test(input.recoveryOperationId) ||
    input.allOriginalsDurable !== true ||
    input.acknowledged !== true ||
    input.released !== true ||
    !Array.isArray(input.originOperations) ||
    input.originOperations.length > 32 ||
    input.originOperations.some(
      (origin) =>
        !/^[a-f0-9]{32}$/.test(origin.operationId) ||
        !["shell", "build", "install"].includes(origin.mode) ||
        origin.snapshotId !== input.rawSnapshotId,
    )
  )
    return;
  return Object.freeze({
    ...input,
    originOperations: Object.freeze(
      input.originOperations.map((origin) =>
        Object.freeze({
          operationId: origin.operationId,
          mode: origin.mode,
          snapshotId: origin.snapshotId,
        }),
      ),
    ),
  });
}
export function createIsolatedRepairProof(input: IsolatedRepairProof): object {
  const proof = normalizeRepairProof(input);
  if (!proof)
    throw new Error("The controlled isolated recovery proof is incomplete");
  const token = Object.freeze({});
  repairProofs.set(token, proof);
  return token;
}
export function parseIsolatedRepairPending(
  value: unknown,
): Readonly<IsolatedRepairPending> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as IsolatedRepairPending).publicationVerified !== true
  )
    return;
  const proof = normalizeRepairProof({
    ...(value as IsolatedRepairPending),
    acknowledged: true,
  });
  if (!proof) return;
  const { acknowledged: _, workspaceVersion: __, ...pending } = proof;
  return Object.freeze({ ...pending, publicationVerified: true });
}
export function createIsolatedRepairPending(
  input: IsolatedRepairPending,
): object {
  const pending = parseIsolatedRepairPending(input);
  if (!pending)
    throw new Error(
      "The controlled recovery verification identity is incomplete",
    );
  const token = Object.freeze({});
  repairPending.set(token, pending);
  return token;
}
export function getIsolatedRepairPending(
  value: unknown,
): Readonly<IsolatedRepairPending> | undefined {
  return value && typeof value === "object"
    ? repairPending.get(value)
    : undefined;
}
export function inheritIsolatedRepairPending<T extends object>(
  target: T,
  original: unknown,
): T {
  const pending = getIsolatedRepairPending(original);
  if (pending) repairPending.set(target, pending);
  return target;
}
export function retainedIsolatedRepairPending(
  entries: readonly SessionEntry[],
  taskId: string,
  callId: string,
  tool: string,
): Readonly<IsolatedRepairPending> | undefined {
  if (tool !== "recover_isolated_changes") return;
  const owner = retainedToolTask(entries, taskId, callId, tool);
  if (!owner) return;
  const user = entries.findIndex((entry) => entry.id === owner.userEntryId);
  const rest = entries.slice(user + 1),
    next = rest.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
  const canonical = next < 0 ? rest : rest.slice(0, next);
  const calls = canonical.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? entry.message.content.filter(
          (block) => block.type === "toolCall" && block.id === callId,
        )
      : [],
  );
  const original = calls[0];
  if (
    !original ||
    original.type !== "toolCall" ||
    original.name !== tool ||
    !["adopt", "recover"].includes(
      String((original.arguments as Record<string, unknown>).action),
    ) ||
    calls.some(
      (call) =>
        call.type !== "toolCall" ||
        call.name !== tool ||
        JSON.stringify(call.arguments) !== JSON.stringify(original.arguments),
    )
  )
    return;
  const first = rest.find(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "ohmygame-tool-attempt" &&
      (entry.data as Record<string, unknown>)?.taskId === owner.taskId &&
      (entry.data as Record<string, unknown>).callId === callId &&
      ["unknown", "blocked", "effects_recovered"].includes(
        String((entry.data as Record<string, unknown>).state),
      ),
  );
  const pending =
    first?.type === "custom"
      ? parseIsolatedRepairPending(
          (first.data as Record<string, unknown>).pendingVerification,
        )
      : undefined;
  if (!pending) return;
  const input = original.arguments as Record<string, unknown>;
  if (
    (input.action === "adopt" && input.reviewId !== pending.reviewId) ||
    (input.action === "recover" &&
      String(input.generation) !== String(pending.generation))
  )
    return;
  const result = canonical.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === callId &&
      entry.message.toolName === tool,
  );
  if (
    result?.type !== "message" ||
    result.message.role !== "toolResult" ||
    result.message.isError !== true
  )
    return;
  const marker = (
    result.message as unknown as { isolatedRepairPending?: unknown }
  ).isolatedRepairPending;
  const native = canonical.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.api === "ohmygame-native" &&
      entry.message.content.some(
        (block) => block.type === "toolCall" && block.id === callId,
      ),
  );
  if (
    (native && marker === undefined) ||
    (marker !== undefined &&
      JSON.stringify(parseIsolatedRepairPending(marker)) !==
        JSON.stringify(pending))
  )
    return;
  return pending;
}
export function getIsolatedRepairProof(value: unknown): object | undefined {
  return value && typeof value === "object" && repairProofs.has(value)
    ? value
    : undefined;
}
export function inheritIsolatedRepairProof<T extends object>(
  target: T,
  original: unknown,
): T {
  const proof =
    original && typeof original === "object"
      ? repairProofs.get(original)
      : undefined;
  if (proof) repairProofs.set(target, proof);
  return target;
}
/** Workspace epoch is audit data. A string never creates a proof or authorizes a changed workspace. */
export function annotateIsolatedRepairPublication<T extends object>(
  value: T,
  workspaceVersion: string,
): T {
  const proof = repairProofs.get(value);
  if (
    !proof ||
    typeof workspaceVersion !== "string" ||
    workspaceVersion.length < 1 ||
    workspaceVersion.length > 256 ||
    /[\x00-\x1f\x7f]/.test(workspaceVersion)
  )
    throw new Error("A trusted recovery publication is required");
  repairProofs.set(value, Object.freeze({ ...proof, workspaceVersion }));
  return value;
}
export function getRepairTargets(): readonly IsolatedRepairTarget[] {
  const scope = scopes.getStore();
  return scope && !scope.closed && !scope.invalid
    ? (scope.repair?.getTargets() ?? [])
    : [];
}
export async function settleIsolatedRepair(value: unknown): Promise<number> {
  const scope = scopes.getStore();
  const proof =
    value && typeof value === "object" ? repairProofs.get(value) : undefined;
  if (!scope || scope.closed || scope.invalid || !scope.repair || !proof)
    throw new Error("A current controlled recovery proof is required");
  const settled = await scope.repair.settle(proof);
  scope.resolutions = Object.freeze([...scope.resolutions, ...settled]);
  return settled.length;
}
export function getIsolatedRepairResolutions(
  value: unknown,
): readonly IsolatedRepairResolution[] | undefined {
  return value && typeof value === "object"
    ? resolutions.get(value)?.resolutions
    : undefined;
}
export function inheritIsolatedRepairResolutions<T extends object>(
  target: T,
  original: unknown,
): T {
  const proof =
    original && typeof original === "object"
      ? resolutions.get(original)
      : undefined;
  if (proof) resolutions.set(target, proof);
  return target;
}
export function parseIsolatedRepairResolution(
  value: unknown,
): IsolatedRepairResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const validId = (value: unknown) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value);
  if (
    data.version !== 1 ||
    ![
      data.taskId,
      data.userEntryId,
      data.callId,
      data.tool,
      data.repairCallId,
    ].every(validId) ||
    !["manual", "test"].includes(String(data.namespace)) ||
    typeof data.projectId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(data.projectId) ||
    typeof data.operationId !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.operationId) ||
    !Number.isSafeInteger(data.generation) ||
    Number(data.generation) < 1 ||
    !["shell", "build", "install", "recovery"].includes(String(data.mode)) ||
    typeof data.recoveryOperationId !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.recoveryOperationId) ||
    ![
      data.rawSnapshotId,
      data.preparedBatchId,
      data.reviewId,
      data.preparedSnapshotId,
      data.hostTargetFingerprint,
    ].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    ) ||
    typeof data.publicationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      data.publicationId,
    ) ||
    (data.workspaceVersion !== undefined && !validId(data.workspaceVersion))
  )
    return;
  return Object.freeze({
    version: 1,
    taskId: String(data.taskId),
    userEntryId: String(data.userEntryId),
    callId: String(data.callId),
    tool: String(data.tool),
    repairCallId: String(data.repairCallId),
    namespace: data.namespace as IsolatedRepairResolution["namespace"],
    projectId: data.projectId,
    operationId: data.operationId,
    generation: Number(data.generation),
    rawSnapshotId: String(data.rawSnapshotId),
    mode: data.mode as IsolatedRepairTarget["mode"],
    preparedBatchId: String(data.preparedBatchId),
    reviewId: String(data.reviewId),
    preparedSnapshotId: String(data.preparedSnapshotId),
    hostTargetFingerprint: String(data.hostTargetFingerprint),
    publicationId: data.publicationId,
    recoveryOperationId: data.recoveryOperationId,
    ...(data.workspaceVersion !== undefined
      ? { workspaceVersion: String(data.workspaceVersion) }
      : {}),
  });
}

/** A resolution is an explicit host reconciliation, never a newer marker that rewrites an old failure. */
export function retainedIsolatedRepairResolutions(
  entries: readonly SessionEntry[],
  taskId: string,
  callId: string,
  tool: string,
): readonly IsolatedRepairResolution[] | undefined {
  const owner = retainedToolTask(entries, taskId, callId, tool);
  if (!owner) return;
  const user = entries.findIndex((entry) => entry.id === owner.userEntryId);
  const rest = entries.slice(user + 1),
    next = rest.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
  const canonical = next < 0 ? rest : rest.slice(0, next);
  const evidence = retainedIsolatedOperationEvidence(
    entries,
    owner.taskId,
    callId,
    tool,
    "history",
  );
  const original = getIsolatedOperationReceipts(evidence);
  const pending = retainedIsolatedRepairPending(
    entries,
    owner.taskId,
    callId,
    tool,
  );
  if (!original && !pending) return;
  const stages = entries
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "ohmygame-tool-attempt",
    )
    .map(
      (entry) => (entry as { data: unknown }).data as Record<string, unknown>,
    );
  const originalStages = stages.filter(
    (data) =>
      data?.version === 1 &&
      data.taskId === owner.taskId &&
      data.callId === callId &&
      data.tool === tool,
  );
  const firstUnknown = originalStages.find((data) =>
    ["unknown", "blocked", "effects_recovered"].includes(String(data.state)),
  );
  const initial = parseIsolatedOperationReceipts(
    firstUnknown?.isolatedOperations,
  );
  const latest = originalStages.findLast(
    (data) => data.state === "effects_recovered",
  );
  if (
    (!initial && !pending) ||
    !latest ||
    !Array.isArray(latest.effectsRecovered) ||
    !latest.effectsRecovered.length
  )
    return;
  const parsed = latest.effectsRecovered.map(parseIsolatedRepairResolution);
  if (parsed.some((value) => !value)) return;
  const values = parsed as IsolatedRepairResolution[];
  const operations = new Set(
    pending
      ? [pending.recoveryOperationId]
      : original!.map((receipt) => receipt.operationId),
  );
  if (values.length !== operations.size) return;
  for (const value of values) {
    if (
      value.taskId !== owner.taskId ||
      value.userEntryId !== owner.userEntryId ||
      value.callId !== callId ||
      value.tool !== tool ||
      !operations.has(value.operationId)
    )
      return;
    if (value.mode === "recovery") {
      if (
        !pending ||
        value.operationId !== pending.recoveryOperationId ||
        value.recoveryOperationId !== pending.recoveryOperationId ||
        value.namespace !== pending.namespace ||
        value.projectId !== pending.projectId ||
        value.generation !== pending.generation ||
        [
          "rawSnapshotId",
          "preparedBatchId",
          "reviewId",
          "preparedSnapshotId",
          "hostTargetFingerprint",
          "publicationId",
        ].some(
          (key) =>
            value[key as keyof IsolatedRepairResolution] !==
            pending[key as keyof IsolatedRepairPending],
        )
      )
        return;
    } else {
      const receipts = initial!.filter(
        (receipt) => receipt.operationId === value.operationId,
      );
      const captured = receipts.find((receipt) => receipt.phase === "captured");
      if (
        !captured ||
        captured.snapshotId !== value.rawSnapshotId ||
        captured.generation !== value.generation ||
        captured.mode !== value.mode ||
        captured.projectId !== value.projectId ||
        captured.namespace !== value.namespace ||
        !receipts.some((receipt) => receipt.phase === "retained") ||
        receipts.at(-1)?.phase !== "released"
      )
        return;
    }
    const repairOwner = retainedToolTask(
      entries,
      owner.taskId,
      value.repairCallId,
      "recover_isolated_changes",
    );
    if (
      repairOwner?.taskId !== owner.taskId ||
      repairOwner.userEntryId !== owner.userEntryId
    )
      return;
    const repairCall = canonical.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.content.filter(
            (block) =>
              block.type === "toolCall" && block.id === value.repairCallId,
          )
        : [],
    );
    const firstCall = repairCall[0];
    if (
      !firstCall ||
      firstCall.type !== "toolCall" ||
      !["adopt", "recover", "verify"].includes(
        String((firstCall.arguments as Record<string, unknown>).action),
      ) ||
      repairCall.some(
        (call) =>
          call.type !== "toolCall" ||
          call.name !== "recover_isolated_changes" ||
          JSON.stringify(call.arguments) !==
            JSON.stringify(firstCall.arguments),
      )
    )
      return;
    const completed = stages.findLast(
      (data) =>
        data.taskId === owner.taskId &&
        data.callId === value.repairCallId &&
        data.tool === "recover_isolated_changes" &&
        data.state === "completed",
    );
    if (
      !Array.isArray(completed?.repairResolutions) ||
      !completed.repairResolutions.some(
        (item) =>
          JSON.stringify(parseIsolatedRepairResolution(item)) ===
          JSON.stringify(value),
      )
    )
      return;
    const result = canonical.findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === value.repairCallId &&
        entry.message.toolName === "recover_isolated_changes",
    );
    if (
      result?.type !== "message" ||
      result.message.role !== "toolResult" ||
      result.message.isError
    )
      return;
    const marker = (
      result.message as unknown as { isolatedRepairResolutions?: unknown }
    ).isolatedRepairResolutions;
    const native = entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.api === "ohmygame-native" &&
        entry.message.content.some(
          (block) =>
            block.type === "toolCall" && block.id === value.repairCallId,
        ),
    );
    if (
      (native && !Array.isArray(marker)) ||
      (marker !== undefined &&
        (!Array.isArray(marker) ||
          !marker.some(
            (item) =>
              JSON.stringify(parseIsolatedRepairResolution(item)) ===
              JSON.stringify(value),
          )))
    )
      return;
  }
  return Object.freeze(values);
}

/** Only the tool guard supplies the observer; the backend cannot choose a task or call ID. */
export async function withIsolatedOperationScope<T>(
  observe: Observe,
  execute: () => Promise<T>,
  repair?: IsolatedRepairScope,
): Promise<T> {
  const scope: Scope = {
    receipts: Object.freeze([]),
    observe,
    closed: false,
    invalid: false,
    tail: Promise.resolve(),
    resolutions: Object.freeze([]),
    ...(repair ? { repair } : {}),
  };
  return scopes.run(scope, async () => {
    try {
      const result = await execute();
      await scope.tail;
      if (scope.invalid) throw new Error(failureMessage);
      if (result && typeof result === "object" && scope.receipts.length)
        trusted.set(result, scope);
      if (result && typeof result === "object" && scope.resolutions.length)
        resolutions.set(result, scope);
      return result;
    } catch (cause) {
      await scope.tail;
      if (cause && typeof cause === "object" && scope.resolutions.length)
        resolutions.set(cause, scope);
      if (scope.invalid) {
        const failure = new Error(failureMessage);
        if (scope.receipts.length) trusted.set(failure, scope);
        throw failure;
      }
      if (cause && typeof cause === "object" && scope.receipts.length) {
        if (trusted.has(cause) && trusted.get(cause) !== scope) {
          const retained = new Error(
            cause instanceof Error ? cause.message : failureMessage,
          );
          if (isIsolatedInputBudgetError(cause)) budgets.add(retained);
          inheritIsolatedRepairPending(retained, cause);
          trusted.set(retained, scope);
          throw retained;
        }
        trusted.set(cause, scope);
      }
      throw cause;
    } finally {
      scope.closed = true;
    }
  });
}

/** Await before prepare/run. No scope preserves existing non-agent backend callers. */
export async function reportIsolatedOperation(
  input: IsolatedOperationReceipt,
  budgetError?: unknown,
): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  const report = scope.tail.then(async () => {
    const receipt = parseIsolatedOperationReceipt(input);
    if (
      !receipt ||
      scope.invalid ||
      (receipt.phase === "input_rejected" &&
        !isIsolatedInputBudgetError(budgetError))
    ) {
      scope.invalid = true;
      throw new Error(failureMessage);
    }
    const next = Object.freeze([...scope.receipts, receipt]);
    if (
      scope.closed &&
      ["input_preflight", "prepare_submitting", "run_submitting"].includes(
        receipt.phase,
      )
    )
      throw new Error(failureMessage);
    if (!validReceiptHistory(next)) {
      scope.invalid = true;
      throw new Error(failureMessage);
    }
    scope.receipts = next;
    try {
      await scope.observe(next, scope.closed);
    } catch {
      scope.invalid = true;
      throw new Error(failureMessage);
    }
    if (
      scope.closed &&
      !["released", "retained", "acknowledged"].includes(receipt.phase)
    )
      throw new Error(failureMessage);
  });
  scope.tail = report.catch(() => {});
  return report;
}

/** Schema validation never grants live evidence or permission to retry. */
export function parseIsolatedOperationReceipt(
  value: unknown,
): IsolatedOperationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (
    input.scope !== "project_command" ||
    !["test", "manual"].includes(String(input.namespace)) ||
    typeof input.projectId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.projectId) ||
    typeof input.operationId !== "string" ||
    !/^[a-f0-9]{32}$/.test(input.operationId) ||
    !phases.includes(input.phase as IsolatedOperationReceipt["phase"]) ||
    (input.generation !== undefined &&
      (!Number.isSafeInteger(input.generation) ||
        Number(input.generation) < 1)) ||
    (input.snapshotId !== undefined &&
      (typeof input.snapshotId !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.snapshotId))) ||
    (input.phase === "input_rejected"
      ? input.rejection !== "input_budget"
      : input.rejection !== undefined) ||
    (input.mode !== undefined &&
      !["shell", "build", "install", "preview"].includes(String(input.mode)))
  )
    return;
  return Object.freeze({
    scope: "project_command",
    namespace: input.namespace as "test" | "manual",
    projectId: input.projectId,
    operationId: input.operationId,
    phase: input.phase as IsolatedOperationReceipt["phase"],
    ...(input.generation !== undefined
      ? { generation: Number(input.generation) }
      : {}),
    ...(input.snapshotId !== undefined
      ? { snapshotId: input.snapshotId as string }
      : {}),
    ...(input.rejection ? { rejection: "input_budget" as const } : {}),
    ...(input.mode
      ? { mode: input.mode as IsolatedOperationReceipt["mode"] }
      : {}),
  });
}
export function parseIsolatedOperationReceipts(
  value: unknown,
): readonly IsolatedOperationReceipt[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return;
  const receipts = value.map(parseIsolatedOperationReceipt);
  if (receipts.some((receipt) => !receipt)) return;
  const parsed = receipts as IsolatedOperationReceipt[];
  return validReceiptHistory(parsed) ? Object.freeze(parsed) : undefined;
}

function validReceiptHistory(
  receipts: readonly IsolatedOperationReceipt[],
): boolean {
  if (receipts.length > 256) return false;
  const operations = new Map<string, IsolatedOperationReceipt>();
  for (const receipt of receipts) {
    if (
      receipt.projectId !== receipts[0]?.projectId ||
      receipt.namespace !== receipts[0]?.namespace
    )
      return false;
    const previous = operations.get(receipt.operationId);
    if (
      previous &&
      (previous.projectId !== receipt.projectId ||
        previous.namespace !== receipt.namespace ||
        (previous.generation !== undefined &&
          previous.generation !== receipt.generation) ||
        (previous.snapshotId !== undefined &&
          previous.snapshotId !== receipt.snapshotId) ||
        previous.mode !== receipt.mode ||
        previous.phase === "input_rejected" ||
        previous.phase === "released" ||
        (phases.indexOf(receipt.phase) < phases.indexOf(previous.phase) &&
          !(previous.phase === "retained" && receipt.phase === "released")))
    )
      return false;
    if (
      receipt.phase === "input_rejected" &&
      previous?.phase !== "input_preflight"
    )
      return false;
    operations.set(receipt.operationId, receipt);
  }
  return operations.size <= 32;
}

export function isolatedCommandsNotSubmitted(
  receipts: readonly IsolatedOperationReceipt[] | undefined,
): boolean {
  if (!receipts?.length || !validReceiptHistory(receipts)) return false;
  const operations = new Map<string, IsolatedOperationReceipt>();
  for (const receipt of receipts) {
    if (!["input_preflight", "input_rejected"].includes(receipt.phase))
      return false;
    operations.set(receipt.operationId, receipt);
  }
  return [...operations.values()].every(
    (receipt) =>
      receipt.phase === "input_rejected" &&
      receipt.rejection === "input_budget",
  );
}
/** Resolve a host task alias without guessing a user or granting receipt evidence. */
export function retainedToolTask(
  entries: readonly SessionEntry[],
  taskId: string,
  callId: string,
  tool: string,
): { taskId: string; userEntryId: string } | undefined {
  const journals = entries
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === "ohmygame-tool-attempt"
        ? [entry.data as Record<string, unknown>]
        : [],
    )
    .filter((data) => data?.version === 1 && typeof data.taskId === "string");
  const matching = journals.filter(
    (data) =>
      data.callId === callId &&
      data.tool === tool &&
      (data.taskId === taskId || data.userEntryId === taskId),
  );
  const originalTask = matching[0]?.taskId;
  if (
    typeof originalTask !== "string" ||
    matching.some((data) => data.taskId !== originalTask)
  )
    return;
  const aliases = new Set(
    journals
      .filter(
        (data) =>
          data.taskId === originalTask && typeof data.userEntryId === "string",
      )
      .map((data) => data.userEntryId as string),
  );
  if (aliases.size > 1) return;
  const userId = [...aliases][0] ?? originalTask;
  if (
    journals.some(
      (data) =>
        (data.userEntryId ?? data.taskId) === userId &&
        data.taskId !== originalTask,
    )
  )
    return;
  if (
    !entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.id === userId,
    )
  )
    return;
  return { taskId: originalTask, userEntryId: userId };
}

/** Rehydrate only host journal history paired with the original unchanged call and actual failure. */
export function retainedIsolatedOperationEvidence(
  entries: readonly SessionEntry[],
  taskId: string,
  callId: string,
  tool: string,
  purpose: "command_not_submitted" | "history" = "command_not_submitted",
): object | undefined {
  const binding = retainedToolTask(entries, taskId, callId, tool);
  if (!binding) return;
  const { taskId: originalTask, userEntryId: userId } = binding;
  const userIndex = entries.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      entry.id === userId,
  );
  if (userIndex < 0) return;
  const branch = entries.slice(userIndex + 1);
  const nextUser = branch.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  const canonical = nextUser < 0 ? branch : branch.slice(0, nextUser);
  const calls = canonical.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? entry.message.content.filter(
          (block) => block.type === "toolCall" && block.id === callId,
        )
      : [],
  );
  const original = calls[0];
  if (
    !original ||
    original.type !== "toolCall" ||
    original.name !== tool ||
    calls.some(
      (call) =>
        call.type !== "toolCall" ||
        call.name !== tool ||
        JSON.stringify(call.arguments) !== JSON.stringify(original.arguments),
    )
  )
    return;
  const results = canonical.flatMap((entry) =>
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    entry.message.toolCallId === callId &&
    entry.message.toolName === tool
      ? [entry.message]
      : [],
  );
  if (
    !results.length ||
    (purpose === "command_not_submitted" &&
      results.some((result) => result.isError !== true))
  )
    return;
  let retained: readonly IsolatedOperationReceipt[] | undefined;
  let unknown = false;
  let lastState: unknown;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "ohmygame-tool-attempt")
      continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (
      data?.version !== 1 ||
      data.taskId !== originalTask ||
      data.callId !== callId ||
      data.tool !== tool
    )
      continue;
    lastState = data.state;
    if (["unknown", "blocked", "completed"].includes(String(data.state)))
      unknown = true;
    if (data.isolatedOperations === undefined) continue;
    const parsed = parseIsolatedOperationReceipts(data.isolatedOperations);
    if (
      !parsed ||
      (retained &&
        JSON.stringify(parsed.slice(0, retained.length)) !==
          JSON.stringify(retained))
    )
      return;
    retained = parsed;
  }
  if (
    !retained ||
    (purpose === "command_not_submitted" &&
      (unknown ||
        lastState !== "command_not_submitted" ||
        !isolatedCommandsNotSubmitted(retained)))
  )
    return;
  const marker = (results.at(-1) as unknown as { isolatedOperations?: unknown })
    .isolatedOperations;
  const native = canonical.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.api === "ohmygame-native" &&
      entry.message.content.some(
        (block) => block.type === "toolCall" && block.id === callId,
      ),
  );
  if (native && marker === undefined) return;
  if (marker !== undefined) {
    const parsed = parseIsolatedOperationReceipts(marker);
    if (
      !parsed ||
      JSON.stringify(
        purpose === "history" ? retained.slice(0, parsed.length) : retained,
      ) !== JSON.stringify(parsed)
    )
      return;
  }
  const token = Object.freeze({});
  trusted.set(token, { receipts: retained! });
  return token;
}
