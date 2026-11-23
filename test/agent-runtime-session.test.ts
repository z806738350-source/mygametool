import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, authorizeConversationAttachment, conversationItems } from "../src/daemon/agent.js";
import { createHash } from "node:crypto";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import { CHECKPOINT_ENTRY } from "../src/daemon/checkpoint-extension.js";
import type { StoredConversation } from "../src/daemon/conversations.js";
import {
  NATIVE_SESSION_ENTRY,
  NativeCodingSession,
  NativeSessionExpiredError,
  latestNativeSession,
  type NativeDriver,
  type NativeTurnInput,
  type NativeTurnOutcome,
  type NativeTurnSink,
} from "../src/daemon/agent-runtimes/native-session.js";
import type {
  AgentUsageLimit,
  ProjectState,
  RuntimeEvent,
  ThreadItem,
} from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { AgentRuntimeId } from "../src/shared/agent-runtimes.js";
import { handoffSummary } from "../src/daemon/agent-runtimes/handoff.js";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";
import { annotateIsolatedRepairPublication, createIsolatedRepairPending, createIsolatedRepairProof, getRepairTargets, inheritIsolatedRepairPending, inheritIsolatedRepairProof, isolatedInputBudgetError, reportIsolatedOperation, settleIsolatedRepair } from "../src/daemon/isolated-tool-receipts.js";
import * as continuation from "../src/daemon/agent-auto-continue.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { createGameUseTool } from "../src/daemon/playtest-tools.js";
import { WEB_GAME_USE_CAPABILITIES, playtestActionError, playtestOpenError, type GameRuntimeAdapter } from "../src/shared/playtest.js";
import { Type } from "typebox";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";
import { findAnimationAction } from "../src/daemon/agent-canvas-media.js";
import { tripoActions } from "../src/shared/model3d-operations.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { volumeMigrationReview, volumeMigrationConfirmation } from "./volume-migration-fixture.js";
import type { VolumeMigrationReview } from "../src/shared/volume-migration.js";

it.each(["codex-cli", "qoder-cli"].flatMap(runtime => [false, true].map(pending => ({ runtime: runtime as "codex-cli" | "qoder-cli", pending }))))("runs $runtime repair-only tools and persists a separate effects-recovered resolution (ACK pending=$pending)", async ({ runtime, pending }) => {
  const project: ProjectState = { id: "11111111-1111-4111-8111-111111111111", name: "Offline fixture", type: "general", workspacePath: "/tmp/native-repair-chain", updatedAt: new Date(0).toISOString(), preview: { status: "waiting" } };
  const stored: StoredConversation = { sessionPath: "/tmp/native-repair-chain/session.jsonl", summary: { id: "repair-conversation", projectId: project.id, title: "Offline", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageCount: 0 } };
  const manager = SessionManager.inMemory(project.workspacePath), snapshot = vi.fn(async () => "1".repeat(40));
  const binding = { scope: "project_command" as const, namespace: "test" as const, projectId: project.id, operationId: "a".repeat(32), mode: "shell" as const };
  let current = "before";
  const original = vi.fn(async (_id: string, input: { command: string }) => { if (input.command === "corrected") { current = "corrected"; return { content: [{ type: "text" as const, text: "Corrected command completed" }], details: {} }; } for (const phase of ["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "retained", "released"] as const)
    await reportIsolatedOperation({ ...binding, phase, ...(["input_preflight", "prepare_submitting"].includes(phase) ? {} : { generation: 1 }), ...(["captured", "retained", "released"].includes(phase) ? { snapshotId: "b".repeat(64) } : {}) }); throw new Error("Original command return failed"); });
  const write = vi.fn(async (_id: string, input: { path: string; content: string }) => { current = input.content; return { content: [{ type: "text" as const, text: "Saved corrected change" }], details: {} }; });
  const reads = vi.fn(async () => ({ content: [{ type: "text" as const, text: current }], details: {} }));
  const trace: string[] = [];
  let agent!: AgentManager;
  const repair = vi.fn(async (_id: string, input: { action: string }) => {
    trace.push(input.action); expect(getRepairTargets()).toHaveLength(input.action === "verify" ? 2 : 1);
    if (!["adopt", "verify"].includes(input.action)) return { content: [{ type: "text" as const, text: `Fresh ${input.action}` }], details: {} };
    current = "restored"; agent.invalidateProjectSessions(project.id);
    const proof = {
      namespace: "test", projectId: project.id, generation: 1, rawSnapshotId: "b".repeat(64), preparedBatchId: "c".repeat(64), reviewId: "d".repeat(64), preparedSnapshotId: "e".repeat(64), hostTargetFingerprint: "f".repeat(64), publicationId: "22222222-2222-4222-8222-222222222222", recoveryOperationId: "c".repeat(32),
      originOperations: [{ operationId: binding.operationId, mode: "shell", snapshotId: "b".repeat(64) }], allOriginalsDurable: true, acknowledged: true, released: true,
    } as const;
    if (pending && input.action === "adopt") { const { acknowledged: _, ...unconfirmed } = proof; throw inheritIsolatedRepairPending(new Error("Publication exists but ACK must be verified"), createIsolatedRepairPending({ ...unconfirmed, publicationVerified: true })); }
    const result = inheritIsolatedRepairProof({ content: [{ type: "text" as const, text: "Exact original effects recovered; read current files" }], details: {} }, createIsolatedRepairProof(proof));
    annotateIsolatedRepairPublication(result, "owned-publication"); expect(await settleIsolatedRepair(result)).toBe(pending ? 2 : 1); return result;
  });
  const tools = [defineTool({ name: "isolated_shell", label: "Original", description: "Offline", parameters: Type.Object({ command: Type.String() }), execute: original }),
    defineTool({ name: "write", label: "Write", description: "Offline", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: write }),
    defineTool({ name: runtime === "codex-cli" ? "read_project_file" : "read", label: "Read", description: "Offline controlled project read", parameters: Type.Object({ path: Type.String() }), execute: reads }),
    defineTool({ name: "recover_isolated_changes", label: "Recover", description: "Offline controlled recovery", parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("review"), Type.Literal("optimize"), Type.Literal("adopt"), Type.Literal("verify")]), reviewId: Type.Optional(Type.String()) }), execute: repair })];
  const guard = new AutoContinueTools(tools, { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), runtime === "qoder-cli");
  expect(JSON.stringify(bridge.list().find(tool => tool.name === "recover_isolated_changes")?.inputSchema)).toContain("optimize");
  expect(bridge.names).not.toContain("bash");
  if (runtime === "codex-cli") { expect(bridge.names).toContain("read_project_file"); expect(bridge.names).not.toContain("read"); expect(bridge.names).not.toContain("write"); }
  const invoke = async (sink: NativeTurnSink, id: string, name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    sink.toolCall(id, name, args); const result = await bridge.call(name, args, id, signal); sink.toolResult(id, result.result, result.isError); return result;
  };
  const finish = async (sink: NativeTurnSink, signal: AbortSignal) => {
    const mutation = runtime === "codex-cli" ? "isolated_shell" : "write";
    const args = runtime === "codex-cli" ? { command: "corrected" } : { path: "game.txt", content: "corrected" };
    expect((await invoke(sink, "needs-read", mutation, args, signal)).isError).toBe(true);
    expect((await invoke(sink, "original-command", "isolated_shell", { command: "original" }, signal)).isError).toBe(true);
    expect((await invoke(sink, "new-id-original-command", "isolated_shell", { command: "original" }, signal)).isError).toBe(true);
    expect((await invoke(sink, "read-current", runtime === "codex-cli" ? "read_project_file" : "read", { path: "game.txt" }, signal)).isError).toBe(false);
    expect((await invoke(sink, "corrected-write", mutation, args, signal)).isError).toBe(false);
    sink.textDone("done", "Corrected work completed"); return { status: "completed" as const };
  };
  const interrupted = () => ({ status: "failed" as const, error: "Native segment limit", interruption: { kind: "turn_limit" as const, source: runtime === "qoder-cli" ? "qoder" as const : "codex" as const, code: "fixture_max_turns" } });
  const scripts: Script[] = [async (_input, sink, signal) => {
    expect((await invoke(sink, "original-command", "isolated_shell", { command: "original" }, signal)).isError).toBe(true);
    return interrupted();
  }, async (input, sink, signal) => {
    expect(input.text).toContain("Repair-only continuation");
    const mutation = runtime === "codex-cli" ? "isolated_shell" : "write";
    const args = runtime === "codex-cli" ? { command: "corrected" } : { path: "game.txt", content: "corrected" };
    expect((await invoke(sink, "blocked-write", mutation, args, signal)).isError).toBe(true);
    for (const [id, action] of [["inspect-1", "inspect"], ["inspect-2", "inspect"], ["review-1", "review"], ["optimize-1", "optimize"], ["review-2", "review"]])
      expect((await invoke(sink, id!, "recover_isolated_changes", { action }, signal)).isError).toBe(false);
    expect((await invoke(sink, "adopt-1", "recover_isolated_changes", { action: "adopt", reviewId: "d".repeat(64) }, signal)).isError).toBe(pending);
    return pending ? interrupted() : finish(sink, signal);
  }];
  if (pending) scripts.push(async (input, sink, signal) => {
    expect(input.text).toContain("Verification-only");
    expect((await invoke(sink, "adopt-must-not-repeat", "recover_isolated_changes", { action: "adopt", reviewId: "d".repeat(64) }, signal)).isError).toBe(true);
    expect((await invoke(sink, "verify-1", "recover_isolated_changes", { action: "verify", reviewId: "d".repeat(64) }, signal)).isError).toBe(false);
    return finish(sink, signal);
  });
  const drivers: ScriptedDriver[] = [];
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard, snapshotBeforeMessage: snapshot, toolNames: bridge.names,
    createDriver: () => { const driver = new ScriptedDriver(scripts, undefined); drivers.push(driver); return driver; }, setActiveTools: names => bridge.setActive(names), requestApproval: async () => "deny" });
  agent = new AgentManager(new RuntimeEventBus(), { createSession: async () => session, activeToolNames: () => ["read", "write", "edit", ...bridge.names] });
  const wait = vi.spyOn(continuation, "waitForContinuation").mockResolvedValue(true);
  try {
    await expect(agent.prompt(project, stored, "Complete the original task through controlled repair").result).resolves.toBe("completed");
    expect(wait).toHaveBeenCalledTimes(pending ? 2 : 1); expect(drivers.flatMap(driver => driver.inputs)).toHaveLength(pending ? 3 : 2);
    expect(snapshot).toHaveBeenCalledOnce(); expect(original.mock.calls.filter(call => call[1].command === "original")).toHaveLength(1); expect(original).toHaveBeenCalledTimes(runtime === "codex-cli" ? 2 : 1); expect(write).toHaveBeenCalledTimes(runtime === "codex-cli" ? 0 : 1); expect(reads).toHaveBeenCalledOnce(); expect(current).toBe("corrected");
    expect(trace).toEqual(["inspect", "inspect", "review", "optimize", "review", "adopt", ...(pending ? ["verify"] : [])]);
    const branch = manager.getBranch(); expect(branch.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(branch.findLast(entry => entry.type === "custom" && entry.customType === "ohmygame-tool-attempt" && (entry.data as { callId: string }).callId === "original-command")).toMatchObject({ data: { state: "effects_recovered" } });
    expect(branch.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === (pending ? "verify-1" : "adopt-1"))).toMatchObject({ message: { isError: false, isolatedRepairResolutions: expect.arrayContaining([expect.objectContaining({ callId: "original-command", operationId: binding.operationId, rawSnapshotId: "b".repeat(64), workspaceVersion: "owned-publication" })]) } });
    expect(handoffSummary(branch)).toContain('"state":"effects_recovered"');
    const restored = new AutoContinueTools(tools, { sessionManager: manager }); const user = branch.find(entry => entry.type === "message" && entry.message.role === "user")!; restored.reset(user.id);
    await restored.prepare(new AbortController().signal); expect(restored.recoverySummary).toContain("effects_recovered");
    await expect(restored.wrap()[0]!.execute("original-command", { command: "original" }, undefined, undefined, {} as never)).rejects.toThrow("Original command return failed");
  } finally { wait.mockRestore(); await agent.close(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("preserves project-command receipt scope through %s canonical results and safe continuation", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-isolated-command-receipts"), snapshot = vi.fn(async () => "1".repeat(40));
  const binding = { scope: "project_command" as const, namespace: "test" as const, projectId: "11111111-1111-4111-8111-111111111111", operationId: "a".repeat(32) };
  const execute = vi.fn(async (_id: string, input: { command: string }) => {
    if (input.command === "original") {
      await reportIsolatedOperation({ ...binding, phase: "input_preflight" });
      const cause = isolatedInputBudgetError("Source input exceeds its budget");
      await reportIsolatedOperation({ ...binding, phase: "input_rejected", rejection: "input_budget" }, cause);
      throw cause;
    }
    return { content: [{ type: "text" as const, text: "Corrected local command completed" }], details: {} };
  });
  const tool = defineTool({ name: "isolated_shell", label: "Offline command", description: "Offline receipt fixture", parameters: Type.Object({ command: Type.String() }), execute });
  const guard = new AutoContinueTools([tool], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const invoke = async (sink: NativeTurnSink, callId: string, command: string, signal: AbortSignal) => {
    sink.toolCall(callId, "isolated_shell", { command }); const outcome = await bridge.call("isolated_shell", { command }, callId, signal); sink.toolResult(callId, outcome.result, outcome.isError);
  };
  const scripts: Script[] = [async (_input, sink, signal) => {
    await invoke(sink, "original-rejected", "original", signal);
    return { status: "failed", error: "Native segment ended", interruption: { kind: "turn_limit", source: runtime === "qoder-cli" ? "qoder" : "codex", code: "fixture_max_turns" } };
  }, async (input, sink, signal) => {
    expect(input.text).toContain("command_not_submitted"); expect(input.text).toContain("VM startup or preview pauses may already have occurred");
    await invoke(sink, "original-rejected", "original", signal);
    await invoke(sink, "new-corrected", "changed", signal);
    return { status: "completed" };
  }];
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard, snapshotBeforeMessage: snapshot, toolNames: ["isolated_shell"], createDriver: () => new ScriptedDriver(scripts, undefined), requestApproval: async () => "deny" });
  try {
    await session.prompt("Correct only the unsubmitted project command");
    expect(manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult")).toMatchObject({ message: { isError: true, isolatedOperations: [{ ...binding, phase: "input_preflight" }, { ...binding, phase: "input_rejected", rejection: "input_budget" }] } });
    const summary = handoffSummary(manager.getBranch())!;
    expect(summary).toContain('"state":"command_not_submitted"'); expect(summary).toContain(binding.operationId); expect(summary).not.toContain('"effect":"none"');
    await session.prepareContinuation(new AbortController().signal); await session.resumeAfterInterruption();
    expect(execute).toHaveBeenCalledTimes(2); expect(snapshot).toHaveBeenCalledOnce();
    expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(session.interruption).toBeUndefined();
  } finally { await session.dispose(); }
});

it.each(["correctable", "blocked", "no-stage", "wrong-task", "wrong-call", "wrong-tool", "unknown-stage", "unknown-then-preflight", "changed-arguments", "changed-tool", "native-missing-marker", "successful-result", "forged-details"] as const)("requires paired host evidence for %s preflight handoff records", scenario => {
  const manager = SessionManager.inMemory("/tmp/preflight-handoff-fixture");
  const proof = scenario === "blocked" ? { effect: "none", reason: "approval_required", disposition: "blocked" } : { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" };
  manager.appendMessage({ role: "user", content: "Keep the original tool receipts", timestamp: 1 });
  const taskId = manager.getLeafId()!;
  if (scenario === "changed-tool") manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "original-edit", name: "write", arguments: {} }], timestamp: 2 } as never);
  manager.appendMessage({ role: "assistant", ...(scenario === "native-missing-marker" ? { api: "ohmygame-native" } : {}), content: [{ type: "toolCall", id: "original-edit", name: "edit", arguments: {} }], timestamp: 2 } as never);
  if (scenario === "unknown-then-preflight") {
    manager.appendCustomEntry("ohmygame-tool-attempt", { version: 1, taskId, callId: "original-edit", tool: "edit", state: "unknown" });
    manager.appendCustomEntry("ohmygame-tool-attempt", { version: 1, taskId, callId: "original-edit", tool: "edit", state: "started" });
  }
  if (!["no-stage", "forged-details"].includes(scenario)) manager.appendCustomEntry("ohmygame-tool-attempt", {
    version: 1, taskId: scenario === "wrong-task" ? "another-task" : taskId, callId: scenario === "wrong-call" ? "another-call" : "original-edit", tool: scenario === "wrong-tool" ? "write" : "edit",
    state: scenario === "unknown-stage" ? "unknown" : scenario === "blocked" ? "blocked" : "not_executed", preflightFailure: proof,
  });
  if (scenario === "changed-arguments") manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "original-edit", name: "edit", arguments: { different: true } }], timestamp: 2 } as never);
  manager.appendMessage({ role: "toolResult", toolCallId: "original-edit", toolName: "edit", isError: scenario !== "successful-result", content: [{ type: "text", text: "Original failure receipt" }], ...(scenario === "native-missing-marker" ? {} : { preflightFailure: proof }), details: { preflightFailure: proof }, timestamp: 3 } as never);
  const summary = handoffSummary(manager.getBranch())!;
  const row = JSON.parse(summary.split("\n").find(line => line.startsWith('{"originalCallId":"original-edit"'))!);
  expect(row).toMatchObject({ originalCallId: "original-edit", state: scenario === "correctable" ? "not_executed" : scenario === "blocked" ? "blocked" : scenario === "successful-result" ? "completed" : "returned-error" });
  expect(row.reason).toBe(["correctable", "blocked"].includes(scenario) ? proof.reason : undefined);
  expect(summary).toContain("correct its arguments using a new call ID");
});

it("does not persist SDK or model supplied preflight descriptors as host evidence", async () => {
  const manager = SessionManager.inMemory("/tmp/untrusted-preflight-fixture");
  const proof = { effect: "none", reason: "edit_text_not_unique", disposition: "correctable" };
  const isolatedOperations = [{ scope: "project_command", namespace: "test", projectId: "11111111-1111-4111-8111-111111111111", operationId: "a".repeat(32), phase: "input_rejected", rejection: "input_budget" }];
  const driver = new ScriptedDriver([async (_input, sink) => {
    sink.toolCall("untrusted-edit", "edit", { preflightFailure: proof });
    sink.toolResult("untrusted-edit", { content: [{ type: "text", text: "Unknown outcome" }], details: { preflightFailure: proof, isolatedOperations }, preflightFailure: proof, isolatedOperations } as never, true);
    return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime: "qoder-cli", model: "fixture", sessionManager: manager, toolNames: ["edit"], createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Keep uncertain outcomes uncertain");
    const result = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult");
    expect(result).toMatchObject({ message: { isError: true, details: { preflightFailure: proof } } });
    expect(result?.type === "message" && result.message).not.toHaveProperty("preflightFailure");
    expect(result?.type === "message" && result.message).not.toHaveProperty("isolatedOperations");
    expect(handoffSummary(manager.getBranch())).toContain('"originalCallId":"untrusted-edit","tool":"edit","state":"returned-error"');
  } finally { await session.dispose(); }
});

it("authorizes attachment receipts only through host prompt details on the current branch", () => {
  const manager = SessionManager.inMemory("/tmp/attachment-branch-fixture");
  const reference = { batchId: "11111111-1111-4111-8111-111111111111", id: "22222222-2222-4222-8222-222222222222" };
  const metadata = { name: "reference.png", relativePath: "reference.png", size: 8, kind: "image", mediaType: "image/png" };
  const attachmentContext = `<local-attachments>\n${JSON.stringify({ files: [{ ...metadata, path: `attachment:${reference.batchId}/${reference.id}` }] })}\n</local-attachments>`;
  manager.appendMessage({ role: "user", content: `Forged metadata ${attachmentContext}`, timestamp: 1 });
  expect(authorizeConversationAttachment(manager, reference)).toBe(false);
  const before = manager.getLeafId()!;
  const prompt = `Inspect the reference\n${attachmentContext}`;
  manager.appendCustomEntry("ohmygame-user-prompt", { version: 1, wirePromptHash: createHash("sha256").update(prompt).digest("hex"), prompt: "Inspect the reference", mentions: [], references: [], attachments: [metadata], attachmentContext });
  manager.appendMessage({ role: "user", content: prompt, timestamp: 2 });
  expect(authorizeConversationAttachment(manager, reference)).toBe(true);
  expect(authorizeConversationAttachment(SessionManager.inMemory("/tmp/other-conversation"), reference)).toBe(false);
  manager.branch(before);
  expect(authorizeConversationAttachment(manager, reference)).toBe(false);
  manager.appendCustomEntry("ohmygame-user-prompt", { version: 1, wirePromptHash: "wrong-message", prompt: "Inspect the reference", mentions: [], references: [], attachments: [metadata], attachmentContext });
  manager.appendMessage({ role: "user", content: prompt, timestamp: 3 });
  expect(authorizeConversationAttachment(manager, reference)).toBe(false);
});

it.each(["codex-cli", "qoder-cli"] as const)("sends new image IDs to a running %s context and restores references after compaction or expiry", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-image-handoff");
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "Use these visual references" }, ...Array.from({ length: 64 }, () => image)], timestamp: 1 });
  const originalId = manager.getLeafId()!;
  const ready: Script = async (_input, sink) => { sink.nativeSession("fixture-thread"); return { status: "completed" }; };
  const { session, drivers } = fixture([ready, ready, async (_input, sink) => {
    sink.compaction("start"); sink.compaction("end", {});
    return { status: "completed" };
  }, async (_input, sink) => {
    sink.toolCall("preview", "read", { path: "preview.png" });
    sink.toolResult("preview", { content: [image] }, false);
    return { status: "completed" };
  }, ready, async () => { throw new NativeSessionExpiredError(); }, ready], manager,
  { runtime, model: "vision-fixture", supportsImages: true, toolNames: ["recall_image", "read_attachment"] });
  const driver = drivers[0]!;
  try {
    await session.prompt("Continue the existing work");
    expect(driver.inputs).toHaveLength(1);
    expect(driver.inputs[0]).toMatchObject({ images: [], requiresImageInput: true });
    expect(driver.inputs[0]!.text).toContain(`${originalId}:0`);
    expect(driver.inputs[0]!.text).toContain("recall_image");
    expect(driver.inputs[0]!.text).toContain("<conversation-handoff>");
    expect(driver.inputs[0]!.text).not.toContain(image.data);
    expect(manager.getEntry(originalId)).toMatchObject({ type: "message", message: { content: expect.arrayContaining([image, { type: "text", text: "Use these visual references" }]) } });
    await session.prompt("How much memory does a 4K texture use?");
    expect(driver.inputs[1]).toMatchObject({ text: "How much memory does a 4K texture use?", images: [], requiresImageInput: true });
    await session.prompt("Use the new reference", { images: [image] });
    const lastUser = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user")!;
    expect(driver.inputs[2]!.text).toContain(`${lastUser.id}:0`);
    expect(driver.inputs[2]!.text).not.toContain(originalId);
    await session.prompt("Read a new preview");
    expect(driver.inputs[3]!.text).toContain(`${originalId}:63`);
    expect(driver.inputs[3]!.text).toContain(`${lastUser.id}:0`);
    const preview = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "toolResult")!;
    await session.prompt("Compare the preview");
    expect(driver.inputs[4]!.text).toContain(`${preview.id}:0`);
    expect(driver.inputs[4]!.text).not.toContain(lastUser.id);
    await session.prompt("Resume after expiry");
    expect(driver.inputs[5]!.text).toBe("Resume after expiry");
    expect(drivers[1]!.inputs[0]!.text).toContain(`${preview.id}:0`);
    expect(drivers[1]!.inputs[0]!.text).toContain(`${originalId}:63`);
    expect(drivers[1]!.inputs[0]!.text).toContain("<conversation-handoff>");
    expect(drivers[1]!.inputs[0]!.images).toEqual([]);
  } finally { await session.dispose(); }
});

it("bounds a single long handoff turn while keeping its request, latest answer, file paths and tool recovery records", async () => {
  const manager = SessionManager.inMemory("/tmp/bounded-handoff");
  const { session } = fixture([async (_input, sink) => {
    for (let index = 0; index < 64; index++) {
      sink.textDone(`part-${index}`, `Progress ${index} ${"x".repeat(1500)}`);
      sink.toolCall(`file-${index}`, "read", { path: `${"y".repeat(200)}-${index}.png` });
      sink.toolResult(`file-${index}`, { content: [{ type: "text", text: "Read" }] }, false);
    }
    sink.toolCall("large-path", "read", { path: "z".repeat(10_000) });
    sink.toolResult("large-path", { content: [{ type: "text", text: "Invalid path" }] }, true);
    sink.textDone("final", "The latest modeling result");
    return { status: "completed" };
  }], manager);
  try {
    await session.prompt("Inspect the character");
    manager.appendCustomEntry("ohmygame-plan", { note: "Plan start " + "P".repeat(60_000) });
    const summary = handoffSummary(manager.getBranch())!;
    const conversation = summary.slice(summary.indexOf("User:"), summary.indexOf("\n\nCurrent structured plan state:"));
    expect(conversation.length).toBeLessThanOrEqual(12_000);
    expect(conversation).toContain("User: Inspect the character");
    expect(conversation).toContain("[Intermediate progress omitted.]");
    expect(conversation).toContain("The latest modeling result");
    const plan = summary.split("Current structured plan state:\n")[1]!.split("\n\n")[0]!;
    expect(plan).toContain("Plan start");
    expect(plan.length).toBeLessThanOrEqual(1_501);
    const files = summary.split("Files the earlier agent worked on: ")[1]!.split("\n\n")[0]!;
    expect(files.length).toBeLessThanOrEqual(2_000);
    expect(files).toContain("-63.png");
    expect(summary).toContain('"originalCallId":"large-path"');
    expect(summary).toContain("recover/review the original call");
  } finally { await session.dispose(); }
});

it("reoffers retained image IDs when a turn fails before dispatch and after an unaccepted native turn", async () => {
  const ready: Script = async (_input, sink) => { sink.nativeSession("image-thread"); return { status: "completed" }; };
  const manager = SessionManager.inMemory("/tmp/native-unaccepted-image");
  const { session, drivers } = fixture([ready, async () => ({ status: "aborted" }), ready], manager,
    { runtime: "codex-cli", supportsImages: true, toolNames: ["recall_image"] });
  try {
    await session.prompt("Open a conversation");
    const failed = vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce(() => { throw new Error("write failed before dispatch"); });
    try {
      await expect(session.prompt("Keep this picture", { images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] })).rejects.toThrow("before dispatch");
    } finally { failed.mockRestore(); }
    expect(drivers[0]!.inputs).toHaveLength(1);
    const failedUser = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user")!;
    await session.prompt("First follow-up");
    expect(drivers[0]!.inputs[1]!.text).toContain(`${failedUser.id}:0`);
    await session.prompt("Second follow-up");
    expect(drivers[1]!.inputs[0]!.text).toContain(`${failedUser.id}:0`);
  } finally { await session.dispose(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("rejects retained image history before a text-only %s model turn", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-text-only-image-fixture");
  manager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }], timestamp: 1 });
  const driver = new ScriptedDriver([], undefined);
  const session = new NativeCodingSession({ runtime, model: "text-fixture", supportsImages: false, sessionManager: manager, toolNames: ["read_attachment"], createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Continue");
    expect(driver.inputs).toEqual([]);
    expect(JSON.stringify(session.messages)).toContain("does not have image input enabled");
    expect(manager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content) && entry.message.content.some(block => block.type === "image"))).toBe(true);
  } finally { await session.dispose(); }
});

type Script = (
  input: NativeTurnInput,
  sink: NativeTurnSink,
  signal: AbortSignal,
) => Promise<NativeTurnOutcome>;

/** A protocol adapter that plays a script for each turn and records what it was given. */
it.each(["codex-cli", "qoder-cli"] as const)("continues %s after a confirmed stopped playtest batch through inspection without replay", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-playtest-inspection");
  const snapshot = { sessionId: "session-1", runtime: "web" as const, capabilities: WEB_GAME_USE_CAPABILITIES, viewport: { width: 800, height: 600 } };
  const request = vi.fn<GameRuntimeAdapter["request"]>().mockImplementation(async input => {
    if (input.operation !== "act" && input.operation !== "inspect") throw Error("Unexpected fixture operation");
    return { operation: input.operation, snapshot };
  }).mockRejectedValueOnce(playtestActionError("Target missing", { version: 1, sessionId: snapshot.sessionId,
    completedActions: 1, failedAction: 2, actionType: "click", phase: "target_lookup", inputDispatched: false }));
  const adapter: GameRuntimeAdapter = { available: true, capabilities: WEB_GAME_USE_CAPABILITIES, request, close() {} };
  const tool = createGameUseTool(adapter, async () => ({ runtime: "web", url: "http://127.0.0.1:43123/" }));
  const guard = new AutoContinueTools([tool], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const driver = new ScriptedDriver([async (_input, sink, signal) => {
    const invoke = async (id: string, args: Record<string, unknown>) => {
      sink.toolCall(id, "game_use", args);
      const outcome = await bridge.call("game_use", args, id, signal);
      sink.toolResult(id, outcome.result, outcome.isError);
      expect(signal.aborted).toBe(false);
      return outcome;
    };
    const first = await invoke("partial", { operation: "act", sessionId: snapshot.sessionId, actions: [{ type: "click", target: { text: "Start" } }, { type: "click", target: { text: "Missing" } }] });
    expect(first.isError).toBe(false);
    expect(first.result.details).toMatchObject({ playtestAction: { status: "partially_completed", completedActions: 1 } });
    const remaining = { operation: "act", sessionId: snapshot.sessionId, actions: [{ type: "press", key: "Enter" }] };
    expect((await invoke("uninspected", remaining)).isError).toBe(true);
    expect((await invoke("inspect", { operation: "inspect", sessionId: snapshot.sessionId })).isError).toBe(false);
    expect((await invoke("remaining", remaining)).isError).toBe(false);
    return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard,
    toolNames: ["game_use"], setActiveTools: names => bridge.setActive(names), createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Inspect the stopped batch, then finish only the remaining action");
    expect(session.interruption).toBeUndefined();
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["act", "inspect", "act"]);
    expect(guard.stopRequested).toBe(false);
  } finally { await session.dispose(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("continues %s after correcting an open limit before the segment turn limit", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-playtest-capacity"), snapshot = { sessionId: "new-session", runtime: "web" as const,
    capabilities: WEB_GAME_USE_CAPABILITIES, viewport: { width: 800, height: 600 } };
  const request = vi.fn<GameRuntimeAdapter["request"]>().mockImplementation(async input => {
    if (input.operation === "open") return { operation: "open", snapshot };
    if (input.operation === "inspect") return { operation: "inspect", snapshot: { ...snapshot, sessionId: input.sessionId } };
    if (input.operation === "close") return { operation: "close" };
    throw Error("Unexpected fixture operation");
  }).mockRejectedValueOnce(playtestOpenError("Session limit", { version: 1, reason: "session_limit", limit: 4, windowCreated: false }));
  const adapter: GameRuntimeAdapter = { available: true, capabilities: WEB_GAME_USE_CAPABILITIES, request,
    ownedSessionIds: () => ["finished-session"], close() {} };
  const tool = createGameUseTool(adapter, async () => ({ runtime: "web", url: "http://127.0.0.1:43123/" }));
  const guard = new AutoContinueTools([tool], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const invoke = async (sink: NativeTurnSink, id: string, args: Record<string, unknown>, signal: AbortSignal) => {
    sink.toolCall(id, "game_use", args); const outcome = await bridge.call("game_use", args, id, signal);
    sink.toolResult(id, outcome.result, outcome.isError); expect(signal.aborted).toBe(false); return outcome;
  };
  const driver = new ScriptedDriver([async (_input, sink, signal) => {
    expect((await invoke(sink, "open-rejected", { operation: "open" }, signal)).isError).toBe(true);
    expect((await invoke(sink, "inspect-finished", { operation: "inspect", sessionId: "finished-session" }, signal)).isError).toBe(false);
    expect((await invoke(sink, "close-finished", { operation: "close", sessionId: "finished-session" }, signal)).isError).toBe(false);
    expect((await invoke(sink, "open-corrected", { operation: "open" }, signal)).isError).toBe(false);
    return { status: "failed", error: "Segment limit", interruption: { kind: "turn_limit", source: runtime === "qoder-cli" ? "qoder" : "codex", code: "fixture_max_turns" } };
  }, async (_input, sink, signal) => {
    expect((await invoke(sink, "inspect-new", { operation: "inspect", sessionId: snapshot.sessionId }, signal)).isError).toBe(false);
    return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard,
    toolNames: ["game_use"], setActiveTools: names => bridge.setActive(names), createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Finish verification after inspecting only owned sessions");
    expect(session.interruption?.kind).toBe("turn_limit");
    await expect(session.prepareContinuation(new AbortController().signal)).resolves.toBeUndefined();
    await session.resumeAfterInterruption();
    expect(session.interruption).toBeUndefined();
    expect(guard.recoverySummary).toContain("not_executed (playtest_session_limit)");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["open", "inspect", "close", "open", "inspect"]);
  } finally { await session.dispose(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("retains %s local audio rejection across continuation without replaying generation", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-audio-input"), request = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from("ID3fixture"), { headers: { "content-type": "audio/mpeg" } }));
  const provider = new VolcengineSeedAudioProvider(() => "fixture-key", request);
  const tool = { name: "generate_music", label: "Music", description: "Fixture audio", parameters: Type.Object({ loop: Type.Boolean() }),
    execute: async (_id: string, input: { loop: boolean }) => {
      await provider.generate({ operation: "music", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" }, prompt: "Quiet forest", instrumental: true, loop: input.loop });
      return { content: [{ type: "text" as const, text: "Audio saved" }], details: {} };
    } };
  const guard = new AutoContinueTools([tool], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const invoke = async (sink: NativeTurnSink, id: string, loop: boolean, signal: AbortSignal) => {
    const input = { loop }; sink.toolCall(id, tool.name, input);
    const outcome = await bridge.call(tool.name, input, id, signal); sink.toolResult(id, outcome.result, outcome.isError);
    expect(signal.aborted).toBe(false); return outcome;
  };
  const driver = new ScriptedDriver([async (_input, sink, signal) => {
    expect((await invoke(sink, "music-local-reject", true, signal)).isError).toBe(true); expect(request).not.toHaveBeenCalled();
    expect((await invoke(sink, "music-corrected", false, signal)).isError).toBe(false);
    return { status: "failed", error: "Segment limit", interruption: { kind: "turn_limit", source: runtime === "qoder-cli" ? "qoder" : "codex", code: "fixture_max_turns" } };
  }, async (_input, sink, signal) => {
    expect((await invoke(sink, "music-local-reject", true, signal)).isError).toBe(true);
    expect((await invoke(sink, "music-corrected", false, signal)).isError).toBe(false);
    return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard,
    toolNames: [tool.name], setActiveTools: names => bridge.setActive(names), createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Correct the local music options and retain the resulting audio");
    expect(session.interruption?.kind).toBe("turn_limit");
    await session.prepareContinuation(new AbortController().signal); await session.resumeAfterInterruption();
    expect(session.interruption).toBeUndefined(); expect(request).toHaveBeenCalledOnce();
    expect(guard.recoverySummary).toContain("not_executed (audio_input_invalid)");
    expect(handoffSummary(manager.getBranch())).toContain('"reason":"audio_input_invalid"');
  } finally { await session.dispose(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("continues %s after a local animation-name rejection without replaying its corrected workflow", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-animation-input"), submitted = vi.fn();
  const library = tripoActions("v2.5-20260210", "quadruped");
  const tool = { name: "animate_3d_asset", label: "Animate", description: "Fixture animation", parameters: Type.Object({ action: Type.String() }),
    execute: async (_id: string, input: { action: string }) => {
      const action = findAnimationAction(library, input.action); submitted(action.id);
      return { content: [{ type: "text" as const, text: "Animation retained" }], details: {} };
    } };
  const catalog = { name: "list_animation_actions", label: "Actions", description: "Read-only fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify(library) }], details: {} }) };
  const guard = new AutoContinueTools([tool, catalog], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const invoke = async (sink: NativeTurnSink, name: string, id: string, input: Record<string, unknown>, signal: AbortSignal) => {
    sink.toolCall(id, name, input); const outcome = await bridge.call(name, input, id, signal); sink.toolResult(id, outcome.result, outcome.isError);
    expect(signal.aborted).toBe(false); return outcome;
  };
  const driver = new ScriptedDriver([async (_input, sink, signal) => {
    expect((await invoke(sink, tool.name, "animation-local-reject", { action: "idle" }, signal)).isError).toBe(true); expect(submitted).not.toHaveBeenCalled();
    expect((await invoke(sink, catalog.name, "catalog-before", {}, signal)).isError).toBe(false);
    expect((await invoke(sink, tool.name, "animation-corrected", { action: "Walk" }, signal)).isError).toBe(false);
    return { status: "failed", error: "Segment limit", interruption: { kind: "turn_limit", source: runtime === "qoder-cli" ? "qoder" : "codex", code: "fixture_max_turns" } };
  }, async (_input, sink, signal) => {
    expect((await invoke(sink, catalog.name, "catalog-after", {}, signal)).isError).toBe(false);
    expect((await invoke(sink, tool.name, "animation-local-reject", { action: "idle" }, signal)).isError).toBe(true);
    expect((await invoke(sink, tool.name, "animation-corrected", { action: "Walk" }, signal)).isError).toBe(false);
    return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard,
    toolNames: [tool.name, catalog.name], setActiveTools: names => bridge.setActive(names), createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Correct the unsupported action name and retain the animation");
    expect(session.interruption?.kind).toBe("turn_limit"); await session.prepareContinuation(new AbortController().signal); await session.resumeAfterInterruption();
    expect(session.interruption).toBeUndefined(); expect(submitted).toHaveBeenCalledExactlyOnceWith("preset:quadruped:walk");
    expect(guard.recoverySummary).toContain("not_executed (invalid_animation_action)");
    expect(handoffSummary(manager.getBranch())).toContain('"reason":"invalid_animation_action"');
  } finally { await session.dispose(); }
});

it.each(["codex-cli", "qoder-cli"] as const)("retains %s pure 3D-option rejection across continuation and submits its correction once", async runtime => {
  const manager = SessionManager.inMemory("/tmp/native-3d-options"), submitted = vi.fn();
  const runner = new ToolRunner("/tmp/native-3d-options", { generate: vi.fn() }, { generate: vi.fn() });
  const tool = { name: "generate_3d_asset", label: "3D", description: "Offline option admission", parameters: Type.Object({ pose: Type.Boolean() }),
    execute: async (_id: string, input: { pose: boolean }) => {
      await runner.assertMediaInputOptions("image-to-3d", { operation: "text", prompt: "A T-pose hero", images: [], model: { provider: "tripo", id: "v3.1-20260211" }, options: input.pose ? { pose: "t-pose" } : {} });
      submitted(); return { content: [{ type: "text" as const, text: "Corrected 3D result retained" }], details: {} };
    } };
  const guard = new AutoContinueTools([tool], { sessionManager: manager }), bridge = new ToolBridge(guard.wrap(), true);
  const invoke = async (sink: NativeTurnSink, id: string, pose: boolean, signal: AbortSignal) => {
    const input = { pose }; sink.toolCall(id, tool.name, input);
    const outcome = await bridge.call(tool.name, input, id, signal); sink.toolResult(id, outcome.result, outcome.isError); return outcome;
  };
  const driver = new ScriptedDriver([async (_input, sink, signal) => {
    expect((await invoke(sink, "3d-local-reject", true, signal)).isError).toBe(true); expect(submitted).not.toHaveBeenCalled();
    expect((await invoke(sink, "3d-corrected", false, signal)).isError).toBe(false);
    return { status: "failed", error: "Segment limit", interruption: { kind: "turn_limit", source: runtime === "qoder-cli" ? "qoder" : "codex", code: "fixture_max_turns" } };
  }, async (_input, sink, signal) => {
    expect((await invoke(sink, "3d-local-reject", true, signal)).isError).toBe(true);
    expect((await invoke(sink, "3d-corrected", false, signal)).isError).toBe(false); return { status: "completed" };
  }], undefined);
  const session = new NativeCodingSession({ runtime, model: "fixture", sessionManager: manager, continuationTools: guard,
    toolNames: [tool.name], setActiveTools: names => bridge.setActive(names), createDriver: () => driver, requestApproval: async () => "deny" });
  try {
    await session.prompt("Correct unsupported 3D options and retain the model");
    expect(session.interruption?.kind).toBe("turn_limit"); await session.prepareContinuation(new AbortController().signal); await session.resumeAfterInterruption();
    expect(session.interruption).toBeUndefined(); expect(submitted).toHaveBeenCalledOnce();
    expect(guard.recoverySummary).toContain("not_executed (invalid_media_options)");
    expect(handoffSummary(manager.getBranch())).toContain('"reason":"invalid_media_options"');
  } finally { await session.dispose(); await runner.close(); }
});

class ScriptedDriver implements NativeDriver {
  readonly inputs: NativeTurnInput[] = [];
  disposed = false;
  constructor(
    private readonly scripts: Script[],
    readonly resume: string | undefined,
  ) {}
  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    if (!script) return { status: "completed" };
    return script(input, sink, signal);
  }
  async interrupt(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
}

function setup(
  scripts: Script[],
  options: {
    snapshot?: () => Promise<string>;
    sessionManager?: SessionManager;
    accountLimits?: () => AgentUsageLimit[];
    beforeCreate?: () => Promise<void>;
    dispose?: () => Promise<void>;
    runtime?: AgentRuntimeId;
    toolNames?: readonly string[];
  } = {},
) {
  const events = new RuntimeEventBus();
  const project: ProjectState = {
    id: "project-1",
    name: "Project",
    type: "general",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
  };
  const conversation: StoredConversation = {
    sessionPath: "/tmp/conversation-1.jsonl",
    summary: {
      id: "conversation-1",
      projectId: project.id,
      title: "Conversation",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
  };
  const sessionManager =
    options.sessionManager ?? SessionManager.inMemory("/tmp/project-1");
  const drivers: ScriptedDriver[] = [];
  const activeTools: string[][] = [];
  let manager!: AgentManager;
  const createSession = async () => {
    await options.beforeCreate?.();
    return new NativeCodingSession({
      runtime: options.runtime ?? "claude-code-cli",
      model: options.runtime === "qoder-cli" ? "auto" : "sonnet",
      sessionManager,
      createDriver: (resume) => {
        const driver = new ScriptedDriver(scripts, resume);
        drivers.push(driver);
        return driver;
      },
      ...(options.snapshot ? { snapshotBeforeMessage: options.snapshot } : {}),
      ...(options.accountLimits
        ? { accountLimits: options.accountLimits }
        : {}),
      requestApproval: (details, toolCallId, signal) =>
        manager.askApproval(
          project.id,
          conversation.summary.id,
          toolCallId,
          details,
          signal,
        ),
      toolNames: options.toolNames ?? ["canvas_check"],
      setActiveTools: (names) => activeTools.push([...names]),
      ...(options.dispose ? { dispose: options.dispose } : {}),
    });
  };
  manager = new AgentManager(events, {
    createSession,
    activeToolNames: (_project, mode, session) =>
      projectPiToolNames(
        mode,
        [],
        session.getAllTools?.().map((tool) => tool.name),
      ),
    ...(options.snapshot
      ? {
          checkpoints: {
            snapshot: options.snapshot,
            changed: async () => ({ files: 0, items: [] }),
          },
        }
      : {}),
  });
  const received: RuntimeEvent[] = [];
  events.subscribe(project.id, (event) => received.push(event));
  return { manager, project, conversation, sessionManager, drivers, received, activeTools };
}

function items(sessionManager: SessionManager): ThreadItem[] {
  return conversationItems(sessionManager.getBranch(), false);
}

// Legacy execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
function fixture(
  scripts: Script[],
  sessionManager = SessionManager.inMemory("/tmp/project-1"),
  extra: Record<string, unknown> = {},
) {
  const drivers: ScriptedDriver[] = [];
  const session = new NativeCodingSession({
    runtime: "claude-code-cli",
    model: "sonnet",
    sessionManager,
    toolNames: [],
    requestApproval: async () => "deny",
    createDriver: (resume) => {
      const driver = new ScriptedDriver(scripts, resume);
      drivers.push(driver);
      return driver;
    },
    ...extra,
  });
  return { session, sessionManager, drivers };
}

describe("project session disposal", () => {
  it.each([false, true])("waits for native disposal when closing, including invalidated sessions (invalidated=%s)", async invalidated => {
    let release!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const state = setup([async () => ({ status: "completed" })], { runtime: "qoder-cli", dispose: cleanup });
    await state.manager.prompt(state.project, state.conversation, "read").result;
    if (invalidated) state.manager.invalidateProjectSessions(state.project.id);
    let closed = false;
    const closing = state.manager.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    release(); await closing; expect(closed).toBe(true);
  });

  it.each([false, true])("waits for a session created during closing and reports its cleanup failure (failure=%s)", async fail => {
    let created = false, releaseCreate!: () => void, releaseCleanup!: () => void;
    const cleanup = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      releaseCleanup = () => fail ? reject(new Error("Closing cleanup failed")) : resolve();
    })).mockResolvedValue(undefined);
    const state = setup([], { runtime: "qoder-cli", dispose: cleanup, beforeCreate: () => new Promise<void>(resolve => { created = true; releaseCreate = resolve; }) });
    const turn = state.manager.prompt(state.project, state.conversation, "read");
    await vi.waitFor(() => expect(created).toBe(true));
    let closed = false;
    const closing = state.manager.close().then(() => { closed = true; return undefined; }, cause => { closed = true; return cause; });
    await Promise.resolve(); expect(closed).toBe(false);
    releaseCreate(); await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(closed).toBe(false); expect(state.drivers[0]!.inputs).toEqual([]);
    releaseCleanup(); const failure = await closing; await turn.result;
    if (fail) {
      expect(failure).toEqual(new Error("Closing cleanup failed"));
      expect(cleanup).toHaveBeenCalledOnce();
      await state.manager.forgetProject(state.project.id); expect(cleanup).toHaveBeenCalledTimes(2);
    } else expect(failure).toBeUndefined();
  });

  it.each([false, true])("waits for native private storage cleanup including previously invalidated sessions (invalidated=%s)", async invalidated => {
    let release!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const state = setup([async () => ({ status: "completed" })], { runtime: "qoder-cli", dispose: cleanup });
    await state.manager.prompt(state.project, state.conversation, "read").result;
    if (invalidated) state.manager.invalidateProjectSessions(state.project.id);
    let removed = false;
    const pending = state.manager.forgetProject(state.project.id).then(() => { removed = true; });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(removed).toBe(false); expect(state.drivers[0]!.disposed).toBe(true);
    release(); await pending; expect(removed).toBe(true);
    await state.manager.close();
  });

  it("reports a cleanup failure and retries it on the next explicit project deletion", async () => {
    const cleanup = vi.fn().mockRejectedValueOnce(new Error("Private storage busy")).mockResolvedValue(undefined);
    const state = setup([async () => ({ status: "completed" })], { runtime: "qoder-cli", dispose: cleanup });
    await state.manager.prompt(state.project, state.conversation, "read").result;
    await expect(state.manager.forgetProject(state.project.id)).rejects.toThrow("Private storage busy");
    await expect(state.manager.forgetProject(state.project.id)).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2); await state.manager.close();
  });

  it("retains native files when stopping the driver fails", async () => {
    const cleanup = vi.fn(async () => {}), { session, drivers } = fixture([], undefined, { dispose: cleanup });
    drivers[0]!.dispose = vi.fn().mockRejectedValueOnce(new Error("Process stop unconfirmed")).mockResolvedValue(undefined);
    await expect(session.dispose()).rejects.toThrow("Process stop unconfirmed");
    expect(cleanup).not.toHaveBeenCalled();
    await session.dispose(); expect(cleanup).toHaveBeenCalledOnce();
  });

  it("waits for an earlier idle process stop before removing its shared private directory", async () => {
    let release!: () => void;
    const cleanup = vi.fn(async () => {}), { session, drivers } = fixture([async () => ({ status: "completed" })], undefined, { dispose: cleanup, idleTimeoutMs: 1 });
    drivers[0]!.dispose = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    await session.prompt("read");
    await vi.waitFor(() => expect(release).toBeDefined());
    const pending = session.dispose();
    await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled();
    release(); await pending; expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("native live steering", () => {
  it("delivers startup steering to the replacement live turn after an explicitly expired context", async () => {
    let expire!: () => void, finish!: () => void, created = 0;
    const inputs: NativeTurnInput[] = [], delivered: string[] = [];
    const store = SessionManager.inMemory("/tmp/native-expired-steering");
    const session = new NativeCodingSession({ runtime: "qoder-cli", model: "fixture", sessionManager: store, toolNames: [],
      requestApproval: async () => "deny", createDriver: () => {
        const expired = ++created === 1;
        let sink: NativeTurnSink;
        return {
          runTurn: async (input, current) => {
            inputs.push(input); sink = current;
            if (expired) {
              await new Promise<void>(resolve => { expire = resolve; });
              throw new NativeSessionExpiredError("Expired fixture context");
            }
            await new Promise<void>(resolve => { finish = resolve; });
            return { status: "completed" };
          },
          steer: async id => {
            if (expired) return false;
            await sink!.steeringStarted!(id); delivered.push(id); return true;
          },
          interrupt: async () => { finish?.(); }, dispose() {},
        };
      } });
    try {
      const run = session.prompt("Original task");
      await vi.waitFor(() => expect(expire).toBeDefined());
      await session.replaceQueue([{ id: "startup-guidance", text: "Keep the feet separate", images: [] }], []);
      expire();
      await vi.waitFor(() => expect(delivered).toEqual(["startup-guidance"]));
      expect(store.getBranch().filter(item => item.type === "message" && item.message.role === "user")).toHaveLength(2);
      finish(); await run;
      expect(inputs).toHaveLength(2);
    } finally { finish?.(); await session.dispose(); }
  });

  it.each(["accepted", "unknown", "unsent"])("preserves %s steering evidence when a failed native turn could otherwise auto-continue", async delivery => {
    let finish!: () => void;
    const manager = SessionManager.inMemory("/tmp/native-failed-steering-receipt");
    const { session, drivers } = fixture([async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "failed", error: "Original transport failure", interruption: { kind: "transient", source: "codex", code: "fixture_connection" } };
    }], manager, { runtime: "codex-cli", continuationTools: new AutoContinueTools([], { sessionManager: manager }) });
    Object.assign(drivers[0]!, { steer: vi.fn(async () => {
      if (delivery === "unknown") throw new Error("Steering response lost");
      return delivery === "accepted";
    }) });
    const run = session.prompt("Original task");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const queued = session.replaceQueue([{ id: "unconfirmed", text: "Updated instruction", images: [] }], []);
    if (delivery === "unknown") await expect(queued).rejects.toThrow("Steering response lost");
    else await queued;
    finish(); await run;
    if (delivery === "unsent") expect(session.interruption?.kind).toBe("transient");
    else {
      expect(session.interruption).toMatchObject({ kind: "blocked", code: "native_steering_unconfirmed" });
      await expect(session.prepareContinuation(new AbortController().signal)).rejects.toThrow("no longer eligible");
      expect(JSON.stringify(manager.getBranch())).toContain("Original transport failure The queued instruction's receipt is unconfirmed");
    }
    expect(drivers.flatMap(driver => driver.inputs)).toHaveLength(1);
    await session.dispose();
  });

  it.each([
    { delivery: "accepted", resumed: false }, { delivery: "unknown", resumed: false },
    { delivery: "accepted", resumed: true }, { delivery: "unknown", resumed: true },
  ])("does not replay $delivery steering without a consumption receipt (resumed=$resumed)", async ({ delivery, resumed }) => {
    let finish!: () => void;
    const manager = SessionManager.inMemory("/tmp/native-steering-receipt");
    const scripts: Script[] = resumed ? [async () => ({ status: "failed", error: "Segment limit", interruption: { kind: "turn_limit", source: "codex", code: "fixture_max_turns" } })] : [];
    scripts.push(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "completed" };
    });
    const { session, drivers } = fixture(scripts, manager, { runtime: "codex-cli", continuationTools: new AutoContinueTools([], { sessionManager: manager }) });
    if (resumed) {
      await session.prompt("Original task");
      await session.prepareContinuation(new AbortController().signal);
    }
    Object.assign(drivers.at(-1)!, { steer: vi.fn(async () => {
      if (delivery === "unknown") throw new Error("Transport response lost");
      return true;
    }) });
    const run = resumed ? session.resumeAfterInterruption() : session.prompt("Original task");
    const failure = expect(run).rejects.toThrow("unconfirmed; it was not sent again");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const queued = session.replaceQueue([{ id: "unconfirmed", text: "Updated instruction", images: [] }], []);
    if (delivery === "unknown") await expect(queued).rejects.toThrow("Transport response lost");
    else await queued;
    finish(); await failure;
    expect(drivers.flatMap(driver => driver.inputs)).toHaveLength(resumed ? 2 : 1);
    expect(drivers).toHaveLength(resumed ? 3 : 2); // A future message rebuilds from the retained transcript.
    await session.dispose();
  });

  it.each([false, true])("rejects unsupported live image input before driver submission (retained=%s)", async retained => {
    let finish!: () => void;
    const { session, drivers, sessionManager } = fixture([async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "completed" };
    }], undefined, { supportsImages: false });
    const steer = vi.fn(async () => true);
    Object.assign(drivers[0]!, { steer });
    const run = session.prompt("Original task");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
    if (retained) sessionManager.appendMessage({ role: "toolResult", toolCallId: "image", toolName: "read", content: [image], isError: false, timestamp: 2 });
    await expect(session.replaceQueue([{ id: "image-steer", text: "Use this reference", images: retained ? [] : [image] }], []))
      .rejects.toThrow("does not have image input enabled");
    expect(steer).not.toHaveBeenCalled();
    session.clearQueue(); finish(); await run; await session.dispose();
  });

  it("admits live steering once at a settled boundary without starting a replacement native turn", async () => {
    let sink!: NativeTurnSink, finish!: () => void;
    const snapshot = vi.fn(async () => "commit");
    const { session, sessionManager, drivers } = fixture([
      async (_input, current) => {
        sink = current;
        sink.toolCall("original-job", "run_blender", { stage: "clean" });
        sink.toolStarted("original-job");
        await new Promise<void>((resolve) => { finish = resolve; });
        sink.textDone("response", "Both feet will remain separate.");
        return { status: "completed" };
      },
    ], undefined, { runtime: "qoder-cli", snapshotBeforeMessage: snapshot });
    const steer = vi.fn(async () => true);
    Object.assign(drivers[0]!, { steer });
    const received: unknown[] = [];
    session.subscribe((event) => received.push(event));
    const run = session.prompt("Clean this character");
    await vi.waitFor(() => expect(sink).toBeDefined());
    const entry = { id: "feet-instruction", text: "Do not join the feet", images: [] };
    await session.replaceQueue([entry], []);
    await session.replaceQueue([entry], []);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(sink.steeringStarted!(entry.id)).rejects.toThrow("tool result is still pending");
    sink.toolResult("original-job", { content: [{ type: "text", text: "Saved original clean scene" }] }, false);
    await sink.steeringStarted!(entry.id);
    await sink.steeringStarted!(entry.id);
    await session.replaceQueue([entry], []); // A stale queue snapshot cannot resend an acknowledged instruction.
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(received).toContainEqual(expect.objectContaining({ type: "message_start", queuedPromptId: entry.id }));
    finish();
    await run;
    expect(drivers[0]!.inputs).toHaveLength(1);
    const messages = sessionManager.getBranch().flatMap((item) => item.type === "message" ? [item.message] : []);
    expect(messages.filter((item) => item.role === "user")).toHaveLength(2);
    expect(messages.findIndex((item) => item.role === "toolResult")).toBeLessThan(messages.findIndex((item) => item.role === "user" && item.content === entry.text));
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    session.dispose();
  });

  it("keeps an admitted instruction when the runtime cannot confirm cancellation", async () => {
    let finish!: () => void;
    const { session, drivers } = fixture([async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: "completed" };
    }]);
    const steer = vi.fn(async () => true), cancelSteering = vi.fn(async (_ids: readonly string[]): Promise<string[]> => []);
    Object.assign(drivers[0]!, { steer, cancelSteering });
    const run = session.prompt("Original task");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const entry = { id: "queued-instruction", text: "Keep the feet separate", images: [] };
    await session.replaceQueue([entry], []);
    await expect(session.replaceQueue([], [])).rejects.toThrow("already being delivered");
    await session.replaceQueue([entry], []);
    expect(steer).toHaveBeenCalledTimes(1);
    cancelSteering.mockResolvedValue([entry.id]);
    await session.replaceQueue([], []);
    finish();
    await run;
    expect(drivers[0]!.inputs).toHaveLength(1);
    session.dispose();
  });

  it("does not archive or release a live instruction when its checkpoint fails", async () => {
    let sink!: NativeTurnSink, finish!: () => void;
    const snapshot = vi.fn(async () => "commit").mockImplementationOnce(async () => "commit").mockImplementationOnce(async () => { throw new Error("snapshot failed"); });
    const { session, drivers, sessionManager } = fixture([async (_input, current) => {
      sink = current;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: "failed", error: "steering checkpoint failed" };
    }], undefined, { snapshotBeforeMessage: snapshot });
    Object.assign(drivers[0]!, { steer: vi.fn(async () => true) });
    const received: unknown[] = [];
    session.subscribe(event => received.push(event));
    const run = session.prompt("Original task"), failure = expect(run).rejects.toThrow("snapshot failed");
    await vi.waitFor(() => expect(sink).toBeDefined());
    await session.replaceQueue([{ id: "queued", text: "Updated instruction", images: [] }], []);
    await expect(sink.steeringStarted!("queued")).rejects.toThrow("snapshot failed");
    expect(received).not.toContainEqual(expect.objectContaining({ type: "message_start", queuedPromptId: "queued" }));
    expect(sessionManager.getBranch().filter(item => item.type === "custom" && item.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
    finish();
    await failure;
    expect(sessionManager.getBranch().filter((item) => item.type === "message" && item.message.role === "user")).toHaveLength(1);
    session.dispose();
  });

  it("does not consume or archive a live instruction cancelled while its snapshot is pending", async () => {
    let sink!: NativeTurnSink, finish!: () => void, releaseSnapshot!: (commit: string) => void;
    const snapshot = vi.fn(async () => "commit").mockImplementationOnce(async () => "commit")
      .mockImplementationOnce(() => new Promise<string>(resolve => { releaseSnapshot = resolve; }));
    const beginTask = vi.fn();
    const { session, drivers, sessionManager } = fixture([async (_input, current) => {
      sink = current;
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "completed" };
    }], undefined, { snapshotBeforeMessage: snapshot, beginTask });
    Object.assign(drivers[0]!, { steer: vi.fn(async () => true), interrupt: async () => { finish(); } });
    const received: unknown[] = [];
    session.subscribe(event => received.push(event));
    const run = session.prompt("Original task");
    await vi.waitFor(() => expect(sink).toBeDefined());
    await session.replaceQueue([{ id: "queued", text: "Updated instruction", images: [] }], []);
    const admitting = sink.steeringStarted!("queued");
    const cancelled = expect(admitting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await session.abort();
    releaseSnapshot("later-checkpoint");
    await cancelled;
    await run;
    expect(received).not.toContainEqual(expect.objectContaining({ type: "message_start", queuedPromptId: "queued" }));
    expect(sessionManager.getBranch().filter(item => item.type === "custom" && item.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
    expect(sessionManager.getBranch().filter(item => item.type === "message" && item.message.role === "user")).toHaveLength(1);
    expect(beginTask).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it("rejects a late snapshot when only the driver's admission signal was cancelled", async () => {
    let sink!: NativeTurnSink, finish!: () => void, releaseSnapshot!: (commit: string) => void, sessionSignal!: AbortSignal;
    const snapshot = vi.fn(async () => "commit").mockImplementationOnce(async () => "commit")
      .mockImplementationOnce(() => new Promise<string>(resolve => { releaseSnapshot = resolve; }));
    const { session, drivers, sessionManager } = fixture([async (_input, current, signal) => {
      sink = current; sessionSignal = signal;
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "failed", error: "Native request ended" };
    }], undefined, { snapshotBeforeMessage: snapshot });
    Object.assign(drivers[0]!, { steer: vi.fn(async () => true) });
    const received: unknown[] = [];
    session.subscribe(event => received.push(event));
    const run = session.prompt("Original task");
    await vi.waitFor(() => expect(sink).toBeDefined());
    await session.replaceQueue([{ id: "queued", text: "Updated instruction", images: [] }], []);
    const admission = new AbortController();
    const admitting = sink.steeringStarted!("queued", admission.signal);
    const cancelled = expect(admitting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    admission.abort(); finish(); await run;
    expect(sessionSignal.aborted).toBe(false);
    releaseSnapshot("late-checkpoint");
    await cancelled;
    expect(received).not.toContainEqual(expect.objectContaining({ type: "message_start", queuedPromptId: "queued" }));
    expect(sessionManager.getBranch().filter(item => item.type === "custom" && item.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
    expect(sessionManager.getBranch().filter(item => item.type === "message" && item.message.role === "user")).toHaveLength(1);
    await session.dispose();
  });

  it("preserves repair-only restrictions when a live instruction arrives", async () => {
    let sink!: NativeTurnSink, finish!: () => void;
    const guard = new AutoContinueTools([]), beginTask = vi.fn();
    const { session, drivers, sessionManager } = fixture([async (_input, current) => {
      sink = current;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: "completed" };
    }], undefined, { continuationTools: guard, beginTask });
    Object.assign(drivers[0]!, { steer: vi.fn(async () => true) });
    const run = session.prompt("Recover the original operation");
    await vi.waitFor(() => expect(sink).toBeDefined());
    // assertSafe intentionally permits recovery; it must not permit a fresh task reset.
    const safe = vi.spyOn(guard, "assertSafe").mockImplementation(() => {});
    const repair = vi.spyOn(guard, "repairOnly", "get").mockReturnValue(true);
    const reset = vi.spyOn(guard, "reset");
    await session.replaceQueue([{ id: "correction", text: "Keep the feet separate", images: [] }], []);
    await expect(sink.steeringStarted!("correction")).rejects.toThrow("effects still need recovery");
    expect(safe).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(beginTask).toHaveBeenCalledOnce();
    expect(sessionManager.getBranch().filter((item) => item.type === "message" && item.message.role === "user")).toHaveLength(1);
    session.clearQueue();
    repair.mockRestore(); safe.mockRestore(); reset.mockRestore();
    finish(); await run; await session.dispose();
  });

});

describe.skip("coding agent sessions", () => {
  it("releases changed runtime settings after a busy run and resumes on the next one", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { manager, project, conversation, drivers } = setup([
      async (_input, sink) => {
        sink.nativeSession("native-1");
        await waiting;
        return { status: "completed" };
      },
      async () => ({ status: "completed" }),
    ]);
    try {
      const run = manager.prompt(project, conversation, "work");
      await expect.poll(() => drivers[0]?.inputs.length).toBe(1);
      manager.releaseRuntimeSessions("claude-code-cli");
      expect(drivers[0]!.disposed).toBe(false);
      finish();
      await run.result;
      expect(drivers[0]!.disposed).toBe(true);
      await manager.prompt(project, conversation, "continue").result;
      expect(drivers).toHaveLength(2);
      expect(drivers[1]!.resume).toBe("native-1");
      manager.releaseRuntimeSessions("claude-code-cli");
      expect(drivers[1]!.disposed).toBe(true);
    } finally {
      finish();
      await manager.close();
    }
  });

  it("recreates a runtime whose settings changed while it was loading", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let creating = false;
    const { manager, project, conversation, drivers } = setup(
      [async () => ({ status: "completed" })],
      {
        beforeCreate: async () => {
          creating = true;
          await waiting;
        },
      },
    );
    try {
      const run = manager.prompt(project, conversation, "work");
      await expect.poll(() => creating).toBe(true);
      manager.releaseRuntimeSessions("claude-code-cli");
      finish();
      await run.result;
      expect(drivers).toHaveLength(2);
      expect(drivers[0]!.disposed).toBe(true);
      expect(drivers[0]!.inputs).toHaveLength(0);
      expect(drivers[1]!.inputs).toHaveLength(1);
    } finally {
      finish();
      await manager.close();
    }
  });


  it("stops an idle CLI and resumes the same native session with the next message", async () => {
    const { session, drivers } = fixture(
      [
        async (_input, sink) => {
          sink.nativeSession("native-1");
          sink.textDone("a", "first");
          return { status: "completed" };
        },
      ],
      undefined,
      { idleTimeoutMs: 5 },
    );
    await session.prompt("first request");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drivers[0]!.disposed).toBe(true);
    expect(drivers[1]!.resume).toBe("native-1");
    await session.prompt("second request");
    expect(drivers[0]!.inputs).toHaveLength(1);
    // The resumed CLI keeps its context, so the message is not wrapped in a handoff.
    expect(drivers[1]!.inputs.map((input) => input.text)).toEqual([
      "second request",
    ]);
    session.dispose();
  });

  it("invalidates native context when editing a later message and keeps it invalid after restart", async () => {
    const { session, sessionManager, drivers } = fixture([
      async (_input, sink) => {
        sink.nativeSession("native-1");
        sink.textDone("a", "first");
        return { status: "completed" };
      },
      async (_input, sink) => {
        sink.textDone("b", "second");
        return { status: "completed" };
      },
    ]);
    await session.prompt("first request");
    await session.prompt("second request to remove");
    const second = sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )[1]!;
    await session.navigateTree(second.id);
    expect(drivers[0]!.disposed).toBe(true);
    expect(drivers[1]!.resume).toBeUndefined();
    expect(
      latestNativeSession(sessionManager.getBranch(), "claude-code-cli"),
    ).toBeUndefined();
    session.dispose();
    const restarted = fixture([], sessionManager);
    await restarted.session.prompt("replacement second request");
    expect(restarted.drivers[0]!.resume).toBeUndefined();
    expect(restarted.drivers[0]!.inputs[0]!.text).toContain("first request");
    expect(restarted.drivers[0]!.inputs[0]!.text).not.toContain(
      "second request to remove",
    );
    restarted.session.dispose();
  });

  it("hands off Pi turns instead of resuming a stale native session", async () => {
    const sm = SessionManager.inMemory("/tmp/project-1");
    sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
    sm.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      state: "ready",
      runtime: "claude-code-cli",
      sessionId: "native-1",
    });
    sm.appendModelChange("pi-provider", "pi-model");
    sm.appendMessage({
      role: "user",
      content: "new requirement handled by Pi",
      timestamp: 2,
    });
    sm.appendModelChange("claude-code-cli", "sonnet");
    const { session, drivers } = fixture([], sm);
    await session.prompt("continue");
    expect(drivers[0]!.resume).toBeUndefined();
    expect(drivers[0]!.inputs[0]!.text).toContain(
      "new requirement handled by Pi",
    );
    session.dispose();
  });

  it("rebuilds an expired native session with one handoff and one stored user message", async () => {
    const sm = SessionManager.inMemory("/tmp/project-1");
    sm.appendMessage({
      role: "user",
      content: "keep the original requirement",
      timestamp: 1,
    });
    sm.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      state: "ready",
      runtime: "claude-code-cli",
      sessionId: "expired",
    });
    const { session, drivers } = fixture(
      [
        async () => {
          throw new NativeSessionExpiredError("gone");
        },
        async (_input, sink) => {
          sink.nativeSession("replacement");
          sink.textDone("a", "continued");
          return { status: "completed" };
        },
      ],
      sm,
    );
    await session.prompt("continue");
    expect(drivers.map((driver) => driver.resume)).toEqual([
      "expired",
      undefined,
    ]);
    expect(drivers[1]!.inputs[0]!.text).toContain(
      "keep the original requirement",
    );
    expect(
      sm
        .getBranch()
        .filter(
          (entry) => entry.type === "message" && entry.message.role === "user",
        ),
    ).toHaveLength(2);
    expect(
      latestNativeSession(sm.getBranch(), "claude-code-cli")?.sessionId,
    ).toBe("replacement");
    session.dispose();
  });

  it("persists a terminal stop when a native turn ends after a denied tool without final text", async () => {
    const { session } = fixture([
      async (_input, sink) => {
        sink.toolCall("read-1", "read", { path: "/outside" });
        sink.toolResult(
          "read-1",
          { content: [{ type: "text", text: "Denied" }] },
          true,
        );
        return { status: "completed" };
      },
    ]);
    await session.prompt("read file");
    expect(
      conversationItems(session.sessionManager.getBranch()).some(
        (item) => item.type === "agentMessage" && item.status === "interrupted",
      ),
    ).toBe(false);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    session.dispose();
  });

  it("queues steering until native writes finish and snapshots before delivery", async () => {
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { session, drivers } = fixture(
      [
        async () => {
          order.push("first");
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: "completed" };
        },
        async () => {
          order.push("steered");
          return { status: "completed" };
        },
      ],
      undefined,
      {
        snapshotBeforeMessage: async () => {
          order.push("snapshot");
          return "commit";
        },
      },
    );
    const run = session.prompt("first");
    await ready;
    await session.steer("steered");
    expect(drivers[0]!.inputs).toHaveLength(1);
    release();
    await run;
    expect(order).toEqual(["snapshot", "first", "snapshot", "steered"]);
    session.dispose();
  });

  it("does not deliver a prompt cancelled while its checkpoint is pending", async () => {
    let release!: (value: string) => void;
    const { session, drivers } = fixture([], undefined, {
      snapshotBeforeMessage: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      cancellationTimeoutMs: 10,
    });
    const run = session.prompt("cancel before launch");
    const cancelled = session.abort();
    release("commit");
    await Promise.all([run, cancelled]);
    expect(drivers.flatMap((driver) => driver.inputs)).toEqual([]);
    session.dispose();
  });

  it("rebuilds context for legacy or interrupted native metadata", () => {
    for (const data of [
      { version: 1, runtime: "claude-code-cli", sessionId: "legacy" },
      {
        version: 2,
        state: "active",
        runtime: "claude-code-cli",
        sessionId: "interrupted",
      },
    ]) {
      const sm = SessionManager.inMemory("/tmp/project-1");
      sm.appendCustomEntry(NATIVE_SESSION_ENTRY, data);
      expect(
        latestNativeSession(sm.getBranch(), "claude-code-cli"),
      ).toBeUndefined();
    }
  });

  it("persists native compaction display records", async () => {
    const { session, sessionManager } = fixture([
      async (_input, sink) => {
        sink.compaction("start");
        sink.compaction("end", { summary: "kept context", tokensBefore: 200 });
        return { status: "completed" };
      },
    ]);
    await session.prompt("compact fixture");
    expect(conversationItems(sessionManager.getBranch(), false)).toContainEqual(
      expect.objectContaining({
        type: "contextCompaction",
        summary: "kept context",
        tokensBefore: 200,
      }),
    );
    session.dispose();
  });
  it("records a turn in the conversation the way OhMyGame's own agent does", async () => {
    let commit = 0;
    const { manager, project, conversation, sessionManager, received } = setup(
      [
        async (_input, sink) => {
          sink.nativeSession("native-1");
          sink.thinking("r1", "Planning");
          sink.thinkingDone("r1");
          sink.text("t1", "Checking ");
          sink.text("t1", "the canvas");
          sink.textDone("t1");
          sink.toolCall("call-1", "canvas_check", {});
          sink.toolStarted("call-1");
          sink.toolResult(
            "call-1",
            {
              content: [{ type: "text", text: "ok" }],
              details: {
                artifact: {
                  type: "image",
                  path: "art/cover.png",
                  mediaType: "image/png",
                },
              },
            },
            false,
          );
          sink.text("t2", "Done");
          sink.textDone("t2");
          sink.usage(
            { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
            1_000,
            400,
          );
          return { status: "completed" };
        },
      ],
      { snapshot: async () => (++commit).toString(16).padStart(40, "0") },
    );

    const run = manager.prompt(project, conversation, "Make a cover");
    await expect(run.result).resolves.toBe("completed");

    const stored = items(sessionManager);
    expect(stored.map((item) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "agentMessage",
      "dynamicToolCall",
      "agentMessage",
    ]);
    expect(stored[0]).toMatchObject({
      type: "userMessage",
      text: "Make a cover",
      checkpointId: expect.any(String),
    });
    expect(stored[3]).toMatchObject({
      type: "dynamicToolCall",
      tool: "canvas_check",
      status: "completed",
      output: "ok",
      artifact: { path: "art/cover.png" },
    });
    expect(stored[4]).toMatchObject({
      type: "agentMessage",
      text: "Done",
      status: "completed",
    });
    // The checkpoint is taken before the message is stored, as Pi's checkpoint extension does.
    const branch = sessionManager.getBranch();
    const checkpoint = branch.findIndex(
      (entry) =>
        entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY,
    );
    const message = branch.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(checkpoint).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeLessThan(message);
    expect(latestNativeSession(branch, "claude-code-cli")).toEqual({
      version: 2,
      state: "ready",
      runtime: "claude-code-cli",
      sessionId: "native-1",
    });

    const types = received.map((event) => event.type);
    expect(types).toContain("checkpoint.created");
    expect(types).toContain("item.agentMessage.delta");
    expect(types).toContain("agent.completed");
    expect(types).toContain("checkpoint.completed");
    await expect(manager.contextUsage(project, conversation)).resolves.toEqual({
      tokens: 400,
      contextWindow: 1_000,
      percent: 40,
    });
  });

  it("reports the account's latest quota before the conversation's first turn", async () => {
    const limits = [
      { id: "claude/five_hour", usedPercent: 18, windowMinutes: 300 },
    ];
    const { manager, project, conversation } = setup([], {
      accountLimits: () => limits,
    });
    await expect(manager.contextUsage(project, conversation)).resolves.toEqual({
      tokens: null,
      contextWindow: 0,
      percent: null,
      limits,
    });
  });

  it("runs a message sent during a turn after it, in the same run", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, project, conversation, sessionManager, drivers } = setup([
      async (_input, sink) => {
        await held;
        sink.text("a", "first");
        return { status: "completed" };
      },
      async (_input, sink) => {
        sink.text("b", "second");
        return { status: "completed" };
      },
    ]);
    const run = manager.prompt(project, conversation, "one");
    await expect.poll(() => drivers[0]?.inputs.length).toBe(1);
    const queued = manager.prompt(project, conversation, "two");
    expect(queued.queued).toBe(true);
    // Admission reads project context asynchronously; finish it while the
    // first turn is still held so this actually exercises the same-run queue.
    await queued.result;
    release();
    await run.result;
    expect(drivers[0]!.inputs.map((input) => input.text)).toEqual([
      "one",
      "two",
    ]);
    expect(
      items(sessionManager)
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.type === "agentMessage" && item.text),
    ).toEqual(["first", "second"]);
  });

  it("stops a turn and keeps what the agent said before it was stopped", async () => {
    let spoke!: () => void;
    const said = new Promise<void>((resolve) => {
      spoke = resolve;
    });
    const { manager, project, conversation, sessionManager, received } = setup([
      async (_input, sink, signal) => {
        sink.text("a", "Working");
        spoke();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "aborted" };
      },
    ]);
    const run = manager.prompt(project, conversation, "go");
    // Stop only once the agent has spoken: a fixed delay raced a slow runner.
    await said;
    await manager.cancel(project.id, conversation.summary.id, run.turnId);
    await expect(run.result).resolves.toBe("cancelled");
    expect(received.map((event) => event.type)).toContain("agent.cancelled");
    expect(
      items(sessionManager).find((item) => item.type === "agentMessage"),
    ).toMatchObject({ text: "Working", status: "cancelled" });
  });

  it("reports an agent's failure as the turn's error", async () => {
    const { manager, project, conversation, received } = setup([
      async () => ({
        status: "failed",
        error: "Claude Code exited with code 1: not signed in",
      }),
    ]);
    const run = manager.prompt(project, conversation, "go");
    await expect(run.result).rejects.toThrow("not signed in");
    expect(
      received.find((event) => event.type === "agent.error")?.data,
    ).toEqual({ error: "Claude Code exited with code 1: not signed in", diagnostics: { provider: "claude-code-cli", model: "sonnet" } });
  });

  it("asks the person and remembers an answer for the conversation", async () => {
    const decisions: string[] = [];
    const { manager, project, conversation, received, sessionManager } = setup([
      async (_input, sink) => {
        const request = {
          kind: "command" as const,
          tool: "Bash",
          command: "git push",
          canAllowSession: true,
        };
        decisions.push(
          await sink.requestApproval(request, { callId: "call-1" }),
        );
        decisions.push(
          await sink.requestApproval(request, { callId: "call-2" }),
        );
        return { status: "completed" };
      },
    ]);
    received.length = 0;
    const run = manager.prompt(project, conversation, "push it");
    await expect
      .poll(() =>
        received.find(
          (event) =>
            event.type === "item.started" &&
            (event.data as { item: ThreadItem }).item.type ===
              "approvalRequest",
        ),
      )
      .toBeTruthy();
    const started = received.find(
      (event) =>
        event.type === "item.started" &&
        (event.data as { item: ThreadItem }).item.type === "approvalRequest",
    )!;
    const item = (
      started.data as { item: Extract<ThreadItem, { type: "approvalRequest" }> }
    ).item;
    expect(item.request.command).toBe("git push");
    expect(() =>
      manager.answerApproval(
        project.id,
        conversation.summary.id,
        "unknown",
        "allow",
      ),
    ).toThrow();
    manager.answerApproval(
      project.id,
      conversation.summary.id,
      item.requestId,
      "allow-session",
    );
    await run.result;
    // The second request matched the first and was not asked again.
    expect(decisions).toEqual(["allow-session", "allow"]);
    expect(
      received.filter(
        (event) =>
          event.type === "item.started" &&
          (event.data as { item: ThreadItem }).item.type === "approvalRequest",
      ),
    ).toHaveLength(1);
    expect(
      conversationItems(sessionManager.getBranch(), false).filter(
        (item) => item.type === "approvalRequest",
      ),
    ).toEqual([
      expect.objectContaining({
        decision: "allow-session",
        status: "completed",
      }),
    ]);
  });

  it("lets a conversation approval cover what its scope names, and nothing else", async () => {
    const decisions: string[] = [];
    const command = (text: string, commands: string[]) => ({
      kind: "command" as const,
      tool: "Bash",
      command: text,
      canAllowSession: true,
      sessionScope: { commands },
    });
    const read = (file: string, folder: string) => ({
      kind: "file" as const,
      tool: "Read",
      path: file,
      canAllowSession: true,
      sessionScope: { readFolders: [folder] },
    });
    const { manager, project, conversation, received } = setup([
      async (_input, sink) => {
        for (const request of [
          command("git push origin main", ["git push"]),
          command("git push upstream dev", ["git push"]),
          command("npm publish", ["npm publish"]),
          read("/notes/a.md", "/notes"),
          read("/notes/drafts/b.md", "/notes/drafts"),
          read("/other/c.md", "/other"),
        ])
          decisions.push(await sink.requestApproval(request));
        return { status: "completed" };
      },
    ]);
    received.length = 0;
    const run = manager.prompt(project, conversation, "go");
    const asked = new Set<string>();
    const answer = async (decision: "allow-session" | "deny") => {
      let item: Extract<ThreadItem, { type: "approvalRequest" }> | undefined;
      await expect
        .poll(() => {
          item = received
            .filter((event) => event.type === "item.started")
            .map(
              (event) =>
                (event.data as { item: ThreadItem }).item as Extract<
                  ThreadItem,
                  { type: "approvalRequest" }
                >,
            )
            .find(
              (candidate) =>
                candidate.type === "approvalRequest" &&
                !asked.has(candidate.requestId),
            );
          return item;
        })
        .toBeTruthy();
      asked.add(item!.requestId);
      manager.answerApproval(
        project.id,
        conversation.summary.id,
        item!.requestId,
        decision,
      );
    };
    await answer("allow-session"); // git push origin main
    await answer("deny"); // npm publish: another command
    await answer("allow-session"); // /notes/a.md
    await answer("deny"); // /other/c.md: another folder
    await run.result;
    expect(decisions).toEqual([
      "allow-session",
      "allow",
      "deny",
      "allow-session",
      "allow",
      "deny",
    ]);
    expect(asked.size).toBe(4);
  });

  it("denies requests that are still waiting when the turn is stopped", async () => {
    let decision: string | undefined;
    const { manager, project, conversation, received } = setup([
      async (_input, sink, signal) => {
        decision = await sink.requestApproval(
          {
            kind: "file",
            tool: "Write",
            path: "/etc/hosts",
            canAllowSession: false,
          },
          { signal },
        );
        return { status: signal.aborted ? "aborted" : "completed" };
      },
    ]);
    const run = manager.prompt(project, conversation, "edit hosts");
    await expect
      .poll(() =>
        received.some(
          (event) =>
            event.type === "item.started" &&
            (event.data as { item: ThreadItem }).item.type ===
              "approvalRequest",
        ),
      )
      .toBe(true);
    await manager.cancel(project.id, conversation.summary.id, run.turnId);
    await run.result;
    expect(decision).toBe("deny");
  });

  it("starts a new native session with a summary after going back before the one it had", async () => {
    const sessionManager = SessionManager.inMemory("/tmp/project-1");
    const { manager, project, conversation, drivers } = setup(
      [
        async (_input, sink) => {
          sink.nativeSession("native-1");
          sink.text("a", "Made hello.txt");
          return { status: "completed" };
        },
        async (_input, sink) => {
          sink.text("b", "Second answer");
          return { status: "completed" };
        },
        async () => ({ status: "completed" }),
      ],
      { sessionManager },
    );
    await manager.prompt(project, conversation, "make hello").result;
    await manager.prompt(project, conversation, "again").result;
    // Editing the first message goes back to before the native session began.
    const first = sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!;
    sessionManager.branch(first.id);
    const fresh = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager,
      createDriver: (resume) => {
        const driver = new ScriptedDriver([], resume);
        drivers.push(driver);
        return driver;
      },
      requestApproval: async () => "deny",
      toolNames: [],
    });
    expect(drivers.at(-1)!.resume).toBeUndefined();
    await fresh.prompt("continue");
    expect(drivers.at(-1)!.inputs[0]!.text).toContain("<conversation-handoff>");
    expect(drivers.at(-1)!.inputs[0]!.text).toContain("User: make hello");
    expect(drivers.at(-1)!.inputs[0]!.text).toMatch(/continue$/);
  });

  it("continues the native session of the same agent and hands off from another one", () => {
    const sessionManager = SessionManager.inMemory("/tmp/project-1");
    sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      state: "ready",
      runtime: "claude-code-cli",
      sessionId: "claude-1",
    });
    expect(
      latestNativeSession(sessionManager.getBranch(), "claude-code-cli")
        ?.sessionId,
    ).toBe("claude-1");
    sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      state: "ready",
      runtime: "codex-cli",
      sessionId: "codex-1",
    });
    // Codex held the conversation since; Claude Code's session has not seen that.
    expect(
      latestNativeSession(sessionManager.getBranch(), "claude-code-cli"),
    ).toBeUndefined();
    expect(
      latestNativeSession(sessionManager.getBranch(), "codex-cli")?.sessionId,
    ).toBe("codex-1");
  });

  it("marks planning turns read-only from the tools OhMyGame allows", async () => {
    const { manager, project, conversation, drivers } = setup([
      async () => ({ status: "completed" }),
    ]);
    await manager.prompt(project, conversation, "plan it", [], [], "planning")
      .result;
    expect(drivers[0]!.inputs[0]!.readOnly).toBe(true);
  });
});

it("does not duplicate delayed native text completions after a tool flushes the assistant", async () => {
  const store = SessionManager.inMemory("/tmp/native-events");
  const session = new NativeCodingSession({
    runtime: "opencode-cli",
    model: "model",
    sessionManager: store,
    toolNames: [],
    requestApproval: async () => "deny",
    createDriver: () =>
      new ScriptedDriver(
        [
          async (_input, sink) => {
            sink.text("part-1", "Checking.");
            sink.toolCall("tool-1", "read", { path: "file" });
            sink.toolStarted("tool-1");
            sink.textDone("part-1", "Checking.");
            sink.toolResult("tool-1", { content: [] }, false);
            sink.text("part-2", "Done.");
            sink.textDone("part-2", "Done.");
            sink.textDone("part-2", "Done.");
            return { status: "completed" };
          },
        ],
        undefined,
      ),
  });
  await session.prompt("test event order");
  const texts = session.messages.flatMap((message: any) =>
    message.role === "assistant"
      ? message.content
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
      : [],
  );
  expect(texts).toEqual(["Checking.", "Done."]);
  session.dispose();
});

it("keeps only the unseen suffix when a native text block continues across a tool", async () => {
  const session = new NativeCodingSession({
    runtime: "opencode-cli",
    model: "model",
    sessionManager: SessionManager.inMemory("/tmp/native-suffix"),
    toolNames: [],
    requestApproval: async () => "deny",
    createDriver: () =>
      new ScriptedDriver(
        [
          async (_input, sink) => {
            sink.text("part", "Before.");
            sink.toolCall("tool", "read", {});
            sink.toolStarted("tool");
            sink.toolResult("tool", { content: [] }, false);
            sink.text("part", " After.");
            sink.textDone("part", "Before. After.");
            return { status: "completed" };
          },
        ],
        undefined,
      ),
  });
  await session.prompt("test suffix");
  expect(
    session.messages.flatMap((message: any) =>
      message.role === "assistant"
        ? message.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
        : [],
    ),
  ).toEqual(["Before.", " After."]);
  session.dispose();
});

describe("controlled Qoder shared sessions", () => {
  it("resumes only the completed Qoder context after the manager restarts", async () => {
    const first = setup([async (_input, sink) => {
      sink.nativeSession("qoder-ready");
      sink.textDone("answer", "The retained work is complete.");
      return { status: "completed" };
    }], { runtime: "qoder-cli" });
    await first.manager.prompt(first.project, first.conversation, "keep this work").result;
    expect(latestNativeSession(first.sessionManager.getBranch(), "qoder-cli")).toMatchObject({ state: "ready", sessionId: "qoder-ready" });
    await first.manager.close();
    expect(first.drivers[0]!.disposed).toBe(true);

    const restarted = setup([], { runtime: "qoder-cli", sessionManager: first.sessionManager });
    try {
      await restarted.manager.prompt(restarted.project, restarted.conversation, "continue").result;
      expect(restarted.drivers[0]!.resume).toBe("qoder-ready");
      expect(restarted.drivers[0]!.inputs[0]!.text).toBe("continue");
    } finally { await restarted.manager.close(); }
  });

  it.each(["cancel", "failure"] as const)("invalidates a %s outcome and hands off to a fresh Qoder context", async (outcome) => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const state = setup([async (_input, sink, signal) => {
      sink.nativeSession("qoder-unfinished");
      sink.text("answer", "Work is still uncertain.");
      started();
      if (outcome === "failure") return { status: "failed", error: "Fixture Qoder failure" };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "aborted" };
    }], { runtime: "qoder-cli" });
    try {
      const run = state.manager.prompt(state.project, state.conversation, "retain the original requirement");
      if (outcome === "failure") await expect(run.result).rejects.toThrow("Fixture Qoder failure");
      else {
        await running;
        await state.manager.cancel(state.project.id, state.conversation.summary.id, run.turnId);
        await expect(run.result).resolves.toBe("cancelled");
      }
      const markers = state.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === NATIVE_SESSION_ENTRY);
      expect(markers).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ runtime: "qoder-cli", state: "invalid" }) }));
      expect(markers).not.toContainEqual(expect.objectContaining({ data: expect.objectContaining({ state: "ready" }) }));
      expect(latestNativeSession(state.sessionManager.getBranch(), "qoder-cli")).toBeUndefined();
    } finally { await state.manager.close(); }

    const restarted = setup([], { runtime: "qoder-cli", sessionManager: state.sessionManager });
    try {
      await restarted.manager.prompt(restarted.project, restarted.conversation, "inspect before continuing").result;
      expect(restarted.drivers[0]!.resume).toBeUndefined();
      expect(restarted.drivers[0]!.inputs[0]!.text).toContain("<conversation-handoff>");
      expect(restarted.drivers[0]!.inputs[0]!.text).toContain("retain the original requirement");
    } finally { await restarted.manager.close(); }
  });

  it.each([false, true])("retries an explicitly expired Qoder context once without duplicate messages or checkpoints (fresh failure: %s)", async (failsAgain) => {
    const store = SessionManager.inMemory("/tmp/qoder-expired-context");
    store.appendMessage({ role: "user", content: "keep the original requirement", timestamp: 1 });
    store.appendCustomEntry(NATIVE_SESSION_ENTRY, { version: 2, state: "ready", runtime: "qoder-cli", sessionId: "qoder-expired" });
    const state = setup([
      async () => { throw new NativeSessionExpiredError("expired fixture context"); },
      async (_input, sink) => {
        if (failsAgain) throw new NativeSessionExpiredError("replacement fixture context expired");
        sink.nativeSession("qoder-replacement");
        sink.textDone("answer", "Continued after inspecting the current work.");
        return { status: "completed" };
      },
    ], { runtime: "qoder-cli", sessionManager: store, snapshot: async () => "1".repeat(40) });
    try {
      const run = state.manager.prompt(state.project, state.conversation, "continue once");
      if (failsAgain) await expect(run.result).rejects.toThrow("replacement fixture context expired");
      else await expect(run.result).resolves.toBe("completed");
      expect(state.drivers[0]!.resume).toBe("qoder-expired");
      expect(state.drivers[1]!.resume).toBeUndefined();
      expect(state.drivers.flatMap((driver) => driver.inputs)).toHaveLength(2);
      expect(state.drivers[1]!.inputs[0]!.text).toContain("<conversation-handoff>");
      expect(state.drivers[1]!.inputs[0]!.text).toContain("keep the original requirement");
      const branch = store.getBranch();
      expect(branch.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
      expect(branch.filter((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY)).toHaveLength(1);
      expect(items(store).filter((item) => item.type === "userMessage" && item.text === "continue once")).toHaveLength(1);
      expect(latestNativeSession(branch, "qoder-cli")?.sessionId).toBe(failsAgain ? undefined : "qoder-replacement");
    } finally { await state.manager.close(); }
  });

  it("passes planning's read-only tool set to Qoder and restores the ordinary tool set explicitly", async () => {
    const state = setup([], { runtime: "qoder-cli", toolNames: ["canvas_check", "isolated_shell", "build_game"] });
    try {
      await state.manager.prompt(state.project, state.conversation, "inspect and plan", [], [], "planning").result;
      expect(state.drivers[0]!.inputs[0]!.readOnly).toBe(true);
      expect(state.activeTools.at(-1)).toEqual(expect.arrayContaining(["read", "grep", "canvas_check"]));
      expect(state.activeTools.at(-1)).not.toEqual(expect.arrayContaining(["write"]));
      expect(state.activeTools.at(-1)).not.toEqual(expect.arrayContaining(["edit"]));
      expect(state.activeTools.at(-1)).not.toEqual(expect.arrayContaining(["isolated_shell"]));
      expect(state.activeTools.at(-1)).not.toEqual(expect.arrayContaining(["build_game"]));
      await state.manager.prompt(state.project, state.conversation, "perform the requested work", [], [], "normal").result;
      expect(state.drivers[0]!.inputs[1]!.readOnly).toBe(false);
      expect(state.activeTools.at(-1)).toEqual(expect.arrayContaining(["write", "edit", "isolated_shell", "build_game"]));
    } finally { await state.manager.close(); }
  });

  it("denies Qoder approvals still pending when its turn is cancelled", async () => {
    let decision: string | undefined;
    const state = setup([async (_input, sink, signal) => {
      decision = await sink.requestApproval({ kind: "tool", tool: "recover_isolated_changes", canAllowSession: false }, { callId: "pending-review", signal });
      return { status: signal.aborted ? "aborted" : "completed" };
    }], { runtime: "qoder-cli" });
    try {
      const run = state.manager.prompt(state.project, state.conversation, "review retained changes");
      await expect.poll(() => state.manager.activeItems(state.project.id, state.conversation.summary.id).some((item) => item.type === "approvalRequest" && item.requestId === "pending-review")).toBe(true);
      await state.manager.cancel(state.project.id, state.conversation.summary.id, run.turnId);
      await expect(run.result).resolves.toBe("cancelled");
      expect(decision).toBe("deny");
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "pending-review", "allow")).toThrow("no longer active");
      expect(latestNativeSession(state.sessionManager.getBranch(), "qoder-cli")).toBeUndefined();
    } finally { await state.manager.close(); }
  });

  it("requires the exact host source confirmation even after Qoder receives a session permission", async () => {
    const review = { reviewId: "a".repeat(64), generation: "22", projectId: "project-1", snapshotId: "b".repeat(64), files: [{ path: "src/main.ts", kind: "code" as const, change: "added" as const, bytes: 10, afterSha256: "c".repeat(64), preview: "untrusted" }], blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
    const decisions: string[] = [];
    const state = setup([async (_input, sink, signal) => {
      decisions.push(await sink.requestApproval({ kind: "tool", tool: "recover_isolated_changes", canAllowSession: true }, { callId: "sdk-permission", signal }));
      // The retained-file tool asks the host directly; SDK grants do not answer this review.
      decisions.push(await state.manager.askApproval(state.project.id, state.conversation.summary.id, "host-review", { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review }, signal));
      return { status: "completed" };
    }], { runtime: "qoder-cli" });
    const waiting = (requestId: string) => state.manager.activeItems(state.project.id, state.conversation.summary.id).some((item) => item.type === "approvalRequest" && item.requestId === requestId);
    try {
      const run = state.manager.prompt(state.project, state.conversation, "adopt the reviewed batch");
      await expect.poll(() => waiting("sdk-permission")).toBe(true);
      state.manager.answerApproval(state.project.id, state.conversation.summary.id, "sdk-permission", "allow-session");
      await expect.poll(() => waiting("host-review")).toBe(true);
      const answer = (confirmation?: { reviewId: string; filesReviewed: boolean; codeReviewed?: boolean }) => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "host-review", "allow", confirmation);
      expect(() => answer()).toThrow("Confirm the exact retained file list");
      expect(() => answer({ reviewId: "wrong-review", filesReviewed: true, codeReviewed: true })).toThrow("Confirm the exact retained file list");
      expect(() => answer({ reviewId: review.reviewId, filesReviewed: true, codeReviewed: false })).toThrow("Confirm the exact retained file list");
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "host-review", "allow-session")).toThrow("only be allowed once");
      expect(decisions).toEqual(["allow-session"]);
      answer({ reviewId: review.reviewId, filesReviewed: true, codeReviewed: true });
      await expect(run.result).resolves.toBe("completed");
      expect(decisions).toEqual(["allow-session", "allow"]);
    } finally { await state.manager.close(); }
  });
});

describe("volume migration approvals", () => {
  it.each(["session", "project", "kind", "mixed", "missing"])("refuses a malformed migration request without presenting an approvable card: %s", async fault => {
    let decision: string | undefined;
    const state = setup([async (_input, _sink, signal) => {
      const review = volumeMigrationReview(fault === "project" ? "another-project" : state.project.id);
      const details = { kind: fault === "kind" ? "tool" as const : "volumeMigration" as const, tool: "execution_storage", canAllowSession: fault === "session",
        ...(fault !== "missing" ? { volumeMigration: review } : {}), ...(fault === "mixed" ? { isolatedSourceReview: { reviewId: "a".repeat(64) } as never } : {}) };
      decision = await state.manager.askApproval(state.project.id, state.conversation.summary.id, "invalid-volume", details, signal);
      return { status: "completed" };
    }], { runtime: "qoder-cli" });
    try {
      await expect(state.manager.prompt(state.project, state.conversation, "inspect the request").result).resolves.toBe("completed");
      expect(decision).toBe("deny");
      expect(state.received.some(event => event.type === "item.started" && (event.data as { item: ThreadItem }).item.type === "approvalRequest")).toBe(false);
    } finally { await state.manager.close(); }
  });
  it.each(["codex-cli", "qoder-cli"] as const)("requires an exact host confirmation after an SDK session permission (%s)", async runtime => {
    const decisions: string[] = [];
    let review!: VolumeMigrationReview;
    const state = setup([async (_input, sink, signal) => {
      decisions.push(await sink.requestApproval({ kind: "tool", tool: "execution_storage", canAllowSession: true }, { callId: "sdk-permission", signal }));
      decisions.push(await state.manager.askApproval(state.project.id, state.conversation.summary.id, "migration", { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review }, signal));
      return { status: "completed" };
    }], { runtime });
    review = volumeMigrationReview(state.project.id);
    const confirmation = volumeMigrationConfirmation(review);
    const waiting = (id: string) => state.manager.activeItems(state.project.id, state.conversation.summary.id).some(item => item.type === "approvalRequest" && item.requestId === id);
    try {
      const run = state.manager.prompt(state.project, state.conversation, "request this exact migration");
      await expect.poll(() => waiting("sdk-permission")).toBe(true);
      state.manager.answerApproval(state.project.id, state.conversation.summary.id, "sdk-permission", "allow-session");
      await expect.poll(() => waiting("migration")).toBe(true);
      const answer = (value?: typeof confirmation) => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "migration", "allow", undefined, value);
      expect(() => answer()).toThrow("exact migration plan");
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "migration", "allow", { reviewId: "a".repeat(64), filesReviewed: true, codeReviewed: true })).toThrow("exact migration plan");
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "migration", "allow-session", undefined, confirmation)).toThrow();
      for (const changed of [{ planId: "22222222-2222-4222-8222-222222222222" }, { generation: 8 }, { sourceImageSha256: "b".repeat(64) }, { capacityReviewed: false }, { approved: true }])
        expect(() => answer({ ...confirmation, ...changed })).toThrow("exact migration plan");
      expect(decisions).toEqual(["allow-session"]);
      // Mutating the caller's DTO cannot rewrite the request the person reviewed.
      review.source.imageSha256 = "c".repeat(64);
      answer(confirmation);
      await expect(run.result).resolves.toBe("completed"); expect(decisions).toEqual(["allow-session", "allow"]);
      expect(() => answer(confirmation)).toThrow("no longer active");
    } finally { await state.manager.close(); }
  });

  it("authorizes a strictly unallocated creation with a null source hash only through its own confirmation", async () => {
    let decision: string | undefined;
    const state = setup([async (_input, _sink, signal) => {
      decision = await state.manager.askApproval(state.project.id, state.conversation.summary.id, "create-volume", { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review }, signal);
      return { status: "completed" };
    }], { runtime: "qoder-cli" });
    const review = volumeMigrationReview(state.project.id, true), confirmation = volumeMigrationConfirmation(review);
    try {
      const run = state.manager.prompt(state.project, state.conversation, "create the selected execution store");
      await expect.poll(() => state.manager.activeItems(state.project.id, state.conversation.summary.id).some(item => item.type === "approvalRequest")).toBe(true);
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "create-volume", "allow", undefined, { ...confirmation, sourceImageSha256: "a".repeat(64) })).toThrow("exact migration plan");
      state.manager.answerApproval(state.project.id, state.conversation.summary.id, "create-volume", "allow", undefined, confirmation);
      await expect(run.result).resolves.toBe("completed"); expect(decision).toBe("allow");
    } finally { await state.manager.close(); }
  });

  it.each(["expired", "unknown", "history", "inodes"])("keeps an unapprovable %s request pending until it is denied", async fault => {
    let decision: string | undefined;
    const state = setup([async (_input, _sink, signal) => {
      decision = await state.manager.askApproval(state.project.id, state.conversation.summary.id, "blocked-volume", { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review }, signal);
      return { status: "completed" };
    }], { runtime: "qoder-cli" });
    const review = volumeMigrationReview(state.project.id);
    if (fault === "expired") review.expiresAt = "2000-01-01T00:00:00Z";
    if (fault === "unknown") review.resources.guestAvailableBytes = null;
    if (fault === "history") review.resources.recoveryUsedBytes = 1024 ** 3;
    if (fault === "inodes") review.resources.availableInodes = 0;
    try {
      const run = state.manager.prompt(state.project, state.conversation, "inspect the blocked plan");
      await expect.poll(() => state.manager.activeItems(state.project.id, state.conversation.summary.id).some(item => item.type === "approvalRequest")).toBe(true);
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "blocked-volume", "allow", undefined, volumeMigrationConfirmation(review))).toThrow("exact migration plan");
      expect(decision).toBeUndefined();
      state.manager.answerApproval(state.project.id, state.conversation.summary.id, "blocked-volume", "deny");
      await expect(run.result).resolves.toBe("completed"); expect(decision).toBe("deny");
    } finally { await state.manager.close(); }
  });

  it("denies an unanswered migration when the turn is cancelled", async () => {
    let decision: string | undefined;
    const state = setup([async (_input, _sink, signal) => {
      decision = await state.manager.askApproval(state.project.id, state.conversation.summary.id, "pending-volume", { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: volumeMigrationReview(state.project.id) }, signal);
      return { status: signal.aborted ? "aborted" : "completed" };
    }], { runtime: "qoder-cli" });
    try {
      const run = state.manager.prompt(state.project, state.conversation, "review the migration");
      await expect.poll(() => state.manager.activeItems(state.project.id, state.conversation.summary.id).some(item => item.type === "approvalRequest")).toBe(true);
      await state.manager.cancel(state.project.id, state.conversation.summary.id, run.turnId);
      await expect(run.result).resolves.toBe("cancelled"); expect(decision).toBe("deny");
      expect(() => state.manager.answerApproval(state.project.id, state.conversation.summary.id, "pending-volume", "allow", undefined, volumeMigrationConfirmation(volumeMigrationReview(state.project.id)))).toThrow("no longer active");
    } finally { await state.manager.close(); }
  });
});
