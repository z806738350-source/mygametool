import { defineTool, type SessionEntry } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";
import { CHARACTER_VIEW_DIRECTIONS, type CharacterViewDirection } from "../shared/character-views.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { CHECKPOINT_ENTRY, parseStoredCheckpoint } from "./checkpoint-extension.js";
import { inspectPublishedSpriteWalk, readPublishedSpriteWalkIdentity, type WalkProject } from "./sprite-walk-review.js";
import type { repairPublishedSpriteWalk } from "./sprite-walk-publish.js";

type Direction = CharacterViewDirection;
type ActionTarget = { setId: string; actionId: string };
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(v);
type Receipt = { setId: string; revision: string; direction: Direction; status: "pass" | "fail" | "inconclusive" };
type Dependencies = { identity: typeof readPublishedSpriteWalkIdentity; inspect: typeof inspectPublishedSpriteWalk };
const published: Dependencies = { identity: readPublishedSpriteWalkIdentity, inspect: inspectPublishedSpriteWalk };
const reviewName = "review_sprite_walk", repairName = "repair_sprite_walk";
export const setId = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,47}$" });
export const rect = Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const limb = Type.Object({ hand: rect, foot: rect }, { additionalProperties: false });
export const direction = Type.Union(CHARACTER_VIEW_DIRECTIONS.map(d => Type.Literal(d)));
const contacts = Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { minItems: 2, maxItems: 2, uniqueItems: true }));
const repairSchema = Type.Object({
  setId, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), candidateDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  directions: Type.Array(Type.Object({ direction, landmarks: Type.Optional(Type.Object({ left: limb, right: limb, body: Type.Optional(rect) }, { additionalProperties: false })), contacts }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });
const contactPair = (values?: number[]): [number, number] | undefined => values ? [values[0]!, values[1]!] : undefined;
export const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export const image = (bytes: Buffer) => ({ type: "image" as const, mimeType: "image/png" as const, data: bytes.toString("base64") });

export function createSpriteWalkTool(project: WalkProject, supportsImages: boolean, gate: () => void, deps = published) {
  return defineTool({
    name: reviewName, label: "Review character walk",
    description: "Inspect one published biped walk direction against its standing view for torn joints and opposite hand/foot movement. Start with setId and direction; the tool marks and tracks the visible hands and boots. Inspect the marked standing image. Override landmarks only when the marked anatomical locations are wrong or inconclusive. Optional contacts identify two different zero-based foot-contact frames.",
    parameters: Type.Object({ setId, direction, landmarks: Type.Optional(Type.Object({ left: Type.Optional(limb), right: Type.Optional(limb), body: Type.Optional(rect) }, { additionalProperties: false })), contacts }, { additionalProperties: false }),
    execute: async (_id, { setId, direction, landmarks, contacts }, signal) => {
      gate();
      const { preview, ...result } = await deps.inspect(project, setId, direction, landmarks, contactPair(contacts), signal, supportsImages);
      const visual = supportsImages && !!preview;
      const text = JSON.stringify(visual ? result : { ...result, visualReview: "No pixels were delivered to this connection. Numeric results alone cannot complete visual review." });
      return { content: [{ type: "text" as const, text }, ...(visual ? [image(preview!)] : [])],
        details: { spriteWalkReview: { setId, direction, revision: result.revision, status: !visual && result.status === "pass" ? "inconclusive" : result.status } satisfies Receipt } };
    },
  });
}

export function sawSpriteCandidate(entries: readonly SessionEntry[], toolName: string, receiptName: string,
  input: { setId: string; actionId?: string; expectedRevision: string; candidateDigest?: string }) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const e = entries[index]!;
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") break;
    if (m.role !== "toolResult" || m.isError || m.toolName !== toolName) continue;
    const preview = record(record(m.details)?.[receiptName]);
    if (preview?.setId === input.setId && preview.actionId === input.actionId &&
        preview.revision === input.expectedRevision && preview.candidateDigest === input.candidateDigest) return true;
  }
  return false;
}

export function createSpriteWalkRepairTool(
  supportsImages: boolean, history: () => SessionEntry[],
  run: (input: Parameters<typeof repairPublishedSpriteWalk>[1], signal?: AbortSignal) => ReturnType<typeof repairPublishedSpriteWalk>,
) {
  const tool = defineTool({
    name: repairName, label: "Repair character walk",
    description: "Repair damaged cutout walk directions using the published standing PNGs. Start with directions containing only direction names. The tool locates and tracks hands and boots; override landmarks when the actual marked regions are wrong. First omit candidateDigest to preview without writing. Inspect the strips for shape, contact, seams and natural movement, then repeat with the returned candidateDigest to publish the exact pixels. Failed candidates are never written.",
    parameters: repairSchema, executionMode: "sequential",
    execute: async (_id, input, signal) => {
      if (!supportsImages) return { content: [{ type: "text" as const, text: "This connection cannot visually inspect the repair candidate. No change was made. Describe this limitation before reporting visual acceptance." }], details: { spriteWalkAttempt: { setId: input.setId } } };
      if (input.candidateDigest && !sawSpriteCandidate(history(), repairName, "spriteWalkPreview", input))
        throw toolPreflightError("Preview this exact candidate in the current task, inspect its strips, then use the returned candidateDigest.", "invalid_sprite_walk_input");
      const { previews, ...result } = await run({ ...input, directions: input.directions.map(d => ({ ...d, contacts: contactPair(d.contacts) })) }, signal);
      const images = (previews ?? []).flatMap(p => [{ type: "text" as const, text: p.direction }, image(p.data)]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }, ...images], details: {
        spriteWalkAttempt: { setId: input.setId },
        ...(images.length && result.candidateDigest && !input.candidateDigest ? { spriteWalkPreview: { setId: input.setId, revision: input.expectedRevision, candidateDigest: result.candidateDigest } } : {}),
        ...(result.changed.length ? { spriteWalkRepair: { setId: input.setId, revision: result.revision, changed: result.changed, reviews: result.reviews } } : {}),
      } };
    },
  });
  return Object.assign(tool, { canReuseResult: () => false });
}

function readReceipt(value: unknown): Receipt | undefined {
  const v = record(value);
  if (!v || typeof v.setId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(v.setId) ||
      typeof v.revision !== "string" || !CHARACTER_VIEW_DIRECTIONS.includes(v.direction as Direction) ||
      !["pass", "fail", "inconclusive"].includes(String(v.status))) return;
  return { setId: v.setId, direction: v.direction as Direction, revision: v.revision, status: v.status as Receipt["status"] };
}

function requiredDirections(text: string, available: readonly Direction[] = CHARACTER_VIEW_DIRECTIONS) {
  if (!/all eight|eight.direction|all (?:other|remaining)|remaining six|八[个個]?向|八[个個]方向|补齐|其[余餘]六|全部/i.test(text) &&
      /\bonly\b|\bpilot\b|仅|僅|只(?:做|检查|查|修|验|測|测)|样片|樣片/i.test(text)) {
    const names = [...text.matchAll(/(?<![a-z])(?:NE|NW|SE|SW|[NSEW])(?![a-z])/gi)].map(m => m[0]!.toUpperCase());
    if (names.length) return CHARACTER_VIEW_DIRECTIONS.filter(d => names.includes(d));
  }
  return /all eight|eight.direction|八[个個]?向|八[个個]方向/i.test(text) ? CHARACTER_VIEW_DIRECTIONS : available;
}

function taskEvidence(project: WalkProject, entries: readonly SessionEntry[]) {
  const start = entries.findLastIndex(e => e.type === "message" && e.message.role === "user");
  const entry = entries[start];
  if (entry?.type !== "message" || entry.message.role !== "user") return;
  const packageRoot = path.resolve(project.workspacePath, project.startupDirectory ?? ".", "public/characters");
  const changes = new Map<string, Set<string>>(), registered = new Set<string>(), receipts: Receipt[] = [];
  const calls = new Map<string, unknown[]>(), played = new Map<string, string>();
  const actionTasks = new Map<string, ActionTarget & { explicit: boolean; inferred: boolean }>();
  const actionReceipts: (Receipt & { actionId: string })[] = [];
  const actionPlayed = new Map<string, string>();
  const namedActions: string[] = [];
  const actionFiles = new Map<string, Set<string>>();
  function addAction(setId: unknown, actionId: unknown, explicit: boolean, inferred = false) {
    if (!validId(setId) || !validId(actionId) || actionId === "manifest") return;
    const key = setId + "/" + actionId;
    const existing = actionTasks.get(key);
    if (!existing || !inferred) actionTasks.set(key, { setId, actionId, explicit: explicit || !!existing?.explicit, inferred });
  }
  let userText = "", biped = false, walkRequested = false, authoring = false, inquiry = false, opaqueWrite = false;
  function addPath(p: unknown, current: boolean, isRead = false) {
    if (typeof p !== "string") return;
    const parts = path.relative(packageRoot, path.resolve(project.workspacePath, p)).split(path.sep);
    const [id, ...rest] = parts, name = rest.join("/");
    if (current && validId(id)) {
      const asset = /^([a-z0-9][a-z0-9_-]{0,47})\.(json|png)$/.exec(name);
      if (asset && asset[1] !== "manifest") {
        const key = id + "/" + asset[1], files = actionFiles.get(key) ?? new Set();
        files.add(asset[2]!);
        actionFiles.set(key, files);
        addAction(id, asset[1], namedActions.includes(asset[1]!) || asset[1] !== "walk" && files.size === 2);
      }
      if (name === "manifest.json" && isRead && authoring) for (const action of namedActions) addAction(id, action, true, true);
    }
    const standingRead = current && isRead && name === "manifest.json" && biped && walkRequested && authoring;
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || !(standingRead || name === "walk.json" || name.endsWith(".png"))) return;
    if (biped && /^walk\.(json|png)$/.test(name)) registered.add(id);
    if (!current) return;
    const files = changes.get(id) ?? new Set<string>();
    files.add(name);
    changes.set(id, files);
  }
  function addReceipt(value: unknown) {
    const r = readReceipt(value);
    if (r) { receipts.push(r); registered.add(r.setId); }
  }
  for (const [i, e] of entries.entries()) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") {
      userText = (typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n")).split(/<(?:editor-context|local-attachments)>/)[0]!;
      biped = /\bbiped(?:al)?\b|humanoid|two[- ]legged|opposite arm|arm.swing|双足|双腿|两条腿|左右脚|顺拐|摆臂|手脚配合|[同对]侧(?:手脚|手臂)|手脚(?:同侧|交替)|人形(?:角色|机器人)/i.test(userText);
      // A request can protect the approved idle art while authorizing changes to the walk.
      const request = userText
        .replace(/(?:不要|别)(?:修改|改动|更改|改|修)(?:已经?|通过|批准|确认|发布|验收|原有|原始|现有|的|[一二三四五六七八九十\d]+[张个向])*站姿(?:图集|原图|素材|图片|资源|文件|帧|图)?(?=\s*[，。；！？,.;!?\n]|\s*$)/g, "")
        .replace(/\b(?:do not|don['’]t) (?:modify|change|fix|touch) (?:(?:the|existing|original|approved|published|eight|8) )*(?:idle|standing)(?: (?:poses?|sprites?|frames?|images?|art|assets?))?(?=\s*[,.;!?\n]|\s*$)/gi, "");
      walkRequested = /walk|gait|步态|步行|行走|走路|跑步/i.test(request) && !/(?:不要|无需|不用|不需要)(?:制作|生成|做|修改)?(?:步态|步行|行走|走路)|(?:without|skip|no) (?:the |a )?(?:walk|gait)/i.test(request);
      inquiry = /read[ -]only|review only|only (?:inspect|review|check)|(?:do not|don['’]t) (?:modify|change|fix|touch)|how (?:do|would|can) (?:I|we|you)|只读|(?:只|仅)(?:检查|审查|分析|评估|看看|查看|预览)|不要(?:改|修)|别(?:改|修)|如何|怎么才能/i.test(request);
      authoring = !inquiry && /\b(?:fix|repair|correct|implement|make|create|generate|animate|redraw|deliver|finish|integrate|revise)\b|返修|修复|修好|修正|修改|整改|改好|纠正|制作|做[出成个一]|生成|实现|交付|接入|补齐|完成|让|讓/i.test(request);
      if (i === start && authoring && /sprite|animat|atlas|图集|精灵|动作|动画|狼|四足|双足|机器人|wolf|robot|biped|quadruped/i.test(request)) {
        if (/\btrot(?:ting)?\b|小跑/i.test(request)) namedActions.push("trot");
        if (/\bjump(?:ing)?\b|跳跃|起跳|蹦跳/i.test(request)) namedActions.push("jump");
      }
    } else if (m.role === "assistant") {
      for (const b of m.content) if (b.type === "toolCall" && ["edit", "write", "read", "read_project_file"].includes(b.name)) {
        const args = record(b.arguments);
        calls.set(b.id, [...(Array.isArray(args?.files) ? args.files : []), args?.path]);
      }
    } else if (m.role === "toolResult" && !m.isError) {
      const details = record(m.details);
      if (i > start && (m.toolName === "review_sprite_action" || m.toolName === "repair_sprite_action")) {
        const target = record(details?.spriteActionReview ?? details?.spriteActionAttempt);
        if (target && (authoring || m.toolName === "repair_sprite_action")) addAction(target.setId, target.actionId, true);
        const receipt = readReceipt(target);
        if (receipt && validId(target?.actionId)) actionReceipts.push({ ...receipt, actionId: target.actionId });
      }
      const input = i > start && m.toolName === "game_use" && details?.playtest && !details.playtestReplay ? record(details.spriteActionPlay) : undefined;
      if (input && validId(input.setId) && validId(input.actionId) && typeof input.revision === "string")
        actionPlayed.set(input.setId + "/" + input.actionId, input.revision);
      const play = i > start && m.toolName === "game_use" && details?.playtest && !details.playtestReplay ? record(details.spriteWalkPlay) : undefined;
      if (play && typeof play.setId === "string" && typeof play.revision === "string") played.set(play.setId, play.revision);
      if (m.toolName === reviewName || m.toolName === "game_use") {
        const r = readReceipt(details?.spriteWalkReview);
        if (r) {
          addReceipt(r);
          if (i > start && authoring && m.toolName === reviewName) addPath(path.join(packageRoot, r.setId, "walk.json"), true);
        }
      }
      let paths: unknown[] = [];
      if (m.toolName === repairName) {
        const attempted = record(details?.spriteWalkAttempt)?.setId;
        if (i > start && authoring && typeof attempted === "string" && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(attempted)) {
          registered.add(attempted);
          addPath(path.join(packageRoot, attempted, "walk.json"), true);
        }
        const repair = record(details?.spriteWalkRepair);
        if (repair && Array.isArray(repair.changed) && repair.changed.length && Array.isArray(repair.reviews)) {
          paths = repair.changed;
          for (const r of repair.reviews) addReceipt({ ...record(r), setId: repair.setId, revision: repair.revision });
        }
      } else if (["write", "edit"].includes(m.toolName)) paths = [record(details?.projectFileVersion)?.path, ...(calls.get(m.toolCallId) ?? [])];
      else if (i > start && authoring && ["read", "read_project_file"].includes(m.toolName)) paths = calls.get(m.toolCallId) ?? [];
      else if (["recover_isolated_changes", "build_game", "isolated_shell"].includes(m.toolName) && Array.isArray(details?.changed)) paths = details.changed;
      if (i > start && m.toolName === "bash") opaqueWrite = true;
      for (const p of paths) addPath(p, i > start, m.toolName === "read" || m.toolName === "read_project_file");
    }
  }
  if (inquiry) return;
  const checkpoint = entries[start - 1];
  const before = checkpoint?.type === "custom" && checkpoint.customType === CHECKPOINT_ENTRY && parseStoredCheckpoint(checkpoint.data);
  const checkOpaque = opaqueWrite && (biped || /walk|gait|步态|步行|行走|走路|跑步/i.test(userText) || registered.size > 0 || namedActions.length > 0 || actionTasks.size > 0);
  return { userId: entry.id, biped, changes, registered, receipts, played, actionTasks, actionReceipts, actionPlayed, userText,
    needsPlay: /playtest|playable|in.game|game_use|游戏内|可玩|试玩|实测|运行时|按键|键盘/i.test(userText), required: requiredDirections(userText),
    checkpoint: checkOpaque && before ? before.commit : undefined, addPath };
}

type ChangesSince = (commit: string) => Promise<readonly { path: string }[]>;
type ActionIdentity = (project: WalkProject, setId: string, actionId: string, signal?: AbortSignal) => Promise<{ revision: string; directions: readonly Direction[]; motionName?: string }>;
export async function spriteWalkBoundary(project: WalkProject, entries: readonly SessionEntry[], signal?: AbortSignal, deps = published, changesSince?: ChangesSince, actionIdentity?: ActionIdentity) {
  const task = taskEvidence(project, entries);
  if (!task) return;
  if (task.checkpoint && changesSince) {
    for (const { path } of await changesSince(task.checkpoint)) task.addPath(path, true);
  }
  for (const [setId, files] of task.changes) {
    signal?.throwIfAborted();
    const fromStanding = files.has("manifest.json");
    const conventional = fromStanding || files.has("walk.json") || files.has("walk.png");
    let identity: Awaited<ReturnType<Dependencies["identity"]>>;
    try { identity = await deps.identity(project, setId, signal); }
    catch (cause) {
      signal?.throwIfAborted();
      if (!conventional || !task.registered.has(setId) && !task.biped) continue;
      const reason = cause instanceof Error ? cause.message : "Cannot read the current walk atlas";
      if (fromStanding) return { key: JSON.stringify([task.userId, setId, reason]),
        text: `The published standing manifest for ${setId} was read. The requested walk package is unavailable: ${reason}. Use those standing references to create or repair public/characters/${setId}/walk.json and its atlas, then review the requested directions before delivery.` };
      return { key: JSON.stringify([task.userId, setId, reason]), text: `Character walk ${setId} needs a readable published atlas and manifest. ${reason}. Inspect the saved files and correct the current task before reporting completion.` };
    }
    if (!(fromStanding || files.has("walk.json") || files.has(identity.image)) || identity.biped === false || !(identity.biped || task.biped || task.registered.has(setId))) continue;
    const statuses = new Map(task.receipts.filter(r => r.setId === setId && r.revision === identity.revision).map(r => [r.direction, r.status]));
    const remaining = task.required.filter(d => statuses.get(d) !== "pass");
    const play = { setId, revision: identity.revision };
    if (!remaining.length) {
      if (task.needsPlay && task.played.get(setId) !== identity.revision) return { key: JSON.stringify([task.userId, setId, identity.revision, "play"]), play,
        text: `The requested walk directions for ${setId} passed on this atlas. Open this revision in a fresh game_use window and exercise movement, turns and stops before reporting the playable result.` };
      continue;
    }
    const next = remaining.find(d => identity.directions.includes(d) && !statuses.has(d));
    let sample: Receipt | undefined, finding = "";
    if (next) {
      try {
        const result = await deps.inspect(project, setId, next, undefined, undefined, signal);
        if (result.revision !== identity.revision) return { key: JSON.stringify([task.userId, setId, identity.revision]), text: `The published walk for ${setId} changed during inspection. Review the current files before delivery.` };
        sample = { setId, revision: result.revision, direction: next, status: result.status === "pass" ? "inconclusive" : result.status };
        finding = ` Host observed ${next}: ${JSON.stringify({ seams: result.seams.slice(0, 3), topology: result.topology.slice(0, 3), gait: result.gait.reasons })}.`;
      } catch (cause) {
        signal?.throwIfAborted();
        finding = ` Current ${next} inspection failed: ${cause instanceof Error ? cause.message : "unreadable animation"}.`;
      }
    }
    const pending = remaining.map(d => `${d} (${!identity.directions.includes(d) ? "not published" : statuses.get(d) ?? "unchecked"})`).join(", ");
    return { key: JSON.stringify([task.userId, setId, identity.revision, pending]), sample, play,
      text: `Character walk ${setId} has unfinished review: ${pending}.${finding} Complete the requested directions. Use review_sprite_walk on the current files. Start with setId and direction. Inspect the automatically marked hand/boot locations. For cutout defects preview repair_sprite_walk using the failed direction names, inspect the returned pixels, publish the verified candidate and replay the affected facings. Resolve inconclusive measurements from the actual art. Respect explicit user stops, budgets and required host approvals.` };
  }
  if (!actionIdentity) return;
  const found = new Set<string>();
  for (const [key, target] of [...task.actionTasks].sort((a, b) => Number(a[1].inferred) - Number(b[1].inferred))) {
    signal?.throwIfAborted();
    const { setId, actionId } = target;
    if (target.inferred && found.has(key)) continue;
    let identity: Awaited<ReturnType<ActionIdentity>>;
    try { identity = await actionIdentity(project, setId, actionId, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!target.explicit) continue;
      const reason = error instanceof Error ? error.message : "Unavailable action package";
      return { key: JSON.stringify([task.userId,key,reason]),
        text: `Character action ${key} needs its published manifest and atlas: ${reason}. Prepare the requested package and inspect its actual frames before delivery.` };
    }
    found.add(setId + "/" + (identity.motionName ?? actionId));
    const statuses = new Map(task.actionReceipts.filter(r => r.setId === setId && r.actionId === actionId && r.revision === identity.revision)
      .map(r => [r.direction, r.status]));
    const missing = requiredDirections(task.userText, identity.directions).filter(d => statuses.get(d) !== "pass");
    const play = { setId, actionId, revision: identity.revision };
    if (missing.length) return { key: JSON.stringify([task.userId, key, identity.revision, missing.map(d => [d,statuses.get(d)])]), play,
      text: `Action ${key} needs review on the published PNG: ${missing.map(d => d + " (" + (statuses.get(d) ?? "unchecked") + ")").join(", ")}. Call review_sprite_action with setId, actionId and direction. Inspect the selected landmarks and keyframes. Repair or redraw confirmed failures and review the saved result. For uncertain anatomy examine additional frames yourself, or report exactly what cannot be verified.` };
    if (task.needsPlay && task.actionPlayed.get(key) !== identity.revision)
      return { key: JSON.stringify([task.userId, key, identity.revision, "play"]), play,
        text: `Open the published ${key} revision in a fresh game_use window and trigger the requested action before reporting its playable result.` };
  }
}

type WalkBoundary = (signal?: AbortSignal) => ReturnType<typeof spriteWalkBoundary>;
export function createSpriteWalkFinishReview(boundary: WalkBoundary) {
  let lastKey: string | undefined;
  return async (signal?: AbortSignal) => {
    const pending = await boundary(signal);
    if (!pending) { lastKey = undefined; return; }
    if (pending.key === lastKey) throw new Error(`The published animation is still unverified after a repair opportunity. ${pending.text}`);
    lastKey = pending.key;
    return pending.text;
  };
}

export function spriteWalkFinishTool(tools: readonly { name: string }[]) {
  const review = tools.find(tool => tool.name === reviewName) as { finishWalkReview?: ReturnType<typeof createSpriteWalkFinishReview> } | undefined;
  return review?.finishWalkReview;
}
