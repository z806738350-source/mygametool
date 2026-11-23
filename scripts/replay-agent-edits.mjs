// Reproduce edit batching offline. Historical scripts and media tools are never executed.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.ts";

// These tools observe the project or update only the conversation. Unrecognized effects invalidate cached source evidence.
const observations = new Set(["ls", "find", "grep", "read_workflow_guide", "blender_status", "list_media_capabilities",
  "tool_search", "update_plan", "inspect_3d_views", "canvas_check", "recall_image", "recall_tool_text"]);

function requests(branch) {
  const rows = [];
  let epoch = 0, turn = 0;
  for (const entry of branch) {
    if (["compaction", "branch_summary", "custom_message"].includes(entry.type)) epoch++;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") turn++;
    if (message.role === "user" || message.role === "system") epoch++;
    if (message.role === "assistant") {
      const calls = message.content.filter(block => block.type === "toolCall");
      rows.push({ number: rows.length + 1, calls, epoch, turn, results: new Map(),
        single: message.stopReason === "toolUse" && calls.length === 1 && message.content.length === 1 });
    } else if (message.role === "toolResult") {
      rows.at(-1)?.results.set(message.toolCallId, message);
    }
  }
  return rows;
}

function singleEdit(row) {
  if (!row?.single) return;
  const [call] = row.calls, args = call.arguments, result = row.results.get(call.id);
  if (call.name === "edit" && result?.toolName === call.name && result.isError === false
    && typeof args.path === "string" && typeof args.oldText === "string" && typeof args.newText === "string"
    && Object.keys(args).every(key => ["path", "oldText", "newText"].includes(key))) return args;
}

// The project's read tool uses 1-based lines, defaults to 200 lines, and clips at 64 Ki characters.
// A partial read can extend a known prefix only if the overlapping lines agree.
function observeRead(previous, args, result, step) {
  const [part] = result.content;
  if (result.content.length !== 1 || part?.type !== "text" || part.text.length >= 64 * 1024) return;
  const start = (args.offset ?? 1) - 1, limit = args.limit ?? 200;
  const lines = part.text.split("\n"), end = start + lines.length, complete = lines.length < limit;
  if (start === 0) return { lines, complete, sourceSteps: [step] };
  if (!previous || start >= previous.lines.length || part.text === "") return;
  const overlap = Math.min(previous.lines.length - start, lines.length);
  if (!lines.slice(0, overlap).every((line, i) => line === previous.lines[start + i])) return;
  if (!complete && end <= previous.lines.length) return previous;
  return { lines: [...previous.lines.slice(0, start), ...lines], complete, sourceSteps: [...previous.sourceSteps, step] };
}

export async function replayAgentEdits(branch) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-edit-replay-"));
  const tools = new Map(createLocalAgentFileTools(directory).map(tool => [tool.name, tool]));
  const execute = (name, args) => tools.get(name).execute("offline", args, undefined, undefined, {});
  const states = new Map(), groups = [], skippedGroups = [], rows = requests(branch);
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.turn !== rows[i - 1]?.turn) states.clear();
      const first = singleEdit(row);
      if (first) {
        let end = i + 1;
        while (end < rows.length && rows[end].epoch === row.epoch && singleEdit(rows[end])?.path === first.path) end++;
        const run = rows.slice(i, end), state = states.get(first.path);
        let reason = "incomplete-source";
        if (state?.complete) {
          // Production write/edit validate relative paths, UTF-8, uniqueness, disjoint ranges and Canvas schemas.
          const source = state.lines.join("\n"), edits = run.map(r => {
            const { oldText, newText } = singleEdit(r);
            return { oldText, newText };
          });
          const snapshots = [Buffer.from(source)];
          try {
            await execute("write", { path: first.path, content: source });
            for (const edit of edits) {
              await execute("edit", { path: first.path, ...edit });
              snapshots.push(await readFile(path.join(directory, first.path)));
            }
            states.set(first.path, { lines: snapshots.at(-1).toString().split("\n"), complete: true,
              sourceSteps: [...state.sourceSteps, ...run.map(r => r.number)] });
            // Try the full batch first. A dependent edit may still allow a smaller independent prefix.
            for (let left = 0; left + 1 < edits.length; left++) {
              for (let right = edits.length; right > left + 1; right--) {
                await execute("write", { path: first.path, content: snapshots[left].toString() });
                try { await execute("edit", { path: first.path, edits: edits.slice(left, right) }); }
                catch { continue; }
                const actual = await readFile(path.join(directory, first.path));
                if (!actual.equals(snapshots[right])) continue;
                groups.push({ steps: run.slice(left, right).map(r => r.number), bytes: actual.length,
                  sourceSteps: [...state.sourceSteps, ...run.slice(0, left).map(r => r.number)] });
                left = right - 1;
                break;
              }
            }
            reason = "dependent-or-different-bytes";
          } catch {
            states.delete(first.path);
            reason = "historical-edit-not-reproducible";
          }
        } else states.delete(first.path); // An edit to an unproven file invalidates any partial read from before it.
        if (run.length > 1 && !groups.some(g => g.steps[0] >= row.number && g.steps[0] <= run.at(-1).number))
          skippedGroups.push({ steps: run.map(r => r.number), reason });
        i = end - 1;
        continue;
      }
      for (const call of row.calls) {
        const args = call.arguments, result = row.results.get(call.id);
        if (observations.has(call.name)) continue;
        if (call.name === "read") {
          if (result?.toolName === "read" && !result.isError && typeof args.path === "string")
            states.set(args.path, observeRead(states.get(args.path), args, result, row.number));
        } else if (call.name === "write" || call.name === "edit") {
          if (call.name === "write" && result?.toolName === "write" && !result.isError && typeof args.content === "string")
            states.set(args.path, { lines: args.content.split("\n"), complete: true, sourceSteps: [row.number] });
          else states.delete(args.path);
        } else if (call.name === "run_blender" && result?.toolName === call.name && !result.isError
          && result.details?.blender?.presentedOnCanvas === false && result.details.blender.reviewPresentation === "internal") {
          // The host snapshots inputs and writes outputs to a distinct retained run directory.
          for (const file of result.details.blender.files ?? []) states.delete(file);
        } else states.clear();
      }
    }
    return { groups, removedSteps: groups.flatMap(group => group.steps.slice(1)), skippedGroups };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { session: { type: "string" } } });
  if (!values.session) throw new Error("Pass --session FILE to replay local edit groups.");
  const entries = (await readFile(values.session, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(entry => entry.type !== "session");
  const byId = new Map(entries.map(entry => [entry.id, entry])), branch = [];
  for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) branch.push(entry);
  console.log(JSON.stringify(await replayAgentEdits(branch.reverse()), null, 2));
}
