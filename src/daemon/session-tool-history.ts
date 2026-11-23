import {
  defineTool,
  truncateHead,
  truncateTail,
  type ContextEditEntryDraft,
  type ExtensionFactory,
  type ProjectedSessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isDeepStrictEqual } from "node:util";
import {
  KUNPO_ASTRA_MODEL_ID,
  KUNPO_PROVIDER_ID,
} from "../shared/kunpo-models.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";

const FULL_TEXT_LIMIT = 4096;
const PAGE_SIZE = 8192;
const fileFields = {
  write: ["content"],
  edit: ["oldText", "newText"],
} as const;
const observations = new Set([
  "read",
  "read_project_file",
  "read_attachment",
  "find",
  "ls",
  "grep",
  "read_workflow_guide",
  "recall_tool_text",
  "blender_status",
  "list_media_capabilities",
  "list_animation_actions",
  "get_model_asset",
  "canvas_check",
  "playable_check",
]);
const productionTools = new Set([
  ...observations,
  "tool_search",
  "recall_image",
  "write",
  "edit",
  "run_blender",
  "update_plan",
]);
const reviewPreparationTools = new Set([
  ...observations,
  "tool_search",
  "update_plan",
]);
const isAstraHistory = (message: AssistantMessage) =>
  message.provider === KUNPO_PROVIDER_ID &&
  message.api === "openai-responses" &&
  message.model === KUNPO_ASTRA_MODEL_ID;

type ToolBatch = {
  request: AssistantMessage;
  calls: ToolCall[];
  replies: ToolResultMessage[];
};

function retainedBlenderRun(result: ToolResultMessage) {
  const report = (
    result.details as
      | {
          blender?: {
            stage?: string;
            runId?: string;
            reviewPresentation?: string;
            presentedOnCanvas?: boolean;
            technicalChecksPassed?: boolean;
            status?: string;
          };
        }
      | undefined
  )?.blender;
  if (
    !result.isError &&
    typeof report?.runId === "string" &&
    report.status !== "failed" &&
    report.status !== "saved-not-run"
  )
    return report;
}

function excerpt(text: string, ref: string) {
  const head = truncateHead(text, { maxLines: 5, maxBytes: 384 }).content;
  const tail = truncateTail(text, { maxLines: 4, maxBytes: 256 }).content;
  return `${head}\n[… ${text.length} characters in original. recall_tool_text ref=${ref} …]\n${tail}`;
}

// Pi's projection supplies the owning entry, current branch, context edits and compaction boundary.
export function completedToolTextEdits(
  entries: ProjectedSessionEntry[],
): ContextEditEntryDraft[] {
  const edits: ContextEditEntryDraft[] = [];
  const results = new Map<
    string,
    {
      id: string;
      message: Extract<Message, { role: "toolResult" }>;
      original: boolean;
    }
  >();
  let finished = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { sourceEntry, messages } = entries[i]!;
    const m = messages[0];
    if (!m) continue;
    if (
      m.role === "user" ||
      (m.role === "assistant" && m.stopReason !== "toolUse")
    ) {
      finished = m.role === "assistant" && m.stopReason === "stop";
      results.clear();
      continue;
    }
    if (!finished) continue;
    if (m.role === "toolResult" && sourceEntry.type === "message") {
      results.set(m.toolCallId, {
        id: sourceEntry.id,
        message: m,
        original: sourceEntry.message === m,
      });
      continue;
    }
    if (
      m.role === "assistant" &&
      m.stopReason === "toolUse" &&
      (m.api as string) !== "ohmygame-native" &&
      sourceEntry.type === "message"
    ) {
      let changed = false;
      // Never edit a signed assistant request or persist an opaque reasoning block again.
      const canEditArgs =
        sourceEntry.message === m &&
        m.content.every(
          (b) =>
            b.type !== "thinking" &&
            !(b.type === "toolCall" && b.thoughtSignature) &&
            !(b.type === "text" && b.textSignature),
        );
      const content = m.content.map((call, index) => {
        if (call.type !== "toolCall") return call;
        const result = results.get(call.id);
        if (
          !result ||
          result.message.isError ||
          result.message.toolName !== call.name
        )
          return call;
        const blocks = result.message.content;
        if (
          result.original &&
          observations.has(call.name) &&
          blocks.every((b) => b.type === "text") &&
          !blocks.some((b) => b.textSignature) &&
          blocks.some((b) => b.text.length > FULL_TEXT_LIMIT)
        ) {
          edits.push({
            type: "context_edit",
            targetId: result.id,
            replacement: {
              content: blocks.map((b, n) =>
                b.text.length > FULL_TEXT_LIMIT
                  ? { ...b, text: excerpt(b.text, `${result.id}:${n}`) }
                  : b,
              ),
            },
          });
        }
        if (!canEditArgs || (call.name !== "write" && call.name !== "edit"))
          return call;
        const args = { ...call.arguments };
        function shorten(
          target: Record<string, unknown>,
          fields: readonly string[],
          prefix: string,
        ) {
          for (const field of fields) {
            const value = target[field];
            if (typeof value === "string" && value.length > FULL_TEXT_LIMIT) {
              target[field] = excerpt(
                value,
                `${sourceEntry.id}:${index}:${prefix}${field}`,
              );
              changed = true;
            }
          }
        }
        shorten(args, fileFields[call.name], "");
        if (call.name === "edit" && Array.isArray(args.edits)) {
          args.edits = args.edits.map((item, n) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
              return item;
            const replacement = { ...item };
            shorten(replacement, fileFields.edit, `edits.${n}.`);
            return replacement;
          });
        }
        return { ...call, arguments: args };
      });
      if (changed)
        edits.push({
          type: "context_edit",
          targetId: sourceEntry.id,
          replacement: { content },
        });
    }
    results.clear();
  }
  return edits;
}

// Derive the handoff from Pi's active projection. The returned messages are request-only;
// SessionManager keeps the original receipts and exact arguments for branch-local recall.
function deliveredFileRecords(
  messages: AgentMessage[],
  entries: ProjectedSessionEntry[],
  archiveBlenderProduction = true,
  archiveEarlierBlenderWork = true,
) {
  const changes = new Map<AgentMessage, AgentMessage | null>();
  const recoverable = new Map<string, string | ToolCall["arguments"]>();
  const sources = new Map<
    string,
    { id: string; message: AgentMessage; original: boolean } | null
  >();
  const key = (m: AgentMessage) => {
    if (m.role === "user") return `user:${m.timestamp}`;
    if (m.role === "toolResult") return `result:${m.toolCallId}`;
    if (m.role !== "assistant") return;
    if (m.stopReason === "stop") return `delivery:${m.timestamp}`;
    const first = m.content.find((block) => block.type === "toolCall");
    if (first) return `save:${first.id}`;
  };
  for (const {
    sourceEntry,
    messages: [m],
  } of entries) {
    if (sourceEntry.type !== "message" || !m) continue;
    const k = key(m);
    if (k)
      sources.set(
        k,
        sources.has(k)
          ? null
          : {
              id: sourceEntry.id,
              message: m,
              original: sourceEntry.message === m,
            },
      );
  }
  const sourceId = (m: AgentMessage, originalOnly = true) => {
    const source = sources.get(key(m) ?? "");
    return source &&
      (!originalOnly || source.original) &&
      (source.message === m || isDeepStrictEqual(source.message, m))
      ? source.id
      : undefined;
  };
  const users = messages.flatMap((m, i) =>
    m.role === "user" && sourceId(m) ? [i] : [],
  );
  const earlierBlenderWork: ToolBatch[] = [];
  const earlierReviewGuides: ToolResultMessage[] = [];
  const includeEarlier = archiveBlenderProduction && archiveEarlierBlenderWork;
  for (let k = 1; k < users.length; k++) {
    const turn = messages
      .slice(users[k - 1]! + 1, users[k])
      .filter((m) => m.role !== "system");
    const final = turn.at(-1);
    if (turn.some((m) => m.role !== "assistant" && m.role !== "toolResult"))
      continue;
    const completed =
      final?.role === "assistant" &&
      final.stopReason === "stop" &&
      sourceId(final) &&
      final.content.some((c) => c.type === "text" && c.text.trim()) &&
      !turn.some(
        (m) =>
          m.role === "assistant" &&
          (m.stopReason === "aborted" || m.stopReason === "error"),
      );
    if (!completed && !includeEarlier) continue;
    const batches = turn.flatMap<ToolBatch>((request, i) => {
      if (
        request.role !== "assistant" ||
        request.stopReason !== "toolUse" ||
        (request.api as string) === "ohmygame-native"
      )
        return [];
      const calls = request.content.filter((c) => c.type === "toolCall");
      const replies = turn
        .slice(i + 1, i + 1 + calls.length)
        .filter((m) => m.role === "toolResult");
      if (
        !calls.length ||
        calls.length !== replies.length ||
        turn[i + 1 + calls.length]?.role === "toolResult" ||
        new Set(calls.map((c) => c.id)).size !== calls.length ||
        calls.some(
          (c, n) =>
            c.id !== replies[n]?.toolCallId || c.name !== replies[n]?.toolName,
        )
      )
        return [];
      return [{ request, calls, replies }];
    });
    if (!completed) {
      const inspections = batches.filter(
        ({ request, calls, replies }) =>
          isAstraHistory(request) &&
          sourceId(request) &&
          calls.some((call, n) => {
            const reply = replies[n]!;
            return (
              call.name === "inspect_3d_views" &&
              !reply.isError &&
              sourceId(reply) &&
              reply.content.some((block) => block.type === "image")
            );
          }),
      );
      if (inspections.length) {
        // A subsequent verified delivery can retire local preparation without
        // changing this attempt's formal review, failed operations or receipts.
        earlierBlenderWork.push(
          ...batches.filter(({ calls }) =>
            calls.every(
              (call) =>
                reviewPreparationTools.has(call.name) &&
                !(
                  call.name === "get_model_asset" &&
                  call.arguments.rebuildPreview === true
                ),
            ),
          ),
        );
        earlierReviewGuides.push(
          ...inspections.flatMap(({ replies }) =>
            replies.filter((reply) => reply.toolName === "read_workflow_guide"),
          ),
        );
      }
      continue;
    }
    // The final receipt is the handoff boundary. Keep it, source inspections and
    // every paid/approval receipt while removing entire completed local batches.
    const delivery = archiveBlenderProduction
      ? batches
          .flatMap(({ request, calls, replies }) => {
            if (!isAstraHistory(request) || !sourceId(request)) return [];
            return replies.filter((reply, n) => {
              const call = calls[n]!;
              const report = retainedBlenderRun(reply);
              return (
                call.name === "recover_blender_run" &&
                call.arguments.reviewPresentation === "final" &&
                report !== undefined &&
                report.runId === call.arguments.runId &&
                report.stage === "export" &&
                report.reviewPresentation === "final" &&
                report.presentedOnCanvas === true &&
                report.technicalChecksPassed === true &&
                !reply.isError &&
                Boolean(sourceId(reply)) &&
                reply.content.length === 1 &&
                reply.content[0]?.type === "text" &&
                !reply.content[0].textSignature
              );
            });
          })
          .at(-1)
      : undefined;
    if (delivery) {
      for (const guide of earlierReviewGuides) {
        const id = sourceId(guide),
          block = guide.content[0];
        if (
          !id ||
          guide.isError ||
          guide.content.length !== 1 ||
          block?.type !== "text" ||
          block.textSignature ||
          block.text.length <= FULL_TEXT_LIMIT
        )
          continue;
        const ref = `${id}:0`;
        recoverable.set(ref, block.text);
        changes.set(guide, {
          ...guide,
          content: [{ ...block, text: excerpt(block.text, ref) }],
        });
      }
      const archived = [];
      for (const { request, calls, replies } of [
        ...earlierBlenderWork,
        ...batches,
      ]) {
        if (!isAstraHistory(request)) continue;
        const requestId = sourceId(request, false);
        if (
          !requestId ||
          calls.some(
            (call) =>
              !productionTools.has(call.name) ||
              (call.name === "run_blender" &&
                call.arguments.stage === "inspect"),
          )
        )
          continue;
        // A projected edit must not change which canonical image an index can recall.
        const replyIds = replies.map((reply) =>
          sourceId(
            reply,
            reply.content.some((block) => block.type === "image"),
          ),
        );
        if (
          replies.some((reply, n) => {
            const status =
              reply.toolName === "run_blender"
                ? (
                    reply.details as
                      { blender?: { status?: string } } | undefined
                  )?.blender?.status
                : undefined;
            return (
              !replyIds[n] ||
              reply.isError ||
              status === "failed" ||
              status === "saved-not-run" ||
              reply.content.some(
                (block) => block.type === "text" && block.textSignature,
              )
            );
          })
        )
          continue;
        changes.set(request, null);
        for (const [n, call] of calls.entries()) {
          const reply = replies[n]!,
            replyId = replyIds[n]!;
          const argsRef = `${requestId}:${request.content.indexOf(call)}`;
          recoverable.set(argsRef, call.arguments);
          const textRefs: string[] = [],
            imageIds: string[] = [];
          for (const [i, block] of reply.content.entries()) {
            if (block.type === "image")
              imageIds.push(`${replyId}:${imageIds.length}`);
            else {
              const ref = `${replyId}:${i}`;
              recoverable.set(ref, block.text);
              textRefs.push(ref);
            }
          }
          const path = call.arguments.path ?? call.arguments.scriptPath;
          archived.push({
            tool: call.name,
            ...(typeof path === "string" ? { path } : {}),
            argsRef,
            textRefs,
            imageIds,
          });
          changes.set(reply, null);
        }
      }
      if (archived.length) {
        const ref = `${sourceId(delivery)}:1`;
        recoverable.set(ref, JSON.stringify(archived));
        const block = delivery.content[0]!;
        const guidance = archiveEarlierBlenderWork
          ? `Use retained source and delivery measurements for factual questions about this export. Read current reports for missing facts, or call recall_tool_text ref=${ref} to find retained tool text and image references.`
          : `Read the retained reports or call recall_tool_text ref=${ref} for the exact tool text and image reference index.`;
        if (block.type === "text")
          changes.set(delivery, {
            ...delivery,
            content: [
              {
                ...block,
                text: `${block.text}\n[Earlier completed Blender work is archived. ${guidance} Reopen needed pixels before judging visual changes.]`,
              },
            ],
          });
      }
      earlierBlenderWork.length = 0;
      earlierReviewGuides.length = 0;
      continue;
    }
    if (
      includeEarlier &&
      batches.some(
        ({ request, calls, replies }) =>
          isAstraHistory(request) &&
          calls.some(
            (call, n) =>
              call.name === "run_blender" &&
              sourceId(replies[n]!) &&
              retainedBlenderRun(replies[n]!),
          ),
      )
    ) {
      earlierBlenderWork.push(...batches);
    }
    const paths = new Set<string>();
    const reads: ToolResultMessage[] = [];
    for (const { calls, replies } of batches)
      for (const [n, call] of calls.entries()) {
        const m = replies[n]!;
        if (m.isError) continue;
        const path =
          call.name === "read"
            ? call.arguments.path
            : call.name === "run_blender"
              ? call.arguments.scriptPath
              : undefined;
        if (typeof path !== "string") continue;
        paths.add(path);
        const [b] = m.content;
        if (
          call.name !== "read" ||
          !/^(canvas|assets)\/.+\.(json|py|md)$/.test(path) ||
          m.content.length !== 1 ||
          b?.type !== "text" ||
          b.textSignature ||
          b.text.length < 512 ||
          b.text.includes("recall_image") ||
          b.text.includes("recall_tool_text ref=")
        )
          continue;
        const id = sourceId(m);
        if (!id) continue;
        const ref = `${id}:0`;
        recoverable.set(ref, b.text);
        reads.push(m);
        changes.set(m, {
          ...m,
          content: [
            {
              type: "text",
              text: `[Historical file after delivery. Read the path for current contents or use recall_tool_text ref=${ref} for the original.]`,
            },
          ],
        });
      }
    // Keep a reference for every removed call in a retained tool result from the same turn.
    const anchor = reads[0];
    if (!anchor) continue;
    const archived: { path: string; ref: string }[] = [];
    for (const { request, calls, replies } of batches) {
      if (request.content.length !== calls.length) continue;
      const id = sourceId(request);
      if (
        !id ||
        !calls.every((c, n) => {
          const result = replies[n]!;
          const expected =
            c.name === "write"
              ? "Project file saved."
              : c.name === "edit"
                ? "Project file edited."
                : undefined;
          return (
            expected &&
            !c.thoughtSignature &&
            typeof c.arguments.path === "string" &&
            paths.has(c.arguments.path) &&
            !result.isError &&
            sourceId(result) &&
            result.content.length === 1 &&
            result.content[0]?.type === "text" &&
            !result.content[0].textSignature &&
            result.content[0].text === expected
          );
        })
      )
        continue;
      changes.set(request, null);
      calls.forEach((c, n) => {
        changes.set(replies[n]!, null);
        const ref = `${id}:${n}`;
        recoverable.set(ref, c.arguments);
        archived.push({ path: String(c.arguments.path), ref });
      });
    }
    if (archived.length) {
      const replacement = changes.get(anchor) as ToolResultMessage;
      const b = replacement.content[0];
      if (b?.type === "text")
        b.text += `\nEarlier successful file saves in this turn (recall_tool_text ref for original arguments): ${JSON.stringify(archived)}`;
    }
  }
  return { changes, recoverable };
}

export function projectDeliveredFileHistory(
  messages: AgentMessage[],
  entries: ProjectedSessionEntry[],
  archiveBlenderProduction = true,
  archiveEarlierBlenderWork = true,
): AgentMessage[] {
  const { changes } = deliveredFileRecords(
    messages,
    entries,
    archiveBlenderProduction,
    archiveEarlierBlenderWork,
  );
  return changes.size
    ? messages.flatMap((m) => (changes.has(m) ? (changes.get(m) ?? []) : m))
    : messages;
}

export const toolHistoryExtension: ExtensionFactory = (pi) => {
  pi.on("context_with_system", (event, ctx) => {
    const first = event.messages.findIndex((m) => m.role === "user");
    if (
      first >= 0 &&
      first !== event.messages.findLastIndex((m) => m.role === "user")
    )
      return {
        messages: projectDeliveredFileHistory(
          event.messages,
          ctx.sessionManager.buildSessionProjection().entries,
        ),
      };
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "completed")
      return { entries: completedToolTextEdits(event.context.contextEntries) };
  });
};

function toolTextValue(
  block:
    | AssistantMessage["content"][number]
    | ToolResultMessage["content"][number]
    | undefined,
  field?: string,
) {
  if (!field && block?.type === "text") return block.text;
  const nested = field && /^edits\.(\d+)\.(oldText|newText)$/.exec(field);
  if (
    nested &&
    block?.type === "toolCall" &&
    block.name === "edit" &&
    Array.isArray(block.arguments.edits)
  )
    return block.arguments.edits[Number(nested[1])]?.[nested[2]!];
  if (
    field &&
    block?.type === "toolCall" &&
    (block.name === "write" || block.name === "edit") &&
    (fileFields[block.name] as readonly string[]).includes(field)
  )
    return block.arguments[field];
  return undefined;
}

export function createToolTextRecall(manager: SessionManager) {
  return defineTool({
    name: "recall_tool_text",
    label: "Recall Tool Text",
    description:
      "Read original text using a historical tool excerpt's ref. Offset counts UTF-16 code units from zero.",
    parameters: Type.Object({
      ref: Type.String({
        pattern:
          "^[a-zA-Z0-9_-]+:[0-9]+(:(content|(edits\\.[0-9]+\\.)?(oldText|newText)))?$",
      }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
    }),
    execute: async (_callId, { ref, offset = 0 }) => {
      const [id, index, field] = ref.split(":");
      const branch = manager.getBranch();
      const source = branch.find((e) => e.id === id);
      const edit = branch.findLast(
        (e) => e.type === "context_edit" && e.targetId === id,
      );
      const original =
        source?.type === "message" &&
        (source.message.role === "assistant" ||
          source.message.role === "toolResult")
          ? source.message.content
          : undefined;
      const visible =
        edit?.type === "context_edit" ? edit.replacement?.content : undefined;
      let text = toolTextValue(original?.[Number(index)], field);
      const replacement = Array.isArray(visible)
        ? toolTextValue(visible[Number(index)], field)
        : undefined;
      if (
        typeof text !== "string" ||
        typeof replacement !== "string" ||
        !replacement.includes(`recall_tool_text ref=${ref} …]`) ||
        replacement !== excerpt(text, ref)
      ) {
        const projection = manager.buildSessionProjection();
        const recovered = deliveredFileRecords(
          projection.messages,
          projection.entries,
        ).recoverable.get(ref);
        text =
          typeof recovered === "object" ? JSON.stringify(recovered) : recovered;
      }
      if (typeof text !== "string" || containsKnownSensitiveValue(text))
        throw new Error("Tool text unavailable on this branch.");
      if (offset > text.length)
        throw new Error("Offset exceeds the original text length.");
      const end = Math.min(offset + PAGE_SIZE, text.length);
      return {
        content: [
          { type: "text", text: text.slice(offset, end) },
          ...(end < text.length
            ? [
                {
                  type: "text" as const,
                  text: `Next page: offset=${end} of ${text.length}.`,
                },
              ]
            : []),
        ],
        details: undefined,
      };
    },
  });
}
