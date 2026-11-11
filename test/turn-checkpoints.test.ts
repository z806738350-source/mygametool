import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import {
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  AgentManager,
  conversationItems,
  createPiSession,
  type CodingSession,
} from "../src/daemon/agent.js";
import { CheckpointStore } from "../src/daemon/checkpoints.js";
import { CheckpointFileTooLargeError } from "../src/daemon/checkpoint-objects.js";
import {
  turnRange,
  CHECKPOINT_ENTRY,
  parseStoredCheckpoint,
} from "../src/daemon/checkpoint-extension.js";
import { ProjectWrites } from "../src/daemon/project-writes.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { ProjectState } from "../src/shared/contracts.js";
import * as continuation from "../src/daemon/agent-auto-continue.js";
import { annotateIsolatedRepairPublication, createIsolatedRepairProof, getRepairTargets, inheritIsolatedRepairProof, reportIsolatedOperation, settleIsolatedRepair } from "../src/daemon/isolated-tool-receipts.js";
import { handoffSummary } from "../src/daemon/agent-runtimes/handoff.js";

it("runs an actual Pi repair-only tool chain under the same task and continuation budget", async () => {
  const binding = { scope: "project_command" as const, namespace: "test" as const, projectId: "11111111-1111-4111-8111-111111111111", operationId: "a".repeat(32), mode: "shell" as const };
  const trace: string[] = [];
  const shell = vi.fn<ToolDefinition["execute"]>(async () => {
    for (const phase of ["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "retained", "released"] as const)
      await reportIsolatedOperation({ ...binding, phase, ...(["input_preflight", "prepare_submitting"].includes(phase) ? {} : { generation: 1 }), ...(["captured", "retained", "released"].includes(phase) ? { snapshotId: "b".repeat(64) } : {}) });
    throw new Error("Original command return failed; retained snapshot is confirmed");
  });
  let state!: Awaited<ReturnType<typeof fixture>>;
  const repair = vi.fn<ToolDefinition["execute"]>(async (_id, input) => {
    const action = String((input as { action: string }).action); trace.push(action);
    expect(getRepairTargets()).toHaveLength(1);
    if (action === "adopt") {
      await writeFile(path.join(state.project.workspacePath, "game.txt"), "restored");
      state.manager.invalidateProjectSessions(state.project.id);
      const output = inheritIsolatedRepairProof({ content: [{ type: "text" as const, text: "Original effects returned; read current files" }], details: {} }, createIsolatedRepairProof({
        namespace: "test", projectId: binding.projectId, generation: 1, rawSnapshotId: "b".repeat(64), preparedBatchId: "c".repeat(64), reviewId: "d".repeat(64), preparedSnapshotId: "e".repeat(64), hostTargetFingerprint: "f".repeat(64),
        publicationId: "22222222-2222-4222-8222-222222222222", recoveryOperationId: "c".repeat(32), originOperations: [{ operationId: binding.operationId, mode: "shell", snapshotId: "b".repeat(64) }], allOriginalsDurable: true, acknowledged: true, released: true,
      }));
      annotateIsolatedRepairPublication(output, "host-publication-1"); expect(await settleIsolatedRepair(output)).toBe(1); return output;
    }
    return { content: [{ type: "text", text: `Fresh ${action} completed` }], details: {} };
  });
  const tools: ToolDefinition[] = [
    { name: "isolated_shell", label: "Offline original", description: "Offline only", parameters: Type.Object({ command: Type.String() }), execute: shell },
    { name: "recover_isolated_changes", label: "Offline recovery", description: "Offline controlled action fixture", parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("review"), Type.Literal("optimize"), Type.Literal("adopt")]) }), execute: repair },
  ];
  state = await fixture(undefined, undefined, tools, ["write"]);
  state.project.id = binding.projectId; state.conversation.summary.projectId = binding.projectId;
  await writeFile(path.join(state.project.workspacePath, "game.txt"), "before");
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true); cleanups.push(() => wait.mockRestore());
  const call = (id: string, name: string, arguments_: Record<string, string>) => assistant([{ type: "toolCall", id, name, arguments: arguments_ }], "toolUse");
  const error = assistant([], "error"); error.errorMessage = "The native segment ended";
  const responses = [call("original-command", "isolated_shell", { command: "original" }), error,
    call("blocked-write", "write", { path: "game.txt", content: "must not run" }),
    call("inspect-1", "recover_isolated_changes", { action: "inspect" }), call("inspect-2", "recover_isolated_changes", { action: "inspect" }),
    call("review-1", "recover_isolated_changes", { action: "review" }), call("optimize-1", "recover_isolated_changes", { action: "optimize" }), call("review-2", "recover_isolated_changes", { action: "review" }), call("adopt-1", "recover_isolated_changes", { action: "adopt" }),
    call("blocked-before-read", "write", { path: "game.txt", content: "must read first" }), call("original-command", "isolated_shell", { command: "original" }), call("same-command-new-id", "isolated_shell", { command: "original" }),
    call("read-current", "read", { path: "game.txt" }), call("corrected-write", "write", { path: "game.txt", content: "corrected" }), assistant([{ type: "text", text: "Finished the corrected task" }])];
  const request = vi.fn(() => { const message = responses.shift(); if (!message) throw new Error("Unexpected extra model loop"); return stream(message); }); state.runtime.streamSimple = request;
  await expect(state.manager.prompt(state.project, state.conversation, "Complete the original task with controlled recovery").result).resolves.toBe("completed");
  expect(wait).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(15); expect(shell).toHaveBeenCalledOnce();
  expect(trace).toEqual(["inspect", "inspect", "review", "optimize", "review", "adopt"]);
  expect(await readFile(path.join(state.project.workspacePath, "game.txt"), "utf8")).toBe("corrected");
  const branch = state.sessionManager.getBranch();
  expect(branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && ["blocked-write", "blocked-before-read"].includes(entry.message.toolCallId))).toEqual([
    expect.objectContaining({ message: expect.objectContaining({ isError: true }) }), expect.objectContaining({ message: expect.objectContaining({ isError: true }) }),
  ]);
  expect(branch.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
  expect(branch.filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
  expect(branch.findLast(entry => entry.type === "custom" && entry.customType === continuation.AUTO_CONTINUE_TOOL_ENTRY && (entry.data as { callId: string }).callId === "original-command")).toMatchObject({ data: { state: "effects_recovered" } });
  expect(handoffSummary(branch)).toContain('"state":"effects_recovered"');
});

it("shares the existing three-continuation limit with actual Pi repair-only work", async () => {
  const binding = { scope: "project_command" as const, namespace: "test" as const, projectId: "11111111-1111-4111-8111-111111111111", operationId: "a".repeat(32), mode: "shell" as const };
  const shell = vi.fn<ToolDefinition["execute"]>(async () => {
    for (const phase of ["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "retained", "released"] as const)
      await reportIsolatedOperation({ ...binding, phase, ...(["input_preflight", "prepare_submitting"].includes(phase) ? {} : { generation: 1 }), ...(["captured", "retained", "released"].includes(phase) ? { snapshotId: "b".repeat(64) } : {}) });
    throw new Error("Retained source output needs repair");
  });
  const inspect = vi.fn<ToolDefinition["execute"]>(async () => { expect(getRepairTargets()).toHaveLength(1); return { content: [{ type: "text", text: "Original retained changes" }], details: {} }; });
  const tools: ToolDefinition[] = [{ name: "isolated_shell", label: "Offline", description: "Offline", parameters: Type.Object({ command: Type.String() }), execute: shell },
    { name: "recover_isolated_changes", label: "Offline", description: "Offline", parameters: Type.Object({ action: Type.Literal("inspect") }), execute: inspect }];
  const state = await fixture(undefined, undefined, tools); state.project.id = binding.projectId; state.conversation.summary.projectId = binding.projectId;
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true); cleanups.push(() => wait.mockRestore());
  const error = () => { const message = assistant([], "error"); message.errorMessage = "Segment interrupted while retained changes need repair"; return message; };
  const responses = [assistant([{ type: "toolCall", id: "original", name: "isolated_shell", arguments: { command: "original" } }], "toolUse"), error(), ...[1, 2, 3].flatMap(attempt => [assistant([{ type: "toolCall", id: `inspect-${attempt}`, name: "recover_isolated_changes", arguments: { action: "inspect" } }], "toolUse"), error()])];
  const request = vi.fn(() => { const message = responses.shift(); if (!message) throw new Error("Repair exceeded the existing continuation limit"); return stream(message); }); state.runtime.streamSimple = request;
  await expect(state.manager.prompt(state.project, state.conversation, "Repair only within the existing continuation policy").result).rejects.toThrow("Segment interrupted");
  expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5_000, 15_000, 45_000]); expect(request).toHaveBeenCalledTimes(8); expect(shell).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledTimes(3);
  const branch = state.sessionManager.getBranch(); expect(branch.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1); expect(branch.filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
});

it.each([500, 503])("continues an actual Pi session after HTTP %s while reusing completed side effects and the original checkpoint", async status => {
  const effect = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Effect already completed" }], details: {} }));
  const tool: ToolDefinition = { name: "optimize_image_asset", label: "Offline effect", description: "Offline test effect", parameters: Type.Object({ path: Type.String() }), execute: effect };
  const state = await fixture(undefined, undefined, [tool]);
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true);
  cleanups.push(() => wait.mockRestore());
  const call = (id: string) => assistant([{ type: "toolCall", id, name: tool.name, arguments: { path: "fixture.png" } }], "toolUse");
  const error = assistant([], "error");
  error.errorMessage = "Provider request failed";
  error.diagnostics = [{ type: "provider_failure", timestamp: Date.now(), details: { status } }];
  const responses = [call("effect-original"), error, call("effect-repeated"), assistant([{ type: "text", text: "Finished" }])];
  const request = vi.fn(() => stream(responses.shift()!));
  state.runtime.streamSimple = request;
  await expect(state.manager.prompt(state.project, state.conversation, "Complete this task").result).resolves.toBe("completed");
  expect(request).toHaveBeenCalledTimes(4); expect(effect).toHaveBeenCalledOnce();
  expect(state.session.messages.filter(message => message.role === "user")).toHaveLength(1);
  expect(state.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
  const reloaded = SessionManager.open(state.sessionManager.getSessionFile()!);
  expect(conversationItems(reloaded.getBranch())).toEqual(expect.arrayContaining([expect.objectContaining({ type: "retry", status: "completed", attempt: 1 })]));
});

it("retrieves an existing media result before actual Pi continuation without resubmitting its generator", async () => {
  const generate = vi.fn(async () => { throw new Error("Result not delivered yet"); });
  const recover = vi.fn<ToolDefinition["execute"]>(async () => ({ content: [{ type: "text" as const, text: "Recovered saved asset existing-image.png" }], details: { assetId: "existing-asset" } }));
  const tools: ToolDefinition[] = [
    { name: "generate_image", label: "Offline generation", description: "Offline only", parameters: Type.Object({ prompt: Type.String() }), execute: generate },
    { name: "recover_media", label: "Recover", description: "Retrieve existing result", parameters: Type.Object({ tool: Type.String(), recoverCallId: Type.String(), originalArguments: Type.Unknown() }), execute: recover },
  ];
  const state = await fixture(undefined, undefined, tools);
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true); cleanups.push(() => wait.mockRestore());
  const call = (id: string) => assistant([{ type: "toolCall", id, name: "generate_image", arguments: { prompt: "Offline moth" } }], "toolUse");
  const error = assistant([], "error"); error.errorMessage = "Provider request failed";
  error.diagnostics = [{ type: "provider_failure", timestamp: Date.now(), details: { status: 500 } }];
  const responses = [call("original-media"), error, call("repeated-media"), assistant([{ type: "text", text: "Finished" }])];
  state.runtime.streamSimple = vi.fn(() => stream(responses.shift()!));
  await expect(state.manager.prompt(state.project, state.conversation, "Complete this task").result).resolves.toBe("completed");
  expect(generate).toHaveBeenCalledOnce(); expect(recover).toHaveBeenCalledOnce();
  expect(recover.mock.calls[0]?.[1]).toMatchObject({ recoverCallId: "original-media", tool: "generate_image" });
  expect(state.session.messages.some(message => message.role === "custom" && message.customType === "ohmygame-recovered-media")).toBe(true);
});

it("ends actual Pi continuation before another model request when a new effect becomes uncertain", async () => {
  const effect = vi.fn(async () => { throw new Error("Unknown operation outcome"); });
  const tool: ToolDefinition = { name: "optimize_image_asset", label: "Offline effect", description: "Offline only", parameters: Type.Object({}), execute: effect };
  const state = await fixture(undefined, undefined, [tool]);
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true); cleanups.push(() => wait.mockRestore());
  const error = assistant([], "error"); error.errorMessage = "Provider request failed";
  error.diagnostics = [{ type: "provider_failure", timestamp: Date.now(), details: { status: 500 } }];
  const replies = [error, assistant([{ type: "toolCall", id: "new-effect", name: tool.name, arguments: {} }], "toolUse")];
  const request = vi.fn(() => stream(replies.shift()!)); state.runtime.streamSimple = request;
  await expect(state.manager.prompt(state.project, state.conversation, "Continue this task").result).rejects.toThrow(/unconfirmed/);
  expect(effect).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(2);
});

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function stream(message: AssistantMessage): AssistantMessageEventStream {
  const result = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted")
      result.push({
        type: "error",
        reason: message.stopReason,
        error: message,
      });
    else
      result.push({
        type: "done",
        reason: message.stopReason === "pending" ? "stop" : message.stopReason,
        message,
      });
  });
  return result;
}
async function fixture(
  snapshotOverride?: (project: ProjectState) => Promise<string>,
  loading?: Promise<void>,
  tools: ToolDefinition[] = [],
  extraActive: string[] = [],
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-turn-checkpoints-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project: ProjectState = {
    id: "project",
    name: "Project",
    type: "web-game",
    workspacePath: path.join(directory, "workspace"),
    storagePath: directory,
    updatedAt: new Date().toISOString(),
    preview: { status: "waiting" },
  };
  await mkdir(project.workspacePath);
  const agentDir = path.join(directory, "agent");
  await mkdir(agentDir);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("anthropic", "turn-checkpoints-fake-credential-20261028");
  const model = runtime.getModels("anthropic")[0]!;
  model.baseUrl = "http://127.0.0.1:43199";
  const sessionManager = SessionManager.create(
    project.workspacePath,
    path.join(directory, "sessions"),
  );
  const store = new CheckpointStore();
  const snapshot = vi.fn(
    snapshotOverride ?? ((state: ProjectState) => store.snapshot(state)),
  );
  const session = (await createPiSession(
    project,
    sessionManager,
    tools,
    runtime,
    model,
    agentDir,
    undefined,
    undefined,
    () => snapshot(project),
  )) as AgentSession;
  const events = new RuntimeEventBus();
  const manager = new AgentManager(events, {
    ...(tools.length || extraActive.length ? { activeToolNames: () => ["read", ...tools.map(tool => tool.name), ...extraActive] } : {}),
    createSession: async () => {
      await loading;
      return session;
    },
    checkpoints: {
      snapshot,
      changed: async (state, before, after) =>
        store.summarize(state, before, after),
    },
  });
  cleanups.push(() => manager.close());
  const conversation = {
    sessionPath: sessionManager.getSessionFile()!,
    summary: {
      id: sessionManager.getSessionId(),
      projectId: project.id,
      title: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    },
  };
  return {
    directory,
    project,
    session,
    sessionManager,
    store,
    manager,
    conversation,
    snapshot,
    events,
    runtime,
  };
}

describe("Manager interruption continuation", () => {
  async function setup(runtime: "qoder" | "codex" = "qoder", withCheckpoints = false) {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-manager-interruption-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const project: ProjectState = { id: "interruption-project", name: "Offline continuation", type: "web-game", workspacePath: path.join(directory, "workspace"), storagePath: directory,
      updatedAt: new Date().toISOString(), preview: { status: "waiting" } };
    await mkdir(project.workspacePath);
    const sessionManager = SessionManager.inMemory(project.workspacePath), events = new RuntimeEventBus();
    const store = new CheckpointStore(), snapshot = vi.fn((state: ProjectState) => store.snapshot(state));
    const messages: Array<AssistantMessage | { role: "user"; content: string; timestamp: number }> = [];
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
    let interruption: continuation.AgentInterruption | undefined;
    const reason: continuation.AgentInterruption = { kind: "turn_limit", source: runtime, code: `${runtime}_max_turns`, phase: "result", terminalReason: "max_turns" };
    const reply = (message: AssistantMessage) => {
      messages.push(message); sessionManager.appendMessage(message); emit({ type: "message_end", message });
    };
    const fail = (value: continuation.AgentInterruption | undefined) => {
      interruption = value;
      const message = assistant([], "error"); message.errorMessage = "Offline runtime request interrupted"; reply(message);
    };
    const complete = () => { interruption = undefined; reply(assistant([{ type: "text", text: "Finished" }])); };
    const respond = vi.fn(async () => fail(reason));
    const prepare = vi.fn(async (_signal: AbortSignal) => {}), resume = vi.fn(async () => complete());
    const consumeUser = async (text: string) => {
      const message = { role: "user" as const, content: text, timestamp: Date.now() };
      emit({ type: "message_start", message });
      sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, { version: 1, commit: withCheckpoints ? await snapshot(project) : "a".repeat(40) });
      emit({ type: "message_end", message }); messages.push(message); sessionManager.appendMessage(message);
    };
    const session: CodingSession = {
      runtime: runtime === "qoder" ? "qoder-cli" : "codex-cli", emitsInitialUserMessage: true, messages, sessionManager,
      get interruption() { return interruption; },
      prompt: vi.fn<CodingSession["prompt"]>(async text => {
        await consumeUser(text); await respond();
      }),
      prepareContinuation: prepare, resumeAfterInterruption: resume,
      followUp: vi.fn(async () => {}),
      abort: vi.fn(async () => {}), dispose: vi.fn(), clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const manager = new AgentManager(events, { createSession: async () => session, ...(withCheckpoints ? { checkpoints: {
      snapshot, changed: (state: ProjectState, before: string, after: string) => store.summarize(state, before, after),
    } } : {}) });
    cleanups.push(() => manager.close());
    const conversation = { sessionPath: path.join(directory, "offline-session.jsonl"), summary: { id: sessionManager.getSessionId(), projectId: project.id,
      title: "Offline", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0 } };
    const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true);
    cleanups.push(() => wait.mockRestore());
    return { project, conversation, manager, session, sessionManager, events, respond, prepare, resume, fail, complete, consumeUser, reason, wait, snapshot };
  }

  it.each(["qoder", "codex"] as const)("continues a safe %s turn limit without a second user message or checkpoint", async runtime => {
    const state = await setup(runtime), turn = state.manager.prompt(state.project, state.conversation, "Finish the saved task");
    await expect(turn.result).resolves.toBe("completed");
    expect(state.session.prompt).toHaveBeenCalledExactlyOnceWith("Finish the saved task");
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.resume).toHaveBeenCalledOnce();
    expect(state.wait).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    expect(state.session.messages.filter(message => (message as { role?: string }).role === "user")).toHaveLength(1);
    expect(state.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
    const retries = conversationItems(state.sessionManager.getBranch()).filter(item => item.type === "retry");
    expect(retries).toMatchObject([{ turnId: expect.any(String), status: "completed", attempt: 1 }]);
    expect(state.events.since(state.project.id).filter(event => (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed")
      && event.data.item.type === "retry").every(event => event.turnId === turn.turnId)).toBe(true);
    expect(state.events.since(state.project.id).filter(event => event.type === "agent.completed")).toHaveLength(1);
    expect(state.events.since(state.project.id).some(event => event.type === "agent.error")).toBe(false);
  });

  it.each(["transient", "runtime_interrupted"] as const)("continues a typed %s native interruption", async kind => {
    const state = await setup();
    state.respond.mockImplementation(async () => state.fail({ kind, source: "qoder", phase: "response-stream", terminalReason: "transport_lost" }));
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).resolves.toBe("completed");
    expect(state.resume).toHaveBeenCalledOnce(); expect(state.session.prompt).toHaveBeenCalledOnce();
  });

  it("does not continue a normal completion", async () => {
    const state = await setup(); state.respond.mockImplementation(async () => state.complete());
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).resolves.toBe("completed");
    expect(state.wait).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled();
  });

  it.each(["unknown", "blocked", "unclassified"] as const)("does not continue an %s native failure", async kind => {
    const state = await setup();
    state.respond.mockImplementation(async () => state.fail(kind === "unclassified" ? undefined : { kind, source: "qoder", terminalReason: "unknown" }));
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).rejects.toThrow("interrupted");
    expect(state.wait).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled();
  });

  it.each(["user", "host"] as const)("does not continue a native interruption cancelled by %s", async cancelOrigin => {
    const state = await setup();
    state.respond.mockImplementation(async () => state.fail({ kind: "runtime_interrupted", source: "qoder", terminalReason: "abort", cancelOrigin }));
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).rejects.toThrow("interrupted");
    expect(state.wait).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled();
  });

  it("stops after three continuations and preserves the original turn", async () => {
    const state = await setup(); state.resume.mockImplementation(async () => state.fail(state.reason));
    await expect(state.manager.prompt(state.project, state.conversation, "Finish once").result).rejects.toThrow("interrupted");
    expect(state.wait.mock.calls.map(([delay]) => delay)).toEqual([5_000, 15_000, 45_000]);
    expect(state.prepare).toHaveBeenCalledTimes(3); expect(state.resume).toHaveBeenCalledTimes(3); expect(state.session.prompt).toHaveBeenCalledOnce();
    expect(conversationItems(state.sessionManager.getBranch()).filter(item => item.type === "retry")).toMatchObject([{ attempt: 3, status: "failed" }]);
    expect(state.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
  });

  it("never sends continuation when preparing recovery fails", async () => {
    const state = await setup(); state.prepare.mockRejectedValue(new Error("Original tool outcome is unconfirmed"));
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).rejects.toThrow("unconfirmed");
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.resume).not.toHaveBeenCalled();
    expect(conversationItems(state.sessionManager.getBranch()).filter(item => item.type === "retry")).toMatchObject([{ status: "failed" }]);
  });

  it("gives manual cancellation priority when the interrupted request settles", async () => {
    const state = await setup(), pending = deferred();
    cleanups.push(() => pending.resolve());
    state.respond.mockImplementation(() => pending.promise);
    vi.mocked(state.session.abort).mockImplementation(async () => { state.fail(state.reason); pending.resolve(); });
    const turn = state.manager.prompt(state.project, state.conversation, "Finish");
    await vi.waitFor(() => expect(state.respond).toHaveBeenCalledOnce());
    await state.manager.cancel(state.project.id, state.conversation.summary.id, turn.turnId);
    await expect(turn.result).resolves.toBe("cancelled");
    expect(state.wait).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled();
    expect(state.events.since(state.project.id).some(event => event.type === "agent.error")).toBe(false);
  });

  it("cancels during backoff after recovery preparation without requesting continuation", async () => {
    const state = await setup(), waiting = deferred();
    let signal: AbortSignal | undefined;
    state.wait.mockImplementation((_delay, current) => new Promise(resolve => {
      signal = current; current.addEventListener("abort", () => resolve(false), { once: true }); waiting.resolve();
    }));
    const turn = state.manager.prompt(state.project, state.conversation, "Finish"); await waiting.promise;
    await state.manager.cancel(state.project.id, state.conversation.summary.id, turn.turnId);
    await expect(turn.result).resolves.toBe("cancelled");
    expect(signal?.aborted).toBe(true); expect(state.prepare).toHaveBeenCalledOnce(); expect(state.resume).not.toHaveBeenCalled();
    expect(conversationItems(state.sessionManager.getBranch()).filter(item => item.type === "retry")).toMatchObject([{ status: "completed" }]);
  });

  it("cancels recovery preparation before requesting continuation", async () => {
    const state = await setup(), preparing = deferred();
    state.prepare.mockImplementation(signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); preparing.resolve();
    }));
    const turn = state.manager.prompt(state.project, state.conversation, "Finish"); await preparing.promise;
    await state.manager.cancel(state.project.id, state.conversation.summary.id, turn.turnId);
    await expect(turn.result).resolves.toBe("cancelled"); expect(state.wait).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled();
  });

  it("does not resume after workspace files change during backoff and retains those edits", async () => {
    const state = await setup("qoder", true), file = path.join(state.project.workspacePath, "manual.txt");
    await writeFile(file, "Before backoff");
    state.wait.mockImplementation(async () => { await writeFile(file, "Edited during backoff"); return true; });
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).rejects.toThrow();
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.wait).toHaveBeenCalledOnce(); expect(state.resume).not.toHaveBeenCalled();
    expect(state.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await readFile(file, "utf8")).toBe("Edited during backoff");
    expect(state.session.prompt).toHaveBeenCalledOnce();
    expect(state.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
  });

  it("does not resume when the durable continuation marker leaves the current branch", async () => {
    const state = await setup(); let markerId: string | undefined;
    state.wait.mockImplementation(async () => {
      markerId = state.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === continuation.AUTO_CONTINUE_ENTRY)?.id;
      expect(markerId).toBeDefined();
      const user = state.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
      state.sessionManager.branch(user.id); return true;
    });
    await expect(state.manager.prompt(state.project, state.conversation, "Finish").result).rejects.toThrow();
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.resume).not.toHaveBeenCalled();
    expect(state.sessionManager.getBranch().some(entry => entry.id === markerId)).toBe(false);
    expect(state.sessionManager.getEntries().some(entry => entry.id === markerId)).toBe(true);
    expect(state.session.prompt).toHaveBeenCalledOnce();
  });

  it.each(["backoff", "preparation"] as const)("gives a new user instruction its own turn during %s", async phase => {
    const state = await setup(), entered = deferred();
    state.respond.mockImplementationOnce(async () => state.fail(state.reason)).mockImplementation(async () => state.complete());
    if (phase === "backoff") state.wait.mockImplementation((_delay, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(false), { once: true }); entered.resolve();
    }));
    else state.prepare.mockImplementation(signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered.resolve();
    }));
    const original = state.manager.prompt(state.project, state.conversation, "Original interrupted task");
    const stopped = expect(original.result).rejects.toThrow("interrupted");
    await entered.promise;
    const replacement = state.manager.prompt(state.project, state.conversation, "New user instruction");
    expect(replacement.queued).toBe(true);
    await stopped; await expect(replacement.result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(state.events.since(state.project.id).some(event => event.type === "agent.completed" && event.turnId === replacement.turnId)).toBe(true));
    expect(state.resume).not.toHaveBeenCalled(); expect(state.session.followUp).not.toHaveBeenCalled();
    expect(vi.mocked(state.session.prompt).mock.calls.map(([text]) => text)).toEqual(["Original interrupted task", "New user instruction"]);
    expect(state.session.messages.filter(message => (message as { role?: string }).role === "user")).toHaveLength(2);
    expect(state.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(2);
    const events = state.events.since(state.project.id);
    expect(events.filter(event => event.type === "agent.error").map(event => event.turnId)).toEqual([original.turnId]);
    expect(events.filter(event => event.type === "agent.completed").map(event => event.turnId)).toEqual([replacement.turnId]);
  });

  it.each(["completed", "failed"] as const)("acknowledges a replacement before its deferred task is %s", async outcome => {
    const state = await setup(), waiting = deferred(), pending = deferred();
    cleanups.push(() => pending.resolve());
    state.respond.mockImplementationOnce(async () => state.fail(state.reason)).mockImplementation(async () => {
      await pending.promise;
      if (outcome === "completed") state.complete();
      else state.fail({ kind: "blocked", source: "qoder", terminalReason: "unknown" });
    });
    state.wait.mockImplementation((_delay, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(false), { once: true }); waiting.resolve();
    }));
    const original = state.manager.prompt(state.project, state.conversation, "Original interrupted task");
    const stopped = expect(original.result).rejects.toThrow("interrupted");
    await waiting.promise;
    const replacement = state.manager.prompt(state.project, state.conversation, "New deferred task");
    expect(replacement.queued).toBe(true);
    await stopped; await expect(replacement.result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(state.respond).toHaveBeenCalledTimes(2));
    expect(state.manager.activeTurnId(state.project.id, state.conversation.summary.id)).toBe(replacement.turnId);
    expect(state.manager.agentState(state.conversation).status).toBe("running");
    const live = state.events.since(state.project.id).filter(event => event.turnId === replacement.turnId);
    expect(live.filter(event => event.type === "agent.started")).toHaveLength(1);
    expect(live.some(event => event.type === "agent.completed" || event.type === "agent.error")).toBe(false);

    pending.resolve();
    const terminal = outcome === "completed" ? "agent.completed" : "agent.error";
    await vi.waitFor(() => expect(state.events.since(state.project.id).some(event => event.type === terminal && event.turnId === replacement.turnId)).toBe(true));
    expect(state.manager.agentState(state.conversation).status).toBe(outcome === "completed" ? "idle" : "error");
    await expect(replacement.result).resolves.toBeUndefined();
    expect(vi.mocked(state.session.prompt).mock.calls.map(([text]) => text)).toEqual(["Original interrupted task", "New deferred task"]);
    expect(state.resume).not.toHaveBeenCalled(); expect(state.session.followUp).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed"] as const)("keeps the original retry scope when dispatched continuation consumes a %s follow-up", async outcome => {
    const state = await setup(), dispatched = deferred(), release = deferred();
    cleanups.push(() => release.resolve());
    let queuedText: string | undefined;
    vi.mocked(state.session.followUp!).mockImplementation(async text => { queuedText = text; });
    state.resume.mockImplementation(async () => {
      dispatched.resolve(); await release.promise;
      state.complete();
      await state.consumeUser(queuedText!);
      if (outcome === "completed") state.complete();
      else state.fail({ kind: "blocked", source: "qoder", terminalReason: "unknown" });
    });
    const original = state.manager.prompt(state.project, state.conversation, "Original interrupted task");
    const finished = outcome === "completed" ? expect(original.result).resolves.toBe("completed") : expect(original.result).rejects.toThrow("interrupted");
    await dispatched.promise;
    const followUp = state.manager.prompt(state.project, state.conversation, "Ordinary queued follow-up");
    expect(followUp.queued).toBe(true); await expect(followUp.result).resolves.toBeUndefined();
    expect(state.session.followUp).toHaveBeenCalledExactlyOnceWith("Ordinary queued follow-up", undefined);
    expect(state.resume).toHaveBeenCalledOnce();
    release.resolve(); await finished;

    const events = state.events.since(state.project.id);
    const completedRetries = events.filter(event => event.type === "item.completed" && event.data.item.type === "retry");
    expect(completedRetries).toHaveLength(1);
    expect(completedRetries[0]).toMatchObject({ turnId: original.turnId, data: { item: { type: "retry", turnId: original.turnId, status: "completed" } } });
    const retryRecords = state.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === continuation.AUTO_CONTINUE_ENTRY
      ? [entry.data as { item: { turnId: string; status: string } }] : []);
    expect(retryRecords.at(-1)?.item).toMatchObject({ turnId: original.turnId, status: "completed" });
    expect(retryRecords.some(record => record.item.status === "failed")).toBe(false);
    expect(events.filter(event => event.type === (outcome === "completed" ? "agent.completed" : "agent.error")).map(event => event.turnId)).toEqual([followUp.turnId]);
    expect(state.session.prompt).toHaveBeenCalledExactlyOnceWith("Original interrupted task");
    expect(state.session.messages.filter(message => (message as { role?: string }).role === "user")).toHaveLength(2);
  });
});

it("stops identical rejected media calls before a third model request and allows a corrected continuation", async () => {
  const validation = "generate_image: Omit maskPath. No generation was submitted.";
  const execute = vi.fn(async (_id: string, args: { prompt: string }) => {
    if (args.prompt === "Executed") throw new Error(validation);
    return { content: [{ type: "text" as const, text: "Fixture result" }], details: {} };
  });
  const tool: ToolDefinition = {
    name: "generate_image", label: "Image", description: "Fixture image",
    parameters: Type.Object({ prompt: Type.String(), maskPath: Type.Optional(Type.String()) }),
    prepareArguments(args) {
      if (typeof args === "object" && args && "maskPath" in args && args.maskPath === "null")
        throw new Error(validation);
      return args;
    },
    execute,
  };
  const { runtime, project, manager, conversation, sessionManager, events } = await fixture(undefined, undefined, [tool]);
  const call = (id: string, args: Record<string,string>) => ({ type: "toolCall" as const, id, name: tool.name, arguments: args });
  const bad = { prompt: "Front", maskPath: "null" };
  const replies = [
    assistant([call("1", bad)], "toolUse"), assistant([call("2", { maskPath: "null", prompt: "Front" })], "toolUse"),
  ];
  const infer = vi.fn(() => stream(replies.shift() ?? assistant([{ type: "text", text: "Done" }])));
  runtime.streamSimple = infer;
  await expect(manager.prompt(project, conversation, "Draw").result).rejects.toThrow("failed local validation twice");
  expect(infer).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
  expect(events.since(project.id).find(event => event.type === "agent.error")?.data).toMatchObject({ code: "repeated_media_arguments" });
  expect(conversationItems(sessionManager.getBranch())).toContainEqual(expect.objectContaining({
    type: "agentMessage", status: "failed", error: expect.objectContaining({ code: "repeated_media_arguments" }),
  }));
  replies.push(
    assistant([call("3", bad)], "toolUse"),
    assistant([call("4", bad), call("5", { prompt: "Side" })], "toolUse"),
    assistant([call("6", bad)], "toolUse"),
    assistant([call("7", { ...bad, prompt: "Back" })], "toolUse"),
    assistant([call("8", { prompt: "Executed" })], "toolUse"),
    assistant([call("9", { prompt: "Executed" })], "toolUse"),
    assistant([call("10", { prompt: "Front" })], "toolUse"),
  );
  await expect(manager.prompt(project, conversation, "Continue").result).resolves.toBe("completed");
  expect(execute).toHaveBeenCalledTimes(4);
});

function checkpointId(
  events: RuntimeEventBus,
  turnId: string,
): string | undefined {
  const event = events
    .since("project")
    .find(
      (candidate) =>
        candidate.type === "checkpoint.created" && candidate.turnId === turnId,
    );
  return event?.type === "checkpoint.created"
    ? event.data.checkpointId
    : undefined;
}
function rangeFor(
  session: SessionManager,
  events: RuntimeEventBus,
  turnId: string,
) {
  const id = checkpointId(events, turnId);
  return id ? turnRange(session.getBranch(), id) : undefined;
}

it("projects real edit/write diffs before the turn ends and restores them from disk", async () => {
  const { events, project, manager, conversation, runtime, sessionManager } =
    await fixture();
  await mkdir(path.join(project.workspacePath, "src"));
  await writeFile(
    path.join(project.workspacePath, "src/render.ts"),
    "const color = 'red';\nconst width = 1;\n",
  );
  const edited = deferred(),
    release = deferred();
  cleanups.push(() => release.resolve());
  let calls = 0;
  runtime.streamSimple = () => {
    if (calls++ === 0)
      return stream(
        assistant(
          [
            {
              type: "toolCall",
              id: "edit",
              name: "edit",
              arguments: {
                path: "src/render.ts",
                oldText: "const color = 'red';\nconst width = 1;",
                newText: "const color = 'green';\nconst width = 2;\nconst height = 3;",
              },
            },
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "notes.txt", content: "first\nsecond\n" },
            },
          ],
          "toolUse",
        ),
      );
    const output = createAssistantMessageEventStream();
    edited.resolve();
    void release.promise.then(() =>
      output.push({
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "Done" }]),
      }),
    );
    return output;
  };
  const turn = manager.prompt(
    project,
    conversation,
    "Edit two blocks and write notes",
  );
  await Promise.race([
    edited.promise,
    turn.result!.then(() => {
      throw new Error("Turn ended before inspection");
    }),
  ]);
  const live = events
    .since(project.id)
    .flatMap((event) =>
      event.type === "item.completed" &&
      event.data.item.type === "dynamicToolCall"
        ? [event.data.item]
        : [],
    );
  expect(live).toHaveLength(2);
  // File tools can complete in either order; each result belongs to its call.
  const edit = live.find((item) => item.toolCallId === "edit");
  const write = live.find((item) => item.toolCallId === "write");
  expect(edit).toMatchObject({
    tool: "edit",
    status: "completed",
    output: "Project file edited.",
    lineChanges: { added: 3, removed: 2 },
  });
  expect(edit?.fileDiff?.hunks.flat().map((line) => line.text)).toContain(
    "const color = 'green';",
  );
  expect(write).toMatchObject({
    tool: "write",
    lineChanges: { added: 2, removed: 0 },
    fileDiff: {
      hunks: [
        [
          { kind: "added", text: "first", after: 1 },
          { kind: "added", text: "second", after: 2 },
        ],
      ],
    },
  });
  expect(
    events.since(project.id).some((event) => event.type === "agent.completed"),
  ).toBe(false);
  release.resolve();
  await turn.result;
  const savedItems = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  );
  expect(savedItems.find((item) => item.type === "userMessage")).toMatchObject({
    changes: {
      files: 2,
      items: [
        { path: "notes.txt", kind: "added", lines: { added: 2, removed: 0 } },
        {
          path: "src/render.ts",
          kind: "modified",
          lines: { added: 3, removed: 2 },
        },
      ],
    },
  });
  const restored = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  ).filter((item) => item.type === "dynamicToolCall");
  expect(restored).toHaveLength(live.length);
  expect(
    restored.map(({ toolCallId, lineChanges, fileDiff }) => ({
      toolCallId,
      lineChanges,
      fileDiff,
    })),
  ).toEqual(
    expect.arrayContaining(
      live.map(({ toolCallId, lineChanges, fileDiff }) => ({
        toolCallId,
        lineChanges,
        fileDiff,
      })),
    ),
  );
  const olderEntries = SessionManager.open(
    sessionManager.getSessionFile()!,
  ).getBranch();
  for (const entry of olderEntries) {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "edit"
    ) {
      const details = entry.message.details as { patch?: string };
      delete details.patch;
    }
  }
  expect(
    conversationItems(olderEntries).find(
      (item) => item.type === "dynamicToolCall" && item.tool === "edit",
    ),
  ).toMatchObject({
    lineChanges: { added: 3, removed: 2 },
    fileDiff: { hunks: expect.any(Array) },
  });
});

it("sanitizes leaked thinking before saving and sending the next prompt", async () => {
  const { manager, project, conversation, sessionManager, runtime } = await fixture();
  const contexts: unknown[] = [];
  let calls = 0;
  runtime.streamSimple = (_model, context) => {
    contexts.push(context);
    calls += 1;
    return stream(assistant([{ type: "text", text: calls === 1 ? "<thinking>private</thinking>Answer" : "Follow-up" }]));
  };

  await expect(manager.prompt(project, conversation, "Build").result).resolves.toBe("completed");
  const saved = sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  expect(saved?.type === "message" && saved.message.role === "assistant" ? saved.message.content : undefined).toEqual([
    { type: "text", text: "Answer" },
  ]);

  await expect(manager.prompt(project, conversation, "Continue").result).resolves.toBe("completed");
  const previous = contexts[1] as { messages: Array<{ role: string; content: unknown }> } | undefined;
  expect(previous?.messages.findLast((message) => message.role === "assistant")?.content).toEqual([
    { type: "text", text: "Answer" },
  ]);
});

it("captures consumed follow-ups and steering at file boundaries, rather than enqueue time", async () => {
  const {
    events,
    project,
    session,
    sessionManager,
    store,
    manager,
    conversation,
    snapshot,
    runtime,
  } = await fixture();
  const firstRequest = deferred(),
    release = deferred();
  cleanups.push(() => release.resolve());
  let calls = 0;
  runtime.streamSimple = (_model, context) => {
    if (calls++ === 0) {
      firstRequest.resolve();
      const output = createAssistantMessageEventStream();
      void release.promise.then(() =>
        output.push({
          type: "done",
          reason: "toolUse",
          message: assistant(
            [
              {
                type: "toolCall",
                id: "write-first",
                name: "write",
                arguments: { path: "game.txt", content: "first" },
              },
            ],
            "toolUse",
          ),
        }),
      );
      return output;
    }
    const user = context.messages.findLast(
      (message) => message.role === "user",
    );
    const text = JSON.stringify(user?.content);
    if (context.messages.at(-1)?.role === "toolResult")
      return stream(assistant([{ type: "text", text: "Done" }]));
    return stream(
      assistant(
        [
          {
            type: "toolCall",
            id: `write-${calls}`,
            name: "write",
            arguments: {
              path: "game.txt",
              content: text.includes("Steer") ? "steered" : "followed",
            },
          },
        ],
        "toolUse",
      ),
    );
  };
  const first = manager.prompt(project, conversation, "First");
  await Promise.race([
    firstRequest.promise,
    first.result!.then(() => {
      throw new Error("Run settled before inference");
    }),
  ]);
  const follow = manager.prompt(project, conversation, "Follow");
  await follow.result;
  const steer = manager.prompt(project, conversation, "Steer");
  await steer.result;
  await manager.steerPending(project.id, conversation.summary.id, steer.turnId);
  expect(snapshot).toHaveBeenCalledTimes(1);
  release.resolve();
  await first.result;
  expect(snapshot).toHaveBeenCalledTimes(4);
  const firstRange = rangeFor(sessionManager, events, first.turnId)!;
  const steerRange = rangeFor(sessionManager, events, steer.turnId)!;
  const followRange = rangeFor(sessionManager, events, follow.turnId)!;
  expect(
    Buffer.from(
      (await store.read(project, firstRange.after!, "game.txt"))!,
    ).toString(),
  ).toBe("first");
  expect(
    Buffer.from(
      (await store.read(project, steerRange.before, "game.txt"))!,
    ).toString(),
  ).toBe("first");
  expect(
    Buffer.from(
      (await store.read(project, followRange.before, "game.txt"))!,
    ).toString(),
  ).toBe("steered");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("followed");
  const restarted = SessionManager.open(
    sessionManager.getSessionFile()!,
  ).getBranch();
  const users = conversationItems(restarted, false).filter(
    (item) => item.type === "userMessage",
  );
  expect(users.map((item) => item.checkpointId)).toEqual([
    checkpointId(events, first.turnId),
    checkpointId(events, steer.turnId),
    checkpointId(events, follow.turnId),
  ]);
});

it("fails closed before inference/tools when the before checkpoint fails", async () => {
  const { events, project, session, manager, conversation, runtime } =
    await fixture(async () => {
      throw new Error("snapshot disk failure");
    });
  const inference = vi.fn(() =>
    stream(
      assistant(
        [
          {
            type: "toolCall",
            id: "write",
            name: "write",
            arguments: { path: "bad.txt", content: "bad" },
          },
        ],
        "toolUse",
      ),
    ),
  );
  runtime.streamSimple = inference;
  await expect(
    manager.prompt(project, conversation, "Write").result,
  ).rejects.toThrow("snapshot disk failure");
  expect(inference).not.toHaveBeenCalled();
  await expect(
    readFile(path.join(project.workspacePath, "bad.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("records partial files on cancellation without rewinding the conversation", async () => {
  const {
    events,
    project,
    session,
    sessionManager,
    manager,
    conversation,
    snapshot,
    runtime,
  } = await fixture();
  const written = deferred();
  let calls = 0;
  runtime.streamSimple = (_model, _context, options) => {
    if (calls++ === 0)
      return stream(
        assistant(
          [
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "partial.txt", content: "partial" },
            },
          ],
          "toolUse",
        ),
      );
    const output = createAssistantMessageEventStream();
    written.resolve();
    options?.signal?.addEventListener(
      "abort",
      () =>
        output.push({
          type: "error",
          reason: "aborted",
          error: assistant([], "aborted"),
        }),
      { once: true },
    );
    return output;
  };
  const turn = manager.prompt(project, conversation, "Write then wait");
  await Promise.race([
    written.promise,
    turn.result!.then(() => {
      throw new Error("Run settled before write");
    }),
  ]);
  await manager.cancel(project.id, conversation.summary.id, turn.turnId);
  await expect(turn.result).resolves.toBe("cancelled");
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(rangeFor(sessionManager, events, turn.turnId)?.after).toBeDefined();
  expect(
    await readFile(path.join(project.workspacePath, "partial.txt"), "utf8"),
  ).toBe("partial");
  expect(
    conversationItems(sessionManager.getBranch()).some(
      (item) => item.type === "userMessage",
    ),
  ).toBe(true);
});

it("bounds preview reads of highly compressed files and validates readable blobs", async () => {
  const { events, project, store } = await fixture();
  await writeFile(
    path.join(project.workspacePath, "huge.txt"),
    "a".repeat(2 * 1024 * 1024),
  );
  await writeFile(path.join(project.workspacePath, "small.txt"), "small");
  const snapshot = await store.snapshot(project);
  await expect(
    store.read(project, snapshot, "huge.txt", 256 * 1024),
  ).rejects.toBeInstanceOf(CheckpointFileTooLargeError);
  expect(
    Buffer.from(
      (await store.read(project, snapshot, "small.txt", 256 * 1024))!,
    ).toString(),
  ).toBe("small");
});

it("keeps failed turn changes reviewable and closes the after checkpoint before reporting failure", async () => {
  const { events, project, manager, conversation, runtime, sessionManager } =
    await fixture();
  let calls = 0;
  runtime.streamSimple = () =>
    calls++ === 0
      ? stream(
          assistant(
            [
              {
                type: "toolCall",
                id: "write",
                name: "write",
                arguments: { path: "failed.txt", content: "partial failure" },
              },
            ],
            "toolUse",
          ),
        )
      : stream({ ...assistant([], "error"), errorMessage: "model failure" });
  const turn = manager.prompt(project, conversation, "Write");
  await expect(turn.result).rejects.toThrow("model failure");
  expect(rangeFor(sessionManager, events, turn.turnId)?.after).toBeDefined();
  expect(
    await readFile(path.join(project.workspacePath, "failed.txt"), "utf8"),
  ).toBe("partial failure");
});

it("marks a missing after snapshot unavailable instead of presenting a complete range", async () => {
  let calls = 0;
  const { project, manager, conversation, runtime, sessionManager, events } =
    await fixture(async () => {
      if (calls++ === 0) return "a".repeat(40);
      throw new Error("after snapshot failure");
    });
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const turn = manager.prompt(project, conversation, "Read");
  await expect(turn.result).resolves.toBe("completed");
  expect(rangeFor(sessionManager, events, turn.turnId)).toBeUndefined();
  const id = checkpointId(events, turn.turnId);
  const entry = sessionManager.getBranch().find((entry) => entry.id === id);
  expect(
    entry?.type === "custom"
      ? parseStoredCheckpoint(entry.data)?.commit
      : undefined,
  ).toBe("a".repeat(40));
  expect(
    events
      .since(project.id)
      .some((event) => event.type === "checkpoint.completed"),
  ).toBe(false);
});

it("adds the durable workspace notice to later model requests", async () => {
  const { events, project, manager, conversation, runtime } = await fixture();
  const { writeWorkspaceNotice } =
    await import("../src/daemon/workspace-notice.js");
  await writeWorkspaceNotice(
    project,
    "User undid the title change. Inspect current files.",
  );
  const inference = vi.fn((_model, context) => {
    expect(JSON.stringify(context)).toContain("User undid the title change");
    return stream(assistant([{ type: "text", text: "Done" }]));
  });
  runtime.streamSimple = inference;
  await manager.prompt(project, conversation, "Continue").result;
  expect(inference).toHaveBeenCalledOnce();
});

it.each([false, "metadata"] as const)("drains %s writes, refuses new stale writes and lets other projects proceed", async (access) => {
  const writes = new ProjectWrites(),
    held = await writes.enter("one", access),
    restored = deferred();
  const operation = writes.exclusive("one", async () => {
    writes.changed("one");
    restored.resolve();
  });
  await Promise.resolve();
  await expect(writes.enter("one", false)).rejects.toThrow("being checkpointed");
  await expect(writes.enter("one", "metadata")).rejects.toThrow("being checkpointed");
  const other = await writes.enter("two", false);
  other();
  held();
  await operation;
  await restored.promise;
  await expect(writes.enter("one", false, "0")).rejects.toThrow("was restored");
  const version = writes.version("one");
  const metadata = await writes.enter("one", "metadata", "0");
  metadata();
  expect(writes.version("one")).toBe(version);
  const current = await writes.enter("one", false, writes.version("one"));
  current();
  await expect(
    writes.exclusive("one", async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  const next = await writes.enter("one", false, writes.version("one"));
  next();
});

it("lets reads through a snapshot and holds writes until it ends", async () => {
  const writes = new ProjectWrites(),
    reading = deferred();
  const snapshot = writes.snapshot("one", () => reading.promise);
  // A snapshot only reads the workspace, so a read need not wait for it.
  const read = await writes.enter("one", true);
  read();
  let wrote = false;
  const write = writes.enter("one", false).then((release) => {
    wrote = true;
    release();
  });
  let renamed = false;
  const metadata = writes.enter("one", "metadata").then((release) => {
    renamed = true;
    release();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(wrote).toBe(false);
  expect(renamed).toBe(false);
  reading.resolve();
  await snapshot;
  await write;
  await metadata;
  expect(wrote).toBe(true);
  expect(renamed).toBe(true);
});

it("holds reads until a restore finishes, so they read the restored workspace", async () => {
  const writes = new ProjectWrites(),
    restoring = deferred();
  const restore = writes.exclusive("one", async () => {
    await restoring.promise;
    writes.changed("one");
  });
  let versionRead: string | undefined;
  const read = writes.enter("one", true).then((release) => {
    versionRead = writes.version("one");
    release();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(versionRead).toBeUndefined();
  restoring.resolve();
  await restore;
  await read;
  expect(versionRead).toBe(writes.version("one"));
  expect(versionRead).not.toBe("0");
});

it("refuses a read that waits too long for a restore", async () => {
  vi.useFakeTimers();
  try {
    const writes = new ProjectWrites(),
      restoring = deferred();
    const restore = writes.exclusive("one", () => restoring.promise);
    const read = writes.enter("one", true);
    const refused = expect(read).rejects.toThrow("being checkpointed");
    await vi.advanceTimersByTimeAsync(120_000);
    await refused;
    restoring.resolve();
    await restore;
  } finally {
    vi.useRealTimers();
  }
});

it("waits for an HTTP write handler even after its client disconnects", async () => {
  const app = Fastify(),
    writes = new ProjectWrites();
  const entered = deferred(),
    release = deferred();
  const order: string[] = [];
  writes.install(app);
  app.addHook("preHandler", async (request) => {
    writes.track(request, await writes.enter("one", false));
  });
  app.post("/write", async () => {
    entered.resolve();
    await release.promise;
    order.push("write");
    return {};
  });
  cleanups.push(
    () => app.close(),
    () => release.resolve(),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(`${address}/write`, { method: "POST" });
  client.on("error", () => {});
  client.end();
  cleanups.push(() => client.destroy());
  await entered.promise;
  const restore = writes.exclusive("one", async () => {
    order.push("restore");
  });
  client.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(order).toEqual([]);
  release.resolve();
  await restore;
  expect(order).toEqual(["write", "restore"]);
});

it.each([false, "metadata"] as const)("waits for a %s write handler that continues after sending its response", async (access) => {
  const app = Fastify();
  const writes = new ProjectWrites();
  const release = deferred();
  const order: string[] = [];
  writes.install(app);
  app.addHook("preHandler", async (request) => {
    writes.track(request, await writes.enter("one", access));
  });
  app.post("/write", async (_request, reply) => {
    reply.send({ accepted: true });
    await release.promise;
    order.push("write");
  });
  cleanups.push(
    () => app.close(),
    () => release.resolve(),
  );
  expect((await app.inject({ method: "POST", url: "/write" })).statusCode).toBe(
    200,
  );
  const restoring = writes.exclusive("one", async () => {
    order.push("restore");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(order).toEqual([]);
  release.resolve();
  await restoring;
  expect(order).toEqual(["write", "restore"]);
});

it("associates an initial consumed message correctly when a follow-up arrives during session loading", async () => {
  const loading = deferred();
  cleanups.push(() => loading.resolve());
  const {
    events,
    project,
    manager,
    conversation,
    runtime,
    sessionManager,
    snapshot,
  } = await fixture(undefined, loading.promise);
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const first = manager.prompt(project, conversation, "First");
  const queued = manager.prompt(
    project,
    conversation,
    "Queued before first message",
  );
  expect(snapshot).not.toHaveBeenCalled();
  loading.resolve();
  await queued.result;
  await first.result;
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(
    conversationItems(sessionManager.getBranch())
      .filter((item) => item.type === "userMessage")
      .map((item) => item.checkpointId),
  ).toEqual([
    checkpointId(events, first.turnId),
    checkpointId(events, queued.turnId),
  ]);
});

it("edits conversation history while preserving files and checkpoints the current files for the replacement", async () => {
  const {
    events,
    project,
    manager,
    conversation,
    runtime,
    sessionManager,
    store,
  } = await fixture();
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  const original = manager.prompt(project, conversation, "First");
  await original.result;
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "Later manual edit",
  );
  const revised = await manager.reviseLast(
    project,
    conversation,
    "Replacement",
    async (reference) => reference,
  );
  await revised.result;
  const checkpoint = rangeFor(sessionManager, events, revised.turnId)!;
  expect(
    Buffer.from(
      (await store.read(project, checkpoint.before, "game.txt"))!,
    ).toString(),
  ).toBe("Later manual edit");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("Later manual edit");
  const users = conversationItems(
    SessionManager.open(sessionManager.getSessionFile()!).getBranch(),
  ).filter((item) => item.type === "userMessage");
  expect(users.map((item) => item.text)).toEqual(["Replacement"]);
});

it("reports checkpoint creation and completion as separate immutable events", async () => {
  const { project, manager, conversation, runtime, events } = await fixture();
  runtime.streamSimple = () =>
    stream(assistant([{ type: "text", text: "Done" }]));
  await manager.prompt(project, conversation, "First").result;
  const created = events
    .since(project.id)
    .find((event) => event.type === "checkpoint.created");
  const completed = events
    .since(project.id)
    .find((event) => event.type === "checkpoint.completed");
  expect(created?.data).toEqual({
    checkpointId:
      completed?.type === "checkpoint.completed"
        ? completed.data.checkpointId
        : undefined,
  });
  expect(completed?.data).toMatchObject({ files: 0 });
});

it("blocks inference if the durable workspace notice cannot be read", async () => {
  const { events, project, manager, conversation, runtime } = await fixture();
  await mkdir(path.join(project.storagePath!, "workspace-restore-notice.txt"));
  const inference = vi.fn(() =>
    stream(assistant([{ type: "text", text: "Done" }])),
  );
  runtime.streamSimple = inference;
  await expect(
    manager.prompt(project, conversation, "Continue").result,
  ).rejects.toThrow();
  expect(inference).not.toHaveBeenCalled();
});
