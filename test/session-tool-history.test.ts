import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { SessionImages } from "../src/daemon/session-images.js";
import {
  completedToolTextEdits,
  createToolTextRecall,
  projectDeliveredFileHistory,
} from "../src/daemon/session-tool-history.js";

const source = Array.from({ length: 800 }, (_, i) => `source line ${i}\n`).join(
  "",
);
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (
  id: string,
  name: string,
  args: ToolCall["arguments"] = {},
): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const assistant = (
  manager: SessionManager,
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"] = [],
  options: Partial<
    Pick<AssistantMessage, "model" | "provider" | "timestamp">
  > = {},
) =>
  manager.appendMessage({
    role: "assistant",
    content,
    stopReason,
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...options,
  });
const result = (
  manager: SessionManager,
  tool: ToolCall,
  content: ToolResultMessage["content"],
  isError = false,
  details?: ToolResultMessage["details"],
) =>
  manager.appendMessage({
    role: "toolResult",
    toolCallId: tool.id,
    toolName: tool.name,
    content,
    isError,
    ...(details !== undefined ? { details } : {}),
    timestamp: 1,
  });
const edits = (manager: SessionManager) =>
  completedToolTextEdits(manager.buildSessionProjection().entries);
const recall = (manager: SessionManager, ref: string, offset = 0) =>
  createToolTextRecall(manager).execute(
    "lookup",
    { ref, offset },
    undefined,
    undefined,
    {} as never,
  );

it("restores the same Pi projection after reopen and only recalls excerpts that are still authorized on the current branch", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-tool-history");
  manager.appendMessage({
    role: "user",
    content: "Write and inspect the script",
    timestamp: 1,
  });
  const write = call("write", "write", { path: "model.py", content: source });
  const read = call("read", "read", { path: "model.py" });
  const request = assistant(manager, "toolUse", [write, read]);
  result(manager, write, [text("Saved")]);
  const observed = result(manager, read, [text(source)]);
  const before = assistant(manager, "stop", [text("Done")]);
  const draft = edits(manager);
  expect(draft.map((edit) => edit.targetId).sort()).toEqual(
    [request, observed].sort(),
  );
  for (const edit of draft)
    manager.appendContextEdit(edit.targetId, edit.replacement);

  const reopened = SessionManager.inMemory(
    manager.getCwd(),
    undefined,
    JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])),
  );
  expect(edits(reopened)).toEqual([]);
  const writeRef = `${request}:0:content`,
    readRef = `${observed}:0`;
  for (const ref of [writeRef, readRef]) {
    expect((await recall(reopened, ref, 8192)).content).toEqual([
      text(source.slice(8192)),
    ]);
  }
  const editLeaf = reopened.getLeafId()!;
  reopened.appendCompaction("Remember the script refs", null, 1000);
  expect((await recall(reopened, readRef, 8192)).content).toEqual([
    text(source.slice(8192)),
  ]);
  expect(edits(reopened)).toEqual([]);
  reopened.branch(before);
  await expect(recall(reopened, readRef)).rejects.toThrow("unavailable");
  reopened.branch(editLeaf);
  reopened.appendContextEdit(observed, null);
  reopened.appendContextEdit(request, {
    content: [
      {
        ...write,
        arguments: {
          content: `Different text: recall_tool_text ref=${writeRef} …]`,
        },
      },
      read,
    ],
  });
  await expect(recall(reopened, readRef)).rejects.toThrow("unavailable");
  await expect(recall(reopened, writeRef)).rejects.toThrow("unavailable");
  expect(edits(reopened)).toEqual([]);
});

it("recalls each long replacement in a completed Pi batch without changing its original, short fields or review handoff", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-batch-history");
  const edit = call("batch", "edit", {
    path: "game.js",
    releaseReviewedImages: true,
    edits: [
      { oldText: source, newText: "short" },
      { oldText: "other", newText: source + "suffix" },
    ],
  });
  const request = assistant(manager, "toolUse", [edit]);
  result(manager, edit, [text("Project file edited.")]);
  assistant(manager, "stop", [text("Done")]);
  const draft = edits(manager);
  expect(draft).toHaveLength(1);
  manager.appendContextEdit(request, draft[0]!.replacement);
  expect(JSON.stringify(draft)).toContain('"releaseReviewedImages":true');
  expect(JSON.stringify(draft)).toContain('"newText":"short"');
  expect(JSON.stringify(draft)).not.toContain(source.slice(2000, 2300));
  expect(
    (await recall(manager, `${request}:0:edits.0.oldText`, 8192)).content,
  ).toEqual([text(source.slice(8192))]);
  expect(
    (await recall(manager, `${request}:0:edits.1.newText`, 8192)).content,
  ).toEqual([text(source.slice(8192) + "suffix")]);
  await expect(recall(manager, `${request}:0:edits.0.newText`)).rejects.toThrow(
    "unavailable",
  );
});

it("leaves signed calls and results, failed writes, visual observations and paid task receipts untouched", () => {
  const manager = SessionManager.inMemory("/tmp/pi-protected-tool-history");
  const write = call("signed-request", "write", {
    path: "model.py",
    content: source,
  });
  assistant(manager, "toolUse", [
    { ...write, thoughtSignature: "opaque-signature" },
  ]);
  result(manager, write, [text("Saved")]);
  const signed = call("signed-result", "read");
  assistant(manager, "toolUse", [signed]);
  result(manager, signed, [{ ...text(source), textSignature: "signed text" }]);
  const failed = call("failed", "edit", { oldText: source, newText: source });
  const visual = call("visual", "read");
  const paid = call("paid", "generate_image", { prompt: source });
  assistant(manager, "toolUse", [failed, visual, paid]);
  result(manager, failed, [text(source)], true);
  result(manager, visual, [
    text(source),
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  ]);
  result(manager, paid, [text("Job 123 remains submitted. " + source)]);
  assistant(manager, "stop", [text("Completed")]);
  expect(edits(manager)).toEqual([]);
});

it.each(["aborted", "error"] as const)(
  "keeps a pending or %s run intact across the next successful request",
  (stopReason) => {
    const manager = SessionManager.inMemory("/tmp/pi-interrupted-tool-history");
    manager.appendMessage({
      role: "user",
      content: "Inspect the first model",
      timestamp: 1,
    });
    const read = call("inspect", "read");
    assistant(manager, "toolUse", [read]);
    result(manager, read, [text(source)]);
    expect(edits(manager)).toEqual([]);
    assistant(manager, stopReason);
    expect(edits(manager)).toEqual([]);
    manager.appendMessage({
      role: "user",
      content: "Inspect a different model",
      timestamp: 2,
    });
    assistant(manager, "toolUse", [read]);
    const completed = result(manager, read, [text(source)]);
    assistant(manager, "stop", [text("Second request completed")]);
    expect(edits(manager).map((edit) => edit.targetId)).toEqual([completed]);
  },
);

function outgoing(manager: SessionManager) {
  const { messages, entries } = manager.buildSessionProjection();
  // Pi gives its context handlers a cloned transcript.
  return projectDeliveredFileHistory(structuredClone(messages), entries);
}

it("hands off only delivered file records on an actual next user turn and recalls exact old bytes and arguments", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-closed-file-handoff");
  const path = "assets/canvas/ref.md",
    old = "earlier file contents\n".repeat(50);
  manager.appendMessage({
    role: "user",
    content: "Make a proof",
    timestamp: 2,
  });
  const read = call("read-proof", "read", { path });
  assistant(manager, "toolUse", [read]);
  const readId = result(manager, read, [text(old)]);
  const write = call("save-proof", "write", {
    path,
    content: "Updated after the first read.",
  });
  const writeId = assistant(manager, "toolUse", [write]);
  result(manager, write, [text("Project file saved.")]);
  const final = assistant(manager, "stop", [
    text("Here is the checked proof."),
  ]);
  const before = manager.buildSessionProjection();
  expect(outgoing(manager)).toEqual(before.messages);
  const synthetic = [
    ...before.messages,
    { role: "user" as const, content: "Resume automatically", timestamp: 40 },
  ];
  expect(projectDeliveredFileHistory(synthetic, before.entries)).toBe(
    synthetic,
  );
  const next = manager.appendMessage({
    role: "user",
    content: "Revise the proof",
    timestamp: 41,
  });
  const readNow = call("read-current", "read", { path });
  assistant(manager, "toolUse", [readNow]);
  result(manager, readNow, [text(old.replaceAll("earlier", "current"))]);
  const projected = outgoing(manager);
  const returned = projected.filter((m) => m.role === "toolResult");
  expect(returned).toHaveLength(2);
  expect(returned[0]!.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(`ref=${readId}:0`),
  });
  expect(returned[0]!.content[0]).toMatchObject({
    text: expect.stringContaining(`${writeId}:0`),
  });
  expect(returned[1]!.content).toEqual([
    text(old.replaceAll("earlier", "current")),
  ]);
  expect((await recall(manager, `${readId}:0`)).content).toEqual([text(old)]);
  expect((await recall(manager, `${writeId}:0`)).content).toEqual([
    text(JSON.stringify(write.arguments)),
  ]);
  expect(manager.getEntry(readId)).toMatchObject({
    message: { content: [text(old)] },
  });
  manager.branch(final);
  await expect(recall(manager, `${readId}:0`)).rejects.toThrow("unavailable");
  manager.branch(next);
  manager.appendContextEdit(readId, null);
  await expect(recall(manager, `${readId}:0`)).rejects.toThrow("unavailable");
  await expect(recall(manager, `${writeId}:0`)).rejects.toThrow("unavailable");
});

it("retains failed, incomplete and signed batches, interrupted deliveries, and prior Pi excerpt references", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-incomplete-file-handoff");
  const path = "canvas/sample.json",
    data = "1234567890".repeat(100);
  manager.appendMessage({
    role: "user",
    content: "Check the file",
    timestamp: 1,
  });
  const seen = call("seen", "read", { path });
  assistant(manager, "toolUse", [seen]);
  const existing = result(manager, seen, [text(source)]);
  const write = call("partial-save", "write", { path, content: data });
  const sibling = call("missing", "edit", { path });
  assistant(manager, "toolUse", [write, sibling]);
  result(manager, write, [text("Project file saved.")]);
  const signed = {
    ...call("signed-save", "write", { path, content: data }),
    thoughtSignature: "keep",
  };
  assistant(manager, "toolUse", [signed]);
  result(manager, signed, [text("Project file saved.")]);
  const bad = call("save-error", "write", { path, content: data });
  assistant(manager, "toolUse", [bad]);
  result(manager, bad, [text("failed")], true);
  const textRead = call("old-text", "read", { path });
  assistant(manager, "toolUse", [textRead]);
  result(manager, textRead, [text(data)]);
  const beforeStop = manager.getLeafId()!;
  assistant(manager, "stop", [text("File checked")]);
  for (const e of edits(manager))
    manager.appendContextEdit(e.targetId, e.replacement);
  manager.appendMessage({ role: "user", content: "Revise", timestamp: 2 });
  const visible = outgoing(manager);
  expect(
    visible.filter((m) => m.role === "assistant" && m.stopReason === "toolUse"),
  ).toHaveLength(5);
  expect(JSON.stringify(visible)).toContain(
    `recall_tool_text ref=${existing}:0`,
  );
  expect((await recall(manager, `${existing}:0`)).content[0]).toEqual(
    text(source.slice(0, 8192)),
  );
  expect(
    visible.find((m) => m.role === "toolResult" && m.toolCallId === "old-text"),
  ).not.toMatchObject({ content: [text(data)] });
  manager.branch(beforeStop);
  assistant(manager, "aborted", []);
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
  expect(outgoing(manager)).toEqual(manager.buildSessionProjection().messages);
});

it("hands off a delivered Blender model for a follow-up without resending completed production batches", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-production-handoff");
  const astra = { provider: "kunpo", model: "gpt-6.2-astra" } as const;
  manager.appendMessage({
    role: "user",
    content: "Use the approved views",
    timestamp: 1,
  });
  const paid = call("submitted", "generate_canvas_media");
  assistant(manager, "toolUse", [paid], astra);
  result(manager, paid, [
    text("The user approved the views. Tripo source asset retained."),
  ]);
  const inspect = call("inspect", "run_blender", { stage: "inspect" });
  assistant(manager, "toolUse", [inspect], astra);
  result(manager, inspect, [
    text("Verified source has 25,628 triangles in report.json."),
  ]);
  const script = call("save-script", "write", {
    path: "assets/design/stage.py",
    content: source,
  });
  const proof = call("read-proof", "read", { path: "assets/design/proof.png" });
  const request = assistant(
    manager,
    "toolUse",
    [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: "sealed historical reasoning",
      },
      script,
      proof,
    ],
    astra,
  );
  const scriptResult = result(manager, script, [text("Project file saved.")]);
  const proofId = result(manager, proof, [
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  ]);
  const failed = call("failed-repair", "run_blender", { stage: "custom" });
  assistant(manager, "toolUse", [failed], astra);
  result(manager, failed, [text("Repair failed.")], false, {
    blender: { status: "failed" },
  });
  const present = call("final-review", "recover_blender_run", {
    runId: "delivered",
    reviewPresentation: "final",
  });
  assistant(manager, "toolUse", [present], astra);
  const receipt = result(
    manager,
    present,
    [text("Final asset and scene.blend are on the Canvas.")],
    false,
    {
      blender: {
        runId: "delivered",
        stage: "export",
        reviewPresentation: "final",
        technicalChecksPassed: true,
        presentedOnCanvas: true,
      },
    },
  );
  const final = assistant(
    manager,
    "stop",
    [text("The checked model is ready.")],
    astra,
  );
  expect(outgoing(manager)).toEqual(manager.buildSessionProjection().messages);
  const next = manager.appendMessage({
    role: "user",
    content: "How many faces are in the original Tripo model?",
    timestamp: 2,
  });
  const followup = outgoing(manager);
  const serialized = JSON.stringify(followup);
  expect(serialized).toContain("The user approved the views");
  expect(serialized).toContain("25,628 triangles");
  expect(serialized).toContain("Repair failed.");
  expect(serialized).toContain("The checked model is ready.");
  expect(serialized).toContain(`recall_tool_text ref=${receipt}:1`);
  expect(serialized).not.toContain("sealed historical reasoning");
  expect(serialized).not.toContain("iVBORw0KGgo=");
  expect(serialized).not.toContain(source.slice(0, 100));
  const index = (await recall(manager, `${receipt}:1`)).content[0] as {
    text: string;
  };
  expect(JSON.parse(index.text)).toEqual([
    {
      tool: "write",
      path: "assets/design/stage.py",
      argsRef: `${request}:1`,
      textRefs: [`${scriptResult}:0`],
      imageIds: [],
    },
    {
      tool: "read",
      path: "assets/design/proof.png",
      argsRef: `${request}:2`,
      textRefs: [],
      imageIds: [`${proofId}:0`],
    },
  ]);
  const argumentsPage = (await recall(manager, `${request}:1`)).content[0] as {
    text: string;
  };
  expect(argumentsPage.text).toBe(
    JSON.stringify(script.arguments).slice(0, 8192),
  );
  const restored = await new SessionImages(
    manager,
    manager.getCwd(),
  ).recallTool.execute(
    "lookup-image",
    { imageId: `${proofId}:0` },
    undefined,
    undefined,
    {} as never,
  );
  expect(restored.content[1]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
  });
  const readNow = call("current-read", "read", {
    path: "assets/design/report.json",
  });
  assistant(manager, "toolUse", [readNow], astra);
  result(manager, readNow, [text("Current source report.")]);
  expect(outgoing(manager).slice(0, followup.length)).toEqual(followup);
  expect(manager.getEntry(proofId)).toMatchObject({
    message: { content: [{ type: "image", data: "iVBORw0KGgo=" }] },
  });
  manager.branch(final);
  await expect(recall(manager, `${receipt}:1`)).rejects.toThrow("unavailable");
  manager.branch(next);
  manager.appendContextEdit(receipt, null);
  await expect(recall(manager, `${request}:1`)).rejects.toThrow("unavailable");
});

it("settles earlier Blender preparation into the verified delivery for a factual follow-up", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-multi-stage-handoff");
  const astra = { provider: "kunpo", model: "gpt-6.2-astra" } as const;
  manager.appendMessage({
    role: "user",
    content: "Edit an unrelated project file",
    timestamp: 1,
  });
  const unrelated = call("unrelated-write", "write", {
    path: "game.js",
    content: "unrelated full file",
  });
  assistant(manager, "toolUse", [unrelated], astra);
  result(manager, unrelated, [text("Project file saved.")]);
  assistant(manager, "stop", [text("The game file is updated.")], astra);

  manager.appendMessage({
    role: "user",
    content: "Prepare reference images",
    timestamp: 2,
  });
  const draftScript = call("draft-script", "write", {
    path: "assets/design/draft.py",
    content: source,
  });
  const draft = call("draft-run", "run_blender", {
    stage: "custom",
    scriptPath: "assets/design/draft.py",
  });
  const draftRequest = assistant(
    manager,
    "toolUse",
    [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: "sealed preparation reasoning",
      },
      draftScript,
      draft,
    ],
    astra,
  );
  result(manager, draftScript, [text("Project file saved.")]);
  result(manager, draft, [text("Draft renders retained.")], false, {
    blender: { runId: "draftRun", stage: "custom" },
  });
  const imagePaid = call("paid-reference", "generate_image");
  assistant(manager, "toolUse", [imagePaid], astra);
  result(manager, imagePaid, [text("Paid reference receipt.")]);
  assistant(manager, "stop", [text("The reference draft is ready.")], {
    ...astra,
    timestamp: 2,
  });

  manager.appendMessage({
    role: "user",
    content: "Approved, use the left-facing reference",
    timestamp: 3,
  });
  expect(JSON.stringify(outgoing(manager))).toContain(
    "sealed preparation reasoning",
  );
  await expect(recall(manager, `${draftRequest}:1`)).rejects.toThrow(
    "unavailable",
  );
  const part = call("approval-setup", "read", { path: "canvas/AGENTS.md" });
  assistant(
    manager,
    "toolUse",
    [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: "sealed approval setup",
      },
      part,
    ],
    astra,
  );
  result(manager, part, [text("Historical approval setup file.")]);
  const rebuilt = call("preview-rebuild", "get_model_asset", {
    rebuildPreview: true,
  });
  assistant(manager, "toolUse", [rebuilt], astra);
  result(manager, rebuilt, [text("Local preview rebuild receipt.")]);
  const views = call("formal-inspection", "inspect_3d_views");
  const guide = call("approval-guide", "read_workflow_guide");
  assistant(manager, "toolUse", [views, guide], astra);
  result(manager, views, [
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  ]);
  const guideResult = result(manager, guide, [text(source)]);
  const failed = call("failed-paid-attempt", "generate_3d_from_views");
  const failedWrite = call("interrupted-write", "write", {
    path: "assets/design/production-record.md",
  });
  assistant(manager, "toolUse", [failed, failedWrite], astra);
  result(manager, failed, [text("Paid submit was blocked.")], true);
  result(manager, failedWrite, [text("Write was stopped.")], true);
  manager.appendMessage({
    role: "user",
    content: "Continue with the checked views",
    timestamp: 4,
  });
  expect(JSON.stringify(outgoing(manager))).toContain("sealed approval setup");
  await expect(recall(manager, `${guideResult}:0`)).rejects.toThrow(
    "unavailable",
  );
  const intake = call("source-inspect", "run_blender", { stage: "inspect" });
  assistant(manager, "toolUse", [intake], astra);
  result(manager, intake, [text("Retained source model: 25,628 triangles.")]);
  const present = call("present", "recover_blender_run", {
    runId: "finalRun",
    reviewPresentation: "final",
  });
  assistant(manager, "toolUse", [present], astra);
  const receipt = result(
    manager,
    present,
    [text("The final export is on the Canvas.")],
    false,
    {
      blender: {
        runId: "finalRun",
        stage: "export",
        reviewPresentation: "final",
        technicalChecksPassed: true,
        presentedOnCanvas: true,
      },
    },
  );
  assistant(manager, "stop", [text("The model is ready for review.")], {
    ...astra,
    timestamp: 4,
  });
  manager.appendMessage({
    role: "user",
    content: "Tripo 出的原始模型有多少面？",
    timestamp: 5,
  });
  const followup = outgoing(manager);
  const serialized = JSON.stringify(followup);
  expect(serialized).toContain("unrelated full file");
  expect(serialized).toContain("The reference draft is ready.");
  expect(serialized).toContain("Approved, use the left-facing reference");
  expect(serialized).toContain("Paid reference receipt.");
  expect(serialized).toContain("25,628 triangles");
  expect(serialized).toContain("The model is ready for review.");
  expect(serialized).toContain("Paid submit was blocked.");
  expect(serialized).toContain("Write was stopped.");
  expect(serialized).toContain("Local preview rebuild receipt.");
  expect(serialized).toContain("iVBORw0KGgo=");
  expect(serialized).toContain(`recall_tool_text ref=${guideResult}:0`);
  expect(serialized).not.toContain("sealed preparation reasoning");
  expect(serialized).not.toContain("sealed approval setup");
  expect(serialized).not.toContain("Historical approval setup file.");
  expect(serialized).not.toContain(source.slice(1000, 1300));
  const { messages, entries } = manager.buildSessionProjection();
  expect(
    JSON.stringify(projectDeliveredFileHistory(messages, entries, true, false)),
  ).toContain("sealed approval setup");
  await expect(recall(manager, `${guideResult}:0`)).resolves.toMatchObject({
    content: [text(source.slice(0, 8192)), expect.any(Object)],
  });
  const page = (await recall(manager, `${receipt}:1`)).content[0] as {
    text: string;
  };
  expect(JSON.parse(page.text)).toContainEqual(
    expect.objectContaining({ argsRef: `${draftRequest}:1` }),
  );
  await expect(recall(manager, `${draftRequest}:1`)).resolves.toMatchObject({
    content: [
      text(JSON.stringify(draftScript.arguments).slice(0, 8192)),
      expect.any(Object),
    ],
  });
  manager.appendMessage({
    role: "user",
    content: "Now inspect the shoulder deformation",
    timestamp: 6,
  });
  expect(outgoing(manager).slice(0, followup.length - 1)).toEqual(
    followup.slice(0, -1),
  );
});
