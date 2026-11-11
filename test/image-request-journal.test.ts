import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSavedImageResult, imageRequestJournal } from "../src/daemon/image-request-journal.js";
import { OpenAIImageGenerator, type ImageSubmission } from "../src/daemon/openai-image.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";

const directories: string[] = [];
const artifactDns = vi.hoisted(() => vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]));
vi.mock("node:dns/promises", async (original) => ({ ...await original<typeof import("node:dns/promises")>(), lookup: artifactDns }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const base = "http://127.0.0.1:43199/v1";
const artifact = "http://127.0.0.1:43199/generated/icon.png";
const input = { prompt: "private image prompt", size: "1024x1024" as const };
const submitted: ImageSubmission = { url: artifact, generation: { model: "gpt-image-2.5-sunburst", protocol: "openai-images", parameters: { size: "1024x1024" } } };
afterEach(async () => { artifactDns.mockReset(); artifactDns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ohmygame-image-journal-")); directories.push(value); return value; }

describe("synchronous image recovery journal", () => {
  it("advertises recovery only for complete validated results without creating missing records", async () => {
    const folder = await directory();
    expect(await hasSavedImageResult(folder, "missing")).toBe(false);
    await expect(readFile(path.join(folder, "missing-0.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const journal = await imageRequestJournal(folder, "ready-0");
    await journal.submitted("scope", input, async () => submitted);
    expect(await hasSavedImageResult(folder, "ready")).toBe(true);
    expect(await hasSavedImageResult(folder, "ready", 2)).toBe(false);
    await expect((await imageRequestJournal(folder, "unknown-0")).submitted("scope", input, async () => { throw new Error("response lost"); })).rejects.toThrow();
    expect(await hasSavedImageResult(folder, "unknown")).toBe(false);
    await writeFile(path.join(folder, "bad-0.json"), "not-json");
    expect(await hasSavedImageResult(folder, "bad")).toBe(false);
    expect(await hasSavedImageResult(folder, "../escape")).toBe(false);
  });
  it("saves the signed result before DNS rejection, then recovers after reopen using GET only", async () => {
    const folder = await directory(), signed = "https://kunpoapiimg.ziy.cc/result.png?signature=private-artifact-capability&expires=1999999999";
    const key = "sk-image-recovery-fake-key-only";
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      if (options?.method === "POST") {
        artifactDns.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
        return Response.json({ data: [{ url: signed }] }, { headers: { "x-request-id": "request-saved-before-dns" } });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    });
    await expect(new OpenAIImageGenerator(key, "https://llm.ziy.cc/v1", request).generate({ ...input, execution: await imageRequestJournal(folder, "dns-result") })).rejects.toThrow("Fake-IP");
    expect(request).toHaveBeenCalledOnce();
    const saved = JSON.parse(await readFile(path.join(folder, "dns-result.json"), "utf8"));
    expect(saved).toMatchObject({ state: "ready", result: { url: signed, requestId: "request-saved-before-dns" } });
    expect(JSON.stringify(saved)).not.toContain(key);
    artifactDns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const reopened = new OpenAIImageGenerator(key, "https://llm.ziy.cc/v1", request);
    await expect(reopened.generate({ ...input, execution: await imageRequestJournal(folder, "dns-result", true) })).resolves.toMatchObject({ bytes: PNG });
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("refuses Fake-IP before billing and permits a later explicit generation after DNS is fixed", async () => {
    const folder = await directory();
    artifactDns.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const generator = new OpenAIImageGenerator("sk-preflight-fake-only", "https://llm.ziy.cc/v1", request);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "preflight") })).rejects.toMatchObject({ notSubmitted: true });
    expect(request).not.toHaveBeenCalled();
    await expect(readFile(path.join(folder, "preflight.json"))).rejects.toMatchObject({ code: "ENOENT" });
    // A recovery button may never turn this absent record into a POST.
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "preflight", true) })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
    artifactDns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "preflight") })).resolves.toMatchObject({ bytes: PNG });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["missing", "unknown"])("never posts when recovery is requested for a %s result", async (state) => {
    const folder = await directory(), create = vi.fn(async () => submitted);
    if (state === "unknown") await expect((await imageRequestJournal(folder, "old")).submitted("scope", input, async () => { throw new Error("lost response"); })).rejects.toThrow();
    await expect((await imageRequestJournal(folder, "old", true)).submitted("scope", input, create)).rejects.toMatchObject({ statusCode: 409, outcomeUnknown: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a saved URL through cancellation and coalesces recovery submissions", async () => {
    const folder = await directory(), abort = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      if (options?.method === "POST") return Response.json({ data: [{ url: artifact }] });
      abort.abort(); throw new DOMException("Cancelled", "AbortError");
    });
    const generator = new OpenAIImageGenerator("cancel-recovery-fake-only", base, request);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "cancel") }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    const first = await imageRequestJournal(folder, "cancel", true), second = await imageRequestJournal(folder, "cancel", true);
    const network = vi.fn<typeof fetch>(async () => new Response(PNG));
    const restored = new OpenAIImageGenerator("cancel-recovery-fake-only", base, network);
    await expect(Promise.all([restored.generate({ ...input, execution: first }), restored.generate({ ...input, execution: second })])).resolves.toHaveLength(2);
    expect(network.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
  it("refuses linked directories, linked records and oversized records before creating a request", async () => {
    const folder = await directory(), outside = await directory();
    const alias = path.join(folder, "alias"); await symlink(outside, alias);
    await expect(imageRequestJournal(alias, "job")).rejects.toMatchObject({ statusCode: 409 });
    const source = path.join(outside, "record.json"); await writeFile(source, "private-not-json");
    await symlink(source, path.join(folder, "linked.json"));
    await link(source, path.join(folder, "hard.json"));
    await writeFile(path.join(folder, "oversized.json"), "x".repeat(65_537));
    const create = vi.fn(async () => submitted);
    for (const id of ["linked", "hard", "oversized"]) await expect((await imageRequestJournal(folder, id)).submitted("scope", input, create)).rejects.toMatchObject({ statusCode: 409, message: "The image recovery record could not be read safely" });
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(source, "utf8")).toBe("private-not-json");
  });

  it("refuses credential-bearing or unreviewed recovery metadata and keeps the submission uncertain", async () => {
    const folder = await directory();
    const canary = "CANARY_IMAGE_JOURNAL_CREDENTIAL_ONLY"; registerSensitiveValue(canary);
    const invalid = [
      { ...submitted, url: `${artifact}?token=${canary}` }, { ...submitted, requestId: canary },
      { ...submitted, url: "https://user:password@kunpoapiimg.ziy.cc/image.png" },
      { ...submitted, url: `${artifact}#private-fragment` },
      { ...submitted, url: `${artifact}\n` },
      { ...submitted, url: `${artifact}?signature=${"x".repeat(16_384)}` },
      { ...submitted, generation: { ...submitted.generation, parameters: { prompt: "private text" } } },
    ];
    for (const [index, value] of invalid.entries()) {
      const journal = await imageRequestJournal(folder, `unsafe-${index}`);
      const create = vi.fn(async () => value);
      await expect(journal.submitted("scope", input, create)).rejects.toMatchObject({ statusCode: 409 });
      expect(await readFile(path.join(folder, `unsafe-${index}.json`), "utf8")).not.toContain(canary);
      await expect(journal.submitted("scope", input, create)).rejects.toMatchObject({ outcomeUnknown: true });
      expect(create).toHaveBeenCalledOnce();
    }
  });
  it("records a safe URL before download and resumes GET without another paid POST", async () => {
    const folder = await directory();
    let downloads = 0;
    const request = vi.fn<typeof fetch>(async (url, options) => options?.method === "POST"
      ? Response.json({ data: [{ url: artifact, b64_json: "" }] }, { headers: { "x-request-id": "image-request-1" } })
      : ++downloads === 1 ? new Response("unavailable", { status: 503 }) : new Response(PNG, { headers: { "content-type": "image/png" } }));
    const generator = new OpenAIImageGenerator("canary-only-image-key", base, request);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "job-0") })).rejects.toThrow("download");
    const stored = await readFile(path.join(folder, "job-0.json"), "utf8");
    expect(JSON.parse(stored)).toMatchObject({ version: 1, state: "ready", result: { url: artifact, requestId: "image-request-1", generation: { model: "gpt-image-2.5-sunburst" } } });
    expect(stored).not.toContain(input.prompt);
    expect(stored).not.toContain("canary-only-image-key");
    expect((await stat(path.join(folder, "job-0.json"))).mode & 0o777).toBe(0o600);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "job-0") })).resolves.toMatchObject({ bytes: PNG, requestId: "image-request-1" });
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(request.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(2);
  });

  it("leaves an unknown submission blocked after a lost response, even after reopening", async () => {
    const folder = await directory();
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
    const generator = new OpenAIImageGenerator("canary-only-image-key", base, request);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "unknown") })).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "unknown") })).rejects.toMatchObject({ statusCode: 409, outcomeUnknown: true });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(folder, "unknown.json"), "utf8"))).toMatchObject({ state: "submitting" });
  });

  it("rejects changed input or credentials rather than reusing a previous result", async () => {
    const folder = await directory();
    const journal = await imageRequestJournal(folder, "changed");
    const create = vi.fn(async () => submitted);
    await journal.submitted("endpoint-and-key-hash-input", { prompt: "first" }, create);
    await expect(journal.submitted("endpoint-and-key-hash-input", { prompt: "second" }, create)).rejects.toMatchObject({ statusCode: 409 });
    await expect(journal.submitted("changed-key", { prompt: "first" }, create)).rejects.toMatchObject({ statusCode: 409 });
    expect(create).toHaveBeenCalledOnce();
  });

  it("serializes simultaneous recovery instances into one submission", async () => {
    const folder = await directory();
    const first = await imageRequestJournal(folder, "double-click"), second = await imageRequestJournal(folder, "double-click");
    const create = vi.fn(async () => submitted);
    const result = await Promise.all([first.submitted("same-scope", input, create), second.submitted("same-scope", input, create)]);
    expect(result).toEqual([submitted, submitted]);
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not persist inline base64 and refuses crash-style replay", async () => {
    const folder = await directory();
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const generator = new OpenAIImageGenerator("canary-only-image-key", base, request);
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "inline") })).resolves.toMatchObject({ bytes: PNG });
    expect(await readFile(path.join(folder, "inline.json"), "utf8")).not.toContain(PNG.toString("base64"));
    await expect(generator.generate({ ...input, execution: await imageRequestJournal(folder, "inline") })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels a queued duplicate promptly without releasing its submission lock early", async () => {
    const folder = await directory();
    const journal = await imageRequestJournal(folder, "queued");
    let release!: (value: ImageSubmission) => void;
    const firstCreate = vi.fn(() => new Promise<ImageSubmission>((resolve) => { release = resolve; }));
    const first = journal.submitted("same", input, firstCreate);
    await vi.waitFor(() => expect(firstCreate).toHaveBeenCalledOnce());
    const controller = new AbortController(), secondCreate = vi.fn(async () => submitted);
    const second = journal.submitted("same", input, secondCreate, controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const thirdCreate = vi.fn(async () => submitted);
    const third = journal.submitted("same", input, thirdCreate);
    release(submitted);
    await expect(first).resolves.toEqual(submitted);
    await expect(third).resolves.toEqual(submitted);
    expect(secondCreate).not.toHaveBeenCalled();
    expect(thirdCreate).not.toHaveBeenCalled();
  });

  it("rejects a traversal recovery identifier", async () => {
    await expect(imageRequestJournal(await directory(), "../escape")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("does not echo a corrupted private journal into an error", async () => {
    const folder = await directory();
    await writeFile(path.join(folder, "corrupt.json"), '{"url":"private-artifact-access-canary');
    const journal = await imageRequestJournal(folder, "corrupt"), create = vi.fn(async () => submitted);
    await expect(journal.submitted("scope", input, create)).rejects.toMatchObject({ message: "The image recovery record could not be read safely", statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });
});
