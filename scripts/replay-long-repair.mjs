// Replay a private Pi session against its own HTTP log and exported Kunpo billing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { buildSessionProjection } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { convertResponsesMessages, convertResponsesTools } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { resolveTranscriptTools } from "../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { projectPastDesignContexts } from "../src/daemon/agent.ts";
import { localAgentPath } from "../src/daemon/agent-local-files.ts";
import { normalizeAssistantMessage } from "../src/daemon/assistant-thinking.ts";
import { BlenderWorkflow } from "../src/daemon/blender-tools.ts";
import { ConversationImageStore } from "../src/daemon/conversation-images.ts";
import { compactProjectToolDeclaration } from "../src/daemon/pi-tool-search.ts";
import { RASTER_BYTES } from "../src/daemon/raster-policy.ts";
import { prepareSessionImageDisplay } from "../src/daemon/retained-image-display.ts";
import { readSafeProjectFile } from "../src/daemon/safe-project-file.ts";
import { inlineImageScope, SessionImages, visualWorkingSet, wireImages } from "../src/daemon/session-images.ts";
import { projectDeliveredFileHistory } from "../src/daemon/session-tool-history.ts";
import { hasTurnaroundAssessment } from "../src/daemon/turnaround-inspection.ts";
import { KUNPO_ASTRA_MODEL_ID, KUNPO_BASE_URL } from "../src/shared/kunpo-models.ts";
import { verifyInlineBlenderPairs } from "./replay-blender-pairs.mjs";
import { createReplayPrefixHistory, fitReplayTokenWeights, priceRecordedReplay } from "./replay-cache-audit.mjs";

const { values: options } = parseArgs({ options: {
  session: { type: "string" }, requests: { type: "string" }, billing: { type: "string" },
  output: { type: "string" }, "billing-offset": { type: "string", default: "+08:00" },
  rates: { type: "string", default: "5,0.4,10,40" }, "direct-model-report": { type: "boolean" }, help: { type: "boolean" },
} });
if (options.help) {
  console.log("node --import tsx scripts/replay-long-repair.mjs --session FILE --requests DAEMON_LOG --billing CSV [--output NEW_JSON] [--billing-offset +08:00] [--rates ordinary,read,write,output] [--direct-model-report]");
  process.exit(0);
}
for (const key of ["session", "requests", "billing"]) assert(options[key], `Missing --${key}`);
const rate = options.rates.split(",").map(Number);
assert(rate.length === 4 && rate.every(n => Number.isFinite(n) && n >= 0), "Expected four nonnegative rates per million tokens");
assert(/^[+-]\d\d:\d\d$/.test(options["billing-offset"]), "Pass a UTC offset for the billing CSV");
globalThis.fetch = () => { throw new Error("Offline replay does not allow HTTP"); };

const model = {
  id: KUNPO_ASTRA_MODEL_ID, provider: "kunpo", api: "openai-responses", baseUrl: KUNPO_BASE_URL,
  reasoning: true, input: ["text", "image"], compat: { supportsStrictMode: true },
};
const toolOptions = { supportsStrictMode: true, supportsOpenAIGrammarTools: false };
const callsIn = entry => entry.message?.role === "assistant" ? entry.message.content.filter(block => block.type === "toolCall") : [];
const isAstraReply = ({ message: m }) => m?.role === "assistant" && m.provider === model.provider && m.model === model.id && m.api === model.api;
const picturesIn = entry => ["user", "toolResult"].includes(entry.message?.role) && Array.isArray(entry.message.content)
  ? entry.message.content.filter(block => block.type === "image") : [];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const hash = data => createHash("sha256").update(data).digest("hex");
const imageIdentity = image => [image.id, image.mime, hash(image.data)];
const sum = values => values.reduce((a, b) => a + b, 0);
const add = (a, b) => a.map((n, i) => n + b[i]);
const recordTime = entry => Date.parse(entry.timestamp);

async function readBranch(file) {
  const source = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const entries = new Map(), lineById = new Map();
  let header, leaf, line = 0;
  for await (const text of source) {
    line++;
    if (!text.trim()) continue;
    const entry = JSON.parse(text);
    if (entry.type === "session") header = entry;
    else if (entry.id) {
      assert(!entries.has(entry.id), "Duplicate session entry ID");
      entries.set(entry.id, entry); lineById.set(entry.id, line); leaf = entry;
    }
  }
  assert(header?.id && leaf, "Missing session header or branch");
  const branch = [];
  for (let entry = leaf; entry; entry = entries.get(entry.parentId)) {
    branch.push(entry);
    assert(branch.length <= entries.size && (!entry.parentId || entries.has(entry.parentId)), "Incomplete or circular session branch");
  }
  return { sessionId: header.id, branch: branch.reverse(), lineById };
}

async function matchBilling(branch, sessionId) {
  const csv = JSON.parse(execFileSync("python3", ["-c", [
    "import csv, json, sys",
    "with open(sys.argv[1],encoding='utf-8-sig',newline='') as f:",
    " print(json.dumps([[r[k] for k in ('时间','输入 Token','缓存读取','缓存写入','输出 Token','费用')] for r in csv.DictReader(f) if r['模型']==sys.argv[2] and r['类型']=='消耗']))",
  ].join("\n"), options.billing, model.id], { encoding: "utf8", maxBuffer: 20 * 1024 ** 2 }));
  const requests = (await readFile(options.requests, "utf8")).split("\n").flatMap(line => {
    if (!line.includes('"Provider request"')) return [];
    try { return [JSON.parse(line.slice(line.indexOf("{")))]; } catch { return []; }
  }).filter(r => r.conversationId === sessionId && r.event === "finished" && r.protocol === model.api &&
    r.outcome === "completed" && Number.isSafeInteger(r.requestBytes));
  const billing = new Map(), seen = new Set(), matchedRequests = new Set();
  let turn, step = 0;
  for (const entry of branch) {
    const m = entry.message;
    if (m?.role === "user") turn = entry;
    if (!isAstraReply(entry)) continue;
    step++;
    const u = m.usage, total = u.input + u.cacheRead + u.cacheWrite;
    if (!total) continue;
    const time = recordTime(entry);
    const stamp = csv.flatMap(([local, input, read, write, output, cost], i) => {
      const when = Date.parse(local.replace(" ", "T") + options["billing-offset"]);
      return Math.abs(time - when) <= 90_000 && [input, read, write, output].map(Number)
        .every((n, j) => n === [total, u.cacheRead, u.cacheWrite, u.output][j])
        ? [{ i, local, when, charge: Number(cost.replace(/^\$/, "")) }] : [];
    });
    if (!stamp.length) continue;
    assert(stamp.length === 1 && !seen.has(stamp[0].i), "Ambiguous billing match");
    const [{ i, local, charge }] = stamp;
    assert(Number.isFinite(charge) && turn, "Incomplete matched usage");
    const http = requests.filter(r => Math.abs(time - r.time) <= 2000 && Number.isFinite(r.totalMs))
      .sort((a, b) => Math.abs(time - a.time) - Math.abs(time - b.time))[0];
    assert(http && !matchedRequests.has(http), "Missing or ambiguous HTTP measurement for a billed reply");
    seen.add(i);
    matchedRequests.add(http);
    billing.set(entry.id, { step, time, local, turn: turn.id, wireBytes: http.requestBytes,
      bill: { total, plain: u.input, read: u.cacheRead, write: u.cacheWrite, output: u.output, charge } });
  }
  assert(billing.size && seen.size === csv.length, "The Astra bill and the active session branch do not match one-to-one");
  return billing;
}

async function verifyTurnarounds(branch, sessionFile) {
  const data = path.resolve(path.dirname(sessionFile), "../../..");
  const workspace = path.resolve(path.dirname(sessionFile), "../workspace");
  const store = new ConversationImageStore(path.join(data, "cache", "conversation-images"));
  const gates = [];
  let inspection, inspectArguments, submitted;
  for (const [index, entry] of branch.entries()) {
    for (const call of callsIn(entry)) {
      if (call.name === "inspect_3d_views") inspectArguments = call.arguments;
      if (["generate_3d_from_views", "generate_canvas_media"].includes(call.name)) submitted = call.id;
    }
    if (entry.message?.toolName === "inspect_3d_views" && !entry.message.isError) inspection = entry;
    const item = entry.customType === "ohmygame-approval" ? entry.data.item : undefined;
    const review = item?.request.turnaroundReview;
    if (!review || item.status !== "completed" || item.decision !== "allow") continue;
    assert(inspection && inspectArguments && submitted, "Missing inspection or submission for an approved turnaround");
    assert(hasTurnaroundAssessment(branch.slice(0, index), inspection.message.toolCallId, submitted),
      "Missing visual assessment before the archived approval");
    assert.deepEqual(review.views.map(view => view.angle), ["front", "left", "back"]);
    assert.equal(review.original?.path, inspectArguments.originalPath);
    assert.deepEqual(review.views.map(view => view.path), inspectArguments.imagePaths);
    const verifiedPixels = picturesIn(inspection);
    const assets = [review.original, ...review.views];
    assert.equal(verifiedPixels.length, assets.length, "Turnaround is missing approved pictures");
    for (const [i, asset] of assets.entries()) {
      const match = /^\/projects\/([a-f0-9-]{36})\/conversation-images\/([a-f0-9]{64})\.(png|jpg|webp)$/.exec(asset.url);
      assert(match, "Invalid saved review image binding");
      const file = await store.read(match[1], `${match[2]}.${match[3]}`) ?? {
        data: await readSafeProjectFile(workspace, await localAgentPath(workspace, asset.path), RASTER_BYTES),
        mediaType: match[3] === "jpg" ? "image/jpeg" : `image/${match[3]}`,
      };
      assert(hash(file.data.toString("base64")) === match[2], "Missing or altered approved review snapshot");
      const display = await prepareSessionImageDisplay(file.data, file.mediaType);
      assert(display.mimeType === verifiedPixels[i].mimeType && display.bytes.toString("base64") === verifiedPixels[i].data,
        "Approved snapshot diverges from the order or pixels inspected by the Agent");
    }
    const receipt = branch.find(e => e.message?.toolCallId === submitted);
    gates.push({ inspectionId: inspection.id, approvalTime: recordTime(entry), count: assets.length,
      submitted: receipt?.message?.details?.canvasGeneration?.toolId === "image-to-3d" &&
        receipt.message.details.canvasGeneration.status === "succeeded" });
  }
  assert.equal(gates.length, 2, "Expected both complete turnaround reviews in this regression");
  assert(gates.at(-1).submitted, "The approved production handoff is missing");
  return gates;
}

function mergeInlinePairs(branch, pairs) {
  const edits = new Map(), removed = new Set();
  for (const pair of pairs) {
    removed.add(pair.saveResultId); removed.add(pair.runEntryId);
    edits.set(pair.saveEntryId, entry => ({ ...entry.message, content: entry.message.content.map(block =>
      block.id === pair.saveCallId ? { ...block, name: "run_blender", id: pair.runCallId, arguments: pair.mergedArguments } : block) }));
    edits.set(pair.runResultId, entry => ({ ...entry.message, details: {
      ...entry.message.details, projectFileVersion: pair.savedVersion,
    } }));
  }
  return branch.map(entry => {
    if (removed.has(entry.id) || entry.type === "context_edit" && (removed.has(entry.targetId) || edits.has(entry.targetId))) {
      const { id, parentId, timestamp } = entry;
      return { id, parentId, timestamp, type: "custom", customType: "offline-folded-save" };
    }
    const edit = edits.get(entry.id);
    return edit ? { ...entry, message: edit(entry) } : entry;
  });
}

async function projectDirectModelReport(branch, turnId, inspectedSource, workspace, {
  answerModelTriangleQuestion, canUseLocalModelReport, modelReportMessage,
}) {
  const userIndex = branch.findIndex(entry => entry.id === turnId);
  const user = branch[userIndex];
  assert(user?.message?.role === "user", "Missing archived face-count question");
  const earlier = branch.slice(0, userIndex);
  const prompt = earlier.findLast(entry => entry.customType === "ohmygame-user-prompt")?.data;
  assert(typeof prompt?.prompt === "string" && !prompt.mentions?.length && !prompt.references?.length &&
    !prompt.attachments?.length && !picturesIn(user).length, "The face-count question needs additional context");
  const content = user.message.content;
  const wirePrompt = typeof content === "string" ? content :
    content.length === 1 && content[0].type === "text" ? content[0].text : undefined;
  assert(wirePrompt && hash(wirePrompt) === prompt.wirePromptHash, "The visible question is not bound to its archived context");
  const answer = answerModelTriangleQuestion(prompt.prompt, earlier);
  assert(answer?.target === "source" && answer.triangles === inspectedSource.models[0].model.triangles &&
    answer.runId === inspectedSource.runId, "The local answer does not match the original model's measurements");
  assert(await canUseLocalModelReport(wirePrompt, answer, workspace), "The archived context or report does not qualify for a local answer");
  const nextUser = branch.findIndex((entry, i) => i > userIndex && entry.message?.role === "user");
  assert(nextUser > userIndex);
  const turn = branch.slice(userIndex + 1, nextUser);
  const replies = turn.filter(isAstraReply), results = turn.filter(entry => entry.message?.role === "toolResult");
  assert.equal(replies.length, 2, "Expected two original model requests on the face-count question");
  assert.equal(results.length, 1, "Expected one local file read in the original answer");
  const [proposal, final] = replies, [result] = results;
  const [call] = callsIn(proposal);
  assert(call?.name === "read" && callsIn(proposal).length === 1 && call.arguments.path === answer.reportPath &&
    result.message.toolCallId === call.id && !result.message.isError && !picturesIn(result).length &&
    final.message.stopReason === "stop", "The original response includes work outside the direct report answer");
  const removed = new Set([proposal.id, result.id]);
  const local = branch.map(entry => {
    if (entry.id === final.id) return { ...entry, timestamp: user.timestamp,
      message: modelReportMessage(answer.text, user.message.timestamp) };
    if (removed.has(entry.id) || entry.type === "context_edit" && (removed.has(entry.targetId) || entry.targetId === final.id)) {
      const { id, parentId, timestamp } = entry;
      return { id, parentId, timestamp, type: "custom", customType: "offline-direct-model-report" };
    }
    return entry;
  });
  return { branch: local, requestIds: replies.map(entry => entry.id), answer };
}

const binaryDimensions = new Map();
async function measure(item, pictures, serialized) {
  if (item.type === "reasoning") return [0, 0, Buffer.byteLength(serialized), 0, 0];
  let patches = 0;
  for (const picture of pictures) {
    if (!binaryDimensions.has(picture.data)) {
      const { width, height } = await sharp(Buffer.from(picture.data, "base64")).metadata();
      assert(width && height, "A replay image failed to decode");
      binaryDimensions.set(picture.data, Math.ceil(width / 32) * Math.ceil(height / 32));
    }
    patches += binaryDimensions.get(picture.data);
  }
  return [Buffer.byteLength(serialized) - sum(pictures.map(p => p.data.length)), 0, 0, pictures.length, patches];
}

async function replay(branch, timeline, cache, { historical = false, priorRelease = false, newSchema, sourceTriangles, localReportText } = {}) {
  const trace = new Map(), calls = new Map(), history = [], notices = [], prior = createReplayPrefixHistory();
  const getBranch = () => [...history, ...notices];
  const images = new SessionImages({ getBranch, appendCustomEntry(customType, data) {
    notices.push({ type: "custom", customType, data });
  } }, cache);
  const designPrompts = new WeakMap();
  const scope = inlineImageScope(model);
  let fresh = [], previousItems, lastEvidence = [];
  for (const entry of branch) {
    const record = timeline.get(entry.id);
    const observed = picturesIn(entry);
    if (observed.length) fresh.push(...observed.map((_, i) => ({
      id: `${entry.id}:${i}`, source: entry.message.toolName ?? "user",
    })));
    if (entry.message?.role === "toolResult") lastEvidence.push(entry.message.toolName);
    if (record && entry.message?.role === "assistant") {
      const { entries, messages } = buildSessionProjection(history, entry.parentId);
      const projected = projectDeliveredFileHistory(messages, entries, !historical, !priorRelease).map(message =>
        message.role === "system" && message.toolsAdded
          ? { ...message, toolsAdded: message.toolsAdded.map(compactProjectToolDeclaration) }
          : message);
      const normalized = convertToLlm(projectPastDesignContexts(projected, history, designPrompts))
        .map(m => m.role === "assistant" ? normalizeAssistantMessage(m) : m);
      const tools = resolveTranscriptTools(normalized, false).requestTools.map(tool =>
        newSchema && tool.name === "run_blender" ? newSchema : tool);
      const context = { messages: normalized, tools };
      const prepared = historical
        ? await images.annotate(context, true, visualWorkingSet(normalized, getBranch(), false))
        : await images.prepare(context, model);
      const input = convertResponsesMessages(model, prepared, new Set(["openai", "openai-codex", "opencode"]), { toolOptions });
      const body = { input, tools: convertResponsesTools(tools, toolOptions) };
      images.budget(body, scope);
      const outgoing = images.withPreviousToolImages(body, scope, !historical && !priorRelease);
      outgoing.commit();
      const payload = outgoing.payload;
      const schemas = JSON.stringify(payload.tools), items = payload.input.map(item => JSON.stringify(item));
      const pictures = payload.input.map(item => wireImages([item]));
      const itemFeatures = await Promise.all(payload.input.map((item, i) => measure(item, pictures[i], items[i])));
      const features = itemFeatures.reduce(add, [0, Buffer.byteLength(schemas), 0, 0, 0]);
      const matches = prior.observe({ step: record.step, time: record.time, schemas, items, itemFeatures });
      const visual = wireImages(payload);
      const visibleIds = new Set(fresh.map(image => image.id));
      const freshPixels = visual.filter(image => visibleIds.has(image.id)).map(imageIdentity);
      assert.equal(freshPixels.length, fresh.length, `Missing newly observed evidence at request ${record.step}`);
      const meta = payload.input.map((item, i) => ({
        type: item.type ?? item.role, tool: calls.get(item.call_id), images: pictures[i].length,
      }));
      const index = matches.adjacent?.items ?? 0;
      const before = previousItems?.[index], after = meta[index];
      trace.set(entry.id, { features, matches, freshPixels, visualScope: fresh.map(p => p.source),
        bytes: bytes(payload), imageBytes: sum(visual.map(image => image.data.length)), nextTools: callsIn(entry).map(call => call.name),
        lastEvidence: [...new Set(lastEvidence)], localReportVisible: localReportText === undefined ? undefined : payload.input.some(item =>
          item.role === "assistant" && Array.isArray(item.content) &&
          item.content.some(part => part.type === "output_text" && part.text === localReportText)),
        firstChange: matches.adjacent?.completePrior
          ? undefined : { before, after }, trianglesVisible: sourceTriangles === undefined ? undefined : payload.input.some(item => {
            if (item.type !== "function_call_output" || calls.get(item.call_id) !== "run_blender" || typeof item.output !== "string")
              return false;
            try {
              const result = JSON.parse(item.output);
              return result.stage === "inspect" && result.models?.some(({ model }) => model.triangles === sourceTriangles);
            } catch { return false; }
          }),
      });
      previousItems = meta;
    }
    for (const call of callsIn(entry)) {
      calls.set(call.id, call.name); calls.set(call.id.split("|")[0], call.name);
    }
    if (entry.message?.role === "assistant") { fresh = []; lastEvidence = []; }
    history.push(entry);
  }
  return trace;
}

const recorded = await readBranch(options.session);
const { sessionId, lineById } = recorded;
const billing = await matchBilling(recorded.branch, sessionId);
const branch = recorded.branch.slice(0, recorded.branch.findLastIndex(entry => billing.has(entry.id)) + 1);
const timeline = new Map(branch.filter(isAstraReply).map((entry, i) => [entry.id, { step: i + 1, time: recordTime(entry) }]));
const approvals = await verifyTurnarounds(branch, options.session);
const start = approvals.at(-1).approvalTime;
const post = [...billing].filter(([, row]) => row.time > start);
assert(post.length, "Missing work after turnaround approval");
const repairTurn = post.at(-1)[1].turn;
const repairUser = branch.find(entry => entry.id === repairTurn);
assert(picturesIn(repairUser).length, "Expected the last billed turn to begin with the user's visual feedback");
const firstAssistant = branch.filter(e => e.message?.role === "assistant").findIndex(e => e.id === post[0][0]) + 1;
const generatedSource = branch.find(entry => recordTime(entry) > start && entry.message?.details?.canvasGeneration?.toolId === "image-to-3d")
  ?.message.details.sourceAssetId;
const inspectedSource = branch.map(entry => entry.message?.details?.blender).find(result =>
  result?.stage === "inspect" && result.sourceOriginal?.assetId === generatedSource);
const sourceTriangles = inspectedSource?.models[0]?.model.triangles;
assert(generatedSource && Number.isSafeInteger(sourceTriangles) && sourceTriangles > 0, "Missing Tripo source inspection");
const scratch = await mkdtemp(path.join(tmpdir(), "ohmygame-long-repair-"));
let report;
try {
  const { pairs, skipped } = await verifyInlineBlenderPairs({ branch, sessionFile: options.session, scratch, firstStep: firstAssistant });
  assert(pairs.length && !skipped.length, "An observed save/run pair could not be verified");
  const imagesCache = path.join(scratch, "image-previews");
  const baseline = await replay(branch, timeline, imagesCache, { historical: true });
  const imageFix = await replay(branch, timeline, imagesCache);
  const runTool = new BlenderWorkflow({ workspace: scratch }).tools().find(tool => tool.name === "run_blender");
  const merged = mergeInlinePairs(branch, pairs);
  const replayOptions = { newSchema: compactProjectToolDeclaration(runTool), sourceTriangles };
  const previous = await replay(merged, timeline, imagesCache, { ...replayOptions, priorRelease: true });
  const combined = await replay(merged, timeline, imagesCache, replayOptions);
  assert.equal(baseline.size, timeline.size);
  assert.equal(combined.size, baseline.size - pairs.length);

  for (const [id, before] of baseline) {
    for (const after of [imageFix.get(id), previous.get(id), combined.get(id)]) {
      assert.deepEqual(after?.freshPixels ?? [], before.freshPixels, `Visual evidence changed at request ${timeline.get(id).step}`);
    }
  }
  for (const { inspectionId, count } of approvals) {
    const evidence = [...combined.values()].flatMap(row => row.freshPixels).filter(([imageId]) => imageId.startsWith(inspectionId + ":"));
    assert.equal(evidence.length, count, "Combined replay omitted an approved comparison");
    assert(evidence.every(([id], i) => id === `${inspectionId}:${i}`), "Combined replay reordered an approved comparison");
  }
  const reintroduced = row => row.firstChange?.before?.type === "user" && row.firstChange.after?.type === "user" &&
    row.firstChange.after.images > row.firstChange.before.images;
  const repair = post.filter(([, row]) => row.turn === repairTurn);
  const returning = repair.filter(([id]) => reintroduced(baseline.get(id)));
  assert(returning.length, "The historical control failed to reproduce the original feedback-image regression");
  assert(!repair.some(([id]) => reintroduced(imageFix.get(id))), "The feedback image moved back into the earlier user message");
  const regained = returning.filter(([id]) => imageFix.get(id).matches.adjacent?.completePrior).length;
  assert(regained, "The fixed image replay preserved no complete previously broken request prefixes");
  const initialTurn = post[0][1].turn;
  const firstFollowup = post.find(([, row]) => row.turn !== initialTurn);
  assert(firstFollowup && combined.get(firstFollowup[0])?.trianglesVisible, "The original face count is missing from the delivery handoff");
  assert(combined.get(firstFollowup[0]).bytes < previous.get(firstFollowup[0]).bytes, "Earlier production history was carried into the follow-up");

  const retiring = repair.filter(([id, row]) => {
    const change = previous.get(id)?.firstChange;
    return row.bill.read < row.bill.total / 10 && row.bill.write >= 100_000 &&
      change?.before?.type === "function_call_output" && change.after?.type === "function_call_output" &&
      change.after.images < change.before.images;
  });
  assert(retiring.length > 0, "The previous release did not reproduce the retired render regression");
  for (const [id, row] of retiring)
    assert(combined.get(id)?.matches.adjacent?.completePrior, `Retired renders changed the complete request prefix at ${row.local}`);

  const comparison = [...billing].map(([id, row]) => ({ ...row, historical: baseline.get(id), candidate: combined.get(id) ?? null }));
  const previousComparison = [...billing].map(([id, row]) => ({ ...row, historical: baseline.get(id), candidate: previous.get(id) ?? null }));
  // HTTP adds the same scalar envelope to each recorded input/tools body.
  const envelope = new Set(comparison.map(({ wireBytes, historical }) => wireBytes - historical.bytes));
  assert(envelope.size === 1 && [...envelope][0] >= 0, "Historical replay disagrees with the recorded HTTP bodies");
  const weights = fitReplayTokenWeights(comparison.map(row => row.historical.features), comparison.map(row => row.bill.total));
  const scopes = records => ({
    afterApproval: priceRecordedReplay({ comparison: records.filter(row => row.time > start), calibrationRows: records, weights, rate }),
    longRepair: priceRecordedReplay({ comparison: records.filter(row => row.turn === repairTurn), calibrationRows: records, weights, rate }),
  });
  const priced = scopes(comparison), priorPrices = scopes(previousComparison);
  const { longRepair } = priced;
  const byStep = new Map(comparison.map(row => [row.step, row]));
  const followupStep = firstFollowup[1].step;
  const previousFollowup = priorPrices.afterApproval.rows.find(row => row.step === followupStep);
  const fixedFollowup = priced.afterApproval.rows.find(row => row.step === followupStep);
  let directModelReport;
  if (options["direct-model-report"]) {
    const { answerModelTriangleQuestion } = await import("../src/daemon/model-report-answer.ts");
    const { canUseLocalModelReport, modelReportMessage } = await import("../src/daemon/agent.ts");
    const workspace = path.resolve(path.dirname(options.session), "../workspace");
    const local = await projectDirectModelReport(merged, firstFollowup[1].turn, inspectedSource, workspace,
      { answerModelTriangleQuestion, canUseLocalModelReport, modelReportMessage });
    const localIds = new Set(local.requestIds);
    const localTimeline = new Map([...timeline].filter(([id]) => !localIds.has(id)));
    const direct = await replay(local.branch, localTimeline, imagesCache, { ...replayOptions, localReportText: local.answer.text });
    assert.equal(direct.size, combined.size - localIds.size, "A direct report answer changed more than its two original model requests");
    for (const [id, row] of baseline)
      assert.deepEqual(direct.get(id)?.freshPixels ?? [], row.freshPixels,
        `Direct report answer changed fresh visual evidence at request ${timeline.get(id).step}`);
    for (const [id, row] of retiring)
      assert(direct.get(id)?.matches.adjacent?.completePrior, `Direct report answer broke a retired-render prefix at ${row.local}`);
    const lastLocalStep = Math.max(...local.requestIds.map(id => timeline.get(id).step));
    const nextRequest = [...localTimeline].find(([id, row]) => row.step > lastLocalStep && direct.has(id));
    assert(nextRequest && direct.get(nextRequest[0]).localReportVisible, "The local answer is missing from the next model request");
    const directComparison = [...billing].map(([id, row]) => ({
      ...row, historical: baseline.get(id), candidate: direct.get(id) ?? null, answeredLocally: localIds.has(id),
    }));
    const directPrices = scopes(directComparison);
    const removed = directPrices.afterApproval.rows.filter(row => row.answeredLocally);
    assert.equal(removed.length, localIds.size, "A removed local-answer request is missing from the bill");
    for (const { scenarios } of removed) for (const estimate of Object.values(scenarios))
      assert.deepEqual(estimate, { total: 0, plain: 0, read: 0, write: 0, output: 0, usd: 0 }, "A direct local answer retained a provider charge");
    directModelReport = {
      triangles: local.answer.triangles, target: local.answer.target,
      removedRequests: removed.map(({ step, actual }) => ({ step, at: byStep.get(step).local, actual })),
      historicalUsdForRemovedRequests: Number(sum(removed.map(row => row.actual.charge)).toFixed(6)),
      followingModelRequest: nextRequest[1].step,
      preservedRetiredRenderPrefixes: retiring.length,
      freshImagesVerified: sum([...direct.values()].map(row => row.freshPixels.length)),
      modelRequestsReplayed: direct.size,
      scopes: Object.fromEntries(Object.entries(directPrices).map(([scope, value]) => [scope, value.scenarios])),
    };
  }
  // Small invariant report only. The transcript, image hashes and recipe arguments never go to stdout or JSON.
  report = {
    replayedRequests: baseline.size, billingMatched: billing.size,
    approvalReplay: approvals.map(({ count, submitted }) => ({ count, submitted })),
    inspectionsVerified: branch.filter(entry => entry.message?.toolName === "inspect_3d_views" && picturesIn(entry).length).length,
    freshImagesVerified: sum([...baseline.values()].map(row => row.freshPixels.length)),
    postApprovalImagesVerified: sum(post.map(([id]) => baseline.get(id).freshPixels.length)),
    savedRunPairs: { verified: pairs.length, historicalErrors: pairs.filter(pair => pair.historicalError).length },
    regression: { historicFeedbackRewrites: returning.length, fixedFeedbackRewrites: 0, regainedAdjacentPrefixes: regained,
      historicRetiredRenderRewrites: retiring.length, fixedRetiredRenderRewrites: 0,
      simpleFollowup: { at: firstFollowup[1].local, beforeBytes: baseline.get(firstFollowup[0]).bytes,
        priorBytes: previous.get(firstFollowup[0]).bytes,
        afterBytes: combined.get(firstFollowup[0]).bytes, sourceTriangles, actualTokens: fixedFollowup.actual.write,
        priorEstimatedTokens: previousFollowup.scenarios.recentExactPrefix.write,
        estimatedTokens: fixedFollowup.scenarios.recentExactPrefix.write },
      fixedHttpEnvelopeBytes: [...envelope][0] },
    retiredRenderRepairs: retiring.map(([, row]) => {
      const old = priorPrices.longRepair.rows.find(receipt => receipt.step === row.step);
      const fixed = longRepair.rows.find(receipt => receipt.step === row.step);
      return { step: row.step, at: row.local, actualTokens: row.bill.write, priorEstimatedTokens: old.scenarios.recentExactPrefix.write,
        estimatedTokens: fixed.scenarios.recentExactPrefix.write };
    }),
    largestRepairWrites: longRepair.rows
      .filter(row => row.scenarios.recentExactPrefix.write >= 100_000)
      .map(row => ({ step: row.step, at: byStep.get(row.step).local, reason: byStep.get(row.step).candidate.firstChange,
        actualTokens: row.actual.write, estimatedTokens: row.scenarios.recentExactPrefix.write })),
    priorRelease: Object.fromEntries(Object.entries(priorPrices).map(([scope, value]) => [scope, value.scenarios])),
    scopes: priced,
    ...(directModelReport ? { directModelReport } : {}),
    requestContext: [...billing].map(([id, row]) => ({ step: row.step, line: lineById.get(id), at: row.local,
      before: baseline.get(id).firstChange, after: combined.get(id)?.firstChange,
      fresh: combined.get(id)?.visualScope, previousTools: combined.get(id)?.lastEvidence,
      nextTools: combined.get(id)?.nextTools, collapsed: !combined.has(id),
    })),
  };
} finally {
  await rm(scratch, { recursive: true, force: true });
}
const json = JSON.stringify(report, null, 2) + "\n";
if (options.output) await writeFile(options.output, json, { mode: 0o600, flag: "wx" });
else process.stdout.write(json);
