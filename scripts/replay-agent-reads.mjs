// Reads can be omitted only when the original returned text is still visible in Pi's projection.
const observations = new Set(["read", "ls", "find", "grep", "inspect_3d_views", "read_workflow_guide",
  "blender_status", "tool_search", "list_media_capabilities", "update_plan", "canvas_check", "recall_image", "recall_tool_text"]);
const text = message => message?.role === "toolResult" && !message.isError && message.content.length === 1
  && message.content[0].type === "text" && !message.content[0].textSignature ? message.content[0].text : undefined;

function knownFile(messages, file) {
  let lines, start, complete, sourceCalls = [];
  const calls = new Map();
  for (const message of messages.slice(messages.findLastIndex(m => m.role === "user") + 1)) {
    if (message.role === "assistant") for (const call of message.content) {
      if (call.type === "toolCall") calls.set(call.id, call);
    }
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== message.toolName) { lines = undefined; continue; }
    const a = call.arguments;
    if (call.name === "read" && a.path === file) {
      const observed = text(message);
      if (observed === undefined || observed.length >= 65536 || observed.includes("recall_tool_text ref=")) { lines = undefined; continue; }
      const index = (a.offset ?? 1) - 1, page = observed.split("\n"), endKnown = page.length < (a.limit ?? 200);
      if (lines && index >= start && index + page.length <= start + lines.length &&
          page.every((line,i) => lines[index - start + i] === line)) continue;
      start = index; lines = page; complete = endKnown; sourceCalls = [call.id];
    } else if (call.name === "write" || call.name === "edit") {
      if (file !== a.path) continue;
      if (message.isError) { lines = undefined; continue; }
      if (call.name === "write" && typeof a.content === "string" && !a.content.includes("recall_tool_text ref=")) {
        lines = a.content.split("\n"); start = 0; complete = true; sourceCalls = [call.id];
      } else if (call.name === "edit" && lines && start === 0 && complete) {
        const source = lines.join("\n"), edits = Array.isArray(a.edits) ? a.edits : [a];
        const matches = edits.flatMap(edit => {
          if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string"
              || [edit.oldText,edit.newText].some(value => value.includes("recall_tool_text ref="))) return [];
          const pos = source.indexOf(edit.oldText);
          return pos >= 0 && pos === source.lastIndexOf(edit.oldText) ? [{ pos, end: pos + edit.oldText.length, replacement: edit.newText }] : [];
        }).sort((a,b) => b.pos - a.pos);
        if (matches.length !== edits.length || matches.some((m,i) => i && m.end > matches[i-1].pos)) { lines = undefined; continue; }
        let updated = source;
        for (const m of matches) updated = updated.slice(0,m.pos) + m.replacement + updated.slice(m.end);
        lines = updated.split("\n"); sourceCalls.push(call.id);
      } else lines = undefined;
    } else if (!observations.has(call.name)) {
      const run = message.details?.blender;
      // Internal Blender runs work on a snapshot and return files under the run's own output paths.
      if (!(call.name === "run_blender" && !message.isError && run?.presentedOnCanvas === false
          && run.reviewPresentation === "internal" && !run.files?.includes(file))) lines = undefined;
    }
  }
  return lines && { lines, start, complete, sourceCalls };
}

export function visibleReadSource(messages, call, originalResult) {
  const expected = text(originalResult);
  if (expected === undefined || typeof expected !== "string" || originalResult.toolName !== call.name || expected.includes("recall_tool_text ref=")) return;
  if (call.name === "read") {
    const file = knownFile(messages, call.arguments.path);
    if (!file) return;
    const low = (call.arguments.offset ?? 1) - 1 - file.start, limit = call.arguments.limit ?? 200;
    if (low < 0 || (!file.complete && low + limit > file.lines.length)) return;
    if (file.lines.slice(low, low + limit).join("\n").slice(0,65536) === expected) return file.sourceCalls;
  }
  if (call.name === "read_workflow_guide" || call.name === "blender_status") {
    const active = call.name === "blender_status" ? messages.slice(messages.findLastIndex(m => m.role === "user") + 1) : messages;
    const prior = new Set(active.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall" &&
      b.name === call.name && JSON.stringify(b.arguments) === JSON.stringify(call.arguments)).map(b => b.id) : []));
    const same = active.findLast(m => prior.has(m.toolCallId) && m.toolName === call.name && text(m) === expected);
    if (same) return [same.toolCallId];
  }
}

// A separate counterfactual: request adjacent overlaps in one page, retaining every observed line.
// Use only bounded text-only reads of the same schema in consecutive requests without an intervening decision.
export function overlappingSchemaReads(branch) {
  const groups = [];
  let previous, last;
  for (const e of branch) {
    if (e.type === "context_edit" || e.type === "compaction" || e.type === "branch_summary") previous = last = undefined;
    const m = e.message;
    if (!m) continue;
    if (m.role === "assistant") {
      last = undefined;
      const calls = m.content.filter(b => b.type === "toolCall");
      const call = calls[0];
      if (calls.length === 1 && call.name === "read" && typeof call.arguments.path === "string" &&
          /^canvas\/schemas\/[^/]+\.schema\.json$/.test(call.arguments.path) &&
          m.content.every(b => b.type === "toolCall" || b.type === "thinking")) last = call;
      else previous = undefined;
    } else if (m.role === "toolResult" && last?.id === m.toolCallId && m.toolName === "read") {
      const observed = text(m);
      if (!observed || observed.length >= 65536 || observed.includes("recall_tool_text ref=")) { previous = last = undefined; continue; }
      const args = last.arguments, start = args.offset ?? 1, limit = args.limit ?? 200;
      const page = { path: args.path, start, end: start + limit, lines: observed.split("\n"), id: last.id };
      if (previous?.path === page.path && previous.lines.length === previous.end - previous.start && page.lines.length === limit) {
        const [a,b] = previous.start <= start ? [previous,page] : [page,previous];
        const overlap = a.end - b.start, count = Math.max(a.end,b.end) - a.start;
        if (overlap > 0 && overlap < Math.min(a.lines.length,b.lines.length) && count <= 1000 &&
            a.lines.slice(-overlap).every((line,i) => b.lines[i] === line)) {
          const combined = [...a.lines,...b.lines.slice(overlap)].join("\n");
          if (combined.length < 65536) {
            groups.push({ first: previous.id, second: page.id, path: page.path, offset: a.start, limit: count, text: combined, overlap });
            previous = last = undefined; continue;
          }
        }
      }
      previous = page;
    } else if (m.role !== "toolResult") previous = last = undefined;
  }
  return groups;
}
