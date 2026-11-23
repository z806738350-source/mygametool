import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_ENTRY,
  CHECKPOINT_UNDONE_ENTRY,
  TURN_END_ENTRY,
} from "../src/daemon/checkpoint-extension.js";
import { answerModelTriangleQuestion } from "../src/daemon/model-report-answer.js";

const SOURCE = "11111111-1111-1111-1111-111111111111";
const INSPECTION = "22222222-2222-2222-2222-222222222222";
const DELIVERY = "33333333-3333-3333-3333-333333333333";
const EXPORT_ASSET = "44444444-4444-4444-4444-444444444444";
const OTHER = "55555555-5555-5555-5555-555555555555";
const HASH = "1".repeat(64);
const COMMIT = "a".repeat(40);
const sourceQuestion = "Tripo 出的原始模型有多少面？";
const deliveryQuestion = "最终交付的 GLB 有多少个三角面？";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixture(inspectionSha = HASH) {
  const manager = SessionManager.inMemory("/tmp/model-metric-session");
  let callIndex = 0;
  function assistant(
    stopReason: AssistantMessage["stopReason"],
    content: AssistantMessage["content"],
  ) {
    return manager.appendMessage({
      role: "assistant",
      provider: "kunpo",
      api: "openai-responses",
      model: "gpt-6.2-astra",
      usage,
      content,
      stopReason,
      timestamp: 2,
    });
  }
  function tool(
    name: string,
    args: ToolCall["arguments"],
    details: ToolResultMessage["details"],
    isError = false,
  ) {
    const id = `tool-${++callIndex}`;
    assistant("toolUse", [{ type: "toolCall", id, name, arguments: args }]);
    return manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError,
      details,
      content: [{ type: "text", text: "Recorded evidence" }],
      timestamp: 2,
    });
  }
  function start() {
    const checkpoint = manager.appendCustomEntry(CHECKPOINT_ENTRY, {
      version: 1,
      commit: COMMIT,
    });
    manager.appendMessage({
      role: "user",
      content: "Work on the selected model",
      timestamp: 1,
    });
    return checkpoint;
  }
  function finish(
    checkpoint: string,
    items: { path: string; kind: "modified"; lines: undefined }[] = [],
  ) {
    assistant("stop", [{ type: "text", text: "Finished." }]);
    manager.appendCustomEntry(TURN_END_ENTRY, {
      version: 1,
      checkpoint,
      commit: COMMIT,
      files: items.length,
      items,
    });
  }
  function generate(assetId = SOURCE) {
    return tool(
      "generate_canvas_media",
      {},
      {
        sourceAssetId: assetId,
        canvasGeneration: {
          model: { provider: "tripo" },
          toolId: "image-to-3d",
          status: "succeeded",
          context: { boardId: "board", nodeId: "original-node" },
        },
      },
    );
  }
  function report(
    runId: string,
    stage: "export" | "inspect",
    triangles: number,
    workflow = "hero",
    sha256 = HASH,
  ) {
    const directory = `assets/blender/${workflow}/runs/${runId}`;
    const originalPath = `${directory}/${stage === "inspect" ? "review" : "model"}.glb`;
    return {
      stage,
      runId,
      workflow,
      directory,
      files: [originalPath, directory + "/report.json"],
      models: [
        {
          originalPath,
          model: { triangles },
          ...(stage === "export" ? { assetId: EXPORT_ASSET } : {}),
        },
      ],
      sourceOriginal: { assetId: SOURCE, sha256, format: "fbx" },
    };
  }
  function deliver(
    runId = DELIVERY,
    triangles = 15636,
    workflow = "hero",
    technicalChecksPassed = true,
  ) {
    return tool(
      "recover_blender_run",
      { runId, reviewPresentation: "final" },
      {
        blender: {
          ...report(runId, "export", triangles, workflow),
          reviewPresentation: "final",
          presentedOnCanvas: true,
          technicalChecksPassed,
          canvas: { boardId: "board", nodeIds: ["delivery-node"] },
        },
      },
    );
  }
  const first = start();
  generate();
  tool(
    "run_blender",
    { stage: "inspect", workflow: "hero", sourceAssetId: SOURCE },
    {
      blender: report(INSPECTION, "inspect", 25628, "hero", inspectionSha),
    },
  );
  const receipt = deliver();
  tool("write", { path: "assets/design/hero/DELIVERY.md" }, {});
  tool("edit", { path: "canvas/boards/board.json" }, {});
  finish(first);
  return {
    manager,
    start,
    finish,
    tool,
    generate,
    deliver,
    receipt,
    answer: (prompt: string) =>
      answerModelTriangleQuestion(prompt, manager.getBranch()),
  };
}

describe("a retained model triangle-count answer", () => {
  it("uses the verified original source, keeps a matching canvas target, and cites the retained report", () => {
    const { answer } = fixture();
    const original = answer(sourceQuestion);
    expect(original).toMatchObject({
      text: expect.stringContaining("25,628 个三角面"),
      target: "source",
      triangles: 25628,
      runId: INSPECTION,
      sourceAssetId: SOURCE,
      sourceSha256: HASH,
      deliveryAssetId: EXPORT_ASSET,
      sourceCanvas: { boardId: "board", nodeId: "original-node" },
      reportPath: `assets/blender/hero/runs/${INSPECTION}/report.json`,
    });
    expect(answer(deliveryQuestion)).toMatchObject({
      text: expect.stringContaining("15,636 个三角面"),
      target: "delivery",
      triangles: 15636,
      runId: DELIVERY,
      boardId: "board",
      canvasNodeIds: ["delivery-node"],
    });
    expect(
      answer("How many triangles are in the delivered GLB?")?.text,
    ).toContain("15,636 triangles");
  });

  it.each([
    "这个模型有多少面？",
    "Tripo 出的原始模型有多少个四边面？",
    "Tripo 出的原始模型有多少面？再减少一半。",
    "最终交付的 GLB 有多少个顶点？",
    "对比原始和成品，有多少面？",
    "Tripo 出的原始模型有多少面？\n并写入记录",
  ])("defers a different or non-exact metric request: %s", (prompt) => {
    expect(fixture().answer(prompt)).toBeUndefined();
  });

  it("defers a source with a different hash or a second Tripo candidate", () => {
    expect(fixture("2".repeat(64)).answer(sourceQuestion)).toBeUndefined();
    const f = fixture();
    const turn = f.start();
    f.generate(OTHER);
    f.deliver(OTHER, 16000);
    f.finish(turn);
    expect(f.answer(sourceQuestion)).toBeUndefined();
  });

  it("selects a same-lineage re-delivery and defers if another workflow is a candidate", () => {
    const f = fixture();
    const next = f.start();
    f.deliver(OTHER, 14686);
    f.finish(next);
    expect(f.answer(deliveryQuestion)?.triangles).toBe(14686);
    expect(f.answer(sourceQuestion)?.triangles).toBe(25628);
    const other = f.start();
    f.deliver(SOURCE, 9000, "other-workflow");
    f.finish(other);
    expect(f.answer(deliveryQuestion)).toBeUndefined();
  });

  it("allows a completed observation but falls back after later model changes", () => {
    const f = fixture();
    const read = f.start();
    f.tool("read", { path: "readme.md" }, {});
    f.finish(read);
    expect(f.answer(sourceQuestion)?.triangles).toBe(25628);
    const change = f.start();
    f.tool("run_blender", { stage: "custom" }, {});
    f.finish(change);
    expect(f.answer(sourceQuestion)).toBeUndefined();
    expect(f.answer(deliveryQuestion)).toBeUndefined();
  });

  it("requires an intact settled delivery on the current branch", () => {
    const f = fixture();
    const clean = f.manager.getLeafId()!;
    f.manager.appendCustomEntry(CHECKPOINT_UNDONE_ENTRY, {});
    expect(f.answer(sourceQuestion)).toBeUndefined();
    f.manager.branch(clean);
    f.manager.appendContextEdit(f.receipt, null);
    expect(f.answer(sourceQuestion)).toBeUndefined();
    f.manager.branch(f.receipt);
    expect(f.answer(deliveryQuestion)).toBeUndefined();
  });
});
