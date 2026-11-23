// Independent request-only controls. Never change the Pi session or execute a tool.
import assert from "node:assert/strict";
import { wireImages } from "../src/daemon/session-images.ts";

// A proposed 2D design stage, ending at human approval before 3D submission.
const laterStage = new Set([
  "game_use", "build_game", "prepare_three_runtime", "generate_video", "generate_speech",
  "generate_sound_effect", "generate_music", "generate_3d_asset", "generate_3d_from_views", "animate_3d_asset",
]);
const excerpt = /\[… \d+ characters in original\. recall_tool_text ref=[^\]\n]+ …\]/;

// Preserve the actual final answer and both user messages. Offer this control only after
// a completed delivery whose earlier image blocks are already released in the real request.
function closedTurn(payload) {
  const users = payload.input.flatMap((item, index) => item.role === "user" ? [index] : []);
  if (users.length !== 2) return;
  const start = users[0] + 1, end = users[1] - 1;
  const final = payload.input[end];
  if (final?.role !== "assistant" || final.status !== "completed") return;
  const closed = payload.input.slice(start, end);
  if (!wireImages(closed).length) return { start, end, closed };
}

// Keep original roles and all current-turn evidence. A removed pair is a fully settled
// unsigned file operation whose target remains named by a retained read or Blender run.
export function completedTurnRolePreservingHandoff(payload, successfulCallIds, unsignedSaveCallIds, record = () => {}) {
  const eligible = closedTurn(payload);
  if (!eligible) return payload;
  const { start, end, closed } = eligible;
  const calls = new Map(closed.filter(item => item.type === "function_call").map(item => [item.call_id,item]));
  const paths = new Set();
  for (const call of calls.values()) {
    const args = JSON.parse(call.arguments);
    if (call.name === "read" && args.path) paths.add(args.path);
    if (call.name === "run_blender" && args.scriptPath) paths.add(args.scriptPath);
  }
  const archived = new Set();
  let changedReads = 0;
  for (let i = 0; i < closed.length;) {
    const from = i;
    while (i < closed.length && closed[i].type !== "function_call_output") i++;
    const outputs = i;
    while (i < closed.length && closed[i].type === "function_call_output") i++;
    const batch = closed.slice(from, outputs), replies = closed.slice(outputs, i);
    if (!batch.length || batch.length !== replies.length || !batch.every((call,n) =>
      call.type === "function_call" && unsignedSaveCallIds?.has(call.call_id) && successfulCallIds?.has(call.call_id) &&
      paths.has(JSON.parse(call.arguments).path) && replies[n].call_id === call.call_id &&
      (call.name === "write" && replies[n].output === "Project file saved." || call.name === "edit" && replies[n].output === "Project file edited."))) continue;
    for (const call of batch) archived.add(call.call_id);
  }
  const prior = closed.filter(item => !archived.has(item.call_id)).map(item => {
    if (item.type !== "function_call_output" || !successfulCallIds?.has(item.call_id)) return item;
    const call = calls.get(item.call_id);
    if (call?.name !== "read" || typeof item.output !== "string" || item.output.length < 512 || excerpt.test(item.output)) return item;
    const { path:file } = JSON.parse(call.arguments);
    if (typeof file !== "string" || !/^(canvas|assets)\/.+\.(json|py|md)$/.test(file) || item.output.includes("recall_image")) return item;
    changedReads++;
    return { ...item, output:"[Historical file contents omitted after delivery. Read the file named in this call for its current contents.]" };
  });
  const input = [...payload.input.slice(0,start), ...prior, ...payload.input.slice(end)];
  const messages = list => list.filter(item => item.role || item.type === "reasoning");
  assert.deepEqual(messages(prior),messages(closed),"Historical user, assistant or reasoning messages changed");
  record({ changedReads, archivedFilePairs:archived.size });
  return { ...payload, input };
}

export function createPrefixCounterfactual() {
  const originals = new Map(), restored = new Map(), schemas = new Set(), developers = new Set();
  let declarationBytes, scopedBytes, hiddenTools, inPlace;
  return {
    project(payload, { step, nextTools = [], successfulCallIds, unsignedSaveCallIds }) {
      assert(nextTools.every(name => !laterStage.has(name)), "Stage ended: a withheld declaration is needed");
      const available = payload.tools.filter(tool => !laterStage.has(tool.name));
      const full = JSON.stringify(payload.tools);
      schemas.add(full);
      developers.add(JSON.stringify(payload.input.filter(item => item.role === "developer" || item.role === "system")));
      declarationBytes = Buffer.byteLength(full);
      scopedBytes = Buffer.byteLength(JSON.stringify(available));
      hiddenTools = payload.tools.filter(tool => laterStage.has(tool.name)).map(tool => tool.name);
      const input = payload.input.map(item => {
        if (item.type !== "function_call" && item.type !== "function_call_output") return item;
        // A former image result can acquire descriptive text later. Never restore images using this text control.
        if (Array.isArray(item.output) && item.output.some(block => block.type !== "input_text")) return item;
        const key = item.type + ":" + item.call_id;
        if (!originals.has(key)) {
          originals.set(key, item);
          return item;
        }
        const original = originals.get(key);
        if (original === item || !excerpt.test(JSON.stringify(item.arguments ?? item.output))) return item;
        if (excerpt.test(JSON.stringify(original.arguments ?? original.output))) return item;
        if (!restored.has(key)) restored.set(key, step);
        return original;
      });
      return {
        deferPriorTextExcerpts: { ...payload, input },
        stageToolDeclarations: { ...payload, tools: available },
        rolePreservingHandoff: completedTurnRolePreservingHandoff(payload, successfulCallIds, unsignedSaveCallIds,
          evidence => { inPlace ??= { firstStep:step, ...evidence }; }),
      };
    },
    report() {
      return {
        distinctDeclarationSets: schemas.size, distinctDeveloperMessageSets: developers.size,
        declarationBytes, scopedBytes, hiddenTools,
        restoredTextItems: restored.size, firstRestoredAt: [...new Set(restored.values())], rolePreservingHandoff:inPlace,
        limits: [
          "Deferral preserves original text in place through the second user turn and postpones its larger prompt cost. Only Pi text excerpts observed with their full original in this replay can be restored.",
          "The scoped declaration set keeps every tool selected in these replies. In production the scope must end at the 3D handoff, expand for other tasks, and preserve access to discovery and recovery.",
          "The in-place control preserves original message roles, all reasoning and assistant text, image/guide/production receipts and every current-turn item. Only successful old text reads and complete unsigned file pairs whose paths remain in the transcript are eligible.",
        ],
      };
    },
  };
}
