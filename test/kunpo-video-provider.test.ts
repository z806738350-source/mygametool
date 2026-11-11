import { mkdtemp, readFile, readdir, writeFile, symlink, rm } from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoModel } from "../src/shared/contracts.js";
import { KunpoVideoProvider } from "../src/daemon/kunpo-video-provider.js";
import { hasSavedVideoTask, videoTaskJournal } from "../src/daemon/video-task-journal.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { SeedanceProvider } from "../src/daemon/seedance-provider.js";
import { seedanceModel } from "../src/daemon/seedance-models.js";
import { referencePng, pngScanlines, pngChunks } from "./video-reference-png-fixture.js";
import * as pngPreparation from "../src/daemon/video-reference-png.js";
import { rememberKunpoImageSource } from "../src/daemon/provider-image-source.js";
import type { VideoReferenceAsset } from "../src/daemon/video-generation.js";
import { VIDEO_REFERENCE_REQUEST_TARGET_BYTES } from "../src/daemon/video-reference-budget.js";
import { validVideoReferencePreparation } from "../src/shared/video-reference-preparation.js";

const source = { name: "KunpoAPI", baseUrl: "http://127.0.0.1:43199/v1", apiKey: "fake-video-canary-20261028" };
const videoDns = vi.hoisted(() => vi.fn(async (_host?: unknown) => [{ address: "8.8.8.8", family: 4 }]));
vi.mock("node:dns/promises", async (original) => ({ ...await original<typeof import("node:dns/promises")>(), lookup: videoDns }));
afterEach(() => { videoDns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); });
const mp4 = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } });
function model(id = "doubao-seedance-2-5-260628"): VideoModel {
  return { provider: "kunpo", providerName: "KunpoAPI", id, name: id, durations: [4, 5, 8], resolutions: ["480p", "720p", "1080p", "768p", "2K", "4K"],
    aspectRatios: ["adaptive", "16:9", "1:1"], maxImageReferences: 30, referenceModes: ["reference", "frame"] };
}

describe("Kunpo video protocols", () => {
  it("measures a long private CDN URL even when URL overhead is larger than its tiny original PNG", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-budget-url-overhead-"));
    try {
      const bytes = referencePng({ width: 8, height: 8 }), refs: Array<VideoReferenceAsset & { bytes: Buffer }> = [], remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" };
      const url = `https://kunpoapiimg.ziy.cc/origin.png?signature=${"synthetic".repeat(600)}`;
      for (const name of ["generated", "local"]) { const file = path.join(directory, `${name}.png`); await writeFile(file, bytes); refs.push({ type: "image", name, mediaType: "image/png", absolutePath: file, bytes }); }
      rememberKunpoImageSource(refs[0]!, url, remote.baseUrl);
      let summary: any;
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "synthetic_url_overhead" })).mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4" } })).mockResolvedValueOnce(mp4());
      await new KunpoVideoProvider(remote, request, 0).generate(model(), { prompt: "Synthetic", duration: 4, resolution: "480p", aspectRatio: "adaptive", references: refs,
        execution: await videoTaskJournal(directory, "new", false, async value => { expect(validVideoReferencePreparation(value)).toBe(true); summary = value; }) });
      expect(summary).toMatchObject({ version: 3, requestBudgetMet: true, requestBudgetPasses: 0 }); expect(summary.requestBytes).toBeGreaterThan(summary.originalRequestBytes);
      expect(JSON.stringify(summary)).not.toContain(url); expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"].flatMap(id => ["reference", "first", "frame"].map(mode => ({ id, mode }))))("fits the full $id $mode JSON from PNG/JPEG/WebP and mixed CDN origins, then only resumes its saved task", async ({ id, mode }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-budget-protocol-"));
    try {
      const png = await sharp(referencePng({ width: 1024, height: 1024, color: 2, noise: true })).blur(0.7).png().toBuffer();
      const jpeg = await sharp(png).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer(), webp = await sharp(png).webp({ lossless: true }).toBuffer();
      const images = mode === "first" ? [jpeg] : [jpeg, webp];
      const refs: Array<VideoReferenceAsset & { bytes: Buffer }> = [];
      const remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" }, originUrl = "https://kunpoapiimg.ziy.cc/original-test.png?signature=synthetic-private";
      if (mode === "reference") {
        const file = path.join(directory, "generated.png"); await writeFile(file, png);
        const reference = { type: "image" as const, name: "generated.png", mediaType: "image/png", absolutePath: file, bytes: png };
        rememberKunpoImageSource(reference, originUrl, remote.baseUrl); refs.push(reference);
      }
      for (const [index, bytes] of images.entries()) {
        const mediaType = index ? "image/webp" : "image/jpeg", file = path.join(directory, `local-${index}`); await writeFile(file, bytes);
        refs.push({ type: "image", name: `local-${index}`, mediaType, absolutePath: file, bytes });
      }
      let summary: any, posted: any;
      const request = vi.fn<typeof fetch>(async (address, init) => {
        if (init?.method === "POST") { posted = JSON.parse(String(init.body)); expect(Buffer.byteLength(String(init.body))).toBeLessThanOrEqual(VIDEO_REFERENCE_REQUEST_TARGET_BYTES); expect(summary?.requestBudgetMet).toBe(true); return Response.json({ id: "synthetic_budget_task" }); }
        if (String(address).endsWith("/content") || String(address).endsWith("result.mp4")) return mp4();
        return Response.json(id === "doubao-seedance-2-5-260628" ? { status: "succeeded", content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4" } } : { status: "completed" });
      });
      const input = { prompt: "Synthetic fixed movement", duration: 4, resolution: id === "minimax-video-h3" ? "768p" as const : "480p" as const, aspectRatio: "adaptive" as const, referenceMode: mode === "reference" ? "reference" as const : "frame" as const, references: refs };
      const execution = await videoTaskJournal(directory, "new", false, async value => { expect(validVideoReferencePreparation(value)).toBe(true); summary = structuredClone(value); });
      const result = await new KunpoVideoProvider(remote, request, 0).generate(model(id), { ...input, execution });
      expect(summary).toMatchObject({ version: 3, requestBudgetMet: true });
      const urls = id === "tencent-vod-vs-2.5" ? mode === "reference" ? posted.images : [posted.first_frame_url, posted.last_frame_url].filter(Boolean) : posted.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
      expect(urls).toHaveLength(refs.length); if (mode === "reference") expect(urls[0]).toBe(originUrl);
      for (const url of urls.slice(mode === "reference" ? 1 : 0)) expect(url).toMatch(/^data:image\/jpeg;base64,/);
      expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(result.metadata?.parameters.referenceBudgetBytes).toBe(VIDEO_REFERENCE_REQUEST_TARGET_BYTES);
      for (const reference of refs) expect(await readFile(reference.absolutePath)).toEqual(reference.bytes);
      const saved = await readFile(path.join(directory, "new.json"), "utf8"); for (const secret of [source.apiKey, originUrl, "data:image", input.prompt]) expect(saved).not.toContain(secret);
      request.mockClear(); await new KunpoVideoProvider(remote, request, 0).generate(model(id), { ...input, execution: await videoTaskJournal(directory, "new", true) });
      expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0); expect(await readFile(path.join(directory, "new.json"), "utf8")).toBe(saved);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["missing-id", "http500", "http400"])("does not repeat a budget-prepared paid POST after %s, including restart", async outcome => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-budget-unknown-"));
    try {
      const bytes = await sharp(referencePng({ width: 1024, height: 1024, color: 2, noise: true })).blur(0.7).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
      const file = path.join(directory, "synthetic.jpg"); await writeFile(file, bytes);
      const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(outcome === "missing-id" ? {} : { error: { code: "bad_response_status_code" } }, { status: outcome === "missing-id" ? 200 : outcome === "http500" ? 500 : 400 }));
      let summary: any;
      const input = { prompt: "Synthetic", duration: 4, resolution: "480p" as const, aspectRatio: "adaptive" as const, references: [{ type: "image" as const, name: "synthetic.jpg", mediaType: "image/jpeg", absolutePath: file }] };
      await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "uncertain", false, async value => { summary = value; }) })).rejects.toMatchObject({ notSubmitted: false });
      expect(summary).toMatchObject({ version: 3, requestBudgetMet: true }); expect(request).toHaveBeenCalledOnce();
      const before = await readFile(path.join(directory, "uncertain.json"), "utf8"); request.mockClear();
      await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "uncertain", true) })).rejects.toMatchObject({ statusCode: 409 });
      expect(request).not.toHaveBeenCalled(); expect(await readFile(path.join(directory, "uncertain.json"), "utf8")).toBe(before); expect(await readFile(file)).toEqual(bytes);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["modified", "unknown", "unsafe-dns", "non-kunpo", "credential-url"])("falls back to the current local bytes for %s provenance without an upload", async kind => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-source-fallback-")), file = path.join(directory, "current.jpg"), bytes = Buffer.from("synthetic-image");
    await writeFile(file, bytes);
    const reference: VideoReferenceAsset & { bytes: Buffer } = { type: "image", name: "current.jpg", mediaType: "image/jpeg", absolutePath: file, bytes };
    if (kind !== "unknown") rememberKunpoImageSource(reference, `https://kunpoapiimg.ziy.cc/image.jpg${kind === "credential-url" ? `?key=${source.apiKey}` : ""}`, "https://llm.ziy.cc/v1");
    if (kind === "modified") await writeFile(file, Buffer.from("different-image"));
    if (kind === "unsafe-dns") videoDns.mockImplementation(async (host) => [{ address: String(host) === "kunpoapiimg.ziy.cc" ? "198.18.0.1" : "8.8.8.8", family: 4 }]);
    const remote = kind === "non-kunpo" ? source : { ...source, baseUrl: "https://llm.ziy.cc/v1" };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_fallback" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: kind === "non-kunpo" ? "http://127.0.0.1:43199/result.mp4" : "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4" } })).mockResolvedValueOnce(mp4());
    const result = await new KunpoVideoProvider(remote, request, 0).generate(model(), { prompt: "Fixture", duration: 4, resolution: "480p", aspectRatio: "adaptive", references: [reference] });
    const sent = JSON.parse(String(request.mock.calls[0]![1]!.body)).content[1].image_url.url;
    expect(sent).toBe(`data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`);
    expect(result.metadata?.parameters).toMatchObject({ referenceUrlCount: 0, referenceLocalCount: 1 });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(new Headers(request.mock.calls[2]![1]?.headers).has("authorization")).toBe(false);
  });

  it.each(["known", "unknown"])("keeps a legacy %s raw-body fingerprint when a CDN receipt becomes available later", async state => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-source-legacy-")), file = path.join(directory, "source.jpg"), bytes = Buffer.from("same image"); await writeFile(file, bytes);
    const remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" };
    const body = { model: model().id, content: [{ type: "text", text: "Legacy" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` }, role: "reference_image" }], duration: 4, resolution: "480p", ratio: "adaptive", generate_audio: true, watermark: false, output_format: "mp4" };
    const old = await videoTaskJournal(directory, "legacy-source");
    await old.submitted("generate", JSON.stringify([remote.baseUrl, remote.apiKey, undefined, "seedance"]), body, async () => {
      if (state === "unknown") throw Error("unknown response"); return { taskId: "task_legacy_source" };
    }).catch(() => undefined);
    const before = await readFile(path.join(directory, "legacy-source.json"), "utf8");
    const reference = { type: "image" as const, name: "source.jpg", mediaType: "image/jpeg", absolutePath: file, bytes };
    rememberKunpoImageSource(reference, "https://kunpoapiimg.ziy.cc/now-known.jpg", remote.baseUrl);
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/old.mp4" } })).mockResolvedValueOnce(mp4());
    const result = new KunpoVideoProvider(remote, request, 0).generate(model(), { prompt: "Legacy", duration: 4, resolution: "480p", aspectRatio: "adaptive", references: [reference], execution: await videoTaskJournal(directory, "legacy-source", true) });
    if (state === "known") {
      expect((await result).metadata?.parameters.referenceUrlCount).toBeUndefined();
      expect(request.mock.calls).toHaveLength(2); expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    } else { await expect(result).rejects.toMatchObject({ statusCode: 409 }); expect(request).not.toHaveBeenCalled(); }
    expect(await readFile(path.join(directory, "legacy-source.json"), "utf8")).toBe(before);
  });

  it("persists a new URL submission once, then recovers after source provenance disappears without exposing its URL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-url-resume-")), file = path.join(directory, "source.jpg"), bytes = Buffer.from("synthetic image"); await writeFile(file, bytes);
    const remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" }, url = "https://kunpoapiimg.ziy.cc/kept-private.jpg?signature=fake-private-value";
    const reference = { type: "image" as const, name: "source.jpg", mediaType: "image/jpeg", absolutePath: file, bytes };
    rememberKunpoImageSource(reference, url, remote.baseUrl);
    const abort = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ id: "task_url_once" });
      abort.abort(); throw new DOMException("Synthetic cancellation", "AbortError");
    });
    const input = { prompt: "Synthetic", duration: 4, resolution: "480p" as const, aspectRatio: "adaptive" as const, references: [reference] };
    await expect(new KunpoVideoProvider(remote, request, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "url-once") }, abort.signal)).rejects.toMatchObject({ statusCode: 499 });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).content[1].image_url.url).toBe(url);
    const saved = await readFile(path.join(directory, "url-once.json"), "utf8");
    for (const secret of [url, "fake-private-value", source.apiKey, "data:image"]) expect(saved).not.toContain(secret);
    const recover = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4" } })).mockResolvedValueOnce(mp4());
    const plainReference = { ...reference }; // No WeakMap capability after a real restart.
    const result = await new KunpoVideoProvider(remote, recover, 0).generate(model(), { ...input, references: [plainReference], execution: await videoTaskJournal(directory, "url-once", true) });
    expect(result.metadata?.parameters).toMatchObject({ referenceUrlCount: 1, referenceLocalCount: 0 });
    expect(recover.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(await readFile(path.join(directory, "url-once.json"), "utf8")).toBe(saved);
  });

  it("coalesces concurrent URL-reference starts and rejects cancellation before dispatch", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-url-concurrent-")), file = path.join(directory, "source.jpg"), bytes = Buffer.from("synthetic image"); await writeFile(file, bytes);
    const remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" };
    const reference = { type: "image" as const, name: "source.jpg", mediaType: "image/jpeg", absolutePath: file, bytes };
    rememberKunpoImageSource(reference, "https://kunpoapiimg.ziy.cc/source.jpg", remote.baseUrl);
    const request = vi.fn<typeof fetch>(async (url, init) => init?.method === "POST" ? Response.json({ id: "task_concurrent_source" }) : String(url).endsWith(".mp4") ? mp4() : Response.json({ status: "succeeded", content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4" } }));
    const provider = new KunpoVideoProvider(remote, request, 0), input = { prompt: "Synthetic", duration: 4, resolution: "480p" as const, aspectRatio: "adaptive" as const, references: [reference] };
    const result = await Promise.all([provider.generate(model(), { ...input, execution: await videoTaskJournal(directory, "same") }), provider.generate(model(), { ...input, execution: await videoTaskJournal(directory, "same") })]);
    expect(result.every(video => video.metadata?.parameters.referenceUrlCount === 1)).toBe(true);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    request.mockClear();
    await expect(provider.generate(model(), input, AbortSignal.abort())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels source DNS verification before any POST without leaving an ambiguous paid marker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-url-dns-cancel-")), file = path.join(directory, "source.jpg"), bytes = Buffer.from("synthetic image"); await writeFile(file, bytes);
    const remote = { ...source, baseUrl: "https://llm.ziy.cc/v1" }, abort = new AbortController();
    const reference = { type: "image" as const, name: "source.jpg", mediaType: "image/jpeg", absolutePath: file, bytes };
    rememberKunpoImageSource(reference, "https://kunpoapiimg.ziy.cc/source.jpg", remote.baseUrl);
    videoDns.mockImplementation(async host => {
      if (host === "kunpoapiimg.ziy.cc") { queueMicrotask(() => abort.abort()); return new Promise(() => undefined); }
      return [{ address: "8.8.8.8", family: 4 }];
    });
    const request = vi.fn<typeof fetch>();
    await expect(new KunpoVideoProvider(remote, request, 0).generate(model(), { prompt: "Synthetic", references: [reference], execution: await videoTaskJournal(directory, "cancel-dns") }, abort.signal)).rejects.toMatchObject({ statusCode: 499, notSubmitted: true });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(directory, "cancel-dns.json"), "utf8"))).toEqual({});
  });

  it.each([{ referenceUrlCount: "31", referenceLocalCount: "0" }, { referenceUrlCount: "1" }, { referenceUrlCount: "1", referenceLocalCount: "-1" }, { referenceUrlCount: "https://private.invalid", referenceLocalCount: "0" }])("rejects malformed transport counts without recreating a paid task: %j", async counts => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-source-counts-"));
    await writeFile(path.join(directory, "invalid.json"), JSON.stringify({ generate: { fingerprint: "a".repeat(64), task: { taskId: "task_old", ...counts } } }), { mode: 0o600 });
    const request = vi.fn<typeof fetch>();
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Synthetic", execution: await videoTaskJournal(directory, "invalid", true) })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("records %s transport attempts before HTTP400, never during pure recovery", async id => {
    const events: string[] = [], started = vi.fn(async () => { events.push("receipt"); });
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-receipt-"));
    const request = vi.fn<typeof fetch>(async () => { events.push("POST"); return Response.json({ error: { type: "bad_response_status_code" } }, { status: 400 }); });
    const input = { prompt: "Synthetic", duration: 4, resolution: id === "minimax-video-h3" ? "768p" as const : "480p" as const, execution: await videoTaskJournal(directory, "receipt", false, undefined, started) };
    const provider = new KunpoVideoProvider(source, request, 0);
    await expect(provider.generate(model(id), input)).rejects.toMatchObject({ statusCode: 400, notSubmitted: false });
    expect(events).toEqual(["receipt", "POST"]); started.mockClear(); request.mockClear();
    await expect(provider.generate(model(id), { ...input, execution: await videoTaskJournal(directory, "receipt", true, undefined, started) })).rejects.toThrow("Recovery never submits");
    expect(started).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it.each(["save-failure", "cancel"])("does not submit when the private receipt %s occurs before dispatch", async mode => {
    const request = vi.fn<typeof fetch>(), controller = new AbortController();
    const started = vi.fn(async () => { if (mode === "cancel") controller.abort(); else throw Error("Synthetic receipt save failure"); });
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Synthetic", execution: { submitted: async (_stage, _scope, _input, create) => create(), submissionStarted: started } }, controller.signal)).rejects.toMatchObject({ notSubmitted: true });
    expect(started).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });

  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("serializes both frame roles for %s without reference-mode fields or extra submissions", async (id) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-two-frame-"));
    const first = path.join(directory, "first.png"), last = path.join(directory, "last.png");
    await writeFile(first, "first-fixture"); await writeFile(last, "last-fixture");
    const native = id === "doubao-seedance-2-5-260628";
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_frames" }))
      .mockResolvedValueOnce(Response.json(native ? { status: "succeeded", content: { video_url: "http://127.0.0.1:43199/frames.mp4" } } : { status: "completed" })).mockResolvedValueOnce(mp4());
    await new KunpoVideoProvider(source, request, 0).generate(model(id), { prompt: "Move between the two frames", duration: 4, resolution: id === "minimax-video-h3" ? "768p" : "480p", aspectRatio: "adaptive", referenceMode: "frame", references: [first, last].map((absolutePath) => ({ type: "image", name: "fixture.png", mediaType: "image/png", absolutePath })) });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    if (id === "tencent-vod-vs-2.5") {
      expect(body.first_frame_url).toBe(`data:image/png;base64,${Buffer.from("first-fixture").toString("base64")}`);
      expect(body.last_frame_url).toBe(`data:image/png;base64,${Buffer.from("last-fixture").toString("base64")}`);
      expect(body.images).toBeUndefined(); expect(body.content).toBeUndefined();
    } else {
      const images = body.content.filter((item: { type: string }) => item.type === "image_url");
      expect(images.map((item: { role: string }) => item.role)).toEqual(["first_frame", "last_frame"]);
      expect(images.map((item: { image_url: { url: string } }) => item.image_url.url)).toEqual(["first-fixture", "last-fixture"].map((value) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`));
    }
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("persists only bounded HTTP diagnostic enums and never echoes provider text", async () => {
    const secretText = `${source.apiKey} https://example.invalid/private?signature=canary data:image/png;base64,private`;
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "invalid_parameter", message: secretText }, request_id: secretText }, { status: 400 }));
    const error = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture" }).catch((cause) => cause);
    expect(error).toMatchObject({ statusCode: 400, diagnostic: { phase: "submission", category: "http", httpStatus: 400, providerCode: "invalid-request" } });
    for (const value of [source.apiKey, "signature=canary", "data:image", "request_id"]) expect(JSON.stringify(error) + error.message).not.toContain(value);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["code", "type"])("recognizes the documented bad_response_status_code %s without treating it as confirmed non-submission", async (field) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-bad-response-"));
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { [field]: "bad_response_status_code", message: `${source.apiKey} https://private.invalid/?signature=private`, param: "private-material" } }, { status: 502 }));
    const provider = new KunpoVideoProvider(source, request, 0);
    const error = await provider.generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "known-error") }).catch((cause) => cause);
    expect(error).toMatchObject({ diagnostic: { phase: "submission", category: "http", httpStatus: 502, providerCode: "bad-response-status" } });
    expect(error.message).toContain("HTTP 502; reason unknown");
    expect(error.notSubmitted).toBe(false);
    await expect(provider.generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "known-error", true) })).rejects.toThrow("could not be confirmed");
    expect(request).toHaveBeenCalledOnce();
    for (const secret of [source.apiKey, "signature=private", "private-material", "https:"]) expect(JSON.stringify(error) + error.message).not.toContain(secret);
  });

  it("does not let a more specific provider tag authorize replay of an uncertain 502 submission", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-specific-uncertain-"));
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "bad_response_status_code", type: "invalid_parameter", message: `${source.apiKey} private-text` } }, { status: 502 }));
    const provider = new KunpoVideoProvider(source, request, 0);
    const error = await provider.generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "mixed") }).catch((cause) => cause);
    expect(error.diagnostic).toMatchObject({ httpStatus: 502, providerCode: "invalid-request" });
    expect(error.notSubmitted).toBe(false);
    await expect(provider.generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "mixed", true) })).rejects.toThrow("could not be confirmed");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["oversize", "stalled", "malformed"])("bounds %s error diagnostics and keeps the saved submission ambiguous", async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-diagnostic-"));
    let cancelled = false;
    const body = kind === "oversize" ? "x".repeat(9000) : kind === "malformed" ? "not JSON" : new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { status: 502 }));
    const error = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "ambiguous") }).catch((cause) => cause);
    expect(error).toMatchObject({ diagnostic: { phase: "submission", category: "http", httpStatus: 502, providerCode: "unclassified" } });
    expect(error.message).toContain("HTTP 502; reason unknown");
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "ambiguous", true) })).rejects.toThrow("could not be confirmed");
    expect(request).toHaveBeenCalledOnce();
    if (kind === "stalled") expect(cancelled).toBe(true);
  });

  it.each([["UND_ERR_HEADERS_TIMEOUT", "timeout", "headers"], ["UND_ERR_BODY_TIMEOUT", "timeout", "body"], ["UND_ERR_CONNECT_TIMEOUT", "timeout", "connect"], ["ETIMEDOUT", "timeout", "unknown"], ["ENOTFOUND", "dns", undefined], ["ECONNRESET", "connection", undefined], ["ECONNREFUSED", "connection", undefined], ["untrusted-secret-code", "unknown", undefined]])("records sanitized transport %s without retaining its raw cause", async (code, category, timeoutKind) => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private ${source.apiKey} https://example.invalid?signature=canary`, { cause: Object.assign(new Error("raw private cause"), { code }) }));
    const error = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture" }).catch((cause) => cause);
    expect(error.diagnostic).toEqual({ phase: "submission", category, ...(timeoutKind ? { timeoutKind } : {}) });
    expect(error.message).toContain("Do not repeat the paid request");
    for (const value of [source.apiKey, "signature=canary", "private cause", "untrusted-secret-code"]) expect(JSON.stringify(error) + error.message).not.toContain(value);
  });

  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("caps only %s submission timeouts on the active dispatcher at fifteen minutes", async (id) => {
    const active = getGlobalDispatcher(), dispatch = vi.spyOn(active, "dispatch").mockReturnValue(true);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const scoped = (init as RequestInit & { dispatcher?: Dispatcher }).dispatcher;
      if (init?.method === "POST") {
        expect(scoped).toBeDefined(); expect(scoped).not.toBe(active);
        scoped!.dispatch({ origin: "http://127.0.0.1:43199", path: "/v1/videos", method: "POST" }, {});
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ headersTimeout: 900_000, bodyTimeout: 900_000 });
        return Response.json({ id: "task_scoped" });
      }
      expect(scoped).toBeUndefined();
      return String(_url).endsWith("/content") || String(_url).endsWith("/scoped.mp4") ? mp4() : Response.json(id.startsWith("doubao") ? { status: "succeeded", content: { video_url: "http://127.0.0.1:43199/scoped.mp4" } } : { status: "completed" });
    });
    try {
      await new KunpoVideoProvider(source, request, 0, 1_800_000).generate(model(id), { prompt: "Fixture" });
      expect(getGlobalDispatcher()).toBe(active); expect(dispatch).toHaveBeenCalledOnce();
    } finally { dispatch.mockRestore(); }
  });

  it("retains only the safe timeout subtype when a successful response body is interrupted", async () => {
    const raw = `private ${source.apiKey} https://example.invalid?signature=canary`;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"partial')); controller.error(new Error(raw, { cause: Object.assign(new Error(raw), { code: "UND_ERR_BODY_TIMEOUT" }) }));
    } }), { headers: { "content-type": "application/json" } }));
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-body-timeout-"));
    const error = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "body-timeout") }).catch((cause) => cause);
    expect(error.diagnostic).toEqual({ phase: "submission", category: "timeout", timeoutKind: "body", httpStatus: 200 });
    for (const secret of [source.apiKey, "signature=canary", "private"]) expect(error.message + JSON.stringify(error)).not.toContain(secret);
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Fixture", execution: await videoTaskJournal(directory, "body-timeout", true) })).rejects.toThrow("could not be confirmed");
    expect(request).toHaveBeenCalledOnce();
  });

  it("waits beyond a shorter active transport default and keeps deadlines, cancellation and other requests bounded", async () => {
    const previous = getGlobalDispatcher(), agent = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let scenario = { mode: "headers", posts: 0, gets: 0 };
    const server = http.createServer((req, res) => {
      req.resume(); req.on("end", () => {
        if (req.method !== "POST") { scenario.gets++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "succeeded", content: { video_url: origin + "/artifact" } })); return; }
        scenario.posts++; const body = JSON.stringify({ id: "task_waiting" });
        if (scenario.mode === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write(body.slice(0, 1)); }
        const timer = setTimeout(() => { timers.delete(timer); if (res.destroyed) return; if (scenario.mode === "body") res.end(body.slice(1)); else { res.setHeader("content-type", "application/json"); res.end(body); } }, 2200);
        timers.add(timer); res.once("close", () => { clearTimeout(timer); timers.delete(timer); });
      });
    });
    let origin = "";
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      setGlobalDispatcher(agent);
      const local = { ...source, baseUrl: origin + "/v1" };
      const request: typeof fetch = (url, init) => {
        expect(new URL(String(url)).origin).toBe(origin);
        return String(url).endsWith("/artifact") ? Promise.resolve(mp4()) : fetch(url, init);
      };
      for (const mode of ["headers", "body"]) {
        scenario = { mode, posts: 0, gets: 0 };
        await expect(new KunpoVideoProvider(local, request, 0, 5000).generate(model(), { prompt: "Delayed local fixture" })).resolves.toMatchObject({ mediaType: "video/mp4" });
        expect(scenario).toMatchObject({ posts: 1, gets: 1 }); expect(getGlobalDispatcher()).toBe(agent);
      }
      // An unrelated provider request still uses the original short transport default.
      scenario = { mode: "headers", posts: 0, gets: 0 };
      const unrelated = await fetch(origin + "/other-provider", { method: "POST", signal: AbortSignal.timeout(5000) }).catch((cause) => cause);
      expect(unrelated.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
      for (const [mode, cancel] of [["headers", false], ["headers", true], ["body", false], ["body", true]] as const) {
        scenario = { mode, posts: 0, gets: 0 };
        const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-deadline-"));
        const abort = new AbortController();
        const pending = new KunpoVideoProvider(local, request, 0, cancel ? 5000 : 150).generate(model(), { prompt: "Interrupted fixture", execution: await videoTaskJournal(directory, "interrupted") }, abort.signal).catch((cause) => cause);
        if (cancel) { await vi.waitFor(() => expect(scenario.posts).toBe(1)); abort.abort(new Error(`private ${source.apiKey}`)); }
        const error = await pending;
        expect(error).toMatchObject({ statusCode: cancel ? 499 : 504, diagnostic: { phase: "submission", category: cancel ? "cancelled" : "timeout", ...(cancel ? {} : { timeoutKind: "deadline" }) } });
        expect(error.message + JSON.stringify(error)).not.toContain(source.apiKey);
        await expect(new KunpoVideoProvider(local, request, 0).generate(model(), { prompt: "Interrupted fixture", execution: await videoTaskJournal(directory, "interrupted", true) })).rejects.toThrow("could not be confirmed");
        expect(scenario.posts).toBe(1); expect(await hasSavedVideoTask(directory, "interrupted")).toBe(false);
      }
    } finally {
      setGlobalDispatcher(previous); for (const timer of timers) clearTimeout(timer);
      await agent.destroy(); server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["status", "download"])("retains the saved task when the %s deadline expires and recovers by GET only", async (phase) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-saved-video-deadline-"));
    const input = { prompt: "Saved fixture", execution: await videoTaskJournal(directory, "saved-deadline") };
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") return Response.json({ id: "task_saved_deadline" });
      if (phase === "download" && !String(url).endsWith("/saved.mp4")) return Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/saved.mp4" } });
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const error = await new KunpoVideoProvider(source, request, 0, 150).generate(model(), input).catch((cause) => cause);
    expect(error).toMatchObject({ statusCode: 504, diagnostic: { phase, category: "timeout", timeoutKind: "deadline" } });
    expect(await hasSavedVideoTask(directory, "saved-deadline")).toBe(true);
    const recovery = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/saved.mp4" } })).mockResolvedValueOnce(mp4());
    await new KunpoVideoProvider(source, recovery, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "saved-deadline", true) });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(recovery).toHaveBeenCalledTimes(2); expect(recovery.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("uses native Seedance states and records the actual task and parameters", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "task_seedance" }))
      .mockResolvedValueOnce(Response.json({ status: "pending" }))
      .mockResolvedValueOnce(Response.json({ status: "running", progress: 100 }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/seedance.mp4" } }))
      .mockResolvedValueOnce(mp4());
    const result = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "A cube rolls", duration: 5, resolution: "720p", aspectRatio: "16:9" });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43199/doubao/api/v3/contents/generations/tasks");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ model: model().id, content: [{ type: "text", text: "A cube rolls" }], duration: 5, resolution: "720p", ratio: "16:9", generate_audio: true, watermark: false, output_format: "mp4" });
    expect(result).toMatchObject({ requestId: "task_seedance", metadata: { protocol: "seedance", taskId: "task_seedance", model: { provider: "kunpo", id: model().id }, parameters: { duration: 5, resolution: "720p" } } });
    expect(request.mock.calls[4]?.[1]?.headers).toBeUndefined();
  });

  it.each(["tencent-vod-vs-2.5", "minimax-video-h3"])("uses Videos states and same-origin authenticated content for %s", async (id) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "task_video" }))
      .mockResolvedValueOnce(Response.json({ status: "in_progress" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", url: "https://untrusted.example/ignored.mp4" }))
      .mockResolvedValueOnce(mp4());
    const result = await new KunpoVideoProvider(source, request, 0).generate(model(id), { prompt: "A cube rolls", duration: 4, resolution: id === "minimax-video-h3" ? "768p" : "4K", aspectRatio: "16:9" });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.seconds).toBe(4);
    expect(body.resolution).toBe(id === "minimax-video-h3" ? "768P" : "4K");
    expect(body.duration).toBeUndefined();
    if (id === "tencent-vod-vs-2.5") {
      expect(body.generate_audio).toBe(false);
      expect(result.metadata?.parameters.generateAudio).toBe(false);
      expect(result.metadata?.parameters).not.toHaveProperty("watermark");
    } else {
      expect(body.aigc_watermark).toBe(false);
      expect(result.metadata?.parameters.watermark).toBe(false);
      expect(result.metadata?.parameters).not.toHaveProperty("generateAudio");
    }
    expect(request.mock.calls[3]?.[0]).toBe("http://127.0.0.1:43199/v1/videos/task_video/content");
    expect(new Headers(request.mock.calls[3]?.[1]?.headers).get("authorization")).toBe(`Bearer ${source.apiKey}`);
    expect(request.mock.calls[3]?.[1]?.redirect).toBe("manual");
  });

  it("validates first/last-frame input before making a paid request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), {
      prompt: "Animate", referenceMode: "frame", aspectRatio: "16:9", references: [{ type: "image", name: "first.png", mediaType: "image/png", absolutePath: "not-read" }],
    })).rejects.toMatchObject({ statusCode: 400, message: "First/last frame mode requires the adaptive aspect ratio" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("rejects empty-frame submissions for %s but can still retrieve a legacy saved task", async (id) => {
    const request = vi.fn<typeof fetch>(), provider = new KunpoVideoProvider(source, request, 0);
    const input = { prompt: "Legacy text-only frame draft", referenceMode: "frame" as const, aspectRatio: "16:9" as const, resolution: id === "minimax-video-h3" ? "768p" as const : "480p" as const };
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-empty-frame-"));
    await expect(provider.generate(model(id), { ...input, execution: await videoTaskJournal(directory, "new-empty-frame") })).rejects.toMatchObject({ statusCode: 400, notSubmitted: true, message: "Add a first frame before generating in first/last frame mode" });
    expect(request).not.toHaveBeenCalled(); expect(await hasSavedVideoTask(directory, "new-empty-frame")).toBe(false);
    const journal = await videoTaskJournal(directory, "legacy-empty-frame");
    // Seed the old submission's exact body through the journal, never through a POST.
    const native = id === "doubao-seedance-2-5-260628";
    const body = native ? { model: id, content: [{ type: "text", text: input.prompt }], duration: 5, resolution: input.resolution, ratio: "16:9", generate_audio: true, watermark: false, output_format: "mp4" }
      : id === "tencent-vod-vs-2.5" ? { model: id, prompt: input.prompt, seconds: 5, resolution: "480P", aspect_ratio: "16:9", generate_audio: false }
      : { model: id, prompt: input.prompt, seconds: 5, resolution: "768P", ratio: "16:9", aigc_watermark: false };
    await journal.submitted("generate", JSON.stringify([source.baseUrl, source.apiKey, undefined, native ? "seedance" : "kunpo-videos"]), body, async () => ({ taskId: "task_legacy_empty_frame" }));
    request.mockResolvedValueOnce(Response.json(native ? { status: "succeeded", content: { video_url: "http://127.0.0.1:43199/old.mp4" } } : { status: "completed" })).mockResolvedValueOnce(mp4());
    await provider.generate(model(id), { ...input, execution: await videoTaskJournal(directory, "legacy-empty-frame", true) });
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("maps VS frame references to its documented fields instead of OpenRouter fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-frames-"));
    const first = path.join(directory, "first.png");
    await writeFile(first, Buffer.from("image-fixture"));
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_frame" })).mockResolvedValueOnce(Response.json({ status: "completed" })).mockResolvedValueOnce(mp4());
    await new KunpoVideoProvider(source, request, 0).generate(model("tencent-vod-vs-2.5"), { prompt: "Animate", referenceMode: "frame", aspectRatio: "adaptive", references: [{ type: "image", name: "first.png", mediaType: "image/png", absolutePath: first }] });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.first_frame_url).toBe(`data:image/png;base64,${Buffer.from("image-fixture").toString("base64")}`);
    expect(body.frame_images).toBeUndefined();
    expect(body.aspect_ratio).toBe("adaptive");
  });

  it("does not expose a local video as a public reference or accept unsupported resolutions", async () => {
    const request = vi.fn<typeof fetch>(), provider = new KunpoVideoProvider(source, request, 0);
    await expect(provider.generate(model(), { prompt: "Extend", references: [{ type: "video", name: "local.mp4", mediaType: "video/mp4", absolutePath: "/not-read" }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(provider.generate(model(), { prompt: "4K", resolution: "4K" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(provider.generate(model("minimax-video-h3"), { prompt: "1080", resolution: "1080p" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds unknown task states without submitting a replacement", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_unknown" })).mockImplementation(async () => Response.json({ status: "unknown" }));
    await expect(new KunpoVideoProvider(source, request, 0, 30).generate(model("tencent-vod-vs-2.5"), { prompt: "Test" })).rejects.toMatchObject({ statusCode: 504 });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(request.mock.calls.length).toBeGreaterThan(3);
  });

  it("tolerates transitional states beyond three polls and still retrieves the same video", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_transitional" }))
      .mockResolvedValueOnce(Response.json({ status: "submitted" })).mockResolvedValueOnce(Response.json({ status: "submitted" }))
      .mockResolvedValueOnce(Response.json({ status: "submitted" })).mockResolvedValueOnce(Response.json({ status: "running" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/clip.mp4" } })).mockResolvedValueOnce(mp4());
    await expect(new KunpoVideoProvider(source, request, 0, 1000).generate(model(), { prompt: "Wait for the existing task" })).resolves.toMatchObject({ requestId: "task_transitional" });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recognizes cancellation as terminal without claiming an upstream refund", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_cancelled" })).mockResolvedValueOnce(Response.json({ status: "cancelled" }));
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Test" })).rejects.toMatchObject({ statusCode: 400, message: "Kunpo video task cancelled; no new task was submitted" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated status transport failures and never replaces a known task", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_retry" })).mockRejectedValue(new Error("offline"));
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Retry status" })).rejects.toMatchObject({ statusCode: 502 });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("times out a pending submission and reports an uncertain outcome", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await expect(new KunpoVideoProvider(source, request, 0, 10).generate(model(), { prompt: "Timeout" })).rejects.toMatchObject({ statusCode: 504 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-video artifact and a declared oversize artifact without another POST", async () => {
    for (const artifact of [new Response("<html>Error</html>"), new Response("x", { headers: { "content-length": String(300 * 1024 * 1024) } })]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_bad_artifact" }))
        .mockResolvedValueOnce(Response.json({ status: "completed" })).mockResolvedValueOnce(artifact);
      await expect(new KunpoVideoProvider(source, request, 0).generate(model("tencent-vod-vs-2.5"), { prompt: "Validate output" })).rejects.toBeInstanceOf(Error);
      expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });
});

describe("video task recovery", () => {
  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"])("checks %s output DNS before a paid POST and leaves no uncertain submission marker", async (id) => {
    videoDns.mockResolvedValue([{ address: "198.18.0.12", family: 4 }]);
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-dns-")), request = vi.fn<typeof fetch>();
    const input = { prompt: "Do not submit with unsafe output DNS", execution: await videoTaskJournal(directory, "dns-before-submit") };
    await expect(new KunpoVideoProvider({ ...source, baseUrl: "https://llm.ziy.cc/v1" }, request, 0).generate(model(id), input)).rejects.toMatchObject({ statusCode: 503, notSubmitted: true });
    expect(request).not.toHaveBeenCalled();
    expect(await hasSavedVideoTask(directory, "dns-before-submit")).toBe(false);
    const stored = JSON.parse(await readFile(path.join(directory, "dns-before-submit.json"), "utf8"));
    expect(stored).toEqual({});
  });
  it("refuses recovery without a validated task and never invokes the paid submit callback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-video-only-"));
    const request = vi.fn<typeof fetch>();
    expect(await hasSavedVideoTask(directory, "missing")).toBe(false);
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Recover only", execution: await videoTaskJournal(directory, "missing", true) })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
    const original = await videoTaskJournal(directory, "saved");
    await original.submitted("generate", "scope", {}, async () => ({ taskId: "task_saved" }));
    expect(await hasSavedVideoTask(directory, "saved")).toBe(true);
    await symlink(path.join(directory, "saved.json"), path.join(directory, "linked.json"));
    expect(await hasSavedVideoTask(directory, "linked")).toBe(false);
    await writeFile(path.join(directory, "invalid.json"), JSON.stringify({ generate: { fingerprint: "a".repeat(64), task: { taskId: "https://unsafe.test/task" } } }), { mode: 0o600 });
    expect(await hasSavedVideoTask(directory, "invalid")).toBe(false);
    const create = vi.fn(async () => ({ taskId: "replacement" }));
    await expect((await videoTaskJournal(directory, "invalid", true)).submitted("generate", "scope", {}, create)).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks submission even if a recovery execution accidentally invokes create", async () => {
    const request = vi.fn<typeof fetch>();
    const execution = { recoveryOnly: true, submitted: async <T extends Record<string, string>>(_stage: string, _scope: string, _input: unknown, create: () => Promise<T>) => create() };
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Recover only", execution })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
  });
  it("persists a task before waiting and resumes after cancellation without another POST", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-recovery-"));
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_resume" })).mockImplementationOnce(async () => { controller.abort(); return Response.json({ status: "running" }); });
    const input = { prompt: "Resume", execution: await videoTaskJournal(directory, "job-resume") };
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), input, controller.signal)).rejects.toMatchObject({ statusCode: 499 });
    const retry = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/video.mp4" } })).mockResolvedValueOnce(mp4());
    const result = await new KunpoVideoProvider(source, retry, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "job-resume") });
    expect(result.requestId).toBe("task_resume");
    expect(String(retry.mock.calls[0]?.[0]).endsWith("/tasks/task_resume")).toBe(true);
    expect(retry.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const journal = await readFile(path.join(directory, (await readdir(directory))[0]!), "utf8");
    expect(journal).toContain("task_resume");
    expect(journal).not.toContain(source.apiKey);
    expect(journal).not.toContain("Resume");
  });

  it("marks an unknown POST result and refuses automatic replay across restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-unknown-"));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error("simulated connection loss"));
    await expect(new KunpoVideoProvider(source, failed, 0).generate(model(), { prompt: "Uncertain", execution: await videoTaskJournal(directory, "job-unknown") })).rejects.toMatchObject({ statusCode: 502 });
    const retry = vi.fn<typeof fetch>();
    await expect(new KunpoVideoProvider(source, retry, 0).generate(model(), { prompt: "Uncertain", execution: await videoTaskJournal(directory, "job-unknown") })).rejects.toMatchObject({ statusCode: 409 });
    expect(retry).not.toHaveBeenCalled();
  });

  it("serializes concurrent submissions sharing a recovery ID and rejects changed parameters", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-race-"));
    const create = vi.fn(async () => ({ taskId: "task_once" }));
    const [left, right] = await Promise.all([videoTaskJournal(directory, "same-job"), videoTaskJournal(directory, "same-job")]);
    await expect(Promise.all([left.submitted("generate", "scope", { duration: 5 }, create), right.submitted("generate", "scope", { duration: 5 }, create)])).resolves.toEqual([{ taskId: "task_once" }, { taskId: "task_once" }]);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(right.submitted("generate", "scope", { duration: 8 }, create)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows a definite HTTP validation rejection to be corrected without an ambiguous marker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-rejected-"));
    const rejected = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: "bad parameters" } }, { status: 400 }));
    await expect(new KunpoVideoProvider(source, rejected, 0).generate(model(), { prompt: "Correctable", execution: await videoTaskJournal(directory, "job-rejected") })).rejects.toMatchObject({ statusCode: 400 });
    const retry = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_corrected" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/video.mp4" } })).mockResolvedValueOnce(mp4());
    await expect(new KunpoVideoProvider(source, retry, 0).generate(model(), { prompt: "Correctable", execution: await videoTaskJournal(directory, "job-rejected") })).resolves.toMatchObject({ requestId: "task_corrected" });
    expect(retry.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("PNG preparation and paid-task identity", () => {
  it.each(["doubao-seedance-2-5-260628", "tencent-vod-vs-2.5", "minimax-video-h3"].flatMap((id) => ["reference", "frame"].map((mode) => ({ id, mode: mode as "reference" | "frame" }))))("optimizes only the new $id $mode payload and preserves the original file", async ({ id, mode }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-png-protocol-")), file = path.join(directory, "source.png"), bytes = referencePng(); await writeFile(file, bytes);
    const native = id.startsWith("doubao"), request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_png" })).mockResolvedValueOnce(Response.json(native ? { status: "succeeded", content: { video_url: source.baseUrl.replace("/v1", "/out.mp4") } } : { status: "completed" })).mockResolvedValueOnce(mp4());
    const input = { prompt: "Synthetic", duration: 4, resolution: id === "minimax-video-h3" ? "768p" as const : "480p" as const, aspectRatio: "adaptive" as const, referenceMode: mode, references: Array.from({ length: mode === "frame" ? 2 : 1 }, () => ({ type: "image" as const, name: "source.png", mediaType: "image/png", absolutePath: file })), execution: await videoTaskJournal(directory, "png") };
    const result = await new KunpoVideoProvider(source, request, 0).generate(model(id), input);
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    const urls = id === "tencent-vod-vs-2.5" ? mode === "frame" ? [body.first_frame_url, body.last_frame_url] : body.images : body.content.filter((part: { type: string }) => part.type === "image_url").map((part: { image_url: { url: string } }) => part.image_url.url);
    for (const url of urls) { const derived = Buffer.from(url.split(",")[1], "base64"); expect(derived.length).toBeLessThan(bytes.length); expect(pngScanlines(derived)).toEqual(pngScanlines(bytes)); expect(pngChunks(derived).filter((c) => c.type !== "IDAT").map((c) => c.raw)).toEqual(pngChunks(bytes).filter((c) => c.type !== "IDAT").map((c) => c.raw)); }
    expect(result.metadata?.parameters.referencePngOptimized).toBe(urls.length); expect(await readFile(file)).toEqual(bytes);
    const saved = await readFile(path.join(directory, "png.json"), "utf8"); expect(saved).not.toContain(source.apiKey); expect(saved).not.toContain("data:");
    const recover = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(native ? { status: "succeeded", content: { video_url: source.baseUrl.replace("/v1", "/out.mp4") } } : { status: "completed" })).mockResolvedValueOnce(mp4());
    const optimizer = vi.spyOn(pngPreparation, "optimizeVideoReferencePng");
    try { const recovered = await new KunpoVideoProvider(source, recover, 0).generate(model(id), { ...input, execution: await videoTaskJournal(directory, "png", true) }); expect(optimizer).not.toHaveBeenCalled(); expect(recovered.metadata?.parameters.referencePngOptimized).toBe(urls.length); expect(recover.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true); expect(await readFile(path.join(directory, "png.json"), "utf8")).toBe(saved); } finally { optimizer.mockRestore(); }
  });

  it("keeps a legacy raw-PNG fingerprint unchanged and queries without optimization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-png-legacy-")), file = path.join(directory, "source.png"), bytes = referencePng(); await writeFile(file, bytes);
    const body = { model: model().id, content: [{ type: "text", text: "Legacy" }, { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` }, role: "reference_image" }], duration: 4, resolution: "480p", ratio: "adaptive", generate_audio: true, watermark: false, output_format: "mp4" };
    await (await videoTaskJournal(directory, "legacy")).submitted("generate", JSON.stringify([source.baseUrl, source.apiKey, undefined, "seedance"]), body, async () => ({ taskId: "task_legacy_png" }));
    const before = await readFile(path.join(directory, "legacy.json"), "utf8"), request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/legacy.mp4" } })).mockResolvedValueOnce(mp4());
    const optimizer = vi.spyOn(pngPreparation, "optimizeVideoReferencePng");
    try { const result = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Legacy", duration: 4, resolution: "480p", aspectRatio: "adaptive", references: [{ type: "image", name: "source.png", mediaType: "image/png", absolutePath: file }], execution: await videoTaskJournal(directory, "legacy", true) }); expect(optimizer).not.toHaveBeenCalled(); expect(result.metadata?.parameters.referencePngOptimized).toBeUndefined(); expect(await readFile(path.join(directory, "legacy.json"), "utf8")).toBe(before); expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true); } finally { optimizer.mockRestore(); }
  });

  it("preserves unknown submissions across restart without optimizing or posting again", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-png-unknown-")), file = path.join(directory, "source.png"); await writeFile(file, referencePng());
    const input = { prompt: "Synthetic", references: [{ type: "image" as const, name: "source.png", mediaType: "image/png", absolutePath: file }] };
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("Connection lost"));
    await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "unknown") })).rejects.toThrow("could not be confirmed");
    const optimizer = vi.spyOn(pngPreparation, "optimizeVideoReferencePng");
    try { await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { ...input, execution: await videoTaskJournal(directory, "unknown", true) })).rejects.toThrow("could not be confirmed"); expect(optimizer).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce(); } finally { optimizer.mockRestore(); }
  });

  it("cancels during preparation without a paid POST and does not leak protected bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-png-cancel-")), file = path.join(directory, "source.png"); await writeFile(file, referencePng());
    const controller = new AbortController(), request = vi.fn<typeof fetch>();
    const optimizer = vi.spyOn(pngPreparation, "optimizeVideoReferencePng").mockImplementation(async () => { controller.abort(); throw new Error("Cancelled"); });
    try { await expect(new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Cancel", references: [{ type: "image", name: "source.png", mediaType: "image/png", absolutePath: file }], execution: await videoTaskJournal(directory, "cancel") }, controller.signal)).rejects.toMatchObject({ notSubmitted: true }); expect(JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8")).generate).toBeUndefined(); expect(request).not.toHaveBeenCalled(); } finally { optimizer.mockRestore(); }
    await writeFile(file, referencePng({ metadata: [["tEXt", Buffer.from(`private\0${source.apiKey}`)]] }));
    const error = await new KunpoVideoProvider(source, request, 0).generate(model(), { prompt: "Protected", references: [{ type: "image", name: "source.png", mediaType: "image/png", absolutePath: file }] }).catch((cause) => cause);
    expect(error.notSubmitted).toBe(true); expect(error.message).not.toContain(source.apiKey); expect(request).not.toHaveBeenCalled();
  });
});

describe("Kunpo native Seedance availability", () => {
  it("keeps the unreviewed 2.0 framework out of the connected Kunpo catalog", async () => {
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(async () => { throw new Error("Runtime must not be queried"); }, request,
      (provider) => provider === "volcengine-ark" ? source.apiKey : undefined, (provider) => provider === "volcengine-ark");
    expect((await videos.catalog()).models.map((entry) => entry.id)).toEqual(["doubao-seedance-2-5-260628"]);
    expect(request).not.toHaveBeenCalled();
    expect(seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")).toBeDefined();
  });

  it("rejects an explicit Kunpo 2.0 request before any paid POST", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new SeedanceProvider("volcengine-ark", () => source.apiKey, request);
    const legacy = seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")!;
    await expect(provider.generate(legacy, { prompt: "Legacy", model: legacy, duration: 5, resolution: "720p", aspectRatio: "16:9" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the primary 2.5 dispatch on its resumable journal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-kunpo-native-resume-"));
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "task_native_primary" }))
      .mockImplementation(async (url) => String(url).endsWith(".mp4") ? mp4() : Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/native.mp4" } }));
    const provider = new SeedanceProvider("volcengine-ark", () => source.apiKey, request, 0, 10_000, { name: "KunpoAPI", baseUrl: "http://127.0.0.1:43199/doubao/api/v3" });
    const primary = seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!;
    const input = { prompt: "Primary", model: primary, duration: 5, resolution: "720p" as const, aspectRatio: "16:9" as const, execution: await videoTaskJournal(directory, "primary-recovery") };
    await provider.generate(primary, input);
    await provider.generate(primary, { ...input, execution: await videoTaskJournal(directory, "primary-recovery") });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/tasks/task_native_primary"))).toHaveLength(2);
  });
});
