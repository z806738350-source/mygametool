import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { crc32 } from "node:zlib";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertMessages as convertCompletionsMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { convertMessages as convertGoogleMessages } from "@earendil-works/pi-ai/api/google-shared";
import type { ImageContent, Message, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_OFFLOAD_ENTRY, IMAGE_ORIGINS_ENTRY, INLINE_IMAGE_HIGH_BYTES, MODEL_REQUEST_HIGH_BYTES, ImageBudgetError, SessionImages, inlineImageScope, prepareSessionImageDisplay, wireImages, recordSessionImageOrigins, sessionImageOrigins, sessionImageReferences, sessionImageReferenceContext } from "../src/daemon/session-images.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const model = openaiProvider().getModels().find((item) => item.input.includes("image"))!;
const image: ImageContent = { type: "image", mimeType: "image/jpeg", data: Buffer.from("same image").toString("base64") };
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-session-images-")); dirs.push(dir);
  const manager = SessionManager.inMemory(dir);
  return { dir, manager, images: new SessionImages(manager, dir) };
}
const context = (manager: SessionManager) => normalizeContext({ messages: convertToLlm(manager.buildSessionContext().messages) });
// Exercise wire-side limits independently from the default per-turn visual projection.
async function budgetPayload(images: SessionImages, manager: SessionManager, selected = model) {
  return { model: selected.id, input: convertResponsesMessages(selected, await images.annotate(context(manager)), new Set(["openai"])) };
}
const astra = { ...model, id: "gpt-6.2-astra", provider: "kunpo", api: "openai-responses" as const, baseUrl: "https://llm.ziy.cc/v1" };
async function projectedPayload(images: SessionImages, manager: SessionManager, selected = model) {
  return { model: selected.id, input: convertResponsesMessages(selected, await images.prepare(context(manager), selected), new Set(["openai"])) };
}
function screenshot(manager: SessionManager, timestamp: number, content = image): string {
  return manager.appendMessage({ role: "toolResult", toolCallId: `call-${timestamp}`, toolName: "game_use", content: [content], isError: false, timestamp });
}

function visualCall(manager: SessionManager, timestamp: number, calls: Omit<ToolCall, "type">[]) {
  manager.appendMessage({ role: "assistant", timestamp, model: astra.id, provider: astra.provider, api: astra.api, stopReason: "toolUse",
    content: calls.map(call => ({ type: "toolCall", ...call })),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}
async function activeImagePayload(manager: SessionManager, images: SessionImages, canRecall = true) {
  const ctx = normalizeContext({ messages: context(manager).messages, tools: canRecall ? [images.recallTool] : [] });
  const result = { input: convertResponsesMessages(astra, await images.prepare(ctx, astra), new Set(["openai"])) };
  await images.budget(result, inlineImageScope(astra));
  return result;
}

describe("session image projection", () => {
  it.each(["within limit", "over limit", "unaccepted", "changed text", "duplicate ID", "offloaded", "new branch", "model switch", "inspection", "retry"] as const)(
    "only carries authentic, accepted Astra tool pictures in the same small visual task (%s)", async scenario => {
      const { manager, images } = await fixture();
      manager.appendMessage({ role: "user", timestamp: 1, content: "Review the work" });
      function observe(n: number, toolName = "read") {
        const toolCallId = `tool-${n}`;
        visualCall(manager, 2*n, [{ id:toolCallId, name:toolName, arguments:{} }]);
        const pixels = Buffer.alloc(scenario === "over limit" ? 3_300_000 : 20, n).toString("base64");
        return manager.appendMessage({ role:"toolResult", toolCallId, toolName, timestamp:2*n+1, isError:false,
          content:[{ type:"text", text:`Result ${n}` }, { ...image, data:pixels }] });
      }
      const scope = inlineImageScope(astra);
      const first = observe(1);
      const second = observe(2);
      const before = await projectedPayload(images, manager, astra);
      await images.budget(before, scope);
      const sent = images.withPreviousToolImages(before, scope);
      if (scenario !== "unaccepted") sent.commit();
      if (scenario === "new branch") { manager.branch(first); observe(4); }
      if (scenario === "model switch") await projectedPayload(images, manager, model);
      if (scenario === "offloaded") manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope, images:[`${first}:0`] });
      const last = observe(3, scenario === "inspection" ? "inspect_3d_views" : "read");
      const base = await projectedPayload(images, manager, astra);
      await images.budget(base, scope);
      if (scenario === "changed text" || scenario === "duplicate ID") {
        const item = base.input.find(item => item.type === "function_call_output" && item.call_id === "tool-1");
        if (item?.type !== "function_call_output" || typeof item.output !== "string") throw new Error("Missing original result");
        if (scenario === "duplicate ID") base.input.push({ ...item }); else item.output += " Revised evidence";
      }
      const full = images.withPreviousToolImages(base, scope);
      if (scenario === "within limit" || scenario === "retry") {
        expect(wireImages(full.payload).map(p => p.id)).toEqual([first,second,last].map(id => `${id}:0`));
        const original = before.input.find(item => item.type === "function_call_output" && item.call_id === "tool-1");
        expect(full.payload.input.find(item => item.type === "function_call_output" && item.call_id === "tool-1")).toEqual(original);
        if (scenario === "retry") {
          full.discard();
          expect(images.withPreviousToolImages(base, scope).payload).toBe(base);
        }
      } else {
        expect(full.payload).toBe(base);
        expect(wireImages(full.payload).map(p => p.id)).not.toContain(`${first}:0`);
      }
    });

  it("keeps an accepted render in place when its paired feedback image is still active", async () => {
    const { manager, images } = await fixture();
    const user = manager.appendMessage({ role: "user", timestamp: 1, content: [image] });
    visualCall(manager, 2, [{ id: "release", name: "recall_image", arguments: { releaseReviewedImages: true } }]);
    manager.appendMessage({ role: "toolResult", timestamp: 3, toolCallId: "release", toolName: "recall_image", isError: false, content: [] });
    function observe(n: number, size: number) {
      const toolCallId = `observation-${n}`;
      visualCall(manager, n, [{ id: toolCallId, name: "read", arguments: {} }]);
      return manager.appendMessage({ role: "toolResult", toolCallId, toolName: "read", timestamp: n + 1, isError: false,
        content: [{ ...image, data: Buffer.alloc(size, n).toString("base64") }] });
    }
    const scope = inlineImageScope(astra);
    const first = observe(4, 1_100_000);
    const second = observe(6, 2_400_000);
    const previous = images.withPreviousToolImages(await activeImagePayload(manager, images), scope);
    previous.commit();
    const fresh = observe(8, 2_400_000);
    const base = await activeImagePayload(manager, images);
    expect(wireImages(base).map(p => p.id)).toEqual([`${user}:0`, `${second}:0`, `${fresh}:0`]);
    const expanded = images.withPreviousToolImages(base, scope);
    expect(expanded.payload.input.slice(0, previous.payload.input.length)).toEqual(previous.payload.input);
    expect(wireImages(expanded.payload).map(p => p.id)).toEqual([`${first}:0`, `${user}:0`, `${second}:0`, `${fresh}:0`]);
  });

  it("keeps complete visual comparisons until a successful explicit handoff, then recalls original bytes on the same branch", async () => {
    const { manager, images, dir } = await fixture();
    const makeImage = (label: string) => ({ ...image, data: Buffer.from(label).toString("base64") });
    const original = makeImage("design");
    const views = ["front", "left", "back"].map(makeImage);
    const user = manager.appendMessage({ role: "user", timestamp: 1, content: [original] });
    visualCall(manager, 2, [{ id: "views", name: "inspect_3d_views", arguments: {} }]);
    const inspected = manager.appendMessage({ role: "toolResult", timestamp: 3, toolCallId: "views", toolName: "inspect_3d_views", isError: false, content: [original, ...views] });
    visualCall(manager, 4, [{ id: "place-nodes", name: "edit", arguments: { path: "canvas/boards/scene.json" } }]);
    const beforeRelease = manager.appendMessage({ role: "toolResult", timestamp: 5, toolCallId: "place-nodes", toolName: "edit", isError: false, content: [] });
    const pixels = (payload: unknown) => wireImages(payload).map(item => item.data);
    expect(pixels(await activeImagePayload(manager, images))).toEqual([original, ...views].map(item => item.data));
    visualCall(manager, 6, [{ id: "save", name: "write", arguments: { path: "canvas/assets.json", releaseReviewedImages: true } }]);
    manager.appendMessage({ role: "toolResult", timestamp: 7, toolCallId: "save", toolName: "write", isError: false, content: [] });
    const released = await activeImagePayload(manager, images);
    expect(pixels(released)).toEqual([]);
    for (const id of [`${user}:0`, ...[0, 1, 2, 3].map(i => `${inspected}:${i}`)]) expect(JSON.stringify(released)).toContain(`Session image: ${id}`);
    const reopened = SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])));
    expect(await activeImagePayload(reopened, new SessionImages(reopened, dir))).toEqual(released);
    const args = { imageId: `${inspected}:2` };
    visualCall(manager, 8, [{ id: "recheck", name: "recall_image", arguments: args }]);
    const recalled = await images.recallTool.execute("recheck", args, undefined, undefined, {} as never);
    manager.appendMessage({ role: "toolResult", timestamp: 9, toolCallId: "recheck", toolName: "recall_image", isError: false, content: recalled.content });
    const nextReview = await activeImagePayload(manager, images);
    expect(nextReview.input.find(item => "role" in item && item.role === "user")).toEqual(released.input.find(item => "role" in item && item.role === "user"));
    expect(pixels(nextReview)).toEqual([views[1]!.data, original.data]);
    for (const [i, view] of [[10, views[0]!], [12, views[2]!]] as const) {
      visualCall(manager, i, [{ id: `view-${i}`, name: "read", arguments: {} }]);
      manager.appendMessage({ role: "toolResult", timestamp: i + 1, toolCallId: `view-${i}`, toolName: "read", isError: false, content: [view] });
    }
    const latestReview = await activeImagePayload(manager, images);
    expect(latestReview.input.find(item => "role" in item && item.role === "user")).toEqual(released.input.find(item => "role" in item && item.role === "user"));
    expect(pixels(latestReview)).toEqual([original.data, views[0]!.data, views[2]!.data]);
    manager.appendMessage({ role: "user", timestamp: 14, content: [makeImage("new reference")] });
    expect(pixels(await activeImagePayload(manager, images))).toEqual([makeImage("new reference").data]);
    manager.branch(beforeRelease);
    expect(pixels(await activeImagePayload(manager, images))).toEqual([original, ...views].map(item => item.data));
  });

  it.each(["failed sibling", "pending sibling", "new image", "mismatched receipt", "unavailable recall", "ordinary edit", "standalone release", "Blender save and run", "Blender failure without saved recipe", "Blender failure after verified save"])("respects the image handoff boundary for %s", async scenario => {
    const { manager, images } = await fixture();
    manager.appendMessage({ role: "user", timestamp: 1, content: [image] });
    const standalone = scenario === "standalone release";
    const blender = scenario.startsWith("Blender");
    const saved = scenario === "Blender failure after verified save";
    const failed = saved || scenario === "Blender failure without saved recipe";
    const handoff: Omit<ToolCall, "type"> = { id: "handoff", name: standalone ? "recall_image" : blender ? "run_blender" : "edit",
      arguments: scenario === "ordinary edit" ? {} : { releaseReviewedImages: true, ...(blender ? { save: { content: "pass" } } : {}) } };
    const peer = { id: "check", name: "read", arguments: { path: "scene" } };
    visualCall(manager, 2, standalone ? [handoff] : [handoff, peer]);
    manager.appendMessage({ role: "toolResult", timestamp: 3, toolCallId: "handoff", toolName: handoff.name, isError: failed,
      content: standalone ? (await images.recallTool.execute("handoff", { releaseReviewedImages: true }, undefined, undefined, {} as never)).content : [],
      ...(failed ? { details: { blender: { status: "failed" }, ...(saved ? { projectFileVersion: { path: "stage.py", sha256: "a".repeat(64) } } : {}) } } : {}) });
    const extra = { ...image, data: Buffer.from("new review").toString("base64") };
    if (!standalone && scenario !== "pending sibling") manager.appendMessage({ role: "toolResult", timestamp: 4,
      toolCallId: scenario === "mismatched receipt" ? "other" : peer.id, toolName: peer.name, isError: scenario === "failed sibling", content: scenario === "new image" ? [extra] : [] });
    const actual = wireImages(await activeImagePayload(manager, images, scenario !== "unavailable recall")).map(item => item.data);
    expect(actual).toEqual(standalone || saved || scenario === "Blender save and run" ? [] : scenario === "new image" ? [image.data, extra.data] : [image.data]);
    if (standalone) await expect(images.recallTool.execute("conflict", { releaseReviewedImages: true, imageId: "abc:0" }, undefined, undefined, {} as never)).rejects.toThrow("separately");
  });

  it("lists canonical image occurrences without sending pixels, provenance or descriptions", async () => {
    const { manager, images } = await fixture();
    const user = manager.appendMessage({ role: "user", timestamp: 1, content: [{ type: "text", text: "PRIVATE_REFERENCE_DESCRIPTION" }, image, image] });
    const tool = screenshot(manager, 2);
    const custom = manager.appendCustomMessageEntry("visual", [image], false, { url: "https://invalid.example/private" });
    manager.appendCustomEntry("not-an-image-message", { content: [image] });
    const entries = structuredClone(manager.getBranch());
    const references = sessionImageReferences(entries);
    expect(references).toEqual([`${user}:0`, `${user}:1`, `${tool}:0`, `${custom}:0`].map(imageId => ({ imageId, mimeType: image.mimeType })));
    const manifest = sessionImageReferenceContext(entries)!;
    expect(manifest).toContain("This list contains no image pixels");
    expect(manifest).toContain("only to the reference list");
    expect(manifest).toContain("Use recall_image with the exact imageId");
    expect(manifest).toContain("Text descriptions are not visual evidence");
    for (const value of [image.data, "PRIVATE_REFERENCE_DESCRIPTION", "invalid.example", "libraryAssetId"]) expect(manifest).not.toContain(value);
    for (const { imageId } of references) {
      const result = await images.recallTool.execute("recall", { imageId }, undefined, undefined, {} as never);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("separate image content block") });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("provider-side processing is not visible") });
      expect(result.content[1]).toEqual(image);
    }
    expect(manager.getBranch()).toEqual(entries);
  });

  it("bounds the manifest to the latest 64 references and keeps it branch and session local", async () => {
    const { manager, images, dir } = await fixture();
    const before = manager.appendMessage({ role: "user", content: "Before references", timestamp: 1 });
    const ids = Array.from({ length: 70 }, (_, index) => screenshot(manager, index + 2));
    const manifest = sessionImageReferenceContext(manager.getBranch())!;
    const listed = manifest.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    expect(sessionImageReferences(manager.getBranch())).toHaveLength(70);
    expect(listed).toEqual(ids.slice(-64).map(id => ({ imageId: `${id}:0`, mimeType: image.mimeType })));
    expect(manifest).toContain("6 older image references are omitted from this list.");
    const list = async (offset?: number) => (await images.recallTool.execute("list", { offset }, undefined, undefined, {} as never)).content;
    expect(await list()).toEqual([{ type: "text", text: manifest }]);
    const older = await list(64);
    expect(older).toEqual([{ type: "text", text: expect.stringContaining(`${ids[0]}:0`) }]);
    expect(older[0]).toMatchObject({ text: expect.not.stringContaining(`${ids[6]}:0`) });
    expect(await list(70)).toEqual([{ type: "text", text: "No retained image references on this page." }]);
    manager.branch(before);
    const branch = manager.getBranch();
    expect(sessionImageReferences(branch)).toEqual([]);
    expect(sessionImageReferenceContext(branch)).toBeUndefined();
    expect(await list()).toEqual([{ type: "text", text: "No retained image references on this page." }]);
    await expect(images.recallTool.execute("recall", { imageId: `${ids[0]}:0` }, undefined, undefined, {} as never)).rejects.toThrow("branch");
    expect(sessionImageReferences(SessionManager.inMemory(dir).getBranch())).toEqual([]);
  });

  it("retains references across serialized reopening, explicit omission and compaction", async () => {
    const { manager, dir } = await fixture();
    const old = manager.appendMessage({ role: "user", content: [image], timestamp: 1 });
    const kept = screenshot(manager, 2);
    manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope: "inline", images: [`${old}:0`] });
    manager.appendCompaction("Previous observations were summarized", kept, 1000);
    const expected = sessionImageReferences(manager.getBranch());
    const reopened = SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])));
    expect(sessionImageReferences(reopened.getBranch())).toEqual(expected);
    expect(expected).toEqual([old, kept].map(id => ({ imageId: `${id}:0`, mimeType: image.mimeType })));
    expect(sessionImageReferenceContext(reopened.getBranch())).toBe(sessionImageReferenceContext(manager.getBranch()));
    const result = await new SessionImages(reopened, dir).recallTool.execute("recall", { imageId: `${old}:0` }, undefined, undefined, {} as never);
    expect(result.content[1]).toEqual(image);
  });

  it("keeps identical historical pictures separated by canonical message occurrence and restores recall origins", async () => {
    const { manager, images } = await fixture();
    const assetA = "11111111-1111-4111-8111-111111111111", assetB = "22222222-2222-4222-8222-222222222222";
    const plain = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "same" }, image] };
    const legacy = manager.appendMessage(structuredClone(plain));
    const ids: string[] = [];
    for (const libraryAssetId of [assetA, assetB]) {
      const message = structuredClone(plain);
      expect(recordSessionImageOrigins(manager, message, [{ mediaType: "image/jpeg", data: image.data, libraryAssetId }])).toBe(true);
      ids.push(manager.appendMessage(message));
    }
    const entries = structuredClone(manager.getBranch()), origins = sessionImageOrigins(entries);
    expect(origins.has(legacy)).toBe(false); expect(origins.get(ids[0]!)).toEqual([assetA]); expect(origins.get(ids[1]!)).toEqual([assetB]);
    const prepared = await images.annotate(context(manager));
    const actual = prepared.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []);
    expect(actual.map(block => (block as typeof block & { libraryAssetId?: string }).libraryAssetId)).toEqual([undefined, assetA, assetB]);
    expect(manager.getBranch()).toEqual(entries);
    const recalled = await images.recallTool.execute("recall", { imageId: `${ids[1]}:0` }, undefined, undefined, {} as never);
    expect(recalled.content[1]).toMatchObject({ ...image, libraryAssetId: assetB });
  });

  it.each(["data", "mime", "text", "timestamp", "metadata"])("does not restore a stale URL identity after canonical %s changes", async change => {
    const { manager, images } = await fixture(), libraryAssetId = "11111111-1111-4111-8111-111111111111";
    const message = { role: "user" as const, timestamp: 1, content: [{ type: "text" as const, text: "same" }, { ...image }] };
    expect(recordSessionImageOrigins(manager, message, [{ mediaType: "image/jpeg", data: image.data, libraryAssetId }])).toBe(true);
    if (change === "metadata") {
      const entry = manager.getBranch().find(entry => entry.type === "custom" && entry.customType === IMAGE_ORIGINS_ENTRY)!;
      if (entry.type === "custom") Object.assign(entry.data as object, { url: "https://invalid.example/private" });
    } else if (change === "data") (message.content[1] as typeof image).data = Buffer.from("otherimage").toString("base64");
    else if (change === "mime") (message.content[1] as typeof image).mimeType = "image/png";
    else if (change === "text") (message.content[0] as { text: string }).text = "edit";
    else message.timestamp = 2;
    const id = manager.appendMessage(message);
    expect(sessionImageOrigins(manager.getBranch()).has(id)).toBe(false);
    const prepared = await images.prepare(context(manager), model);
    expect(JSON.stringify(prepared)).not.toContain("libraryAssetId");
  });

  it("rejects changed, dropped and reordered normalized images and keeps missing provenance optional", async () => {
    const { manager } = await fixture(), libraryAssetId = "11111111-1111-4111-8111-111111111111";
    const original = { mediaType: "image/jpeg" as const, data: image.data, libraryAssetId }, other = { ...image, data: Buffer.from("otherimage").toString("base64") };
    for (const pictures of [[], [other], [other, image]]) expect(recordSessionImageOrigins(manager, { role: "user", timestamp: 1, content: pictures }, [original, { mediaType: "image/jpeg", data: other.data }])).toBe(false);
    expect(recordSessionImageOrigins(undefined, { role: "user", timestamp: 1, content: [image] }, [original])).toBe(false);
    expect(manager.getEntries()).toHaveLength(0);
  });

  it("prunes old screenshot occurrences in batches, survives replay, and preserves canonical images", async () => {
    const { manager, images, dir } = await fixture();
    manager.appendMessage({ role: "user", content: "Play", timestamp: 1 });
    const ids = Array.from({ length: 70 }, (_, index) => screenshot(manager, index + 2));
    const original = structuredClone(manager.getEntries());
    const outgoing = await budgetPayload(images, manager);
    expect(wireImages(outgoing)).toHaveLength(70);
    expect(await images.budget(outgoing, "inline")).toBe(true);
    expect(wireImages(outgoing)).toHaveLength(32);
    expect(manager.getEntries().slice(0, original.length)).toEqual(original);
    const offload = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === IMAGE_OFFLOAD_ENTRY);
    expect(offload).toMatchObject({ data: { scope: "inline", images: ids.slice(0, 38).map((id) => `${id}:0`) } });
    const replayed = new SessionImages(manager, dir);
    const again = await budgetPayload(replayed, manager);
    await replayed.budget(again, "inline");
    expect(again).toEqual(outgoing);
    expect(manager.getEntries()).toHaveLength(original.length + 1);
    const recall = await replayed.recallTool.execute("recall", { imageId: `${ids[0]}:0` }, undefined, undefined, {} as never);
    expect(recall.content[1]).toEqual(image);
    const reread = manager.appendMessage({ role: "toolResult", toolCallId: "recall", toolName: "recall_image", content: recall.content, isError: false, timestamp: 100 });
    const recalled = await budgetPayload(replayed, manager); await replayed.budget(recalled, "inline");
    expect(wireImages(recalled).at(-1)?.id).toBe(`${reread}:0`);
    expect(wireImages(recalled)).toHaveLength(33);
  });

  it("reduces Astra's 53-image replay and retains every view from the current parallel read batch", async () => {
    const { manager, images, dir } = await fixture();
    const historyId = manager.appendMessage({ role: "user", timestamp: 1, content: Array(36).fill(image) });
    const current = manager.appendMessage({ role: "user", timestamp: 2, content: Array(13).fill(image) });
    const calls = Array.from({ length: 4 }, (_, i) => ({ type: "toolCall" as const, id: `call_view_${i}`, name: "read", arguments: { path: `view-${i}.png` } }));
    manager.appendMessage({ role: "assistant", content: calls, model: astra.id, provider: astra.provider, api: astra.api, timestamp: 3, stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const batchIds = calls.map((call, i) => manager.appendMessage({ role: "toolResult", timestamp: 4 + i, toolCallId: call.id, toolName: call.name, content: [{ ...image, data: Buffer.from(call.id).toString("base64") }], isError: false }));
    const outgoing = await projectedPayload(images, manager, astra);
    expect(wireImages(outgoing)).toHaveLength(17);
    const scope = inlineImageScope(astra);
    expect(await images.budget(outgoing, scope)).toBe(false);
    const retained = [...Array.from({ length: 13 }, (_, i) => `${current}:${i}`), ...batchIds.map(id => `${id}:0`)];
    expect(wireImages(outgoing).map(view => view.id)).toEqual(retained);
    const fresh = new SessionImages(manager, dir);
    const replay = await projectedPayload(fresh, manager, astra); await fresh.budget(replay, scope);
    expect(wireImages(replay).map(view => view.id)).toEqual(retained);
    const recalled = await fresh.recallTool.execute("recall", { imageId: `${historyId}:0` }, undefined, undefined, {} as never);
    expect(recalled.content[1]).toEqual(image);
    for (const other of [{ ...astra, provider: "custom" }, { ...astra, id: "other" }, { ...astra, api: "openai-completions" as const }, { ...astra, baseUrl: "https://example.com/v1" }]) {
      expect(inlineImageScope(other)).toBe("inline");
    }
    const other = await projectedPayload(fresh, manager, model);
    expect(await fresh.budget(other, inlineImageScope(model))).toBe(false);
    expect(wireImages(other).map(view => view.id)).toEqual(retained);
  });

  it("fits a full current batch of transparent reads against the actual request while retaining exact originals", async () => {
    const { manager, images, dir } = await fixture();
    const png = await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
    const original = { ...image, mimeType: "image/png", data: png.toString("base64") };
    const calls = Array.from({ length: 8 }, (_, i) => ({ id: `view-${i}`, name: "read", arguments: {} }));
    manager.appendMessage({ role: "user", timestamp: 1, content: "Compare every direction." });
    visualCall(manager, 2, calls);
    const ids = calls.map((call, i) => manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: call.id,
      timestamp: i + 3, content: [original], isError: false }) + ":0");
    const scope = inlineImageScope(astra);
    // The eight read results fit the image-only limit, but their actual request also carries text.
    const text = "x".repeat(26 * 1024 * 1024);
    const request = { ...await projectedPayload(images, manager, astra), instructions: text };
    expect(wireImages(request).reduce((sum,p) => sum + p.data.length, 0)).toBeLessThan(INLINE_IMAGE_HIGH_BYTES);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(MODEL_REQUEST_HIGH_BYTES);
    await images.budget(request, scope);
    const sent = wireImages(request);
    expect(sent.map(p => p.id)).toEqual(ids);
    expect(request.instructions === text).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(MODEL_REQUEST_HIGH_BYTES);
    const dimensions = await sharp(Buffer.from(sent[0]!.data, "base64")).metadata();
    expect(dimensions.hasAlpha).toBe(true);
    const output = request.input.find(item => item.type === "function_call_output" && item.call_id === calls[0]!.id);
    expect(output?.type === "function_call_output" && Array.isArray(output.output) && output.output[0]).toMatchObject({
      type: "input_text", text: expect.stringContaining(`Displayed at ${dimensions.width}x${dimensions.height} from the 512x512 source`),
    });
    for (const id of ids) {
      const recall = await images.recallTool.execute("recall", { imageId: id }, undefined, undefined, {} as never);
      expect((recall.content[1] as ImageContent).data === original.data).toBe(true);
    }
    const accepted = images.withPreviousToolImages(request, scope);
    accepted.commit();
    const unscaledImages = new SessionImages(manager, dir);
    const exact = await unscaledImages.prepare(context(manager), astra, false);
    const unscaled = { instructions: text, input: convertResponsesMessages(astra, exact, new Set(["openai"])) };
    await expect(unscaledImages.budget(unscaled, scope)).rejects.toThrow(ImageBudgetError);

    // As this batch ages out, the accepted prefix still carries its identical display copy and dimensions.
    for (const n of [20, 22]) {
      visualCall(manager, n, [{ id: `follow-${n}`, name: "read", arguments: {} }]);
      manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: `follow-${n}`, timestamp: n + 1, content: [image], isError: false });
    }
    const later = await projectedPayload(images, manager, astra);
    await images.budget(later, scope);
    const restored = images.withPreviousToolImages(later, scope);
    for (const call of calls) {
      const matches = (item: typeof later.input[number]) => item.type === "function_call_output" && item.call_id === call.id;
      expect(restored.payload.input.find(matches)).toEqual(accepted.payload.input.find(matches));
    }
  });

  it("trims bulky Astra image history before the count watermark and still enforces the hard limit for current references", async () => {
    const { manager, images } = await fixture();
    const scope = inlineImageScope(astra);
    const picture = { ...image, data: "A".repeat(1024 * 1024) };
    for (let i = 0; i < 9; i++) manager.appendMessage({ role: "user", timestamp: i, content: [picture] });
    const outgoing = await budgetPayload(images, manager, astra);
    expect(await images.budget(outgoing, scope)).toBe(true);
    expect(wireImages(outgoing)).toHaveLength(4);
    manager.appendMessage({ role: "user", timestamp: 10, content: Array(65).fill(image) });
    const oversized = await budgetPayload(images, manager, astra);
    await expect(images.budget(oversized, scope)).rejects.toThrow(ImageBudgetError);
  });

  it("keeps both large visual observations below the shared hard limit and can reduce the older one after an explicit 413", async () => {
    const { images, manager } = await fixture();
    const size = 5 * 1024 * 1024;
    const first = screenshot(manager, 1, { ...image, data: "A".repeat(size) });
    const second = screenshot(manager, 2, { ...image, data: "B".repeat(size) });
    const outgoing = await projectedPayload(images, manager, astra), scope = inlineImageScope(astra);
    expect(await images.budget(outgoing, scope)).toBe(false);
    expect(wireImages(outgoing).map(view => view.id)).toEqual([`${first}:0`, `${second}:0`]);
    expect(await images.budget(outgoing, scope, true)).toBe(true);
    expect(wireImages(outgoing).map(view => view.id)).toEqual([`${second}:0`]);
    await expect(images.budget(outgoing, scope, true)).rejects.toThrow(ImageBudgetError);
  });

  it("sends the current request and two visual observations below all watermarks, with originals available for later recall", async () => {
    const { images, manager } = await fixture();
    const picture = (label: string): ImageContent => ({ ...image, data: Buffer.from(label).toString("base64") });
    const user = manager.appendMessage({ role: "user", timestamp: 1, content: [picture("design")] });
    const first = screenshot(manager, 2, picture("front"));
    const second = screenshot(manager, 3, picture("side"));
    const third = screenshot(manager, 4, picture("back"));
    manager.appendMessage({ role: "toolResult", timestamp: 5, toolName: "canvas_check", toolCallId: "check", isError: false, content: [{ type: "text", text: "OK" }] });
    // Pi normalizes this host instruction to role:user alongside the pictures.
    const host = manager.appendCustomMessageEntry("continuation", "Continue checking.", false);
    const before = await projectedPayload(images, manager);
    expect(wireImages(before).map(item => item.id)).toEqual([user, second, third].map(id => `${id}:0`));
    expect(JSON.stringify(before)).toContain(`Session image: ${first}:0`);
    const timestamp = Date.parse(manager.getEntry(host)!.timestamp);
    manager.appendMessage({ role: "user", timestamp, content: "Compare the earlier front in a new task" });
    expect(wireImages(await projectedPayload(images, manager))).toHaveLength(0);
    const recalled = await images.recallTool.execute("recall", { imageId: `${first}:0` }, undefined, undefined, {} as never);
    manager.appendMessage({ role: "toolResult", timestamp: timestamp + 1, toolName: "recall_image", toolCallId: "recall", isError: false, content: recalled.content });
    expect(wireImages(await projectedPayload(images, manager)).map(item => item.data)).toEqual([picture("front").data]);
    expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === IMAGE_OFFLOAD_ENTRY)).toBe(false);
  });

  it("refers to identical pixels across active observations, keeps the latest comparison intact and preserves unknown image sources", async () => {
    const { images, manager } = await fixture();
    screenshot(manager, 1);
    const latest = manager.appendMessage({ role: "toolResult", timestamp: 2, toolName: "inspect_3d_views", toolCallId: "angles", isError: false,
      content: [image, { ...image, data: "c2lkZQ==" }, { ...image, data: "YmFjaw==" }] });
    const outgoing = await projectedPayload(images, manager);
    expect(wireImages(outgoing).map(item => item.id)).toEqual([0, 1, 2].map(i => `${latest}:${i}`));
    expect(JSON.stringify(outgoing)).toContain(`Identical pixels are included under session image ${latest}:0`);
    const external: Message = { role: "user", timestamp: 0, content: [{ ...image, data: "ZXh0ZXJuYWw=" }] };
    const prepared = await images.prepare(normalizeContext({ messages: [external, ...context(manager).messages, { role: "user", timestamp: 3, content: "Next" }] }), model);
    expect(wireImages({ input: convertResponsesMessages(model, prepared, new Set(["openai"])) }).map(item => item.data)).toEqual(["ZXh0ZXJuYWw="]);
  });

  it("uses byte thresholds as well as count and protects the latest user attachment and observations", async () => {
    const { manager, images } = await fixture();
    const large = { ...image, data: "a".repeat(3 * 1024 * 1024) };
    for (let index = 1; index <= 8; index++) screenshot(manager, index, large);
    const user = manager.appendMessage({ role: "user", timestamp: 20, content: [large] });
    const outgoing = await budgetPayload(images, manager);
    await images.budget(outgoing, "inline");
    expect(wireImages(outgoing)).toHaveLength(3);
    expect(wireImages(outgoing).at(-1)?.id).toBe(`${user}:0`);
  });

  it("maps every image in a tool result after Pi merges its text blocks", async () => {
    const { manager, images } = await fixture();
    const old = manager.appendMessage({ role: "toolResult", toolCallId: "multi", toolName: "game_use",
      timestamp: 1, isError: false, content: Array.from({ length: 70 }, () => ({ ...image })) });
    screenshot(manager, 2); screenshot(manager, 3);
    const outgoing = await budgetPayload(images, manager);
    expect(wireImages(outgoing).slice(0, 70).map((image) => image.id)).toEqual(Array.from({ length: 70 }, (_, index) => `${old}:${index}`));
    await images.budget(outgoing, "inline");
    expect(wireImages(outgoing)).toHaveLength(32);
    expect(wireImages(outgoing)[0].id).toBe(`${old}:40`);
    await images.budget(outgoing, "inline");
    expect(wireImages(outgoing)[0].id).toBe(`${old}:40`);
  });

  it.each(["completions", "gemini-2.5", "gemini-3"])("maps separated tool images and persists valid %s omissions", async (api) => {
    const { manager, images } = await fixture();
    const old = manager.appendMessage({ role: "toolResult", toolCallId: "multi", toolName: "game_use",
      timestamp: 1, isError: false, content: Array.from({ length: 70 }, () => ({ ...image })) });
    screenshot(manager, 2); screenshot(manager, 3);
    const prepared = await images.annotate(context(manager));
    const outgoing = api === "completions"
      ? { messages: convertCompletionsMessages({ ...model, api: "openai-completions" }, prepared, {} as Parameters<typeof convertCompletionsMessages>[2]) }
      : { contents: convertGoogleMessages({ ...model, api: "google-generative-ai", compat: undefined, id: `${api}-pro` }, prepared) };
    expect(wireImages(outgoing).slice(0, 70).map((image) => image.id)).toEqual(Array.from({ length: 70 }, (_, index) => `${old}:${index}`));
    await images.budget(outgoing, "inline");
    expect(wireImages(outgoing)).toHaveLength(32);
    expect(wireImages(outgoing)[0].id).toBe(`${old}:40`);
    const once = structuredClone(outgoing); await images.budget(outgoing, "inline");
    expect(outgoing).toEqual(once);
    if (api === "gemini-3") {
      const serialized = outgoing as { contents: Array<{ parts: Array<{ functionResponse: { parts: unknown[]; response: { output: string } } }> }> };
      const result = serialized.contents[0].parts[0].functionResponse;
      expect(result.parts).toHaveLength(30);
      expect(result.parts.every((part) => typeof part === "object" && part && "inlineData" in part)).toBe(true);
      expect(result.response.output).toContain("Image omitted from model context");
    }
  });

  it("treats the low watermark as a cleanup target while preserving current images on size recovery", async () => {
    const { manager, images } = await fixture();
    manager.appendMessage({ role: "user", timestamp: 1, content: [image] });
    const current = manager.appendMessage({ role: "user", timestamp: 2, content: [{ ...image, data: "a".repeat(12 * 1024 * 1024) }] });
    const outgoing = await budgetPayload(images, manager);
    expect(await images.budget(outgoing, "inline")).toBe(false);
    expect(await images.budget(outgoing, "inline", true)).toBe(true);
    expect(wireImages(outgoing).map((image) => image.id)).toEqual([`${current}:0`]);
    await expect(images.budget(outgoing, "inline", true)).rejects.toThrow(ImageBudgetError);
  });

  it("fails locally if current protected images or text alone cannot fit", async () => {
    const { manager, images } = await fixture();
    manager.appendMessage({ role: "user", timestamp: 1, content: [{ ...image, data: "a".repeat(21 * 1024 * 1024) }] });
    await expect(images.budget({ input: [] , text: "x".repeat(33 * 1024 * 1024) }, "inline")).rejects.toThrow(ImageBudgetError);
    const outgoing = await budgetPayload(images, manager);
    await expect(images.budget(outgoing, "inline")).rejects.toThrow(ImageBudgetError);
    expect(manager.getEntries()).toHaveLength(1);
  });

  it("keeps decisions scoped to a branch and to the inline transport policy", async () => {
    const { manager, images } = await fixture();
    const root = manager.appendMessage({ role: "user", content: "Play", timestamp: 1 });
    Array.from({ length: 70 }, (_, index) => screenshot(manager, index + 2));
    const outgoing = await budgetPayload(images, manager); await images.budget(outgoing, "inline");
    const otherPolicy = await budgetPayload(images, manager); images.applyOmissions(otherPolicy, "openai-inline");
    expect(wireImages(otherPolicy)).toHaveLength(70);
    manager.branch(root);
    const newImage = screenshot(manager, 200);
    const branch = await budgetPayload(images, manager); await images.budget(branch, "inline");
    expect(wireImages(branch)).toHaveLength(1);
    expect(wireImages(branch)[0].id).toBe(`${newImage}:0`);
    await expect(images.recallTool.execute("call", { imageId: `${wireImages(otherPolicy)[0].id}` }, undefined, undefined, {} as never)).rejects.toThrow("branch");
  });

  it("covers custom message images and leaves official DeepSeek context unmodified", async () => {
    const { manager, images } = await fixture();
    manager.appendCustomMessageEntry("visual", [image], false);
    const ctx = context(manager);
    const prepared = await images.prepare(ctx, model);
    expect(prepared.messages).not.toEqual(ctx.messages);
    expect(wireImages({ input: convertResponsesMessages(model, prepared, new Set(["openai"])) })[0].id).toBeDefined();
    expect(await images.prepare(ctx, { ...model, baseUrl: "https://api.deepseek.com", api: "openai-completions" })).toBe(ctx);
  });

  it("matches distinct and repeated occurrences sharing the same message timestamp", async () => {
    const { manager, images } = await fixture();
    const other = { ...image, data: "b3RoZXI=" };
    const first = manager.appendMessage({ role: "user", timestamp: 1, content: [image] });
    const second = manager.appendMessage({ role: "user", timestamp: 1, content: [other] });
    const third = manager.appendMessage({ role: "user", timestamp: 1, content: [image] });
    const ctx = context(manager);
    const prepared = await images.annotate({ ...ctx, messages: [ctx.messages[1], ctx.messages[0], ctx.messages[2]] });
    const outgoing = { input: convertResponsesMessages(model, prepared, new Set(["openai"])) };
    expect(wireImages(outgoing).map((image) => image.id)).toEqual([`${second}:0`, `${first}:0`, `${third}:0`]);
  });

  it("preserves occurrence decisions through serialized session reopening and compaction", async () => {
    const { manager, images, dir } = await fixture();
    manager.appendMessage({ role: "user", content: "Play", timestamp: 1 });
    const ids = Array.from({ length: 70 }, (_, index) => screenshot(manager, index + 2));
    const outgoing = await budgetPayload(images, manager); await images.budget(outgoing, "inline");
    const reopened = SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])));
    const fresh = new SessionImages(reopened, dir);
    const replay = await budgetPayload(fresh, reopened); await fresh.budget(replay, "inline");
    expect(replay).toEqual(outgoing);
    reopened.appendCompaction("Older playtest observations were summarized", ids[30], 10000);
    const compacted = await budgetPayload(fresh, reopened); await fresh.budget(compacted, "inline");
    expect(wireImages(compacted)).toHaveLength(32);
    expect(wireImages(compacted)[0].id).toBe(`${ids[38]}:0`);
    const recall = await fresh.recallTool.execute("recall", { imageId: `${ids[0]}:0` }, undefined, undefined, {} as never);
    expect(recall.content[1]).toEqual(image);
  });

  it("caches deterministic screenshot previews without changing dimensions or user references", async () => {
    const { manager, images, dir } = await fixture();
    const noise = randomBytes(512 * 512 * 3);
    const png = await sharp(noise, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    const original = { ...image, mimeType: "image/png", data: png.toString("base64") };
    manager.appendMessage({ role: "user", timestamp: 1, content: [original] });
    screenshot(manager, 2, original);
    const prepared = await images.prepare(context(manager), model);
    const user = prepared.messages.find((message) => message.role === "user")!;
    const content = user.content;
    expect(Array.isArray(content) && content[1] === original).toBe(true);
    const tool = prepared.messages.at(-1)!;
    expect(tool.role).toBe("toolResult");
    const preview = (tool as Extract<Message, { role: "toolResult" }>).content.at(-1) as ImageContent;
    expect(preview.mimeType).toBe("image/jpeg");
    expect(preview.data.length).toBeLessThan(original.data.length);
    expect(await sharp(Buffer.from(preview.data, "base64")).metadata()).toMatchObject({ width: 512, height: 512 });
    expect(await new SessionImages(manager, dir).prepare(context(manager), model)).toEqual(prepared);
    expect((manager.getBranch().at(-1) as any).message.content[0]).toEqual(original);
  });

  it("previews historical read images while preserving canonical bytes, recall and the resize setting", async () => {
    const { manager, images } = await fixture();
    const png = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    const original = { ...image, mimeType: "image/png", data: png.toString("base64") };
    const id = manager.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "read", timestamp: 1, isError: false,
      content: [{ type: "text", text: "Read image file [image/png]" }, original] });
    manager.appendMessage({ role: "toolResult", toolName: "canvas_check", toolCallId: "checked", timestamp: 2, content: [{ type: "text", text: "OK" }], isError: false });
    const entries = structuredClone(manager.getEntries());
    const prepared = await images.prepare(context(manager), model);
    const read = prepared.messages[0] as Extract<Message, { role: "toolResult" }>;
    expect(read.content[0]).toMatchObject({ text: "Read image file [image/jpeg]" });
    const preview = read.content.at(-1) as ImageContent;
    expect(preview.mimeType).toBe("image/jpeg");
    expect(preview.data.length).toBeLessThan(original.data.length);
    expect(await sharp(Buffer.from(preview.data, "base64")).metadata()).toMatchObject({ width: 512, height: 512 });
    expect(manager.getEntries()).toEqual(entries);
    const recall = await images.recallTool.execute("recall", { imageId: `${id}:0` }, undefined, undefined, {} as never);
    expect(recall.content[1]).toEqual(original);
    manager.appendMessage({ role: "toolResult", toolName: "recall_image", toolCallId: "recall", content: recall.content, timestamp: 3, isError: false });
    const recalled = await images.prepare(context(manager), model);
    expect((recalled.messages.at(-1) as Extract<Message, { role: "toolResult" }>).content.at(-1)).toEqual(original);
    const disabled = await images.prepare(context(manager), model, false);
    const retained = wireImages({ input: convertResponsesMessages(model, disabled, new Set(["openai"])) });
    expect(retained).toHaveLength(1); expect(retained[0]?.data === original.data).toBe(true);
  });

  it.each([false, true])("keeps transparent read PNGs, including palette transparency (%s)", async (palette) => {
    const { manager, images } = await fixture();
    const pixels = randomBytes(512 * 512 * 4);
    const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png({ palette }).toBuffer();
    if (palette) { expect(png[25]).toBe(3); expect(png.includes(Buffer.from("tRNS"))).toBe(true); }
    const original = { ...image, mimeType: "image/png", data: png.toString("base64") };
    expect(original.data.length).toBeGreaterThan(256 * 1024);
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "read", content: [original], timestamp: 1, isError: false });
    const prepared = await images.prepare(context(manager), model);
    expect((prepared.messages[0] as Extract<Message, { role: "toolResult" }>).content.at(-1)).toEqual(original);
  });

  it("retains undecodable screenshots instead of failing image preparation", async () => {
    const { manager, images } = await fixture();
    const original = { ...image, mimeType: "image/png", data: Buffer.alloc(300 * 1024).toString("base64") };
    screenshot(manager, 1, original);
    const prepared = await images.prepare(context(manager), model);
    expect((prepared.messages[0] as Extract<Message, { role: "toolResult" }>).content.at(-1)).toEqual(original);
  });

  it("recognizes all supported inline wire formats without touching external image URLs or file IDs", () => {
    const outgoing = { values: [
      { type: "input_image", image_url: "data:image/png;base64,YQ==" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
      { inlineData: { mimeType: "image/png", data: "YQ==" } },
      { image: { format: "png", source: { bytes: new Uint8Array([97]) } } },
      { type: "input_image", file_id: "file-a" }, { type: "input_image", image_url: "https://example.com/image.png" },
    ] };
    const slots = wireImages(outgoing); expect(slots).toHaveLength(5);
    slots.forEach((slot) => slot.replace({ type: "image", mimeType: "image/webp", data: "Yg==" }));
    expect(wireImages(outgoing).map(slot => [slot.mime, slot.data])).toEqual(Array(5).fill(["image/webp", "Yg=="]));
    slots.forEach((slot) => slot.omit());
    expect(wireImages(outgoing)).toHaveLength(0);
    expect(outgoing.values.at(-2)).toEqual({ type: "input_image", file_id: "file-a" });
  });

  it("counts SDK binary images by their Base64 wire size and omits mapped Bedrock history", async () => {
    const { manager, images } = await fixture();
    const large = { ...image, data: Buffer.alloc(3 * 1024 * 1024, 97).toString("base64") };
    for (let index = 1; index <= 8; index++) screenshot(manager, index, large);
    const prepared = await images.annotate(context(manager));
    const outgoing = { messages: prepared.messages.map((message) => ({ role: "user", content: Array.isArray(message.content)
      ? message.content.map((block) => block.type === "image"
        ? { image: { format: "jpeg", source: { bytes: new Uint8Array(Buffer.from(block.data, "base64")) } } }
        : { text: block.type === "text" ? block.text : "" }) : [] })) };
    await images.budget(outgoing, "inline");
    expect(wireImages(outgoing)).toHaveLength(2);
    const single = { messages: [outgoing.messages.at(-1)] };
    await expect(images.budget(single, "inline")).resolves.toBe(false);
  });
});


describe("retained image display", () => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  it.each(["png", "jpeg", "webp"] as const)("keeps a small static %s exact with explicit source/display hashes", async format => {
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#448866" } }).toFormat(format).toBuffer();
    const mime = `image/${format}` as "image/png" | "image/jpeg" | "image/webp", original = Buffer.from(bytes), result = await prepareSessionImageDisplay(bytes, mime);
    expect(result).toMatchObject({ mimeType: mime, sourceSha256: sha(bytes), displaySha256: sha(bytes), sourceWidth: 24, sourceHeight: 16, displayWidth: 24, displayHeight: 16, sourceBytes: bytes.length, displayBytes: bytes.length, isProxy: false }); expect(result.bytes).toEqual(original); expect(bytes).toEqual(original);
  });
  it("bounds a transparent display proxy without changing the retained image or removing alpha", async () => {
    const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: "#99553366" } }).png().toBuffer(), original = sha(bytes);
    const result = await prepareSessionImageDisplay(bytes, "image/png"); expect(result).toMatchObject({ mimeType: "image/png", sourceWidth: 2000, sourceHeight: 1000, sourceHasAlpha: true, displayWidth: 1536, displayHeight: 768, sourceSha256: original, isProxy: true });
    expect(result.displayBytes).toBeLessThanOrEqual(1024 * 1024); expect(result.displaySha256).toBe(sha(result.bytes)); expect(sha(bytes)).toBe(original); expect(result.displaySha256).not.toBe(original); expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(true);
  });
  it("uses only a bounded set of smaller display copies for a noisy alpha image", async () => {
    const bytes = await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer(), before = sha(bytes);
    expect(bytes.length).toBeGreaterThan(1024 * 1024); const result = await prepareSessionImageDisplay(bytes, "image/png");
    expect(result.displayBytes).toBeLessThanOrEqual(1024 * 1024); expect([1024, 768, 384]).toContain(result.displayWidth); expect(result.displayHeight).toBe(result.displayWidth); expect(result.mimeType).toBe("image/png"); expect(result.isProxy).toBe(true); expect(sha(bytes)).toBe(before);
  });
  it("rejects format, truncation, source byte and source pixel violations without an original-byte fallback", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#88888888" } }).png().toBuffer();
    await expect(prepareSessionImageDisplay(bytes, "image/jpeg")).rejects.toThrow("format");
    await expect(prepareSessionImageDisplay(bytes.subarray(0, bytes.length - 8), "image/png")).rejects.toThrow();
    await expect(prepareSessionImageDisplay(Buffer.alloc(32 * 1024 * 1024 + 1), "image/png")).rejects.toThrow("32 MiB");
    const huge = Buffer.from(bytes); huge.writeUInt32BE(9000, 16); huge.writeUInt32BE(9000, 20); huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
    await expect(prepareSessionImageDisplay(huge, "image/png")).rejects.toMatchObject({ code: "RASTER_RETURN_REVIEW_REQUIRED" });
  });
  it("rejects protected bytes and late cancellation or disclosure-policy changes instead of returning a proxy", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#88888888" } }).png().toBuffer();
    const secret = "retained-display-secret-canary"; registerSensitiveValue(secret);
    await expect(prepareSessionImageDisplay(Buffer.concat([bytes, Buffer.from(secret)]), "image/png")).rejects.toThrow("Protected credential");
    const controller = new AbortController(), cancelled = prepareSessionImageDisplay(bytes, "image/png", controller.signal); controller.abort(); await expect(cancelled).rejects.toThrow();
    const changed = prepareSessionImageDisplay(bytes, "image/png"); registerSensitiveValue("retained-display-new-policy-canary"); await expect(changed).rejects.toThrow("policy changed");
  });
});
