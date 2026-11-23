import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  CHECKPOINT_ENTRY,
  CHECKPOINT_RESTORED_ENTRY,
  CHECKPOINT_UNDONE_ENTRY,
  TURN_END_ENTRY,
  parseStoredCheckpoint,
  parseStoredTurnEnd,
} from "./checkpoint-extension.js";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const CANVAS_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const observations = new Set([
  "read",
  "read_project_file",
  "find",
  "ls",
  "grep",
  "read_workflow_guide",
  "recall_tool_text",
  "recall_image",
  "tool_search",
  "blender_status",
  "canvas_check",
]);

type Target = "source" | "delivery";
type Row = Record<string, unknown>;
type Source = { assetId: string; sha256: string; format: "glb" | "fbx" };
type Matched = {
  call: ToolCall;
  owner: number;
  index: number;
  reply: ToolResultMessage;
};
type ModelMeasure = {
  runId: string;
  reportPath: string;
  modelPath: string;
  triangles: number;
};
export type ModelTriangleAnswer = ModelMeasure & {
  text: string;
  target: Target;
  deliveryAssetId: string;
  deliveryModelPath: string;
  boardId: string;
  canvasNodeIds: string[];
  sourceAssetId?: string;
  sourceSha256?: string;
  sourceCanvas?: { boardId: string; nodeId: string };
};

function row(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function id(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function parseQuestion(
  prompt: string,
): { target: Target; locale: "zh" | "en" } | undefined {
  const text = prompt.normalize("NFKC").trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text)) return;
  const zh = text.replace(/[ \t]/g, "").replace(/[?。]$/, "");
  const count =
    /(?:有(?:多少(?:个)?|几个)(?:三角)?面|(?:三角)?面数(?:是)?多少)$/;
  const subject = zh.replace(count, "").replace(/^请问[，,]?/, "");
  if (subject !== zh && count.test(zh)) {
    if (
      /^(?:Tripo(?:生成的|出的)?)?(?:原始(?:角色)?模型|原始(?:角色)?初模|原始FBX|初模)$/i.test(
        subject,
      )
    )
      return { target: "source", locale: "zh" };
    if (
      /^(?:最终(?:交付的?|导出的?)?|交付的?)(?:(?:角色)?模型|GLB)$/i.test(
        subject,
      )
    )
      return { target: "delivery", locale: "zh" };
  }
  const en =
    /^(?:how many (?:triangles|faces) (?:are in|does) (?:the )?(?<subject1>[^?]+?)(?: have)?|(?:what is|what's) the triangle count (?:of|for) (?:the )?(?<subject2>[^?]+?))\??$/i.exec(
      text,
    );
  const englishSubject = en?.groups?.subject1 ?? en?.groups?.subject2;
  if (
    englishSubject &&
    /^(?:original (?:Tripo )?model|original Tripo FBX|Tripo source model)$/i.test(
      englishSubject,
    )
  )
    return { target: "source", locale: "en" };
  if (
    englishSubject &&
    /^(?:final model|delivered model|final GLB|delivered GLB)$/i.test(
      englishSubject,
    )
  )
    return { target: "delivery", locale: "en" };
}

function sourceIdentity(report: Row): Source | undefined {
  const source = row(report.sourceOriginal);
  if (
    source &&
    id(source.assetId, UUID) &&
    id(source.sha256, /^[a-f\d]{64}$/i) &&
    (source.format === "glb" || source.format === "fbx")
  )
    return {
      assetId: source.assetId,
      sha256: source.sha256,
      format: source.format,
    };
}

function blenderMeasure(report: Row) {
  const { runId, workflow, files, models } = report;
  if (
    !id(runId, UUID) ||
    !id(workflow, /^[a-z\d][a-z\d-]{0,63}$/) ||
    !Array.isArray(files) ||
    !Array.isArray(models) ||
    models.length !== 1
  )
    return;
  const directory = `assets/blender/${workflow}/runs/${runId}`;
  if (report.directory !== directory) return;
  const reportPath = `${directory}/report.json`;
  const model = row(models[0]),
    geometry = row(model?.model);
  const modelPath = model?.originalPath,
    triangles = geometry?.triangles;
  if (
    !files.includes(reportPath) ||
    typeof modelPath !== "string" ||
    !modelPath.startsWith(directory + "/") ||
    !id(modelPath.slice(directory.length + 1), /^[a-z\d][a-z\d_.-]*\.glb$/i) ||
    !files.includes(modelPath) ||
    typeof triangles !== "number" ||
    !Number.isSafeInteger(triangles) ||
    triangles <= 0
  )
    return;
  return {
    runId,
    reportPath,
    modelPath,
    triangles,
    modelAssetId: model?.assetId,
    workflow,
  };
}

function matchesInBranch(
  branch: readonly SessionEntry[],
): Matched[] | undefined {
  const settled = new Map<string, Matched>(),
    calls = new Map<string, { call: ToolCall; owner: number }>();
  const edited = new Set(
    branch.flatMap((entry) =>
      entry.type === "context_edit" ? [entry.targetId] : [],
    ),
  );
  const ids = new Set<string>();
  let owner = -1;
  for (const [index, entry] of branch.entries()) {
    if (entry.parentId !== (branch[index - 1]?.id ?? null) || ids.has(entry.id))
      return;
    ids.add(entry.id);
    if (entry.type !== "message" || edited.has(entry.id)) continue;
    const message = entry.message;
    if (message.role === "user") owner = index;
    if (owner < 0) continue;
    if (message.role === "assistant" && message.stopReason === "toolUse") {
      for (const call of message.content)
        if (call.type === "toolCall") {
          if (calls.has(call.id)) return;
          calls.set(call.id, { call, owner });
        }
    } else if (message.role === "toolResult") {
      const matched = calls.get(message.toolCallId);
      if (
        !matched ||
        matched.owner !== owner ||
        matched.call.name !== message.toolName
      )
        continue;
      if (settled.has(message.toolCallId)) return;
      settled.set(message.toolCallId, { ...matched, index, reply: message });
    }
  }
  return [...settled.values()];
}

function safeOwnDeliveryBookkeeping(call: ToolCall): boolean {
  const path = call.arguments.path;
  return (
    observations.has(call.name) ||
    call.name === "update_plan" ||
    (call.name === "get_model_asset" &&
      call.arguments.rebuildPreview !== true) ||
    ((call.name === "write" || call.name === "edit") &&
      typeof path === "string" &&
      /^(?:assets\/design\/[^\r\n]+\.md|canvas\/(?:assets|boards\/[\w-]+)\.json)$/.test(
        path,
      ))
  );
}

function changedSinceDelivery(
  branch: readonly SessionEntry[],
  delivery: Matched,
): boolean {
  const checkpoint = branch[delivery.owner - 1];
  if (
    checkpoint?.type !== "custom" ||
    checkpoint.customType !== CHECKPOINT_ENTRY ||
    !parseStoredCheckpoint(checkpoint.data)
  )
    return true;
  const end = branch.findIndex(
    (entry, index) =>
      index > delivery.index &&
      entry.type === "custom" &&
      entry.customType === TURN_END_ENTRY &&
      parseStoredTurnEnd(entry.data)?.checkpoint === checkpoint.id,
  );
  if (end < 0) return true;
  for (const [index, entry] of branch.entries()) {
    if (index <= delivery.index) continue;
    if (
      entry.type === "custom" &&
      (entry.customType === CHECKPOINT_RESTORED_ENTRY ||
        entry.customType === CHECKPOINT_UNDONE_ENTRY)
    )
      return true;
    if (
      entry.type === "custom" &&
      index > end &&
      entry.customType === TURN_END_ENTRY
    ) {
      const changes = parseStoredTurnEnd(entry.data);
      if (
        !changes ||
        (changes.files > 0 &&
          (!changes.items ||
            changes.items.some(
              (item) => !item.path.startsWith("canvas/editor/"),
            )))
      )
        return true;
    }
    if (entry.type !== "message") continue;
    if (entry.message.role === "user" && index < end) return true;
    if (entry.message.role === "toolResult" && entry.message.isError)
      return true;
    if (entry.message.role !== "assistant") continue;
    if (
      ["aborted", "error", "length"].includes(entry.message.stopReason) ||
      entry.message.content.some(
        (block) =>
          block.type === "toolCall" &&
          !(index < end
            ? safeOwnDeliveryBookkeeping(block)
            : observations.has(block.name)),
      )
    )
      return true;
  }
  const last = branch.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "assistant" || entry.message.role === "user"),
  );
  const message = branch[last];
  if (
    message?.type !== "message" ||
    message.message.role !== "assistant" ||
    message.message.stopReason !== "stop"
  )
    return true;
  const lastUser = branch.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (lastUser <= end) return false;
  const lastCheckpoint = branch[lastUser - 1];
  return (
    lastCheckpoint?.type !== "custom" ||
    lastCheckpoint.customType !== CHECKPOINT_ENTRY ||
    !parseStoredCheckpoint(lastCheckpoint.data) ||
    !branch
      .slice(last + 1)
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === TURN_END_ENTRY &&
          parseStoredTurnEnd(entry.data)?.checkpoint === lastCheckpoint.id,
      )
  );
}

/** A narrow lookup over retained, branch-owned Blender measurements. Unknown questions use the normal agent. */
export function answerModelTriangleQuestion(
  prompt: string,
  branch: readonly SessionEntry[],
): ModelTriangleAnswer | undefined {
  const question = parseQuestion(prompt);
  if (!question) return;
  const matched = matchesInBranch(branch);
  if (!matched) return;
  const deliveries = matched.flatMap((receipt) => {
    const { call, reply } = receipt;
    const report = row(row(reply.details)?.blender);
    if (
      call.name !== "recover_blender_run" ||
      call.arguments.reviewPresentation !== "final" ||
      reply.isError ||
      !report ||
      report.runId !== call.arguments.runId ||
      report.stage !== "export" ||
      report.reviewPresentation !== "final" ||
      report.presentedOnCanvas !== true ||
      report.technicalChecksPassed !== true ||
      report.presentationIssue !== undefined ||
      report.deliveryIssue !== undefined
    )
      return [];
    const measure = blenderMeasure(report),
      canvas = row(report.canvas);
    if (
      !measure ||
      !id(measure.modelAssetId, UUID) ||
      !canvas ||
      !id(canvas.boardId, CANVAS_ID) ||
      !Array.isArray(canvas.nodeIds) ||
      !canvas.nodeIds.length ||
      !canvas.nodeIds.every((value) => id(value, CANVAS_ID))
    )
      return [];
    return [
      {
        receipt,
        measure,
        source: sourceIdentity(report),
        boardId: canvas.boardId,
        nodes: canvas.nodeIds as string[],
        assetId: measure.modelAssetId,
      },
    ];
  });
  const delivery = deliveries.at(-1);
  if (
    !delivery ||
    deliveries.some(
      (other) =>
        other.measure.workflow !== delivery.measure.workflow ||
        other.source?.assetId !== delivery.source?.assetId ||
        other.source?.sha256 !== delivery.source?.sha256,
    ) ||
    changedSinceDelivery(branch, delivery.receipt)
  )
    return;

  let measure: ModelMeasure = delivery.measure;
  let sourceCanvas: ModelTriangleAnswer["sourceCanvas"];
  if (question.target === "source") {
    const source = delivery.source;
    if (!source) return;
    const generations = matched.flatMap(({ call, index, reply }) => {
      if (
        index >= delivery.receipt.index ||
        ![
          "generate_canvas_media",
          "generate_3d_from_views",
          "generate_3d_asset",
        ].includes(call.name) ||
        reply.isError
      )
        return [];
      const details = row(reply.details),
        job = row(details?.canvasGeneration),
        context = row(job?.context);
      if (
        job?.toolId !== "image-to-3d" ||
        job.status !== "succeeded" ||
        row(job.model)?.provider !== "tripo" ||
        !id(details?.sourceAssetId, UUID) ||
        !id(context?.nodeId, CANVAS_ID) ||
        !id(context?.boardId, CANVAS_ID)
      )
        return [];
      return [
        {
          index,
          assetId: details.sourceAssetId,
          boardId: context.boardId,
          nodeId: context.nodeId,
        },
      ];
    });
    const generated = generations.at(-1);
    if (
      !generated ||
      generated.assetId !== source.assetId ||
      generations.some((other) => other.assetId !== source.assetId)
    )
      return;
    const inspections = matched.flatMap(({ call, index, reply }) => {
      if (
        call.name !== "run_blender" ||
        call.arguments.stage !== "inspect" ||
        call.arguments.sourceAssetId !== source.assetId ||
        reply.isError ||
        index <= generated.index ||
        index >= delivery.receipt.index
      )
        return [];
      const report = row(row(reply.details)?.blender);
      if (
        !report ||
        report.stage !== "inspect" ||
        report.workflow !== call.arguments.workflow
      )
        return [];
      const identity = sourceIdentity(report),
        measured = blenderMeasure(report);
      return identity?.assetId === source.assetId &&
        identity.sha256 === source.sha256 &&
        identity.format === source.format &&
        measured
        ? [{ index, measured }]
        : [];
    });
    const inspection = inspections.at(-1);
    if (
      !inspection ||
      inspections.some(
        (other) => other.measured.triangles !== inspection.measured.triangles,
      ) ||
      branch
        .slice(inspection.index + 1)
        .some(
          (entry) =>
            entry.type === "custom" &&
            (entry.customType === CHECKPOINT_RESTORED_ENTRY ||
              entry.customType === CHECKPOINT_UNDONE_ENTRY),
        )
    )
      return;
    measure = inspection.measured;
    sourceCanvas = { boardId: generated.boardId, nodeId: generated.nodeId };
  }

  const count = measure.triangles.toLocaleString("en-US");
  const citation =
    question.locale === "zh" ? "Blender 检查报告" : "Blender inspection report";
  const subject =
    question.target === "source"
      ? question.locale === "zh"
        ? "Tripo 原始模型"
        : "The original Tripo model"
      : question.locale === "zh"
        ? "最终交付的 GLB"
        : "The delivered GLB";
  const text =
    question.locale === "zh"
      ? `${subject}实测为 **${count} 个三角面**（按三角化统计）。[${citation}](${measure.reportPath})`
      : `${subject} has **${count} triangles** after triangulation. [${citation}](${measure.reportPath})`;
  return {
    text,
    target: question.target,
    triangles: measure.triangles,
    runId: measure.runId,
    reportPath: measure.reportPath,
    modelPath: measure.modelPath,
    deliveryAssetId: delivery.assetId,
    deliveryModelPath: delivery.measure.modelPath,
    boardId: delivery.boardId,
    canvasNodeIds: delivery.nodes,
    sourceAssetId: delivery.source?.assetId,
    sourceSha256: delivery.source?.sha256,
    sourceCanvas,
  };
}
