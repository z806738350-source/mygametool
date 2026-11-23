// Offline replay. Model and media clients are never created.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { buildSessionProjection } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { convertResponsesMessages, convertResponsesTools } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { resolveTranscriptTools } from "../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { SessionImages, inlineImageScope, wireImages } from "../src/daemon/session-images.ts";
import { normalizeAssistantMessage } from "../src/daemon/assistant-thinking.ts";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.ts";
import { createAgentTools } from "../src/daemon/agent-tools.ts";
import { ensureCanvasContract } from "../src/daemon/canvas-workspace.ts";
import { BlenderWorkflow } from "../src/daemon/blender-tools.ts";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.ts";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.ts";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.ts";
import { workflowGuideTools } from "../src/daemon/workflow-guide.ts";
import { createProjectMediaCapabilitiesTool } from "../src/daemon/project-media-capabilities.ts";
import { createCacheAudit, priceCacheAudit, summarizeCacheAudit, estimateCacheHitSensitivity, fitReplayTokenWeights } from "./replay-cache-audit.mjs";
import { verifiedBlenderPairs } from "./replay-blender-pairs.mjs";
import { overlappingSchemaReads, visibleReadSource } from "./replay-agent-reads.mjs";
import { diagnosticGuideResult, imageStageCapabilities } from "./replay-agent-guide.mjs";
import { completedToolTextEdits, createToolTextRecall, projectDeliveredFileHistory } from "../src/daemon/session-tool-history.ts";
import * as catalog from "../src/daemon/pi-tool-search.ts";
import { KUNPO_BASE_URL } from "../src/shared/kunpo-models.ts";

const { values } = parseArgs({ options: Object.fromEntries(
  ["session", "requests", "billing", "baseline", "save-baseline", "prior-report", "compare-4mib", "billing-offset", "rates", "release-after", "batch-edits", "reuse-reads", "diagnostic-guide", "image-capabilities", "save-run", "cache-audit", "visual-layout", "text-layout", "rows", "help"]
    .map(name => [name, { type: ["rows", "batch-edits", "reuse-reads", "diagnostic-guide", "image-capabilities", "save-run", "cache-audit", "visual-layout", "text-layout", "help"].includes(name) ? "boolean" : "string" }])),
});
if (values.help) {
  console.log("node --import tsx scripts/replay-agent-usage.mjs --session FILE --requests DAEMON_LOG --billing CSV --baseline DIST_OR_SAMPLES_JSON [--save-baseline NEW_JSON] [--billing-offset +08:00] [--rates ordinary,read,write,output] [--release-after 43,67] [--batch-edits] [--reuse-reads] [--diagnostic-guide] [--image-capabilities] [--save-run] [--cache-audit] [--visual-layout] [--text-layout] [--prior-report FILE] [--compare-4mib ARCHIVED_AUDIT_JSON] [--rows]");
  process.exit(0);
}
for (const key of ["session", "requests", "billing", "baseline"]) assert(values[key], "Missing --" + key);
if (values["cache-audit"]) assert(values["save-run"],"--cache-audit requires --save-run");
if (values["visual-layout"] || values["text-layout"]) assert(values["cache-audit"],"Layout comparisons require --cache-audit");
if (values["compare-4mib"]) assert(values["cache-audit"],"--compare-4mib requires --save-run --cache-audit");
const model = { id: "gpt-6.2-astra", provider: "kunpo", api: "openai-responses", baseUrl: KUNPO_BASE_URL,
  reasoning: true, input: ["text", "image"], compat: { supportsStrictMode: true } };
const bytes = x => Buffer.byteLength(JSON.stringify(x));
const sum = array => array.reduce((a, b) => a + b, 0);
const mean = values => sum(values) / values.length;
const rate = values.rates?.split(",").map(Number);
if (rate) assert(rate.length === 4 && rate.every(n => Number.isFinite(n) && n >= 0), "Invalid --rates");
const optIn = new Set((values["release-after"] || "").split(",").filter(Boolean).map(Number));
const offset = values["billing-offset"] || "+08:00";
assert(/^[+-]\d\d:\d\d$/.test(offset), "Use a UTC offset for the timezone of the billing CSV");
const lines = (await readFile(values.session, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const entries = lines.filter(e => e.id && e.type !== "session");
const byId = new Map(entries.map(e => [e.id, e]));
const branch = [];
for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) branch.push(entry);
branch.reverse();
const sessionId = lines.find(e => e.type === "session")?.id;
assert(sessionId, "Missing Pi session header");
const requests = (await readFile(values.requests, "utf8")).split(/\n/).flatMap(line => {
  if (!line.includes('"Provider request"')) return [];
  try { return [JSON.parse(line.slice(line.indexOf("{")))]; } catch { return []; }
}).filter(r => r.conversationId === sessionId && r.event === "finished" && r.protocol === model.api).sort((a, b) => a.time - b.time);
const assistants = branch.filter(e => e.message?.role === "assistant");
assert(assistants.length && requests.length === assistants.length, "Missing/extra HTTP attempts, incomplete branch or rotated log. Cannot pair requests.");
assert(requests.every(r => r.outcome === "completed" && Number.isSafeInteger(r.requestBytes)), "Incomplete HTTP measurements");
assert(assistants.every(e => e.message.model === model.id && e.message.api === model.api), "Only homogeneous Kunpo Astra Responses sessions are supported");
const csv = JSON.parse(execFileSync("python3", ["-c", [
  "import csv, json, sys", "with open(sys.argv[1],encoding='utf-8-sig',newline='') as f:",
  " print(json.dumps([[r[k] for k in ('时间','输入 Token','缓存读取','缓存写入','输出 Token','费用')] for r in csv.DictReader(f) if r['模型']==sys.argv[2] and r['类型']=='消耗']))",
].join("\n"), values.billing, model.id], { encoding: "utf8", maxBuffer: 20 * 1024 ** 2 }));
const bills = assistants.map((e, i) => {
  const u = e.message.usage, r = requests[i], total = u.input + u.cacheRead + u.cacheWrite;
  assert(Math.abs(Date.parse(e.timestamp) - r.time) < 10000, "Session and HTTP timestamps disagree");
  const matches = csv.map((row, index) => ({ row, index })).filter(({ row }) => {
    const time = Date.parse(row[0].replace(" ", "T") + offset);
    return Math.abs(r.time - time) < Math.max(15000, r.totalMs + 15000) &&
      [total, u.cacheRead, u.cacheWrite, u.output].every((n, j) => n === Number(row[j + 1]));
  });
  assert.equal(matches.length, 1, "Billing row missing or ambiguous at step " + (i + 1));
  const [row] = csv.splice(matches[0].index, 1), charge = Number(row[5].replace(/^\$/, ""));
  assert(Number.isFinite(charge), "Unrecognized CSV currency");
  return { total, plain: u.input, read: u.cacheRead, write: u.cacheWrite, output: u.output, charge };
});

const baseline = name => import(pathToFileURL(path.resolve(values.baseline, "daemon", name + ".js")).href);
const samplesOnly = (await stat(values.baseline)).isFile();
const saved = samplesOnly ? JSON.parse(await readFile(values.baseline, "utf8")) : undefined;
const oldImages = samplesOnly ? undefined : await baseline("session-images");
const oldSearch = samplesOnly ? undefined : await baseline("pi-tool-search");
const requestEvidence = requests.map((r, i) => [r.time, r.requestBytes, bills[i].total, bills[i].read, bills[i].write, bills[i].output]);
if (saved) {
  assert.equal(saved.version, 1); assert.deepEqual(saved.requestEvidence, requestEvidence, "Samples do not match the session, log and billing rows");
  assert.equal(saved.sessionId, sessionId); assert.equal(saved.historical.rows.length, requests.length);
}
function registerSearch(factory) {
  let definition, tools = [];
  factory({ on() {}, registerTool(tool) { definition = tool; }, getAllTools: () => tools, getActiveTools: () => tools.map(t => t.name) });
  return { definition, authorize(list) { tools = list; } };
}
const decl = ({ name, description, parameters }) => ({ name, description, parameters });
const cache = await mkdtemp(path.join(tmpdir(), "ohmygame-usage-replay-"));
const dimensions = new Map();
async function picturePatches(data) {
  if (!dimensions.has(data)) {
    const { width, height } = await sharp(Buffer.from(data, "base64")).metadata();
    dimensions.set(data, Math.ceil(width / 32) * Math.ceil(height / 32));
  }
  return dimensions.get(data);
}
const zero = () => [0, 0, 0, 0, 0];
const add = (a, b) => a.map((n, i) => n + b[i]);
const dot = (a, b) => sum(a.map((n, i) => n * b[i]));
async function signature(payload, previous) {
  const schemas = JSON.stringify(payload.tools), schemaFeature = [0, Buffer.byteLength(schemas), 0, 0, 0];
  let features = schemaFeature, prefix = zero(), pics = 0, base64 = 0;
  let matching = previous?.schemas === schemas;
  if (matching) prefix = schemaFeature;
  const items = [];
  for (const [i, item] of payload.input.entries()) {
    const text = JSON.stringify(item), images = wireImages([item]);
    const imgBytes = sum(images.map(img => img.data.length));
    const weight = item.type === "reasoning" ? [0, 0, Buffer.byteLength(text), 0, 0]
      : [Buffer.byteLength(text) - imgBytes, 0, 0, images.length, sum(await Promise.all(images.map(img => picturePatches(img.data))))];
    features = add(features, weight);
    matching = matching && previous.items[i] === text;
    if (matching) prefix = add(prefix, weight);
    items.push(text); pics += images.length; base64 += imgBytes;
  }
  return { state: { schemas, items }, row: { features, prefix, pics, base64,
    inputAndToolBytes: bytes(payload.input) + bytes(payload.tools), tools: payload.tools.length } };
}

const firstUsePreviews = new Map(); // Retain only transformed historical images in memory, never in the saved samples.
const reviewBaseline = new Map(saved?.historical.reviews?.map(r => [r.step, r.ids]) ?? []);
const actualResult = new Map(branch.filter(e => e.message?.role === "toolResult").map(e => [e.message.toolCallId, e.message]));
const callStep = new Map(assistants.flatMap((e,i) => e.message.content.filter(b => b.type === "toolCall").map(b => [b.id, i+1])));
const schemaPages = overlappingSchemaReads(branch);
const candidateVision = new Map();
const diagnosticRuns = assistants.flatMap(e => e.message.content).filter(b => b.type === "toolCall");
if (values["diagnostic-guide"]) assert(diagnosticRuns.some(b => b.name === "run_blender") &&
  diagnosticRuns.every(b => b.name !== "run_blender" || b.arguments.stage === "custom") &&
  !diagnosticRuns.some(b => ["generate_3d_asset", "generate_3d_from_views", "animate_3d_asset"].includes(b.name)),
  "Review the task before selecting a 2D-only guide projection");
const successfulCallIds = new Set([...actualResult.values()].filter(m => !m.isError)
  .flatMap(m => [m.toolCallId,m.toolCallId.split("|")[0]]));
const unsignedSaveCallIds = new Set(assistants.flatMap(({message}) => message.content.length &&
  message.content.every(b => b.type === "toolCall" && ["write","edit"].includes(b.name) && !b.thoughtSignature)
  ? message.content.flatMap(c => [c.id,c.id.split("|")[0]]) : []));
const auditToolNames = new Map(diagnosticRuns.flatMap(c => [[c.id,c.name],[c.id.split("|")[0],c.name]]));
const productionCalls = diagnosticRuns.filter(c => ["generate_canvas_media","generate_image","run_blender","inspect_3d_views"].includes(c.name));
const projectDir = path.dirname(path.dirname(path.resolve(values.session)));
const project = values["save-run"] ? JSON.parse(await readFile(path.join(projectDir,"project.json"),"utf8")) : undefined;
let liveGuide, mediaCatalog, canvasRead;
if (project) {
  assert(values["batch-edits"] && values["diagnostic-guide"] && values["reuse-reads"] && values["image-capabilities"],
    "Use --save-run together with the read, edit, guide and image scenarios");
  const plugins = new BundledPluginStore(path.resolve("plugins")), settings = new PluginSettingsStore(cache);
  await plugins.load(); await settings.load();
  [liveGuide] = workflowGuideTools(project, plugins, settings);
  const record = [...actualResult.values()].find(m => m.toolName === "list_media_capabilities");
  const image = JSON.parse(record.content[0].text).image;
  // Restore the recorded project choice and supply only the local image catalog.
  // A request for another backend cannot silently reach the network during replay.
  mediaCatalog = createProjectMediaCapabilitiesTool(() => ({ ...project, modelSelections: { image: image.projectSelection } }), {
    images: { catalog: async () => ({ models: image.candidates }) }, defaultModel: () => image.globalDefault,
  });
  const result = await mediaCatalog.execute("offline", { capability: "image" });
  assert.deepEqual(JSON.parse(result.content[0].text), { image }, "Narrowing changed recorded image models or parameters");
  const canvasPath = "canvas/AGENTS.md";
  const initialRead = diagnosticRuns.find(c => c.name === "read" && c.arguments.path === canvasPath);
  const source = actualResult.get(initialRead.id).content[0].text;
  assert(!initialRead.arguments.offset && !initialRead.arguments.limit && source.split("\n").length < 200);
  const files = createLocalAgentFileTools(cache);
  await files.find(t => t.name === "write").execute("offline", { path:canvasPath, content:source });
  await ensureCanvasContract(cache); // Migrate the recorded instructions on a disposable project copy.
  canvasRead = files.find(t => t.name === "read");
}
function productionResultTool(name,args) {
  if (name === "read_workflow_guide") return liveGuide;
  if (name === "list_media_capabilities") return mediaCatalog;
  if (name === "read" && args?.path === "canvas/AGENTS.md") return canvasRead;
}
if (values["image-capabilities"]) {
  const generated = branch.filter(e => e.message?.toolName === "generate_canvas_media").map(e => e.message);
  assert(generated.length && generated.every(m => !m.isError && m.details?.canvasGeneration?.toolId === "generate-image"),
    "Image catalog scope requires completed image-only Canvas generation");
}
async function replay(candidate, release, batches = [], scenario = {}) {
  const changed = new Set(), reused = [], scopeChanges = [], skipped = [], comparisonTransfers = [], retainedProduction = [];
  const pageStart = new Map((scenario.reuse ? schemaPages : []).map(p => [p.first,p]));
  const pageEnd = new Map((scenario.reuse ? schemaPages : []).map(p => [p.second,p]));
  const history = [], omissions = [], loaded = new Set(), pending = new Map(), fresh = [], rows = [], reviews = [], marked = new Set(), sources = new Map();
  const getBranch = () => [...history, ...omissions];
  const manager = { getBranch, appendCustomEntry(customType, data) { omissions.push({ type: "custom", customType, data }); } };
  const images = new (candidate ? SessionImages : oldImages.SessionImages)(manager, cache);
  // The control and the production request must not share Pi image omission or prior-send state.
  const productionOmissions = [];
  const runtimeImages = scenario.implemented && new SessionImages({
    getBranch: () => [...history,...productionOmissions],
    appendCustomEntry(customType,data) { productionOmissions.push({type:"custom",customType,data}); },
  }, cache);
  const deliveryContext = { requiredImageOccurrences:0, additionalImageOccurrences:0, completePrefixMatches:0, handoffSteps:[], steps:[] };
  const recalled = new Set();
  const forecastCheck = runtimeImages && scenario.audit && values["compare-4mib"] ? {
    visual:(await import("./replay-bounded-visual-history.mjs")).createBoundedVisualHistory(),
    handoff:(await import("./replay-prefix-counterfactual.mjs")).completedTurnRolePreservingHandoff,
    changedSteps:[], changedItemKinds:new Set(), changedImageSteps:[], inputByteDelta:0,
  } : undefined;
  const search = registerSearch(candidate ? catalog.projectToolSearch : oldSearch.projectToolSearch);
  const liveTools = scenario.live ? [liveGuide, mediaCatalog, ...new BlenderWorkflow({ workspace: cache }).tools()].filter(Boolean) : [];
  const updatedTools = candidate ? [...createLocalAgentFileTools(cache, undefined, true).filter(t => scenario.live || ["edit", "write"].includes(t.name)), images.recallTool, createToolTextRecall(manager), search.definition, ...liveTools] : [];
  // Creating these definitions only reads metadata. ToolRunner/ProjectManager are never invoked.
  const promptTools = candidate ? [...createAgentTools({ id: "offline", workspacePath: cache }, undefined, undefined), ...updatedTools] : [];
  const merged = new Map(batches.map(g => [g.steps[0], g.steps]));
  const removed = new Set(batches.flatMap(g => g.steps.slice(1))), omittedCallIds = new Set();
  const runAtSave = new Map((scenario.pairs ?? []).map(p => [p.saveStep,p.runStep]));
  const pairReceipts = new Map((scenario.pairs ?? []).map(p => [p.receipt.toolCallId,p.receipt]));
  const executedVersions = new Map((scenario.pairs ?? []).map(p => [p.runStep,p.receipt.details.projectFileVersion.sha256]));
  const pairedRuns = new Set(runAtSave.values());
  const pipelineArgs = a => scenario.live && a?.guide === "blender-assets" && a.reference === "pipeline.md"
    ? { ...a, reference: "design-proofs.md" } : a;
  const markedIn = steps => steps.filter(n => release.has(n));
  let previous, authorized = [], refreshed = 0, originalStep = 0, inspection = false, awaitingRunReview;
  const runReviews = [];
  const audit = scenario.audit ? createCacheAudit() : undefined;
  const variations = [];
  if (scenario.audit && !scenario.implemented && values["visual-layout"]) variations.push(
    (await import("./replay-visual-counterfactual.mjs")).createVisualCounterfactual(),
    (await import("./replay-bounded-visual-history.mjs")).createBoundedVisualHistory());
  if (scenario.audit && !scenario.implemented && values["text-layout"]) variations.push((await import("./replay-prefix-counterfactual.mjs")).createPrefixCounterfactual());
  const combineHandoff = scenario.audit && !scenario.implemented && values["visual-layout"] && values["text-layout"]
    ? (await import("./replay-prefix-counterfactual.mjs")).completedTurnRolePreservingHandoff : undefined;
  const combinedChecks = Object.fromEntries([4,8].map(limit => [limit,
    { requests:0, pixelBlocksChecked:0, freshBlocksChecked:0, inspections:[], postHandoffAt:[] }]));
  const variantStates = new Map();
  for (const original of branch) {
    let e = original, m = e.message;
    if (m?.role === "assistant") originalStep++;
    if (m?.role === "assistant" && pairedRuns.has(originalStep)) {
      // Only the inference between a successful save and starting the job disappears. Keep the real job result.
      history.push({ id:e.id, parentId:e.parentId, timestamp:e.timestamp, type:"custom", customType:"offline-same-batch", data:{} });
      continue;
    }
    if (e.type === "context_edit" && changed.has(e.targetId)) {
      const draft = completedToolTextEdits(buildSessionProjection(history, e.parentId).entries).find(d => d.targetId === e.targetId);
      e = draft ? { ...e, replacement: draft.replacement }
        : { id: e.id, parentId: e.parentId, timestamp: e.timestamp, type: "custom", customType: "offline-obsolete-excerpt", data: {} };
    }
    if (scenario.reuse && m?.role === "assistant" && !removed.has(originalStep)) {
      const visible = buildSessionProjection(history, e.parentId).messages;
      const calls = m.content.filter(b => b.type === "toolCall");
      const checked = await Promise.all(calls.map(async call => {
        const args = pipelineArgs(call.arguments), original = actualResult.get(call.id);
        const tool = scenario.live && ["read","read_workflow_guide"].includes(call.name) && productionResultTool(call.name,args);
        const result = tool && original && !original.isError ? { ...original, ...await tool.execute(call.id,args) } : original;
        const covered = visibleReadSource(visible, { ...call,arguments:args }, result);
        const page = pageEnd.get(call.id);
        if (!covered && !page) return false;
        if (calls.length === 1 && m.content.some(b => b.type !== "toolCall")) return false;
        return { step: originalStep, tool: call.name, sourceSteps: [...new Set((covered ?? [page.first]).map(id => callStep.get(id)))],
          reason: page ? "overlapping-schema-page" : "already-visible-text" };
      }));
      const redundant = calls.filter((_,i) => checked[i]);
      if (redundant.length === calls.length && m.content.some(b => b.type !== "toolCall")) redundant.pop();
      if (redundant.length) {
        reused.push(...redundant.map(call => checked[calls.indexOf(call)]));
        for (const call of redundant) omittedCallIds.add(call.id);
        if (redundant.length === calls.length) { skipped.push(originalStep); removed.add(originalStep); }
        else { m = { ...m, content: m.content.filter(b => !omittedCallIds.has(b.id)) }; e = { ...e, message: m }; changed.add(e.id); }
      }
      if (calls.some(c => pageStart.has(c.id))) {
        m = { ...m, content: m.content.map(c => pageStart.has(c.id) ? { ...c, arguments: {
          ...c.arguments, offset: pageStart.get(c.id).offset, limit: pageStart.get(c.id).limit } } : c) };
        e = { ...e, message: m }; changed.add(e.id);
      }
    }
    if (scenario.capabilities && m?.role === "assistant" && m.content.some(c => c.name === "list_media_capabilities" && !Object.keys(c.arguments).length)) {
      m = { ...m, content: m.content.map(c => c.name === "list_media_capabilities" && !Object.keys(c.arguments).length
        ? { ...c, arguments: { capability: "image" } } : c) };
      e = { ...e, message: m }; changed.add(e.id);
    }
    if (scenario.live && m?.role === "assistant" && m.content.some(c => c.name === "read_workflow_guide" && pipelineArgs(c.arguments) !== c.arguments)) {
      m = { ...m, content: m.content.map(c => c.name === "read_workflow_guide" ? { ...c, arguments:pipelineArgs(c.arguments) } : c) };
      e = { ...e, message:m }; changed.add(e.id);
    }
    if (m?.role === "assistant" && removed.has(originalStep)) {
      for (const b of m.content) if (b.type === "toolCall") omittedCallIds.add(b.id);
    }
    if (m?.role === "assistant" && removed.has(originalStep) || m?.role === "toolResult" && omittedCallIds.has(m.toolCallId)) {
      // Preserve parent links for Pi's branch projection.
      history.push({ id: e.id, parentId: e.parentId, timestamp: e.timestamp, type: "custom", customType: "offline-merged-edit", data: {} });
      continue;
    }
    if (m?.role === "user") loaded.clear();
    if (m?.role === "system") {
      if (m.toolsAdded || m.toolsRemoved) {
        const replacements = new Map(authorized.map(t => [t.name, t]));
        for (const t of m.toolsRemoved ?? []) replacements.delete(t.name);
        for (const t of m.toolsAdded ?? []) replacements.set(t.name, t);
        authorized = [...replacements.values()];
      }
      if (candidate) {
        const sections = { ...m.sections };
        if (scenario.live && sections.addendum) {
          const boundary = sections.addendum.indexOf("\n\nCurrent local secure edition execution contract");
          assert(boundary > 0 && sections.addendum.startsWith("<addendum>\n"), "Unrecognized local project system prompt");
          sections.addendum = "<addendum>\n" + appendSystemPromptForProject(project).join("\n\n") + sections.addendum.slice(boundary);
        }
        if ("rules" in sections || "tools" in sections || m.toolsAdded || m.toolsRemoved) {
          const next = buildSystemPromptSections({ cwd: cache, selectedTools: authorized.map(t => t.name),
            toolSnippets: Object.fromEntries(promptTools.filter(t => t.promptSnippet).map(t => [t.name, t.promptSnippet])),
            toolGuidelines: Object.fromEntries(promptTools.filter(t => t.promptGuidelines).map(t => [t.name, t.promptGuidelines])) });
          sections.rules = next.rules; sections.tools = next.tools;
        }
        const updated = new Map(updatedTools.map(t => [t.name, decl(t)]));
        const additions = m.toolsAdded?.map(t => {
          if (scenario.capabilities && !scenario.live && t.name === "list_media_capabilities") return { ...t, parameters: { ...t.parameters,
            properties: { ...t.parameters.properties, capability: { type: "string", enum: ["image","video","speech","sound-effect","music","3d-generation","3d-processing"] } } } };
          return updated.get(t.name) || t;
        });
        m = { ...m, sections, ...(additions ? { toolsAdded: additions.map(catalog.compactProjectToolDeclaration) } : {}) };
        e = { ...e, message: m };
      }
    }
    if (m?.role === "toolResult") {
      if (scenario.live && m.toolName === "run_blender") {
        assert(!awaitingRunReview, "The preceding Blender run still needs visual inspection");
        assert.deepEqual(m, actualResult.get(m.toolCallId));
        const runStep = callStep.get(m.toolCallId);
        // The new receipts carry host-only file version metadata. Model-visible evidence stays intact.
        if (executedVersions.has(runStep)) {
          m = { ...m, details:{ ...m.details, executedScriptSha256:executedVersions.get(runStep) } };
          e = { ...e, message:m };
        }
        awaitingRunReview = { runStep, result:m };
      } else if (pairReceipts.has(m.toolCallId)) {
        m = pairReceipts.get(m.toolCallId); e = { ...e, message:m };
      }
      const page = pageStart.get(m.toolCallId);
      if (page) { m = { ...m, content: [{ ...m.content[0], text: page.text }] }; e = { ...e, message: m }; changed.add(e.id); }
      const args = pending.get(m.toolCallId);
      let projected = m;
      if (scenario.live && !m.isError) {
        const tool = productionResultTool(m.toolName,args);
        if (tool) {
          const result = await tool.execute(m.toolCallId,args);
          if (result.content[0].text !== m.content[0].text) projected = { ...m, ...result };
        }
      } else {
        if (scenario.guide) projected = diagnosticGuideResult(projected,args);
        if (scenario.capabilities) projected = imageStageCapabilities(projected,args);
      }
      if (projected !== m) {
        scopeChanges.push({ step: originalStep, tool: m.toolName, beforeCharacters: m.content[0].text.length,
          afterCharacters: projected.content[0].text.length });
        m = projected; e = { ...e, message: m }; changed.add(e.id);
      }
      if (m.toolName === "inspect_3d_views" && m.content.some(b => b.type === "image")) inspection = true;
      if (m.toolName === "tool_search" && !m.isError) {
        if (candidate) {
          const query = pending.get(m.toolCallId); assert(query, "Unmatched tool search");
          search.authorize(scenario.live ? authorized.map(t => updatedTools.find(u => u.name === t.name) ?? t) : authorized);
          const result = await search.definition.execute(m.toolCallId, query, undefined, undefined, {});
          m = { ...m, content: result.content, details: result.details }; e = { ...e, message: m };
        } else for (const name of m.details?.loaded || []) loaded.add(name);
      }
      m.content.filter(b => b.type === "image").forEach((b, i) => fresh.push({ id: e.id + ":" + i, source: b }));
    }
    if (m?.role === "user" && Array.isArray(m.content)) m.content.filter(b => b.type === "image").forEach((b, i) => fresh.push({ id: e.id + ":" + i, source: b }));
    if (m?.role === "assistant") {
      const index = originalStep;
      const projection = buildSessionProjection(history, e.parentId);
      const normalize = messages => convertToLlm(messages).map(msg => {
        if (msg.role === "assistant") return normalizeAssistantMessage(msg);
        if (candidate || msg.role !== "system" || !msg.toolsAdded) return msg;
        const hidden = new Set(search.definition.prepareLoadout({ declared: msg.toolsAdded }).hiddenDeclarations);
        return { ...msg, toolsAdded: msg.toolsAdded.filter(t => !hidden.has(t.name) || loaded.has(t.name)) };
      });
      const normalized = normalize(projection.messages);
      const currentTools = resolveTranscriptTools(normalized, false).requestTools;
      const opts = { supportsStrictMode: true, supportsOpenAIGrammarTools: false };
      const serialize = async (messages, policy) => {
        const context = await policy.prepare({ messages, tools:currentTools }, model);
        const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), { toolOptions:opts });
        const body = { input, tools:convertResponsesTools(currentTools, opts) };
        policy.budget(body, inlineImageScope(model));
        return body;
      };
      let payload = await serialize(normalized, images);
      const wire = wireImages(payload), ids = wire.map(i => i.id);
      if (awaitingRunReview) {
        const review = awaitingRunReview;
        if (!review.receiptReadAt) {
          assert(normalized.some(msg => msg.role === "toolResult" && msg.toolCallId === review.result.toolCallId &&
            msg.content[0]?.text === review.result.content[0]?.text), "Blender result not seen before choosing the next action");
          review.receiptReadAt = index;
        }
        if (fresh.length) {
          const fromRun = fresh.some(p => {
            const source = byId.get(p.id.split(":")[0])?.message;
            const args = pending.get(source?.toolCallId);
            return args && JSON.stringify(args).includes(review.result.details.blender.directory + "/");
          });
          assert(fromRun,"Expected the new visual batch to contain output from this Blender run");
          runReviews.push({runStep:review.runStep, receiptSeenAt:review.receiptReadAt, artworkSeenAt:index, freshImageBlocks:fresh.length});
          awaitingRunReview = undefined;
        }
      }
      let start = 0;
      for (const { id, source } of fresh) {
        const position = ids.indexOf(id, start);
        assert(position >= 0, "New visual evidence omitted or reordered at step " + index);
        const first = wire[position];
        sources.set(id, source);
        if (!candidate && (first.mime !== source.mimeType || first.data !== source.data)) firstUsePreviews.set(id, first);
        const expected = firstUsePreviews.get(id) ?? { mime: source.mimeType, data: source.data };
        assert(first.mime === expected.mime && first.data === expected.data, "First-use image pixels differ from the historical representation at step " + index);
        start = position + 1;
      }
      const auditMeta = audit && { step:index, freshIds:fresh.map(f => f.id), isInspection:inspection,
        nextTools:[...m.content.filter(b => b.type === "toolCall").map(b => b.name),...(runAtSave.has(index) ? ["run_blender"] : [])],
        toolNames:auditToolNames, successfulCallIds, unsignedSaveCallIds };
      refreshed += fresh.length; fresh.length = 0;
      if (scenario.rememberVision) candidateVision.set(index, ids);
      if (scenario.reuse || scenario.guide || scenario.capabilities) {
        const displaced = [];
        for (let n = index - 1; skipped.includes(n); n--) displaced.unshift(n);
        for (const oldStep of [...displaced,index,...(runAtSave.has(index) ? [runAtSave.get(index)] : [])]) {
          assert.deepEqual(ids,candidateVision.get(oldStep), "Visual context changed at historical decision " + oldStep);
          for (const pixel of wire) {
            const source = sources.get(pixel.id), preview = firstUsePreviews.get(pixel.id);
            assert(source && pixel.mime === (preview?.mime ?? source.mimeType) && pixel.data === (preview?.data ?? source.data),
              "Visual pixels changed at historical decision " + oldStep);
          }
          if (oldStep !== index && ids.length) comparisonTransfers.push({ from: oldStep, to: index, pictures: ids.length });
        }
      }
      if (inspection) {
        if (!candidate) reviewBaseline.set(index, ids);
        assert.deepEqual(ids, reviewBaseline.get(index), "Visual comparison set or order changed at step " + index);
        for (const i of wire) {
          const source = sources.get(i.id), historical = firstUsePreviews.get(i.id);
          assert(source && i.mime === (historical?.mime ?? source.mimeType) && i.data === (historical?.data ?? source.data),
            "Visual comparison contains different pixels at step " + index);
        }
        reviews.push({ step: index, ids, mime: wire.map(i => i.mime), encodedBytes: wire.map(i => i.data.length) });
        inspection = false;
      }
      if (runtimeImages) {
        const effective = projectDeliveredFileHistory(projection.messages, projection.entries);
        const currentUser = projection.messages.findLast(message => message.role === "user");
        assert(currentUser);
        const boundary = effective.indexOf(currentUser);
        assert(boundary >= 0);
        assert.deepEqual(effective.slice(boundary), projection.messages.slice(projection.messages.indexOf(currentUser)),
          "Production handoff changed the current user turn");
        const protects = messages => messages.filter(m => m.role === "user" || m.role === "assistant" && m.stopReason === "stop" ||
          m.role === "toolResult" && ["run_blender","inspect_3d_views","generate_canvas_media","canvas_check"].includes(m.toolName));
        assert.deepEqual(protects(effective),protects(projection.messages), "Production handoff changed user feedback, completed replies or production results");
        const changedHistory = effective.length !== projection.messages.length || effective.some((m,i) => m !== projection.messages[i]);
        if (changedHistory) {
          deliveryContext.handoffSteps.push(index);
          const recall = createToolTextRecall({ getBranch, buildSessionProjection:() => projection });
          const offered = effective.filter(msg => msg.role === "toolResult").flatMap(msg => msg.content.filter(block => block.type === "text").map(block => block.text));
          for (const { sourceEntry, messages:[prior] } of projection.entries) {
            if (!prior || effective.includes(prior)) continue;
            const recoverable = prior.role === "toolResult" && prior.toolName === "read" ? [[0, prior.content[0].text]]
              : prior.role === "assistant" ? prior.content.flatMap((block,n) => block.type === "toolCall" ? [[n,JSON.stringify(block.arguments)]] : []) : [];
            for (const [n,expected] of recoverable) {
              const ref = sourceEntry.id + ":" + n;
              if (recalled.has(ref)) continue;
              assert(offered.some(text => text.includes(ref)),"Original file text lacks a visible recall reference");
              let recovered = "";
              do {
                const page = await recall.execute("offline-recall", { ref,offset:recovered.length });
                assert(page.content[0]?.text?.length, "Recall did not advance");
                recovered += page.content[0].text;
              } while (recovered.length < expected.length);
              assert.equal(recovered,expected,"Recovered historical file data differs from its original");
              recalled.add(ref);
            }
          }
        }
        const body = await serialize(normalize(effective),runtimeImages);
        const sent = runtimeImages.withPreviousToolImages(body, inlineImageScope(model), !values["compare-4mib"]);
        const actual = wireImages(sent.payload);
        const required = new Set(ids), present = actual.filter(img => required.has(img.id));
        assert.deepEqual(present.map(img => img.id),ids,"A current image was lost or reordered at step " + index);
        assert(present.every((img,i) => img.mime === wire[i].mime && img.data === wire[i].data));
        if (!ids.length || reviews.at(-1)?.step === index) assert.equal(actual.length,ids.length,"Additional pixels in an explicit release or complete visual review");
        const extra = actual.filter(image => !required.has(image.id));
        for (const img of extra) {
          const source = sources.get(img.id), preview = firstUsePreviews.get(img.id);
          assert(source && img.mime === (preview?.mime ?? source.mimeType) && img.data === (preview?.data ?? source.data),"Unexpected extra image");
        }
        const added = actual.length-ids.length;
        deliveryContext.requiredImageOccurrences += ids.length;
        deliveryContext.additionalImageOccurrences += added;
        deliveryContext.steps.push({step:index, requiredImages:ids.length, additionalImages:added,
          ...(added ? { additionalImageIds:extra.map(img=>img.id) } : {}),baselineInputAndToolBytes:bytes(payload.input)+bytes(payload.tools)});
        if (forecastCheck) {
          const prior = forecastCheck.visual.project(payload,auditMeta).keepPriorInSourceUnder4MiB;
          const predicted = forecastCheck.handoff(prior,successfulCallIds,unsignedSaveCallIds);
          const expectedImages = wireImages(predicted);
          if (expectedImages.length !== actual.length || expectedImages.some((img,i) => img.id !== actual[i].id ||
              img.mime !== actual[i].mime || img.data !== actual[i].data)) forecastCheck.changedImageSteps.push(index);
          if (JSON.stringify(predicted.input) !== JSON.stringify(sent.payload.input)) {
            forecastCheck.changedSteps.push(index);
            for (let i=0;i<Math.max(predicted.input.length,sent.payload.input.length);i++) {
              const first = predicted.input[i], second = sent.payload.input[i];
              if (JSON.stringify(first) !== JSON.stringify(second)) {
                const kind = item => item?.type === "function_call_output" ? item.type+"."+auditToolNames.get(item.call_id) : item?.type ?? item?.role ?? "absent";
                forecastCheck.changedItemKinds.add(kind(first)+" → "+kind(second));
              }
            }
          }
          forecastCheck.inputByteDelta += bytes(sent.payload.input)-bytes(predicted.input);
        }
        payload = sent.payload;
        // Each original HTTP completion and assistant reply was verified above. No live HTTP call.
        sent.commit();
      }
      const result = await signature(payload, previous);
      if (runtimeImages && previous?.schemas === result.state.schemas && previous.items.every((item,i) => result.state.items[i] === item))
        deliveryContext.completePrefixMatches++;
      const audited = audit && await audit(payload, result.state, previous, auditMeta, picturePatches);
      const variants = {};
      for (const variation of variations) {
        const projected = await variation.project(payload,auditMeta);
        for (const limit of [4,8]) {
          const bounded = projected[`keepPriorInSourceUnder${limit}MiB`];
          if (!bounded || !combineHandoff) continue;
          const checks = combinedChecks[limit];
          const combined = combineHandoff(bounded,successfulCallIds,unsignedSaveCallIds);
          const actual = wireImages(combined), before = wireImages(bounded);
          assert.equal(actual.length,before.length);
          assert(actual.every((img,i) => img.id === before[i].id && img.mime === before[i].mime && img.data === before[i].data));
          assert(auditMeta.freshIds.every(id => actual.some(image => image.id === id)));
          if (auditMeta.isInspection) {
            assert.deepEqual(actual.map(img => img.id),wire.map(img => img.id));
            checks.inspections.push({ step:index,pictures:actual.length });
          }
          if (combined !== bounded) {
            checks.postHandoffAt.push(index);
            const lastUser = bounded.input.findLastIndex(item => item.role === "user");
            assert(lastUser > 0 && bounded.input[lastUser-1].role === "assistant");
            assert.deepEqual(combined.input.slice(-(bounded.input.length-lastUser+1)),bounded.input.slice(lastUser-1));
          }
          checks.requests++; checks.pixelBlocksChecked += actual.length; checks.freshBlocksChecked += auditMeta.freshIds.length;
          projected[`bounded${limit}MiBAndRolePreservingHandoff`] = combined;
        }
        for (const [name,alternate] of Object.entries(projected)) {
          const earlier = variantStates.get(name);
          const serialized = await signature(alternate,earlier);
          const prevIsExactPrefix = !!earlier && earlier.schemas === serialized.state.schemas &&
            earlier.items.every((item,i) => item === serialized.state.items[i]);
          variantStates.set(name,serialized.state);
          variants[name] = { ...serialized.row,prevIsExactPrefix };
        }
        assert.equal(JSON.stringify(payload.tools),result.state.schemas);
        assert.deepEqual(payload.input.map(item => JSON.stringify(item)),result.state.items,"Scenario mutated the original request");
      }
      rows.push({ ...result.row, step:index, ...(audited ? { audited, variants } : {}) }); previous = result.state;
      for (const call of m.content.filter(b => b.type === "toolCall")) pending.set(call.id, call.arguments);
      const grouped = merged.get(index) || [index];
      if (grouped.length > 1) {
        const edits = grouped.map(n => assistants[n - 1].message.content.find(b => b.type === "toolCall").arguments);
        m = { ...m, content: m.content.map(b => b.type === "toolCall" ? { ...b, arguments: { path: edits[0].path,
          edits: edits.map(({ oldText, newText }) => ({ oldText, newText })) } } : b) };
        e = { ...e, message: m };
      }
      if (runAtSave.has(index)) {
        const [run] = assistants[runAtSave.get(index)-1].message.content;
        assert.equal(run.name,"run_blender");
        m = { ...m, content:[...m.content,run] };
        e = { ...e, message:m }; changed.add(e.id);
        pending.set(run.id,run.arguments);
      }
      if (markedIn(grouped).length) {
        const edits = m.content.filter(b => b.type === "toolCall" && b.name === "edit" && b.arguments?.path?.startsWith("canvas/"));
        assert.equal(edits.length, 1, "--release-after requires one recorded canvas edit in that response");
        assert(branch.some(b => b.message?.role === "toolResult" && b.message.toolCallId === edits[0].id && !b.message.isError), "Selected edit failed");
        m = { ...m, content: m.content.map(b => b === edits[0] ? { ...b, arguments: { ...b.arguments, releaseReviewedImages: true } } : b) };
        e = { ...e, message: m }; for (const n of markedIn(grouped)) marked.add(n);
      }
    }
    if (m?.role === "assistant") retainedProduction.push(...m.content.filter(c => productionCalls.some(original => original.id === c.id)));
    history.push(e);
  }
  assert.equal(release.size, marked.size, "Unknown --release-after step");
  assert.deepEqual(retainedProduction, productionCalls, "Generation, Blender or inspection calls changed");
  let delivery;
  if (scenario.live) {
    assert.equal(runReviews.length, productionCalls.filter(c => c.name === "run_blender").length);
    const atHandoff = entry => entry.message?.role === "user" ||
      entry.message?.role === "assistant" && entry.message.stopReason === "stop";
    assert.deepEqual(history.filter(atHandoff), branch.filter(atHandoff), "User corrections or final handoffs changed");
    const checks = transcript => transcript.flatMap(e => e.message?.role === "assistant"
      ? e.message.content.filter(c => c.type === "toolCall" && ["canvas_check","recover_blender_run"].includes(c.name)) : []);
    const verified = checks(history);
    assert.deepEqual(verified,checks(branch));
    for (const c of verified) assert.deepEqual(history.find(e => e.message?.toolCallId === c.id)?.message,actualResult.get(c.id));
    delivery = { userTurns:history.filter(e => e.message?.role === "user").length,
      assistantHandoffs:history.filter(e => e.message?.stopReason === "stop").length, canvasChecks:verified.filter(c => c.name === "canvas_check").length };
  }
  if (runtimeImages) {
    deliveryContext.originalFileReferencesRecovered = recalled.size;
    if (forecastCheck) deliveryContext.forecastDifferences = {
      changedSteps:forecastCheck.changedSteps, itemKinds:[...forecastCheck.changedItemKinds],
      changedImageSteps:forecastCheck.changedImageSteps,inputByteDelta:forecastCheck.inputByteDelta,
    };
  }
  return { rows, refreshed, reviews, reused, skipped, scopeChanges, comparisonTransfers, runReviews, delivery, ...(runtimeImages ? {deliveryContext} : {}),
    variantChecks:[...variations.map(variation => variation.report()),...(combineHandoff ? [{combinedChecks}] : [])] };
}

function totals(rows, key) { return sum(rows.map(x => x[key])); }
try {
  const historical = saved?.historical ?? await replay(false, new Set());
  const gap = requests.map((r, i) => r.requestBytes - historical.rows[i].inputAndToolBytes);
  assert(gap.every(n => n === gap[0] && n >= 0 && n < 4096), "Baseline JSON sizes disagree with actual wire size; use the historical build and SDK.");
  const weights = fitReplayTokenWeights(historical.rows.map(r => r.features), bills.map(b => b.total));
  const money = (b) => dot([b.plain, b.read, b.write, b.output], rate) / 1e6;
  if (rate) assert(bills.every(b => Math.abs(money(b) - b.charge) < 0.000002), "Supplied rates disagree with individual CSV charges");
  const actual = { calls: bills.length, wireBytes: totals(requests, "requestBytes"), inputTokens: totals(bills, "total"),
    cacheRead: totals(bills, "read"), cacheWrite: totals(bills, "write"), output: totals(bills, "output"), usd: +totals(bills, "charge").toFixed(6),
    imageOccurrences: totals(historical.rows, "pics"), imageBase64Bytes: totals(historical.rows, "base64"),
    firstUseImagesVerified: historical.refreshed, visualComparisonRequests: historical.reviews.map(r => ({ step: r.step, pictures: r.ids.length })),
    additionalSameModelCsvRowsExcluded: csv.length, outerBytesPerRequest: gap[0] };
  const compare = async (release, batches = [], scenario = {}) => {
    const result = await replay(true, release, batches, scenario);
    let fixedAnchorUsd = 0, fixedAnchorWrite = 0;
    const scenarioTotals = {};
    const step = result.rows.map(r => {
      const i = r.step - 1;
      let anchor = i;
      while (result.skipped.includes(anchor)) anchor--;
      const group = batches.find(g => g.steps[0] === r.step);
      const paired = scenario.pairs?.find(p => p.saveStep === r.step);
      const output = (group ? sum(group.steps.map(n => bills[n - 1].output)) : bills[i].output) + (paired ? bills[paired.runStep-1].output : 0)
        + sum(bills.slice(anchor,i).map(b => b.output));
      const price = (index, row = r) => {
        const old = historical.rows[index], b = bills[index];
        const total = Math.max(b.plain, Math.round(b.total + dot(row.features,weights) - dot(old.features,weights)));
        const read = Math.max(0, Math.min(total - b.plain, Math.round(b.read + dot(row.prefix,weights) - dot(old.prefix,weights))));
        const write = total - b.plain - read;
        return { total, read, write, usd: rate ? money({ ...b,read,write,output }) : undefined };
      };
      const { total, read, write, usd } = price(anchor);
      const fixed = price(i);
      fixedAnchorUsd += fixed.usd ?? 0; fixedAnchorWrite += fixed.write;
      for (const [name,alternate] of Object.entries(r.variants ?? {})) {
        const main = price(anchor,alternate), sameStep = price(i,alternate);
        const summary = scenarioTotals[name] ??= { calls:0, estimatedCacheWrite:0, fixedAnchorCacheWrite:0, wireBytes:0, maxWireBytes:0, imageOccurrences:0, estimatedInputTokens:0, estimatedCacheRead:0, ...(rate ? {estimatedUsd:0, fixedAnchorUsd:0} : {}), steps:[] };
        const requestBytes = alternate.inputAndToolBytes + gap[i];
        summary.wireBytes += requestBytes; summary.maxWireBytes = Math.max(summary.maxWireBytes,requestBytes);
        summary.imageOccurrences += alternate.pics; summary.estimatedInputTokens += main.total; summary.estimatedCacheRead += main.read;
        summary.calls++; summary.estimatedCacheWrite += main.write; summary.fixedAnchorCacheWrite += sameStep.write;
        if (rate) { summary.estimatedUsd += main.usd; summary.fixedAnchorUsd += sameStep.usd; }
        summary.steps.push({ step:i+1, cacheWrite:main.write, usd:main.usd, inputTokens:main.total, prevIsExactPrefix:alternate.prevIsExactPrefix });
      }
      const audit = r.audited && priceCacheAudit(r.audited, r.features, r.prefix, weights, { total, read,write,usd, wireBytes:r.inputAndToolBytes + gap[i] },fixed,anchor+1);
      return { ...(audit ? { audit } : {}), step: i + 1, wireBytes: r.inputAndToolBytes + gap[i], pics: r.pics, base64: r.base64,
        total, read, write, output, usd };
    });
    assert.equal(totals(step,"output"), totals(bills,"output"), "Budget lost historical output");
    if (result.deliveryContext) {
      for (const [i,check] of result.deliveryContext.steps.entries()) {
        check.baselineWireBytes = check.baselineInputAndToolBytes + gap[check.step-1];
        delete check.baselineInputAndToolBytes;
        check.sentWireBytes = step[i].wireBytes;
      }
    }
    return { ...(result.deliveryContext ? { deliveredContext:result.deliveryContext, maxWireBytes:Math.max(...step.map(r => r.wireBytes)) } : {}), ...(scenario.audit ? { cacheAudit:{
      summary:summarizeCacheAudit(step.map(row => row.audit)), rows:step.map(row => row.audit), scenarios:scenarioTotals, scenarioChecks:result.variantChecks,
      attributionBasis:"A request's estimated write is anchored to the billing log. Source features measure the serialized suffix after the exact common prefix with the immediately previous request, not the provider's cache boundary. The signed model offset reconciles that weighted suffix with the anchored write estimate; sources are not per-block billing records.",
    } } : {}), ...(scenario.reuse || scenario.guide || scenario.capabilities ? {
        unchangedProductionCalls: productionCalls.reduce((a,c) => ({ ...a, [c.name]: (a[c.name] ?? 0) + 1 }), {}),
        reusedTools: result.reused, removedAdditionalSteps: result.skipped, narrowerToolResults: result.scopeChanges,
        identicalVisualContextsChecked: result.rows.length + result.skipped.length + (scenario.pairs?.length ?? 0), transferredVisualDecisions: result.comparisonTransfers,
        ...(scenario.live ? { postRunVisualReviews:result.runReviews, unchangedDelivery:result.delivery } : {}),
        ...(scenario.reuse ? { cacheAnchorSensitivity: { fixedStepEstimatedCacheWrite: fixedAnchorWrite,
          fixedStepEstimatedUsd: rate ? +fixedAnchorUsd.toFixed(6) : undefined } } : {}) } : {}),
      calls: step.length, wireBytes: totals(step, "wireBytes"), imageOccurrences: totals(step, "pics"), imageBase64Bytes: totals(step, "base64"),
      firstUseImagesVerified: result.refreshed, byteIdenticalComparisonRequests: result.reviews.map(r => ({ step: r.step, pictures: r.ids.length })),
      estimatedInputTokens: totals(step, "total"), estimatedCacheRead: totals(step, "read"), estimatedCacheWrite: totals(step, "write"),
      assumedOutputTokens: totals(step, "output"), estimatedUsd: rate ? +totals(step, "usd").toFixed(6) : undefined, ...(values.rows ? { steps: step } : {}) };
  };
  const batchCheck = values["batch-edits"] ? await (await import("./replay-agent-edits.mjs")).replayAgentEdits(branch) : undefined;
  const report = { actual, ...(!project ? { unchangedDecisions: await compare(new Set()) } : {}),
    ...(optIn.size && !project ? { conditionalExplicitVisualRelease: { after: [...optIn], ...await compare(optIn) } } : {}),
    ...(batchCheck ? { conditionalBatchedEdits: { releaseAfter: [...optIn], verifiedGroups: batchCheck.groups, removedSteps: batchCheck.removedSteps,
      ...await compare(optIn, batchCheck.groups, { rememberVision: true }) } } : {}),
    calibration: { historicalMeanAbsoluteInputTokenError: Math.round(mean(historical.rows.map((r,i) => Math.abs(dot(r.features, weights) - bills[i].total)))),
      historicalMeanAbsoluteCachedTokenError: Math.round(mean(historical.rows.map((r,i) => Math.abs(dot(r.prefix, weights) - bills[i].read)))),
      pricePerMillionOrdinaryReadWriteOutput: rate, weights },
    assumptions: ["Same recorded decisions in unchangedDecisions. Candidate tool/rule sections use current Pi and project metadata. Other historical prompt sections and non-search tool results are held fixed. Explicit handoffs and verified batches require different model decisions. Batch forecasts retain all original output tokens.",
      "Estimates apply the calibrated change in whole input and adjacent exact-prefix features to each observed input and cache reading; ordinary input and output remain as billed. The upstream cache, tokenizer and candidate charges are unobserved.",
      "All new image occurrences must appear with the historical MIME type, identical image bytes and original order on their first model request, after wire budgets."] };
  const advanced = { reuse: values["reuse-reads"], guide: values["diagnostic-guide"], capabilities: values["image-capabilities"] };
  if (Object.values(advanced).some(Boolean) && !project) {
    assert(batchCheck, "Compare the additional scenarios against --batch-edits");
    report.additionalScenarios = {};
    for (const name of Object.keys(advanced).filter(key => advanced[key])) {
      report.additionalScenarios[name] = await compare(optIn, batchCheck.groups, { [name]: true });
    }
    if (Object.values(advanced).filter(Boolean).length > 1) report.additionalScenarios.combined = await compare(optIn,batchCheck.groups,advanced);
    report.assumptions.push("Additional scenarios preserve the visual context of every retained decision; omitted text-read decisions transfer to an identical visual context. Cost anchors transfer the first skipped read's original input and cache terms to the next retained request. fixedStep is the sensitivity result using the original unshifted anchor. These are modeled cache behaviors.");
  }
  if (values["save-run"]) {
    report.reproduction = { directory:process.cwd(), executable:process.execPath, arguments:[...process.execArgv,...process.argv.slice(1)] };
    const pairs = await verifiedBlenderPairs({ branch, sessionFile:values.session, batchGroups:batchCheck.groups, scratch:cache });
    assert(pairs.length, "No eligible script saves with byte-identical retained jobs");
    const current = { ...advanced, live:true, implemented:true };
    report.currentProduction = { pairs:pairs.map(({receipt,...evidence}) => evidence),
      separate: await compare(optIn,batchCheck.groups,current),
      samePiBatch: await compare(optIn,batchCheck.groups,{ ...current,pairs,audit:values["cache-audit"] }) };
    assert.equal(report.currentProduction.separate.calls - report.currentProduction.samePiBatch.calls,pairs.length);
    if (values["cache-audit"]) {
      const batch = report.currentProduction.samePiBatch;
      if (values["visual-layout"] || values["text-layout"])
        report.layoutExperimentsBeforeRetention = await compare(optIn,batchCheck.groups,{...current,implemented:false,pairs,audit:true});
      const userBoundaries = [];
      let needsFirstAssistant = false, assistantStep = 0;
      for (const e of branch) {
        if (e.message?.role === "user") needsFirstAssistant = true;
        if (e.message?.role !== "assistant") continue;
        assistantStep++;
        if (needsFirstAssistant) userBoundaries.push(assistantStep);
        needsFirstAssistant = false;
      }
      batch.cacheAudit.billingSensitivity = estimateCacheHitSensitivity({
        audit:batch.cacheAudit, historicalRows:historical.rows, bills, userBoundaries, output:batch.assumedOutputTokens, rate });
      if (report.layoutExperimentsBeforeRetention) {
        const reference = report.layoutExperimentsBeforeRetention;
        reference.cacheAudit.billingSensitivity = estimateCacheHitSensitivity({
          audit:reference.cacheAudit,historicalRows:historical.rows,bills,userBoundaries,output:reference.assumedOutputTokens,rate });
      }
      if (values["compare-4mib"]) {
        const archive = JSON.parse(await readFile(values["compare-4mib"],"utf8"));
        assert.deepEqual(archive.actual,actual,"Previous audit does not match these bills and recorded requests");
        assert.deepEqual(archive.calibration,report.calibration,"Pricing, input or cache calibration differs from the audit");
        const before = archive.currentProduction.samePiBatch;
        const forecast = before.cacheAudit.scenarios.bounded4MiBAndRolePreservingHandoff;
        assert(forecast,"Missing historical 4 MiB forecast");
        for (const key of ["unchangedProductionCalls","byteIdenticalComparisonRequests","firstUseImagesVerified","postRunVisualReviews","unchangedDelivery","assumedOutputTokens"])
          assert.deepEqual(batch[key],before[key],"Production evidence changed: "+key);
        assert.deepEqual(batch.deliveredContext.steps.map(s => [s.step,s.baselineWireBytes,s.requiredImages]),
          before.cacheAudit.rows.map(s => [s.step,s.wireBytes,s.images.length]),"The pre-retention control no longer reproduces the old layout");
        assert.equal(batch.wireBytes-batch.deliveredContext.forecastDifferences.inputByteDelta,forecast.wireBytes,
          "The reference layout no longer reproduces the archived forecast's serialized size");
        const metrics = v => ({
          calls:v.calls, cacheWrite:v.estimatedCacheWrite, cacheRead:v.estimatedCacheRead, input:v.estimatedInputTokens, usd:v.estimatedUsd,
          wireBytes:v.wireBytes, maxWireBytes:v.maxWireBytes ?? Math.max(...v.cacheAudit.rows.map(s => s.wireBytes)), images:v.imageOccurrences,
          fixedAnchorCacheWrite:v.fixedAnchorCacheWrite ?? v.cacheAnchorSensitivity?.fixedStepEstimatedCacheWrite,
          fixedAnchorUsd:v.fixedAnchorUsd ?? v.cacheAnchorSensitivity?.fixedStepEstimatedUsd,
        });
        report.deliveredContextComparison = { before:metrics(before), predicted:metrics(forecast), implemented:metrics(batch),
          extraBytes:batch.wireBytes-before.wireBytes, cacheWritesSaved:before.estimatedCacheWrite-batch.estimatedCacheWrite,
          sameSessionAndRates:true, referenceRequestsChecked:before.cacheAudit.rows.length };
      }
    }
    if (values["prior-report"]) {
      const previous = JSON.parse(await readFile(values["prior-report"],"utf8"));
      assert.deepEqual(previous.actual,report.actual,"Prior report must describe the same billed session");
      const old = previous.additionalScenarios.combined;
      report.currentProduction.previousEstimate = { calls:old.calls, estimatedCacheWrite:old.estimatedCacheWrite, estimatedUsd:old.estimatedUsd };
    }
    report.assumptions.push("Both current-production scenarios use the same checked-out project instructions, migrated Canvas instructions, workflow guides, tool declarations and recorded image catalog. Other system sections and transient results stay historical. Both use the first skipped read's input and cache anchor; fixedStep uses the next retained request's original anchor as a sensitivity check.",
      "The measured request inputs use the shipped completed-delivery file projection and previous-tool image policy. Saved historical decisions, success receipts, all output tokens and user corrections are held fixed. Successful HTTP completions are simulated locally. Image bytes and ordering are checked before pricing. Provider billing and actual future model choices are not measured.",
      "Pairing retains both original tool calls, IDs, parameters, and model-visible receipts. Current host-only version fields are reconstructed from production file writes and matched to the delivered and private staged scripts. Retained inputs and original job identities match. The production reuse check accepts the matching version and rejects missing or failed saves and unversioned results. No Blender, generation or model request is executed. Upstream cache behavior and actual model choices, output and fees remain unobserved.");
  }
  if (values["save-baseline"]) {
    assert(firstUsePreviews.size === 0, "Historical first-use previews differ from originals. Reuse the historical build for a byte-for-byte comparison.");
    await writeFile(values["save-baseline"], JSON.stringify({ version: 1, sessionId, requestEvidence, historical }) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(cache, { recursive: true, force: true }); }
