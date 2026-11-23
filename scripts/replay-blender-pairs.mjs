// Pair a known-good script save with its next internal Blender invocation. No historical Python is executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalAgentFileTools, localAgentPath, projectFileVersionPath } from "../src/daemon/agent-local-files.ts";
import { readSafeProjectFile } from "../src/daemon/safe-project-file.ts";
import { BlenderWorkflow } from "../src/daemon/blender-tools.ts";
import { BlenderRunError, BlenderRunner } from "../src/daemon/blender-runner.ts";

const read = async (root, relative) => readSafeProjectFile(root, await localAgentPath(root, relative));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export async function verifiedBlenderPairs({ branch, sessionFile, batchGroups, scratch }) {
  const projectDir = path.dirname(path.dirname(path.resolve(sessionFile)));
  const workspace = await realpath(path.join(projectDir, "workspace"));
  const jobs = await realpath(path.join(projectDir, "../../blender-jobs", path.basename(projectDir)));
  const output = new Map(branch.filter(e => e.message?.role === "toolResult").map(e => [e.message.toolCallId,e.message]));
  const fileTools = new Map(createLocalAgentFileTools(scratch).map(t => [t.name,t]));
  const runTool = new BlenderWorkflow({ workspace:scratch }).tools().find(t => t.name === "run_blender");
  const grouped = new Map(batchGroups.map(g => [g.steps[0], g.steps]));
  const assistants = branch.filter(e => e.message?.role === "assistant").map(e => e.message);
  const removed = new Set(batchGroups.flatMap(g => g.steps.slice(1)));
  let step = 0, known = [], save;
  const pairs = [];
  for (const entry of branch) {
    const m = entry.message;
    if (m?.role === "user" || ["compaction", "branch_summary", "custom_message"].includes(entry.type)) {
      known = []; save = undefined;
    }
    if (!m) continue;
    if (m.role === "assistant") {
      step++;
      const calls = m.content.filter(b => b.type === "toolCall");
      if (!removed.has(step)) {
        const c = calls[0], a = c?.arguments;
        if (save && m.content.length === 1 && c?.name === "run_blender" && a.stage === "custom" &&
            a.scriptPath === save.path && (a.reviewPresentation ?? "internal") === "internal" &&
            !a.sourcePath && !a.sourceAssetId && !a.configPath && !a.brief &&
            (a.inputs ?? []).every(p => save.known.some(s => s.includes(p)))) {
          const returned = output.get(c.id), info = returned?.details?.blender;
          assert(info && !returned.isError && info.reviewPresentation === "internal" && info.presentedOnCanvas === false);
          assert.match(info.runId, /^[0-9a-f-]{36}$/);
          const jobDir = path.join(jobs,info.runId);
          const invocation = JSON.parse(await read(jobDir,"invocation.json"));
          assert.equal(invocation.callId,c.id);
          assert.equal(await realpath(invocation.sessionFile),await realpath(sessionFile));
          assert.deepEqual(invocation.request, a);
          assert.deepEqual(JSON.parse(await read(jobDir,"completed.json")), { id: info.runId, status: "completed" });
          const script = await read(scratch, save.path);
          assert(script.equals(await read(jobDir,"scripts/script.py")));
          assert(script.equals(await read(workspace,info.directory + "/recipe/script.py")));
          for (const p of a.inputs ?? []) assert((await read(workspace,p)).equals(await read(jobDir,"inputs/" + p)));
          const sha = createHash("sha256").update(script).digest("hex");
          assert.deepEqual(save.receipt.details.projectFileVersion, { path:save.path, sha256:sha });
          const proposal = { type:"message", message:{role:"assistant",content:[save.call,c]} };
          const prior = { ...returned, details:{ ...returned.details, executedScriptSha256:sha } };
          const reusable = (result, receipts) => runTool.canReuseResult(result,c.id,a,undefined,undefined,{
            sessionManager:{ getBranch:() => [proposal,...receipts.map(message => ({ type:"message",message }))] }
          });
          assert.equal(await reusable(prior,[save.receipt]),true);
          assert.equal(await reusable(prior,[]),false);
          assert.equal(await reusable(prior,[{...save.receipt,isError:true}]),false);
          assert.equal(await reusable(returned,[save.receipt]),false);
          pairs.push({ saveStep: save.step, runStep: step, inputs: a.inputs?.length ?? 0, scriptBytes: script.length, receipt:save.receipt });
        }
        save = undefined;
        if (calls.length === 1 && ["write","edit"].includes(c.name) && a.path?.endsWith(".py")) {
          const steps = grouped.get(step) ?? [step];
          const changes = steps.map(n => assistants[n-1].content.find(b => b.type === "toolCall"));
          const args = steps.length === 1 ? a : { path: a.path, edits: changes.map(b => ({ oldText:b.arguments.oldText, newText:b.arguments.newText })) };
          const expected = c.name === "write" ? "Project file saved." : "Project file edited.";
          if (changes.every(b => {
            const r = output.get(b.id);
            return r?.toolName === b.name && !r.isError && r.content.length === 1 && r.content[0].text === expected;
          })) {
            const actual = await fileTools.get(c.name).execute(c.id, args, undefined, undefined, {});
            const historical = output.get(c.id);
            assert.deepEqual(actual.content,historical.content);
            save = { step, path:a.path, known:known.slice(), call:{ ...c,arguments:args }, receipt:{ ...historical,...actual } };
          }
        }
      }
    }
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === "text") known.push(block.text);
      else if (block.type === "toolCall") known.push(JSON.stringify(block.arguments));
    }
  }
  return pairs;
}

function stagePath(args) {
  return args.stage === "custom" ? args.scriptPath : args.configPath;
}

function retainedRunId(receipt) {
  const text = receipt?.message.content[0]?.text;
  const candidate = receipt?.message.details?.blender?.runId ??
    /^Blender run ([a-f\d-]+) is retained\./i.exec(text ?? "")?.[1];
  if (typeof candidate === "string" && uuid.test(candidate)) return candidate;
}

async function stageFile(workspace, relative, bytes) {
  const file = await localAgentPath(workspace, relative, true);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
}

/** Replay save effects while replacing the actual Blender worker at the normal ToolDefinition boundary. */
export async function verifyInlineBlenderPairs({
  branch, sessionFile, scratch, firstStep = 1,
  bundledScriptsDirectory = path.resolve("plugins/blender/skills/blender-assets/scripts"),
}) {
  const session = await realpath(sessionFile);
  const projectDir = path.dirname(path.dirname(session));
  const jobs = await realpath(path.join(projectDir, "../../blender-jobs", path.basename(projectDir)));
  const retainedJobs = new BlenderRunner(jobs);
  const root = await mkdtemp(path.join(await realpath(scratch), "inline-blender-replay-"));
  const history = path.join(root, "history");
  const fileTools = new Map(createLocalAgentFileTools(history).map(tool => [tool.name, tool]));
  const recorded = new Map(), receipts = new Map(), saves = new Map(), candidates = [];
  let previous, step = 0;
  try {
    await mkdir(history);
    for (const entry of branch) {
      const message = entry.message;
      if (message?.role === "user" || message?.role === "system" ||
        ["compaction", "branch_summary", "custom_message", "model_change", "thinking_level_change"].includes(entry.type)) {
        previous = undefined;
      }
      if (message?.role === "assistant") {
        step++;
        const calls = message.content.filter(block => block.type === "toolCall");
        for (const call of calls) {
          assert(!recorded.has(call.id), "Call identity is ambiguous in the recorded branch");
          recorded.set(call.id, call);
        }
        const [run] = calls, save = previous?.call;
        if (step >= firstStep && message.content.length === 1 && run?.name === "run_blender" &&
          save && ["write", "edit"].includes(save.name) && typeof save.arguments.path === "string" &&
          (run.arguments.reviewPresentation ?? "internal") === "internal" && !run.arguments.save &&
          save.arguments.path === stagePath(run.arguments)) {
          candidates.push({ saveStep: previous.step, saveEntry: previous.entry, save,
            runStep: step, runEntry: entry, run });
        }
        previous = calls.length === 1 ? { step, entry, call: calls[0] } : undefined;
      }
      if (message?.role !== "toolResult") continue;
      assert(!receipts.has(message.toolCallId), "A saved call has multiple receipts in the recorded branch");
      receipts.set(message.toolCallId, entry);
      const call = recorded.get(message.toolCallId), args = call?.arguments;
      if (!call || call.name !== message.toolName || message.isError ||
        !["write", "edit"].includes(call.name) || !/\.(py|json)$/.test(args?.path)) continue;
      let file;
      try {
        file = await localAgentPath(history, args.path, true);
        const before = await read(history, args.path).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        const applied = await fileTools.get(call.name).execute(call.id, args, undefined, undefined, {});
        assert.deepEqual(applied.content, message.content);
        const version = applied.details.projectFileVersion;
        if (message.details?.projectFileVersion) assert.deepEqual(version, message.details.projectFileVersion);
        const after = await read(history, args.path);
        assert.equal(sha256(after), version.sha256);
        saves.set(call.id, { before, after, version });
      } catch {
        // A later complete write can restore the missing baseline. Unknown versions never qualify.
        if (file) await rm(file, { force: true });
      }
    }

    const pairs = [], skipped = [];
    for (const candidate of candidates) {
      const { save, run, saveStep, runStep, saveEntry, runEntry } = candidate;
      const ids = { saveStep, runStep, saveEntryId: saveEntry.id, runEntryId: runEntry.id,
        saveCallId: save.id, runCallId: run.id };
      const savedFile = saves.get(save.id), runReceipt = receipts.get(run.id);
      const runId = retainedRunId(runReceipt);
      if (!savedFile || !runId || runReceipt.message.toolName !== run.name) {
        skipped.push({ ...ids, reason: !savedFile ? "unverified-save" : "unverified-run" });
        continue;
      }
      const workspace = path.join(root, String(runStep)), job = path.join(jobs, runId);
      let reason = "unverified-invocation";
      try {
        const recordedInvocation = JSON.parse(await read(job, "invocation.json"));
        assert.equal(recordedInvocation.callId, run.id);
        assert.equal(await realpath(recordedInvocation.sessionFile), session);
        assert.deepEqual(recordedInvocation.request, run.arguments);
        const { status: historicalRunStatus } = await retainedJobs.inspectJob(runId);
        assert(historicalRunStatus === "completed" || historicalRunStatus === "failed");
        assert(historicalRunStatus !== "failed" || runReceipt.message.isError);
        const relative = stagePath(run.arguments);
        const custom = run.arguments.stage === "custom";
        reason = "retained-recipe-mismatch";
        assert(savedFile.after.equals(await read(job, custom ? "scripts/script.py" : "inputs/" + relative)));
        const { content, edits, oldText, newText, releaseReviewedImages } = save.arguments;
        const mergedArguments = { ...run.arguments,
          save: save.name === "write" ? { content } : { edits: edits ?? [{ oldText, newText }] },
          ...(releaseReviewedImages ? { releaseReviewedImages: true } : {}),
        };
        assert.equal(projectFileVersionPath(relative), savedFile.version.path);
        reason = "inline-replay-mismatch";
        await mkdir(workspace);
        if (savedFile.before) await stageFile(workspace, relative, savedFile.before);
        // The worker and dependency processing are deliberately outside this experiment.
        for (const file of new Set([run.arguments.configPath, run.arguments.sourcePath, ...(run.arguments.inputs ?? [])]))
          if (file && file !== relative) await stageFile(workspace, file, "");
        let invoke;
        const runner = { run: async options => {
          assert.equal(invoke, undefined, "An inline save must attempt at most one worker");
          invoke = options;
          throw new BlenderRunError("Offline replay captured the verified recipe");
        } };
        const resolveSourceAsset = run.arguments.sourceAssetId ? async assetId => {
          const source = JSON.parse(await read(job, "source-original.json"));
          assert.equal(assetId, source.assetId);
          return { ...source, extension: source.format, tripo: run.arguments.brief?.route === "tripo", bytes: Buffer.alloc(0) };
        } : undefined;
        const tool = new BlenderWorkflow({ workspace, privateRoot: path.join(root, "no-worker-jobs"),
          bundledScriptsDirectory, runner, mutate: action => action(), resolveSourceAsset })
          .tools().find(tool => tool.name === "run_blender");
        const executed = await tool.execute(run.id, mergedArguments, undefined, undefined, {});
        assert.equal(executed.details?.blender?.status, "saved-not-run");
        assert.deepEqual(executed.details.projectFileVersion, savedFile.version);
        assert((await read(workspace, relative)).equals(savedFile.after));
        if (custom) assert(Buffer.from(invoke.bundledScripts.files["script.py"]).equals(savedFile.after));
        else assert.equal(invoke.expectedInputSha256[relative], savedFile.version.sha256);
        const pair = { ...ids, saveResultId: receipts.get(save.id).id, runResultId: runReceipt.id,
          retainedRunId: runId, savedVersion: savedFile.version,
          historicalRunStatus, historicalError: runReceipt.message.isError, scriptBytes: savedFile.after.length };
        // The projection needs the recipe text in memory. Keep it out of reports.
        Object.defineProperty(pair, "mergedArguments", { value: mergedArguments });
        pairs.push(pair);
      } catch {
        skipped.push({ ...ids, reason });
      }
    }
    return { pairs, skipped };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
